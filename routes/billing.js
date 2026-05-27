/**
 * Owns: subscription checkout + verification + Polsia webhook reception.
 * Does NOT own: founding-member checkout (that's routes/founding.js — a separate
 * one-time payment flow), zip cap enforcement (routes/territory.js).
 *
 * Three endpoints:
 *  - GET  /api/billing/checkout?tier=base&interval=month
 *      Requires auth. Calls Polsia to create a Stripe subscription checkout
 *      session, then 303-redirects the browser to the Stripe URL.
 *
 *  - GET  /billing/welcome?session_id=...     (mounted in server.js as page route)
 *      Stripe redirects here on success. We verify the session via Polsia,
 *      update contractor.plan + stripe IDs, then send the contractor to /contractor.
 *
 *  - POST /api/billing/webhook
 *      Polsia POSTs subscription events here (renewed, upgraded, downgraded,
 *      canceled). Auth via shared bearer secret in BILLING_WEBHOOK_SECRET.
 *      See docs/polsia-billing-integration.md for the exact contract.
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../lib/require-auth');
const {
  getContractorById,
  setContractorPlan,
  getContractorByStripeSubscriptionId,
} = require('../db/contractors');

const APP_URL = process.env.APP_URL || 'https://scopilot.polsia.app';
const POLSIA_API_URL = process.env.POLSIA_API_URL || 'https://polsia.com';
const POLSIA_API_KEY = process.env.POLSIA_API_KEY || '';
const WEBHOOK_SECRET = process.env.BILLING_WEBHOOK_SECRET || '';

/**
 * Public pricing — mirrors the /pricing page. Single source of truth on the
 * server. If you change tier prices, update this table and the pricing.html
 * card data attributes together.
 *
 * `monthly` and `annual` are full USD amounts (not cents). Polsia accepts
 * dollars in `amount` and converts to Stripe's cents internally.
 */
const PLAN_PRICES = {
  base:   { name: 'Scopilot — Base (3 ZIPs)',     monthly: 249, annual: 2490, zip_count: 3 },
  plus_1: { name: 'Scopilot — +1 ZIP (4 ZIPs)',   monthly: 349, annual: 3490, zip_count: 4 },
  plus_2: { name: 'Scopilot — +2 ZIPs (5 ZIPs)',  monthly: 449, annual: 4490, zip_count: 5 },
  plus_3: { name: 'Scopilot — +3 ZIPs (6 ZIPs)',  monthly: 599, annual: 5990, zip_count: 6 },
};

const VALID_INTERVALS = new Set(['month', 'year']);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/billing/checkout?tier=base&interval=month
//
// Creates a subscription checkout session via Polsia, then redirects the
// browser to the returned Stripe URL. After payment Stripe redirects to
// /billing/welcome?session_id=... where we verify + persist the plan.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/checkout', requireAuth, async (req, res) => {
  const tier = String(req.query.tier || '').toLowerCase();
  const intervalParam = String(req.query.interval || 'month').toLowerCase();
  const interval = intervalParam === 'annual' || intervalParam === 'year' ? 'year' : 'month';

  if (!PLAN_PRICES[tier]) {
    return res.redirect('/pricing?error=invalid_tier');
  }
  if (!VALID_INTERVALS.has(interval)) {
    return res.redirect('/pricing?error=invalid_interval');
  }
  if (!POLSIA_API_KEY) {
    console.error('[billing/checkout] POLSIA_API_KEY not configured');
    return res.redirect('/pricing?error=billing_unavailable');
  }

  const contractorId = req.session.contractorId;
  const contractor = await getContractorById(contractorId);
  if (!contractor) return res.redirect('/login');

  const price = PLAN_PRICES[tier];
  const amount = interval === 'year' ? price.annual : price.monthly;

  // success_url uses the Stripe placeholder {CHECKOUT_SESSION_ID} which Stripe
  // (or Polsia, on Stripe's behalf) substitutes with the real session id when
  // it redirects the browser back.
  const successUrl = `${APP_URL}/billing/welcome?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl  = `${APP_URL}/pricing?canceled=1`;

  try {
    const sessionResp = await fetch(
      `${POLSIA_API_URL}/api/company-payments/create-checkout-session`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${POLSIA_API_KEY}`,
        },
        body: JSON.stringify({
          // Subscription-specific fields. Polsia needs to translate these into
          // Stripe Checkout params with mode=subscription and a Price created
          // on the fly from amount + interval.
          mode: 'subscription',
          name: price.name,
          amount,
          interval,                         // 'month' | 'year'
          customer_email: contractor.email, // pre-fill on Stripe so they don't retype
          success_url: successUrl,
          cancel_url: cancelUrl,
          // Metadata travels with the Stripe session and the resulting
          // subscription so the webhook can look us up reliably.
          metadata: {
            scopilot_contractor_id: String(contractor.id),
            scopilot_plan: tier,
            scopilot_interval: interval,
          },
        }),
      }
    );

    if (!sessionResp.ok) {
      const errText = await sessionResp.text();
      console.error('[billing/checkout] Polsia error:', sessionResp.status, errText);
      return res.redirect('/pricing?error=checkout_failed');
    }
    const { url } = await sessionResp.json();
    if (!url) {
      console.error('[billing/checkout] Polsia returned no url');
      return res.redirect('/pricing?error=checkout_failed');
    }
    return res.redirect(303, url);
  } catch (err) {
    console.error('[billing/checkout] error:', err.message);
    return res.redirect('/pricing?error=checkout_failed');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /billing/welcome?session_id=...  (mounted as PAGE route in server.js)
//
// Stripe redirects here after a successful checkout. We verify the session
// with Polsia, then set the contractor's plan + Stripe linkage.
// ─────────────────────────────────────────────────────────────────────────────
async function handleBillingWelcome(req, res) {
  const sessionId = req.query.session_id;
  if (!sessionId) return res.redirect('/pricing');

  try {
    const verifyResp = await fetch(
      `${POLSIA_API_URL}/api/company-payments/verify?session_id=${encodeURIComponent(sessionId)}`,
      { headers: { Authorization: `Bearer ${POLSIA_API_KEY}` } }
    );
    if (!verifyResp.ok) {
      console.error('[billing/welcome] verify error:', verifyResp.status);
      return res.redirect('/pricing?error=verify_failed');
    }
    const { verified, payment } = await verifyResp.json();
    if (!verified || !payment) {
      return res.redirect('/pricing?error=payment_not_verified');
    }

    // Read metadata that we set in /checkout above. Polsia should round-trip it.
    const md = payment.metadata || {};
    const contractorId = parseInt(md.scopilot_contractor_id, 10);
    const plan = md.scopilot_plan;

    if (!contractorId || !PLAN_PRICES[plan]) {
      console.error('[billing/welcome] missing/invalid metadata:', md);
      return res.redirect('/pricing?error=metadata_missing');
    }

    await setContractorPlan(contractorId, {
      plan,
      stripeCustomerId: payment.customer_id || null,
      stripeSubscriptionId: payment.subscription_id || null,
      planPeriodEnd: payment.current_period_end
        ? new Date(payment.current_period_end * 1000) // Stripe sends unix seconds
        : null,
    });

    // If the user happens to not be logged in (e.g. they paid from an incognito
    // window after coming from the pricing page), we still record the upgrade
    // — but send them to /login. Otherwise straight to the dashboard.
    if (req.session && req.session.contractorId === contractorId) {
      return res.redirect(303, '/contractor?upgraded=1');
    }
    return res.redirect(303, '/login?upgraded=1');
  } catch (err) {
    console.error('[billing/welcome] error:', err.message);
    return res.redirect('/pricing?error=welcome_failed');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/billing/webhook
//
// Polsia forwards Stripe subscription events here. The payload is
// pre-normalized by Polsia — we don't have to interpret raw Stripe events.
// Auth is a shared bearer secret in env var BILLING_WEBHOOK_SECRET.
//
// Expected event shape — see docs/polsia-billing-integration.md for the full
// contract. Briefly:
//   {
//     "event_type": "subscription.created" | "subscription.updated" | "subscription.canceled",
//     "scopilot_contractor_id": "42",          // from checkout metadata
//     "scopilot_plan": "base",                 // tier code if active, omit/null on cancel
//     "stripe_customer_id": "cus_...",
//     "stripe_subscription_id": "sub_...",
//     "subscription_status": "active" | "canceled" | "past_due" | "trialing",
//     "current_period_end": 1234567890         // unix seconds, optional
//   }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/webhook', async (req, res) => {
  // Auth: shared bearer token. If you're rotating this secret, set the new
  // value on both ends (BILLING_WEBHOOK_SECRET here, Polsia config on theirs).
  if (!WEBHOOK_SECRET) {
    console.error('[billing/webhook] BILLING_WEBHOOK_SECRET not configured — refusing all events');
    return res.status(503).json({ error: 'webhook_not_configured' });
  }
  const authHeader = req.headers.authorization || '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!provided || provided !== WEBHOOK_SECRET) {
    console.error('[billing/webhook] bad bearer token');
    return res.status(401).json({ error: 'unauthorized' });
  }

  const event = req.body || {};
  const eventType = event.event_type;
  const contractorIdRaw = event.scopilot_contractor_id;
  const subId = event.stripe_subscription_id;

  // Resolve the contractor. Prefer the explicit id from metadata; fall back to
  // subscription-id lookup (covers the case where Polsia forwards an event for
  // a subscription that exists in our DB but didn't carry metadata).
  let contractorId = parseInt(contractorIdRaw, 10);
  if (!contractorId && subId) {
    const found = await getContractorByStripeSubscriptionId(subId);
    if (found) contractorId = found.id;
  }
  if (!contractorId) {
    console.error('[billing/webhook] could not resolve contractor for event:', JSON.stringify(event));
    return res.status(404).json({ error: 'contractor_not_found' });
  }

  // Decide what plan the contractor should be on after this event.
  let newPlan;
  switch (eventType) {
    case 'subscription.created':
    case 'subscription.updated': {
      // Status active/trialing → use the tier from metadata.
      // Past_due → keep current plan (don't kick them off mid-grace).
      // Canceled → drop to 'free'.
      const status = event.subscription_status;
      if (status === 'canceled') {
        newPlan = 'free';
      } else if (status === 'past_due') {
        newPlan = null; // signal "don't change plan"
      } else {
        newPlan = event.scopilot_plan;
        if (!PLAN_PRICES[newPlan]) {
          console.error('[billing/webhook] unknown plan in metadata:', newPlan);
          return res.status(400).json({ error: 'unknown_plan' });
        }
      }
      break;
    }
    case 'subscription.canceled':
    case 'subscription.deleted': {
      newPlan = 'free';
      break;
    }
    default:
      // We don't act on other event types but acknowledge receipt so Polsia
      // doesn't retry. Add cases here if we start caring about more events.
      console.log('[billing/webhook] ignoring event_type:', eventType);
      return res.json({ received: true, ignored: true });
  }

  if (newPlan === null) {
    // past_due — leave plan unchanged, just update period_end if provided
    await setContractorPlan(contractorId, {
      plan: undefined, // not used, see UPDATE statement
      stripeCustomerId: event.stripe_customer_id,
      stripeSubscriptionId: subId,
      planPeriodEnd: event.current_period_end ? new Date(event.current_period_end * 1000) : null,
    });
    return res.json({ received: true, plan_changed: false });
  }

  await setContractorPlan(contractorId, {
    plan: newPlan,
    stripeCustomerId: event.stripe_customer_id,
    stripeSubscriptionId: subId,
    planPeriodEnd: event.current_period_end ? new Date(event.current_period_end * 1000) : null,
  });

  console.log(`[billing/webhook] contractor ${contractorId} → plan=${newPlan} (${eventType})`);
  res.json({ received: true, plan_changed: true, new_plan: newPlan });
});

module.exports = router;
module.exports.handleBillingWelcome = handleBillingWelcome;
module.exports.PLAN_PRICES = PLAN_PRICES;
