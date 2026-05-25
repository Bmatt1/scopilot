# Scopilot Access & Testing Guide

> A non-engineer should be able to follow this guide and exercise every major user flow in under 15 minutes.

---

## Environments

| Item | Value |
|------|-------|
| **Production URL** | https://scopilot.polsia.app |
| **Render logs** | https://dashboard.render.com → Services → scopilot → Logs |
| **Email sender** | Sent via Polsia email proxy (`POLSIA_EMAIL_PROXY_URL`). "From" address is configured by the proxy. |
| **Database** | Neon PostgreSQL — `DATABASE_URL` env var on Render |

---

## Admin Panel

### URL & Auth

```
https://scopilot.polsia.app/admin?key=<ADMIN_PASSWORD>
```

Authentication uses the `ADMIN_PASSWORD` environment variable (default: `scopilot-admin-2026` for dev).

Two supported auth methods:
- **Query param:** `?key=<ADMIN_PASSWORD>` — simplest for browser access
- **Basic Auth:** `Authorization: Basic <base64(:<password>)>` — for curl / API testing

The admin panel is excluded from search engines (`robots.txt` disallows `/admin`).

### Admin Panel Sections

| Section | Path | What it shows |
|---------|------|---------------|
| **Home stats** | `/admin` | Platform KPIs: total leads, contractors, territory claims, weekly lead volume |
| **Leads** | `/admin/leads` | All submitted leads — expandable rows with photos, Q&A detail, satellite map, status badge |
| **Contractors** | `/admin/contractors` | All contractor accounts — suspend/activate toggle, lead count, territory count |
| **Territory map** | `/admin/territory` | Mapbox map with claimed ZIP markers color-coded by contractor |
| **Analytics** | `/admin/analytics` | Lead status breakdown, contractor stats |
| **Metrics** | `/admin/metrics` | Page views, top pages, referrers, lead submission counts |
| **Funnel** | `/admin/funnel` | Conversion funnels: founding page, homeowner scope, contractor signup |
| **Help** | `/admin/help` | This guide rendered in-product |

> **Tip:** Append `?key=<ADMIN_PASSWORD>` to every admin URL — it persists the session for that tab.

---

## Founding Member Checkout

### Checkout URL

The self-serve checkout URL to paste in outreach emails:

```
https://scopilot.polsia.app/founding
```

Button on that page redirects to a Stripe Checkout session at `POST /api/founding/checkout`.

### How the Flow Works

1. Homeowner (or contractor) clicks **"Claim My Founding Spot"** on `/founding`
2. Browser POSTs to `/api/founding/checkout` → backend calls Polsia payment proxy → returns a Stripe Checkout URL
3. Customer pays $1,500 on Stripe's hosted checkout
4. Stripe redirects to `/founding/welcome?session_id=<stripe_session_id>`
5. Backend verifies the session via `GET ${POLSIA_API_URL}/api/company-payments/verify?session_id=<id>`
6. On verification success: `provisionFoundingContractor()` runs — upserts the contractor row with `founding_member=true`, `plan='lifetime'`, and a one-time magic login token (7-day TTL)
7. Welcome email fires with the magic login link and scoping link
8. Customer clicks magic link → `/founding/set-password?token=<token>` → auto-logged in → dashboard

**Note:** No Stripe webhook is required. Payment is verified on the redirect back. This is the Polsia-standard verification pattern. If a customer closes the tab before the welcome page loads, they still have a valid session_id — they can re-visit `/founding/welcome?session_id=<their_session_id>` from their Stripe receipt to trigger provisioning.

### Admin Reconciliation

If a payment comes through but no contractor account was created (edge case: session_id missing, tab closed, server error):

1. Go to `/admin/contractors` — filter by email if you know it
2. If account is missing, run the SQL below to provision manually:

```sql
INSERT INTO contractors (business_name, owner_name, email, password_hash, trade_type, unique_slug, founding_member, plan, founding_purchased_at)
VALUES ('<Business Name>', '<Owner Name>', '<email>', '', 'general', '<slug>', true, 'lifetime', NOW())
ON CONFLICT (email) DO UPDATE SET founding_member = true, plan = 'lifetime', founding_purchased_at = NOW();
```

3. Reset their password via the dashboard or issue a magic link via:

```sql
UPDATE contractors SET login_token = gen_random_uuid()::text, login_token_expires_at = NOW() + INTERVAL '7 days' WHERE email = '<email>';
-- Then send: https://scopilot.polsia.app/founding/set-password?token=<login_token>
```

### Founding Spots Counter

The admin dashboard (`/admin`) shows a gold **"Founding Spots Remaining"** stat card.

Counter logic: `50 - COUNT(founding_config WHERE key='founding_count')` — incremented on each successful welcome page provision.

---

## Contractor Dashboard

### Signup & Login

1. **Sign up:** `https://scopilot.polsia.app/signup`
   - Required: Business name, owner name, email, password (min 8 chars), trade type
   - Optional: phone, service area description

2. **Login:** `https://scopilot.polsia.app/login`
   - Email + password
   - Session cookie persists across tabs
   - Click **"Forgot password? Email me a login link instead"** for passwordless login

3. **Magic-link login (passwordless):** `https://scopilot.polsia.app/login/magic`
   - Enter email → receive a one-time login link by email
   - Link expires in **15 minutes**, single-use only
   - Rate limit: max 3 requests per email per hour
   - On success: `GET /auth/magic?token=<token>` → session created → redirect to dashboard
   - On failure (expired/used): redirect to `/login?error=link_invalid_or_expired`

4. **Dashboard:** `https://scopilot.polsia.app/contractor`

### Magic-Link Token Details

| Property | Value |
|----------|-------|
| Token lifetime | 15 minutes |
| Single-use | Yes — marked `used_at=NOW()` on first use |
| Rate limit | 3 requests per email per 1-hour window |
| Table | `contractor_magic_links` |
| Failure redirect | `/login?error=link_invalid_or_expired` |

> **Mattingly Concrete access:** Their welcome email contains a `/founding/set-password?token=` link (legacy 30-day token). They can also use the new `/login/magic` flow at any time.

### Dashboard Sections

| Section | What it shows |
|---------|---------------|
| **Active Leads** | Leads routed to this contractor — expandable detail, map, contact info |
| **Territory Claims** | Claimed ZIP codes, status badges (green=active / amber=at_risk / red=suspended), claim/release controls |
| **Your Performance** | Rolling 10-lead response time vs 48h goal; average homeowner rating vs 4.0 goal |
| **Founding-member CTA** | Shown only to authenticated non-founding contractors |

### Opportunities Board

`https://scopilot.polsia.app/contractor/opportunities`

- Leads passed by other contractors appear here
- Filter by trade type or "nearby" (ZIPs within ±5 of contractor's claimed ZIPs)
- Contact info is blurred until claimed
- Claim button is atomic / race-safe

---

## Test Credentials

> ⚠️ **Test-only.** Do not use these accounts in production marketing, demos, or customer-facing contexts.

| Account | Email | Password | Notes |
|---------|-------|----------|-------|
| **Test Contractor 1** (Founding) | `test-contractor-1@scopilot.test` | `TestPass123!` | Founding member (is_founding_member=true), trade: concrete |
| **Test Contractor 2** (Standard) | `test-contractor-2@scopilot.test` | `TestPass456!` | Standard account, trade: excavation |

To seed these accounts fresh: `npm run seed:test-contractors`

Admin access (default dev password): `https://scopilot.polsia.app/admin?key=scopilot-admin-2026`

---

## Homeowner Flow (Scope Submission)

### End-to-End Walkthrough

1. Go to `https://scopilot.polsia.app/scope.html`
2. **Enter address** — use autocomplete:
   - **Urban (routed lead):** `123 Main St, Denver, CO 80202` — a ZIP that's been claimed by a contractor will trigger routing to that contractor
   - **Rural (unrouted lead):** `Rural Route 1, Glenwood Springs, CO 81601` — no claimed ZIP → lead goes to the opportunity board
3. **Draw the project area** — click to place polygon points on the satellite map
4. **Answer guided questions** — select project type, scope details
5. **Upload photos** — optional but improves lead quality
6. **Submit** — generates an estimate and routes the lead

### Routed vs. Unrouted Logic

- **Routed:** Lead's ZIP matches an `active` territory claim → `routed_to_contractor_id` is set, contractor receives email immediately
- **Unrouted:** No claim for that ZIP → `routed_to_contractor_id` is NULL → lead is visible on the Opportunity Board to nearby contractors

---

## Territory + SLA Testing

### Claim a ZIP

1. Log in as a test contractor
2. Go to `/contractor` → Territory card
3. Enter a 5-digit ZIP and click "Check Availability"
4. Click "Claim" — first ZIP is free; additional ZIPs are $79/mo via Stripe

### Force a 48h SLA Breach (for testing)

Run this SQL to push `first_response_at` back 50 hours on a specific lead:

```sql
-- Replace <lead_id> with the actual lead ID
UPDATE leads
SET first_response_at = NOW() - INTERVAL '50 hours'
WHERE id = <lead_id>;
```

Or to force breach on ALL active leads for a contractor:

```sql
UPDATE leads
SET first_response_at = NOW() - INTERVAL '50 hours'
WHERE routed_to_contractor_id = <contractor_id>
  AND first_response_at IS NOT NULL;
```

### Run the SLA Check Job Manually

```bash
node jobs/sla-check.js
```

This job (normally runs at 2 AM UTC via `polsia.toml`):
- Evaluates rolling 10-lead response time and homeowner rating for each contractor
- Transitions territory status: `active` → `at_risk` → `suspended` → `released`
- Sends contractor alert emails at each transition

### Run the Rating Email Job Manually

```bash
node jobs/rating-email.js
```

This job (normally runs at 9 AM UTC):
- Finds leads 7+ days old where no rating email has been sent
- Sends a one-click star-rating link to the homeowner

---

## Opportunity Board Testing

### Pass a Lead

1. Log in as **Test Contractor 1** and view an active routed lead
2. Open lead detail panel → click **"Pass"**
3. Enter an optional pass reason in the modal
4. Lead transitions to `passed` status; neighboring contractors receive email notification
5. Lead becomes visible on the Opportunity Board for other contractors

### Claim from the Board

1. Log in as **Test Contractor 2** → go to `/contractor/opportunities`
2. Find the passed lead (use the "All" filter if ZIP is outside contractor's territory)
3. Click **"Claim"** — contact info is revealed immediately
4. Lead status transitions to `claimed_from_board`

### What Email Neighbors Receive

Neighboring contractors (ZIPs within ±5) receive an email with:
- Project summary (type, square footage, address area)
- Satellite map thumbnail
- Link to claim from the board

---

## Rating System

### Trigger the Rating Email Manually

```bash
node jobs/rating-email.js
```

This sends a rating request email for any lead 7+ days old that hasn't been rated.

### Submit a Star Rating via Token URL

The rating email contains links like:

```
https://scopilot.polsia.app/rate/<token>?r=5
```

Where `r=` is the star rating (1–5). Visiting this URL in a browser submits the rating.

To test without a real email, grab the token directly from the database:

```sql
SELECT id, rating_token FROM leads WHERE homeowner_rating IS NULL LIMIT 5;
```

Then visit: `https://scopilot.polsia.app/rate/<token>?r=4`

---

## Common SQL Snippets

Use these in `psql` (with `DATABASE_URL`) or the Neon console:

```sql
-- List all contractors
SELECT id, business_name, email, trade_type, created_at FROM contractors ORDER BY created_at DESC;

-- List all active territory claims
SELECT tc.zip_code, tc.status, c.business_name, c.email, tc.created_at
FROM territory_claims tc
JOIN contractors c ON c.id = tc.contractor_id
WHERE tc.status = 'active'
ORDER BY tc.created_at DESC;

-- List leads by status
SELECT id, address, project_type, lead_status, zip_code, created_at
FROM leads
ORDER BY created_at DESC
LIMIT 50;

-- List leads routed to a specific contractor
SELECT id, address, project_type, lead_status, created_at
FROM leads
WHERE routed_to_contractor_id = <contractor_id>
ORDER BY created_at DESC;

-- Reset a contractor's territory (release all claims)
UPDATE territory_claims
SET status = 'released'
WHERE contractor_id = <contractor_id>
  AND status IN ('active', 'at_risk', 'suspended');

-- Check SLA stats for all contractors
SELECT contractor_id, avg_response_hours, avg_rating, updated_at
FROM (
  SELECT
    routed_to_contractor_id AS contractor_id,
    ROUND(AVG(EXTRACT(EPOCH FROM (first_response_at - created_at)) / 3600)::numeric, 1) AS avg_response_hours,
    ROUND(AVG(homeowner_rating)::numeric, 2) AS avg_rating,
    NOW() AS updated_at
  FROM leads
  WHERE first_response_at IS NOT NULL
    AND routed_to_contractor_id IS NOT NULL
  GROUP BY routed_to_contractor_id
) stats
ORDER BY avg_response_hours;

-- List all leads with pending rating emails (for manual trigger testing)
SELECT id, address, created_at, rating_token, rating_email_sent_at
FROM leads
WHERE rating_email_sent_at IS NULL
  AND created_at < NOW() - INTERVAL '7 days'
LIMIT 20;
```

---

## Environment Variables Reference

| Variable | Purpose | Default |
|----------|---------|---------|
| `DATABASE_URL` | Neon PostgreSQL connection string | — (required) |
| `ADMIN_PASSWORD` | Admin panel gate | `scopilot-admin-2026` |
| `SESSION_SECRET` | Session cookie signing | `scopilot-dev-secret-change-in-prod` |
| `MAPBOX_TOKEN` | Map tiles + address autocomplete | — |
| `POLSIA_API_URL` | Polsia API base (payment verify, etc.) | — |
| `POLSIA_API_KEY` | Polsia API auth key | — |
| `POLSIA_EMAIL_PROXY_URL` | Email proxy endpoint | — |
| `APP_URL` | Public app URL for email links | `https://scopilot.polsia.app` |
| `PORT` | HTTP port | `3000` |
