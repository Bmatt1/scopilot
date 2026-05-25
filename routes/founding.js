/**
 * Owns: founding member purchase flow — checkout session creation, payment verification, welcome page.
 * Does NOT own: contractor auth/session management, general signup flow, lead management.
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const {
  getFoundingCount,
  incrementFoundingCount,
  provisionFoundingContractor,
  getContractorByLoginToken,
  clearLoginToken,
  FOUNDING_LIMIT
} = require('../db/founding');
const { sendFoundingWelcomeEmail } = require('../services/email');
const { insertEvents } = require('../db/events');

const APP_URL = process.env.APP_URL || 'https://scopilot.polsia.app';
const POLSIA_API_URL = process.env.POLSIA_API_URL || 'https://polsia.com';
const POLSIA_API_KEY = process.env.POLSIA_API_KEY || '';

/**
 * POST /api/founding/checkout
 * Creates a Stripe Checkout Session for the $1,500 founding membership.
 * Gates on available spots before creating the session.
 */
router.post('/checkout', async (req, res) => {
  try {
    // Gate: check spots remaining before creating session
    const count = await getFoundingCount();
    if (count >= FOUNDING_LIMIT) {
      return res.status(410).json({
        error: 'sold_out',
        message: 'The founding cohort is full. Join the waitlist instead.',
        redirect: '/founding/waitlist'
      });
    }

    const successUrl = `${APP_URL}/founding/welcome?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${APP_URL}/founding`;

    // Create checkout session via Polsia payment proxy
    const sessionResp = await fetch(
      `${POLSIA_API_URL}/api/company-payments/create-checkout-session`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${POLSIA_API_KEY}`
        },
        body: JSON.stringify({
          name: 'Scopilot Founding Member — Lifetime Access',
          amount: 1500,
          success_url: successUrl,
          cancel_url: cancelUrl
        })
      }
    );

    if (!sessionResp.ok) {
      const errText = await sessionResp.text();
      console.error('[founding/checkout] session create error:', sessionResp.status, errText);
      return res.status(502).json({ error: 'Failed to create checkout session. Try again.' });
    }

    const { url } = await sessionResp.json();
    if (!url) {
      console.error('[founding/checkout] no URL in session response');
      return res.status(502).json({ error: 'Payment provider error. Try again.' });
    }

    // Track checkout_started server-side (session_id from client body if provided)
    const sessionId = req.body && req.body.session_id;
    insertEvents([{
      event_type: 'founding_checkout_started',
      session_id: sessionId || null,
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress,
      user_agent: req.headers['user-agent'] || '',
      referrer: req.headers['referer'] || null,
      properties: {}
    }]).catch(err => console.error('[founding] track checkout_started error:', err.message));

    res.json({ url });
  } catch (err) {
    console.error('[founding/checkout] error:', err.message);
    res.status(500).json({ error: 'Checkout failed. Try again.' });
  }
});

/**
 * GET /founding/welcome?session_id=<id>
 * Post-purchase confirmation page. Verifies payment, provisions account if needed,
 * sends welcome email, shows dashboard + scoping link.
 *
 * Note: this is a PAGE route, mounted directly in server.js (not /api prefix).
 * The route handler is exported separately for server.js to use.
 */
async function handleWelcomePage(req, res) {
  const sessionId = req.query.session_id;
  if (!sessionId) {
    return res.redirect('/founding');
  }

  try {
    // Verify payment with Polsia
    const verifyResp = await fetch(
      `${POLSIA_API_URL}/api/company-payments/verify?session_id=${encodeURIComponent(sessionId)}`,
      {
        headers: { Authorization: `Bearer ${POLSIA_API_KEY}` }
      }
    );

    if (!verifyResp.ok) {
      console.error('[founding/welcome] verify error:', verifyResp.status);
      return res.render('founding-welcome', {
        verified: false,
        error: 'Could not verify your payment. Contact support@polsia.com.',
        contractor: null
      });
    }

    const { verified, payment } = await verifyResp.json();

    if (!verified) {
      return res.render('founding-welcome', {
        verified: false,
        error: 'Payment not verified. If you completed payment, contact support@polsia.com.',
        contractor: null
      });
    }

    // Provision founding member account
    const loginToken = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const businessName = payment.business_name || payment.customer_name || payment.customer_email.split('@')[0];
    const email = payment.customer_email;
    const paymentIntentId = payment.payment_intent_id || payment.id || sessionId;
    const stripeCustomerId = payment.customer_id || null;

    const contractor = await provisionFoundingContractor({
      business_name: businessName,
      email,
      stripe_customer_id: stripeCustomerId,
      stripe_payment_intent_id: paymentIntentId,
      login_token: loginToken,
      login_token_expires_at: tokenExpiry
    });

    // Track checkout_completed
    insertEvents([{
      event_type: 'founding_checkout_completed',
      session_id: null,
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress,
      user_agent: req.headers['user-agent'] || '',
      referrer: req.headers['referer'] || null,
      properties: { email: email.replace(/(.{2}).+(@.+)/, '$1***$2') } // partial mask
    }]).catch(err => console.error('[founding] track checkout_completed error:', err.message));

    // Increment founding count (best-effort; hard-cap flag on overflow handled in webhook note)
    const newCount = await incrementFoundingCount();
    if (newCount > FOUNDING_LIMIT) {
      // Over cap — still honor purchase, flag for review
      console.warn('[founding/welcome] founding count exceeded cap! count:', newCount, 'email:', email);
    }

    const scopingLink = `${APP_URL}/scope.html?c=${contractor.unique_slug}`;
    const dashboardLink = `${APP_URL}/contractor`;
    const setPasswordLink = `${APP_URL}/founding/set-password?token=${loginToken}`;

    // Send welcome email (fire-and-forget)
    sendFoundingWelcomeEmail({
      email,
      businessName: contractor.business_name,
      scopingLink,
      dashboardLink,
      setPasswordLink
    }).catch(err => console.error('[founding] welcome email failed:', err.message));

    // Register as known contact for email deliverability
    const emailBase = process.env.POLSIA_EMAIL_PROXY_URL || process.env.POLSIA_EMAIL_URL || 'https://polsia.com/api/proxy/email';
    const contactsUrl = emailBase.replace(/\/send$/, '') + '/contacts';
    fetch(contactsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${POLSIA_API_KEY}`
      },
      body: JSON.stringify({ email, name: contractor.business_name, source: 'purchase' })
    }).catch(() => {}); // Non-critical

    return res.render('founding-welcome', {
      verified: true,
      error: null,
      contractor: {
        business_name: contractor.business_name,
        email,
        unique_slug: contractor.unique_slug,
        scoping_link: scopingLink,
        dashboard_link: dashboardLink,
        set_password_link: setPasswordLink
      }
    });
  } catch (err) {
    console.error('[founding/welcome] error:', err.message);
    return res.render('founding-welcome', {
      verified: false,
      error: 'Something went wrong. Your payment was processed — contact support@polsia.com with your receipt.',
      contractor: null
    });
  }
}

/**
 * GET /founding/set-password?token=<token>
 * One-time login link from welcome email — logs the contractor in and
 * redirects to dashboard where they can set a real password.
 */
async function handleSetPassword(req, res) {
  const { token } = req.query;
  if (!token) return res.redirect('/login');

  try {
    const contractor = await getContractorByLoginToken(token);
    if (!contractor) {
      return res.status(400).send(`
        <html><body style="font-family:sans-serif;max-width:500px;margin:80px auto;text-align:center;">
          <h2>Link Expired</h2>
          <p>This login link has expired or already been used.</p>
          <p><a href="/login">Log in here</a></p>
        </body></html>
      `);
    }

    // Clear the token (single-use)
    await clearLoginToken(contractor.id);

    // Establish session
    req.session.contractorId = contractor.id;
    req.session.contractorSlug = contractor.unique_slug;

    // Redirect to dashboard
    res.redirect('/contractor');
  } catch (err) {
    console.error('[founding/set-password] error:', err.message);
    res.redirect('/login');
  }
}

// ── Spots cache (30s TTL) ────────────────────────────────────────────────
const FOUNDING_LAUNCH_DATE = '2026-05-22T00:00:00Z'; // when the founding offer opened
const OFFER_EXPIRES_AT = '2026-05-29T23:59:59Z';     // hard deadline

let spotsCache = null; // { claimed, ts }

async function getCachedSpots() {
  const now = Date.now();
  if (spotsCache && (now - spotsCache.ts) < 30_000) {
    return spotsCache.claimed;
  }
  const count = await getFoundingCount();
  spotsCache = { claimed: count, ts: now };
  return count;
}

/**
 * GET /api/founding/spots
 * Legacy — kept for backwards compat with founding.ejs
 */
router.get('/spots', async (req, res) => {
  try {
    const claimed = await getCachedSpots();
    res.json({ spots_remaining: Math.max(0, FOUNDING_LIMIT - claimed), total: FOUNDING_LIMIT });
  } catch (err) {
    console.error('[founding/spots] error:', err.message);
    res.json({ spots_remaining: FOUNDING_LIMIT, total: FOUNDING_LIMIT });
  }
});

/**
 * GET /api/founding/spots_remaining
 * Returns full scarcity payload used by /founding page polling.
 * claimed = count of contractors where founding_member = true.
 * Cache: 30s TTL.
 */
router.get('/spots_remaining', async (req, res) => {
  try {
    const claimed = await getCachedSpots();
    const remaining = Math.max(0, FOUNDING_LIMIT - claimed);
    res.json({
      total: FOUNDING_LIMIT,
      claimed,
      remaining,
      expires_at: OFFER_EXPIRES_AT
    });
  } catch (err) {
    console.error('[founding/spots_remaining] error:', err.message);
    // Fail-open: serve optimistic defaults rather than breaking the page
    res.json({ total: FOUNDING_LIMIT, claimed: 0, remaining: FOUNDING_LIMIT, expires_at: OFFER_EXPIRES_AT });
  }
});

module.exports = { router, handleWelcomePage, handleSetPassword };
