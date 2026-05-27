/**
 * Owns: zip-code territory claim endpoints — availability check, claim, release, list, SLA stats,
 *       public ZIP checker (/check), and waitlist (/waitlist).
 * Does NOT own: lead routing (scope.js), Stripe webhook processing, contractor auth.
 *
 * Billing: 1st zip is free (included in plan). Additional zips (up to 3 total) are
 * $79/mo via the Stripe subscription link below. The client redirects to that link;
 * on return we verify via Polsia payment API and then activate the claim.
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { requireAuth } = require('../lib/require-auth');
const {
  getClaimsByContractor,
  getActiveClaimForZip,
  getEffectiveCap,
  createClaim,
  releaseClaim,
  countActiveClaims,
  getActiveClaimedZips,
  getRecentlyCheckedZips,
  logTerritoryCheck,
  addToWaitlist,
  MAX_ZIPS_PER_CONTRACTOR,
  FREE_ZIP_COUNT,
  ADDITIONAL_ZIP_PRICE_CENTS,
} = require('../db/territory');
const { getContractorSlaStats } = require('../db/sla');

// ── ZIP adjacency helpers ────────────────────────────────────────────────────

/**
 * Fetch the lat/lng centroid for a ZIP using Mapbox Geocoding API.
 * Returns { lat, lng } or null if not found.
 */
async function getZipCentroid(zip) {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) return null;
  try {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${zip}.json?country=US&types=postcode&limit=1&access_token=${encodeURIComponent(token)}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.features || !data.features.length) return null;
    const [lng, lat] = data.features[0].center;
    return { lat, lng };
  } catch {
    return null;
  }
}

/** Haversine distance in miles between two lat/lng points. */
function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Find open ZIPs within ~100 miles of a given ZIP centroid.
 * Uses the Mapbox Geocoding API to batch-geocode ZIPs queried from territory_checks
 * and territory_claims (claimed ZIPs we know about), then filters by distance.
 * Limited to 20 results.
 */
async function getAdjacentOpenZips(zip, centroid, limit = 20) {
  if (!centroid) return [];

  // Pull active claims and recently-checked ZIPs via db functions (no raw pool in routes)
  const claimedZips = await getActiveClaimedZips();
  const claimedSet = new Set(claimedZips);

  const checkedZips = await getRecentlyCheckedZips(zip);
  const candidates = checkedZips.filter(z => !claimedSet.has(z) && z !== zip);

  // Seed with numerically adjacent ZIPs (same prefix ±50) as a fast fallback
  const prefix = zip.slice(0, 3);
  const base = parseInt(prefix + '00', 10);
  for (let i = -50; i <= 50; i++) {
    const candidate = String(base + i).padStart(5, '0');
    if (candidate !== zip && !claimedSet.has(candidate)) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  }

  // Geocode candidates in parallel (up to 60 to keep latency reasonable)
  const token = process.env.MAPBOX_TOKEN;
  if (!token) return candidates.slice(0, limit);

  const toCheck = candidates.slice(0, 60);
  const withDistance = [];

  await Promise.all(toCheck.map(async (candidateZip) => {
    const c = await getZipCentroid(candidateZip);
    if (!c) return;
    const miles = haversineMiles(centroid.lat, centroid.lng, c.lat, c.lng);
    if (miles <= 100) withDistance.push({ zip: candidateZip, miles });
  }));

  withDistance.sort((a, b) => a.miles - b.miles);
  return withDistance.slice(0, limit).map(x => x.zip);
}

/** Anonymize IP for storage (SHA-256 prefix). */
function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

// The Stripe subscription link for additional zip codes ($79/mo)
const ADDITIONAL_ZIP_STRIPE_URL = 'https://buy.stripe.com/6oU14odRa5f072ufYpc3m00';

// Validate 5-digit US zip code
function isValidZip(zip) {
  return /^\d{5}$/.test(String(zip || '').trim());
}

// GET /api/territory/check?zip=XXXXX
// Public — returns claim status + adjacent open ZIPs within ~100 miles.
router.get('/check', async (req, res) => {
  const zip = String(req.query.zip || '').trim();
  if (!isValidZip(zip)) {
    return res.status(400).json({ error: 'Invalid zip code — must be 5 digits' });
  }

  try {
    const claim = await getActiveClaimForZip(zip);
    const isClaimed = !!claim;
    const ipHash = hashIp(req.ip || req.headers['x-forwarded-for']);

    // Log asynchronously — don't block response
    logTerritoryCheck({
      zip,
      ipHash,
      userAgent: req.headers['user-agent'] || null,
      claimedAtCheck: isClaimed,
    }).catch(err => console.error('[territory/check] log error:', err.message));

    // Compute adjacent open ZIPs
    const centroid = await getZipCentroid(zip);
    const adjacentOpenZips = await getAdjacentOpenZips(zip, centroid);

    return res.json({
      zip,
      status: isClaimed ? 'claimed' : 'available',
      claimed_by: isClaimed ? {
        business_name: claim.business_name,
        founding: !!(claim.is_included_in_plan),
      } : null,
      adjacent_open_zips: adjacentOpenZips,
      adjacent_pool_size: adjacentOpenZips.length,
    });
  } catch (err) {
    console.error('[territory/check] error:', err);
    res.status(500).json({ error: 'Failed to check zip availability' });
  }
});

// POST /api/territory/waitlist
// Body: { zip, email } — saves waitlist signup for a claimed ZIP.
router.post('/waitlist', async (req, res) => {
  const zip = String(req.body.zip || '').trim();
  const email = String(req.body.email || '').trim();

  if (!isValidZip(zip)) {
    return res.status(400).json({ error: 'Invalid zip code' });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  try {
    const ipHash = hashIp(req.ip || req.headers['x-forwarded-for']);
    const { inserted } = await addToWaitlist({ zip, email, ipHash });
    res.json({ success: true, inserted });
  } catch (err) {
    console.error('[territory/waitlist] error:', err);
    res.status(500).json({ error: 'Failed to save waitlist entry' });
  }
});

// GET /api/territory/availability?zip=42420
// Public endpoint — no PII returned if taken
router.get('/availability', async (req, res) => {
  const zip = String(req.query.zip || '').trim();
  if (!isValidZip(zip)) {
    return res.status(400).json({ error: 'Invalid zip code — must be 5 digits' });
  }
  try {
    const claim = await getActiveClaimForZip(zip);
    if (claim) {
      return res.json({ available: false, message: 'Owned by another contractor' });
    }
    return res.json({ available: true });
  } catch (err) {
    console.error('territory availability error:', err);
    res.status(500).json({ error: 'Failed to check availability' });
  }
});

// GET /api/territory/my-claims
// Returns all active claims for the authenticated contractor
router.get('/my-claims', requireAuth, async (req, res) => {
  try {
    const claims = await getClaimsByContractor(req.session.contractorId);
    const count = claims.filter(c => c.status !== 'released').length;
    res.json({
      claims,
      count,
      max: MAX_ZIPS_PER_CONTRACTOR,
      free_included: FREE_ZIP_COUNT,
      additional_zip_price_cents: ADDITIONAL_ZIP_PRICE_CENTS,
      additional_zip_stripe_url: ADDITIONAL_ZIP_STRIPE_URL,
    });
  } catch (err) {
    console.error('my-claims error:', err);
    res.status(500).json({ error: 'Failed to load territory claims' });
  }
});

// POST /api/territory/claim
// Body: { zip_code }
// First zip is free. Additional zips require a Stripe subscription (client-side redirect).
// For paid claims the client sends back { zip_code, session_id } after Stripe checkout.
router.post('/claim', requireAuth, async (req, res) => {
  const zip = String(req.body.zip_code || '').trim();
  if (!isValidZip(zip)) {
    return res.status(400).json({ error: 'Invalid zip code — must be 5 digits' });
  }

  const contractorId = req.session.contractorId;

  try {
    // Look up the contractor's effective cap based on their subscription plan.
    // getEffectiveCap returns null for uncapped accounts (legacy_free,
    // founding_member, plan='lifetime', plan='legacy') and a number for the
    // tier limit otherwise (free 0, base 3, plus_1 4, plus_2 5, plus_3 6).
    const { getContractorById } = require('../db/contractors');
    const contractor = await getContractorById(contractorId);
    const cap = getEffectiveCap(contractor);   // null = uncapped

    // Count existing active claims
    const currentCount = await countActiveClaims(contractorId);

    if (cap !== null && currentCount >= cap) {
      return res.status(400).json({
        error: `Your plan's zip code limit has been reached. Upgrade to add more.`,
        code: 'CAP_REACHED',
        upgrade_url: '/pricing',
        current_cap: cap,
      });
    }

    // Every claim under the cap is "included in plan" — the contractor's
    // subscription already covers it. The old "1 free + extras at $79/mo"
    // model has been replaced by the tier model (Base 3, +1 4, +2 5, +3 6).
    // To claim more zips, contractors upgrade their tier, not pay per zip.
    const claim = await createClaim({
      contractorId,
      zipCode: zip,
      isIncludedInPlan: true,
      monthlyPriceCents: 0,
      cap,
    });
    res.json({ success: true, claim });
  } catch (err) {
    if (err.message === 'ZIP_TAKEN') {
      return res.status(409).json({ error: 'That zip code is already claimed by another contractor', code: 'ZIP_TAKEN' });
    }
    if (err.message === 'CAP_REACHED') {
      // Belt-and-suspenders fallthrough — the outer cap check above should
      // have already returned this, but the DB layer can also throw it.
      return res.status(400).json({
        error: `Your plan's zip code limit has been reached. Upgrade to add more.`,
        code: 'CAP_REACHED',
        upgrade_url: '/pricing',
      });
    }
    console.error('claim error:', err);
    res.status(500).json({ error: 'Failed to claim zip code' });
  }
});

// DELETE /api/territory/claim/:id
// Release (relinquish) a zip code claim
router.delete('/claim/:id', requireAuth, async (req, res) => {
  const claimId = parseInt(req.params.id, 10);
  if (!claimId) return res.status(400).json({ error: 'Invalid claim id' });

  try {
    const released = await releaseClaim(claimId, req.session.contractorId);
    if (!released) {
      return res.status(404).json({ error: 'Claim not found or already released' });
    }
    res.json({ success: true, claim: released });
  } catch (err) {
    console.error('release claim error:', err);
    res.status(500).json({ error: 'Failed to release zip code' });
  }
});

// GET /api/territory/sla-stats
// Returns the authenticated contractor's SLA performance metrics for the performance card.
router.get('/sla-stats', requireAuth, async (req, res) => {
  try {
    const stats = await getContractorSlaStats(req.session.contractorId);
    if (!stats) {
      return res.json({
        has_data: false,
        message: 'No leads yet — SLA tracking begins with your first routed lead.',
      });
    }
    res.json({ has_data: true, ...stats });
  } catch (err) {
    console.error('sla-stats error:', err);
    res.status(500).json({ error: 'Failed to load SLA stats' });
  }
});

module.exports = router;
