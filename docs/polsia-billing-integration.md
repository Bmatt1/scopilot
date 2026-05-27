# Polsia ↔ Scopilot Subscription Billing Integration

This document specifies the **contract between Scopilot and Polsia's payment proxy** for Scopilot's contractor subscriptions (Base / +1 ZIP / +2 ZIPs / +3 ZIPs). It is written for someone implementing the Polsia side — every section says exactly what Polsia must accept and emit.

If anything in this contract conflicts with what's currently implemented in Polsia's payment proxy, Polsia is the source of truth — flag the discrepancy and we'll update Scopilot's [`routes/billing.js`](../routes/billing.js) to match.

---

## Background

Scopilot's `/pricing` page sells four monthly subscription tiers (and an annual variant of each). Founding members (one-time $1,500) and operator-gifted "legacy" accounts already use Polsia's payment proxy in **one-time payment mode**. This document covers the new **subscription mode** flow for the four tiers.

| Tier | Internal code | Monthly | Annual | Zip cap |
|------|---------------|---------|--------|---------|
| Base | `base` | $249 | $2,490 | 3 |
| +1 ZIP | `plus_1` | $349 | $3,490 | 4 |
| +2 ZIPs | `plus_2` | $449 | $4,490 | 5 |
| +3 ZIPs | `plus_3` | $599 | $5,990 | 6 |

Annual amounts equal ten monthly payments (i.e. two months free). The full list lives in `PLAN_PRICES` in [`routes/billing.js`](../routes/billing.js) — this is the only place to change if pricing changes.

---

## Three things Polsia needs to implement

### 1. Accept `mode: "subscription"` on `create-checkout-session`

**Endpoint:** `POST {POLSIA_API_URL}/api/company-payments/create-checkout-session`

**Request body Scopilot will send:**

```json
{
  "mode": "subscription",
  "name": "Scopilot — Base (3 ZIPs)",
  "amount": 249,
  "interval": "month",
  "customer_email": "jane@hendersonconcrete.com",
  "success_url": "https://scopilot.polsia.app/billing/welcome?session_id={CHECKOUT_SESSION_ID}",
  "cancel_url": "https://scopilot.polsia.app/pricing?canceled=1",
  "metadata": {
    "scopilot_contractor_id": "42",
    "scopilot_plan": "base",
    "scopilot_interval": "month"
  }
}
```

**Field notes:**

| Field | Type | Meaning |
|-------|------|---------|
| `mode` | string | Always `"subscription"` for this flow. Polsia should also keep accepting the existing one-time mode (used by founding). |
| `amount` | integer | USD dollars (not cents). Polsia is responsible for converting to Stripe's smallest unit. |
| `interval` | string | `"month"` or `"year"`. Polsia creates a Stripe Price on the fly with this recurring interval. |
| `customer_email` | string | Pre-fills Stripe Checkout so the contractor doesn't retype. |
| `success_url` | string | Must support the literal `{CHECKOUT_SESSION_ID}` placeholder. Stripe substitutes it. |
| `metadata` | object | **Critical.** Round-trip this on the resulting Stripe Subscription and forward it on every webhook event (see section 3). Scopilot uses `scopilot_contractor_id` and `scopilot_plan` to identify who upgraded to what. |

**Response:**

```json
{ "url": "https://checkout.stripe.com/c/pay/cs_test_..." }
```

Same shape as the existing one-time response. Scopilot redirects the browser to this URL.

### 2. Return subscription details from `verify`

**Endpoint:** `GET {POLSIA_API_URL}/api/company-payments/verify?session_id=...`

This endpoint already exists for one-time payments. For subscription sessions Polsia must return additional fields:

```json
{
  "verified": true,
  "payment": {
    "id": "cs_test_...",
    "customer_id": "cus_...",
    "customer_email": "jane@hendersonconcrete.com",
    "subscription_id": "sub_...",
    "subscription_status": "active",
    "current_period_end": 1730000000,
    "metadata": {
      "scopilot_contractor_id": "42",
      "scopilot_plan": "base",
      "scopilot_interval": "month"
    }
  }
}
```

**Required additions vs. the one-time response:**

- `subscription_id` — Stripe subscription id (`sub_...`).
- `subscription_status` — current status. Scopilot only cares about `active`, `trialing`, `past_due`, `canceled`.
- `current_period_end` — unix seconds (Stripe's native format) when the current billing cycle ends.
- `metadata` — pass through whatever Polsia sent on the matching Stripe Subscription object.

Scopilot's [`handleBillingWelcome`](../routes/billing.js) reads these fields, finds the contractor by `metadata.scopilot_contractor_id`, and sets their plan.

### 3. Forward subscription events to Scopilot's webhook

**Endpoint Polsia POSTs to:** `POST https://scopilot.polsia.app/api/billing/webhook`

**Auth:** Bearer token. Scopilot and Polsia share a secret out-of-band. Polsia sets this header on every request:

```
Authorization: Bearer <BILLING_WEBHOOK_SECRET>
```

The value lives in Scopilot's `BILLING_WEBHOOK_SECRET` env var. If the header is missing or the value doesn't match, Scopilot returns `401`.

**When Polsia should send a webhook:** any time a Scopilot-related Stripe subscription changes state. Specifically, on:

- `customer.subscription.created` — new subscription started.
- `customer.subscription.updated` — plan changed (upgrade / downgrade), status changed, or renewal happened.
- `customer.subscription.deleted` — subscription canceled.

Polsia identifies "Scopilot-related" subscriptions by checking that `metadata.scopilot_contractor_id` is present on the Stripe Subscription. Subscriptions without that metadata key are for other Polsia products and Polsia should not forward them to this endpoint.

**Request body Scopilot expects (normalized — Polsia translates raw Stripe events into this shape):**

```json
{
  "event_type": "subscription.created",
  "scopilot_contractor_id": "42",
  "scopilot_plan": "base",
  "stripe_customer_id": "cus_...",
  "stripe_subscription_id": "sub_...",
  "subscription_status": "active",
  "current_period_end": 1730000000
}
```

**Field notes:**

| Field | Type | When required |
|-------|------|---------------|
| `event_type` | string | One of `subscription.created`, `subscription.updated`, `subscription.canceled`, `subscription.deleted`. Last two are treated identically — both drop the contractor to the `free` plan. |
| `scopilot_contractor_id` | string | Always send if `metadata.scopilot_contractor_id` is on the Stripe Subscription. If absent, Scopilot falls back to looking up by `stripe_subscription_id`. |
| `scopilot_plan` | string | The tier code (`base`, `plus_1`, `plus_2`, `plus_3`). For `subscription.created` and `subscription.updated` events, this should reflect the **new** plan after the change. For cancellation events it can be omitted. |
| `subscription_status` | string | Stripe's status string. Scopilot acts on `active`, `trialing`, `canceled`, `past_due`. |
| `current_period_end` | number | Unix seconds, optional. Stamped to `contractors.plan_period_end` for admin visibility. |

**How Scopilot reacts:**

| Event | `subscription_status` | What happens to `contractors.plan` |
|-------|----------------------|-------------------------------------|
| `subscription.created` / `updated` | `active` / `trialing` | Set to `scopilot_plan` |
| `subscription.created` / `updated` | `past_due` | **Unchanged** (grace period — contractor keeps access while they fix payment) |
| `subscription.created` / `updated` | `canceled` | Set to `free` |
| `subscription.canceled` / `deleted` | any | Set to `free` |
| any other `event_type` | any | Logged, `200 { received: true, ignored: true }`. No state change. |

**Response Scopilot returns:**

```json
{ "received": true, "plan_changed": true, "new_plan": "base" }
```

On success, status `200`. On auth failure, `401`. On a contractor that can't be resolved, `404`.

**Retry behavior:** If Scopilot returns non-2xx, Polsia should retry with exponential backoff (recommended: 5 attempts over ~30 minutes). The endpoint is idempotent — replaying the same event is safe.

---

## Out of scope for this contract

- **Customer portal links.** Scopilot does not yet provide a "manage your subscription" link inside the dashboard. When this is added, it will request a portal session URL from Polsia separately. Not in scope here.
- **Refunds, disputes, invoice events.** Polsia does not need to forward these. Scopilot operators handle them via the Polsia dashboard directly.
- **The founding-member flow.** That's a separate one-time payment (`mode` is not `"subscription"`) and uses [`routes/founding.js`](../routes/founding.js). Polsia's existing implementation for it stays unchanged.
- **Per-zip pricing.** The old "$79/mo per extra zip" charge is gone. Every zip in a contractor's tier is included in their subscription. Polsia does not need to create per-zip subscriptions.

---

## Operator checklist for going live

Once Polsia has implemented the above:

1. **Set the shared secret.** Generate a long random string. Set it as `BILLING_WEBHOOK_SECRET` on Scopilot's Render service (Settings → Environment) and on the Polsia side wherever the webhook destination is configured.
2. **Smoke-test checkout end to end.** From a logged-in test contractor, click "Get started" on the Base tier → complete Stripe checkout in test mode → verify the contractor's `plan` column flips to `'base'` and `stripe_subscription_id` is populated.
3. **Smoke-test webhook handling.** Trigger a Stripe test event (`customer.subscription.updated` with `metadata.scopilot_plan: "plus_1"`) and verify Scopilot's `contractors.plan` updates to `plus_1`. Scopilot logs `[billing/webhook] contractor 42 → plan=plus_1 (subscription.updated)` on success.
4. **Test the cap enforcement.** Create a free-tier contractor; confirm they cannot claim any zip until they upgrade. Upgrade them to Base; confirm they can claim up to 3.
5. **Test the cancellation flow.** Cancel a subscription in Stripe → confirm the webhook fires → confirm the contractor drops to `plan='free'` and can no longer add new zips (existing zips stay, see follow-up below).

---

## Open follow-ups (not blocking the v1 contract above)

- **Cancellation should release zips.** Today, dropping to `plan='free'` after cancellation does NOT automatically release the contractor's existing zip claims. Their `currentCount` will exceed their `cap` (0 for free) and they simply can't add more. We probably want a grace period (keep existing zips active until `plan_period_end`), then auto-release. Not blocking v1.
- **Mid-cycle prorated upgrades.** Stripe handles proration on its side. Scopilot just updates the plan when the webhook arrives. No work needed here.
- **Customer portal.** Add a "Manage subscription" link in the contractor dashboard that hits a Polsia endpoint returning a Stripe customer-portal URL. Requires a new Polsia endpoint and is a separate piece of work.
