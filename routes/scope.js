/**
 * Owns: homeowner scoping flow endpoints — submit lead, upload photos, calculate estimate.
 * Does NOT own: contractor dashboard, authentication, payments.
 */
const express = require('express');
const router = express.Router();
const { createLead, addLeadPhoto } = require('../db/leads');
const { sendLeadNotification, sendLeadConfirmation } = require('../services/email');
const { getContractorBySlug } = require('../db/contractors');
const { logLeadEvent } = require('../db/analytics');
const { trackEvent } = require('../lib/track-pageview');
const { getActiveClaimForZip } = require('../db/territory');

/**
 * Extract 5-digit US zip code from an address string.
 * Matches " 42420" or " 42420-1234" patterns.
 */
function extractZipFromAddress(address) {
  if (!address) return null;
  const m = address.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : null;
}

// ── Vertical-specific ballpark pricing ────────────────────────────────────
// Industry midpoints for Western KY market. All $/sqft unless noted.
// These are rough guides — contractor quotes will vary by site conditions.
//
// Assumptions:
//   Concrete:        $6–10/sqft base (4" broom finish driveway/patio, Owensboro KY midpoint)
//   Excavation:      $3–6/sqft for shallow grading; depth and rock multiply cost
//   Drainage:        $25–65/linear ft for French drain all-in (pipe + stone + labor)
//   Retaining wall:  $35–80/linear ft at standard 3–4 ft block wall height
//   Demolition:      $2–5/sqft concrete slab; $1.50–3 asphalt
//   Land clearing:   $0.50–4/sqft depending on density/trees
//   Gravel delivery: $30–55/ton delivered + spread; ~1 ton per 200 sqft at 4" depth
//   Fence:           $10–40/linear ft depending on material; perimeter ≈ 4√(sqft)

function calculateEstimate(projectType, sqft, tradeInputs) {
  const ti = tradeInputs || {};
  let low = 0, high = 0;

  if (!sqft || sqft <= 0) return { estimate_low: 0, estimate_high: 0 };

  switch (projectType) {
    case 'concrete': {
      low = 6 * sqft; high = 10 * sqft;
      if (ti.tear_out === 'yes')          { low += 2 * sqft; high += 4 * sqft; }
      if (ti.thickness === '5in')         { low += 0.5 * sqft; high += 1 * sqft; }
      if (ti.thickness === '6in')         { low += 1 * sqft; high += 2 * sqft; }
      if (ti.reinforcement === 'rebar' || ti.reinforcement === 'wire') { low += 1.5 * sqft; high += 2.5 * sqft; }
      if (ti.reinforcement === 'fiber')   { low += 0.5 * sqft; high += 1 * sqft; }
      if (ti.finish_type === 'exposed')   { low += 1 * sqft; high += 2 * sqft; }
      if (ti.finish_type === 'stamped')   { low += 4 * sqft; high += 8 * sqft; }
      if (ti.finish_type === 'smooth')    { low += 0.5 * sqft; high += 1 * sqft; }
      if (ti.truck_access === 'pump')     { low += 800; high += 1800; }
      break;
    }
    case 'excavation': {
      const depthMult = { '1-3': 1, '4-6': 1.4, '7-10': 1.9, '10+': 2.5 };
      const dMult = depthMult[ti.depth_ft] || 1;
      low = 3 * sqft * dMult; high = 6 * sqft * dMult;
      if (ti.soil_type === 'rock')        { low *= 1.4; high *= 1.8; }
      if (ti.haul_off === 'yes')          { low += 1.5 * sqft; high += 2.5 * sqft; }
      break;
    }
    case 'drainage': {
      const linFtMids = { 'under25': 20, '25-75': 50, '75-150': 110, '150+': 200 };
      const linFt = linFtMids[ti.linear_ft] || Math.max(20, Math.sqrt(sqft));
      low = 25 * linFt; high = 65 * linFt;
      if (ti.drainage_problem === 'yard_regrade') { low += 500; high += 1500; }
      break;
    }
    case 'retaining_wall': {
      const wallFtMids = { 'under20': 15, '20-50': 35, '50-100': 75, '100+': 150 };
      const wallFt = wallFtMids[ti.wall_length_ft] || Math.max(15, Math.sqrt(sqft));
      const hMult = { 'under2': 0.6, '2-4': 1, '4-6': 1.5, '6+': 2.2 }[ti.wall_height_ft] || 1;
      low = 35 * wallFt * hMult; high = 80 * wallFt * hMult;
      if (ti.tiered === 'tiered')         { low *= 1.3; high *= 1.5; }
      if (ti.drainage_behind === 'yes')   { low += 500; high += 1200; }
      break;
    }
    case 'demolition': {
      const demoRate = { concrete: [2, 5], asphalt: [1.5, 3] };
      const [r1, r2] = demoRate[ti.demo_material] || [1.5, 4];
      low = r1 * sqft; high = r2 * sqft;
      if (ti.haul_off === 'yes')          { low += 1 * sqft; high += 2 * sqft; }
      break;
    }
    case 'land_clearing': {
      const clearRate = { brush_light: [0.5, 1.5], brush_heavy: [0.8, 2.5], trees_small: [1, 3], trees_large: [1.5, 4], mixed: [1.5, 4] };
      const [c1, c2] = clearRate[ti.clearing_type] || [0.8, 2.5];
      low = c1 * sqft; high = c2 * sqft;
      if (ti.stump_removal === 'yes')     { low += 200; high += 600; }
      if (ti.debris_disposal === 'haul_off') { low += 0.3 * sqft; high += 0.8 * sqft; }
      break;
    }
    case 'gravel_delivery': {
      const tons = Math.max(2, sqft / 200);
      const tRates = { driveway_gravel: [30, 55], limestone: [28, 50], pea_gravel: [45, 75], road_base: [25, 45], fill_dirt: [15, 30], topsoil: [30, 55] };
      const [t1, t2] = tRates[ti.gravel_type] || [30, 55];
      low = t1 * tons; high = t2 * tons;
      if (ti.spreading === 'yes')         { low += 0.5 * sqft; high += 1.5 * sqft; }
      break;
    }
    case 'fence': {
      const linearFt = Math.max(30, 4 * Math.sqrt(sqft));
      const fRates = { wood_privacy: [18, 35], wood_picket: [12, 22], chain_link: [10, 20], vinyl: [22, 40], aluminum: [20, 38], split_rail: [8, 16] };
      const [f1, f2] = fRates[ti.fence_material] || [15, 30];
      const hMult = { '3': 0.7, '4': 0.85, '6': 1, '8': 1.25 }[ti.fence_height_ft] || 1;
      low = f1 * linearFt * hMult; high = f2 * linearFt * hMult;
      if (ti.remove_existing === 'yes')   { low += 2 * linearFt; high += 4 * linearFt; }
      if (ti.gates === 'both')            { low += 800; high += 2000; }
      else if (ti.gates && ti.gates !== 'none') { low += 300; high += 800; }
      break;
    }
    default:
      low = 5 * sqft; high = 12 * sqft;
  }

  // Minimum $500; round to nearest $100
  low = Math.max(500, Math.round(low / 100) * 100);
  high = Math.max(low + 200, Math.round(high / 100) * 100);
  return { estimate_low: low, estimate_high: high };
}

// POST /api/scope/started — homeowner begins the scoping flow
router.post('/started', (req, res) => {
  trackEvent({
    eventType: 'lead_started',
    pageUrl: '/scope.html',
    metadata: {
      source: req.query.c ? 'contractor_link' : 'direct'
    }
  });
  res.status(204).end();
});

// POST /api/scope/submit — create a new lead
router.post('/submit', async (req, res) => {
  try {
    const {
      address, latitude, longitude, project_area_geojson, sq_footage,
      project_type, trade_inputs,
      // Legacy fields kept for backwards compat (older clients)
      tear_out, reinforcement, finish_type, has_drainage,
      notes, homeowner_name, homeowner_email, homeowner_phone, photo_urls,
      contractor_slug
    } = req.body;

    if (!address || !homeowner_name || !homeowner_email) {
      return res.status(400).json({ error: 'address, homeowner_name, and homeowner_email are required' });
    }

    const type = project_type || 'concrete';
    const inputs = trade_inputs || {};

    // Merge legacy fields into trade_inputs for old clients
    if (!inputs.tear_out && tear_out !== undefined) inputs.tear_out = tear_out ? 'yes' : 'no';
    if (!inputs.reinforcement && reinforcement)     inputs.reinforcement = reinforcement;
    if (!inputs.finish_type && finish_type)         inputs.finish_type = finish_type;

    const { estimate_low, estimate_high } = calculateEstimate(type, parseFloat(sq_footage), inputs);

    // Resolve contractor slug → contractor_id (for scoped/personalized links)
    let contractorId = null;
    let contractorEmail = process.env.CONTRACTOR_EMAIL || process.env.NOTIFY_EMAIL || null;
    if (contractor_slug) {
      const contractor = await getContractorBySlug(contractor_slug);
      if (contractor) {
        contractorId = contractor.id;
        contractorEmail = contractor.email;
      }
    }

    // Derive zip from address string (Mapbox autocomplete embeds zip in the full address)
    const zipCode = req.body.zip_code || extractZipFromAddress(address);

    // Territory routing: if a contractor owns this zip, route to them
    // (overrides contractor_slug — territory owner always gets the lead)
    let routedToContractorId = null;
    if (zipCode) {
      try {
        const territoryClaim = await getActiveClaimForZip(zipCode);
        if (territoryClaim) {
          routedToContractorId = territoryClaim.contractor_id;
          // Territory owner takes over notification unless contractor_slug already points to them
          if (!contractorId || contractorId !== territoryClaim.contractor_id) {
            contractorId = territoryClaim.contractor_id;
            // fetch contractor email for notification
            const { getContractorById } = require('../db/contractors');
            const territoryContractor = await getContractorById(territoryClaim.contractor_id);
            if (territoryContractor) contractorEmail = territoryContractor.email;
          }
        }
      } catch (zipErr) {
        // Non-fatal — continue without territory routing
        console.error('Territory lookup error:', zipErr.message);
      }
    }

    if (!contractorEmail) contractorEmail = null;

    const lead = await createLead({
      address, latitude, longitude, project_area_geojson, sq_footage,
      project_type: type,
      trade_inputs: inputs,
      // Keep legacy columns populated for dashboard backwards compat
      tear_out: inputs.tear_out === 'yes' || !!tear_out,
      reinforcement: inputs.reinforcement || reinforcement || null,
      finish_type: inputs.finish_type || finish_type || null,
      has_drainage: type === 'drainage' || !!has_drainage,
      notes,
      homeowner_name, homeowner_email, homeowner_phone,
      estimate_low, estimate_high, contractor_email: contractorEmail, contractor_id: contractorId,
      zip_code: zipCode, routed_to_contractor_id: routedToContractorId
    });

    // Attach any pre-uploaded photo URLs
    const photos = Array.isArray(photo_urls) ? photo_urls : [];
    for (const url of photos.slice(0, 3)) {
      await addLeadPhoto(lead.id, url);
    }

    // Track lead submission event
    logLeadEvent({
      leadId: lead.id,
      contractorId: contractorId,
      eventType: 'submitted',
      metadata: { project_type: type, source: contractor_slug ? 'contractor_link' : 'direct' }
    }).catch(err => console.error('Lead event tracking error:', err.message));

    // Server-side analytics events — fire-and-forget
    trackEvent({
      eventType: 'lead_submitted',
      pageUrl: '/scope.html',
      contractorId: contractorId,
      metadata: { project_type: type, zip_code: zipCode, estimate_low, estimate_high }
    });

    // Fire-and-forget email notification to the contractor.
    sendLeadNotification(lead, photos).catch(err =>
      console.error('[scope/submit] contractor notification failed:', err.message)
    );

    // Fire-and-forget confirmation/summary to the homeowner. Failure does NOT
    // block the 200 response — the homeowner already sees the in-app
    // confirmation screen, and a missing email is recoverable.
    sendLeadConfirmation(lead, photos).catch(err =>
      console.error('[scope/submit] homeowner confirmation failed:', err.message)
    );

    res.json({ success: true, lead_id: lead.id, estimate_low, estimate_high });
  } catch (err) {
    console.error('scope submit error:', err);
    res.status(500).json({ error: 'Failed to submit project scope' });
  }
});

// POST /api/scope/upload — upload a photo, returns URL
// Uses Polsia R2 proxy if POLSIA_R2_BASE_URL is set, otherwise base64 dataURL fallback
router.post('/upload', async (req, res) => {
  try {
    const { data_url, filename } = req.body;
    if (!data_url) return res.status(400).json({ error: 'data_url required' });

    const r2Base = process.env.POLSIA_R2_BASE_URL;
    if (!r2Base) {
      // No R2 configured — DEV-ONLY fallback. Returning the raw data: URL means
      // the lead can be created, but the photo won't render in email clients
      // (Gmail blocks data: image sources). services/email.js filters these out
      // before sending so the email isn't visibly broken; the contractor just
      // sees no photos. Log loudly so a misconfigured prod doesn't pass silently.
      console.warn('[scope/upload] POLSIA_R2_BASE_URL not set — returning data: URL. Photos will NOT appear in email notifications.');
      return res.json({ url: data_url });
    }

    // Upload to R2 via Polsia proxy
    const base64 = data_url.split(',')[1];
    const mimeMatch = data_url.match(/^data:([^;]+);/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const fname = filename || `lead-photo-${Date.now()}.jpg`;

    const resp = await fetch(`${r2Base}/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.POLSIA_R2_KEY ? { 'Authorization': `Bearer ${process.env.POLSIA_R2_KEY}` } : {})
      },
      body: JSON.stringify({ base64, filename: fname, contentType: mime })
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error('R2 upload error:', text);
      return res.status(500).json({ error: 'Upload failed' });
    }

    const json = await resp.json();
    res.json({ url: json.url || json.public_url });
  } catch (err) {
    console.error('upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

module.exports = router;
