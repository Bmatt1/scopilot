# Scopilot

Contractor lead-generation for home improvement projects. Homeowners scope their own concrete, excavation, drainage, or other outdoor project in 5 minutes — entering an address, drawing the project area on a satellite map, answering a short set of questions, and uploading photos. Contractors receive qualified leads with full project details via email and a dashboard.

**Live app:** https://scopilot.polsia.app

---

## For developers & AI agents picking this up

Before changing anything, read **[CLAUDE.md](CLAUDE.md)** — it's the project handbook, kept current. The section called **"Recent changes"** at the bottom is a chronological log of what was last worked on and why. The most recent entries explain the current auth model and the mobile-responsiveness pass; reading them stops you from re-introducing workarounds that were deliberately removed (e.g. the localStorage session-ID fallback — there was a reason it was deleted, written up under "Auth model" in CLAUDE.md). The `docs/` folder has more detail: `docs/api.md` for endpoints, `docs/schema.md` for tables, `docs/flows.md` for user flows.

---

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL (Neon or local)

### 1. Clone
```
git clone https://github.com/Polsia-Inc/scopilot
cd scopilot
```

### 2. Configure environment
Create a `.env` file:
```bash
DATABASE_URL=REDACTED/scopilot
SESSION_SECRET=any-long-random-string-here
MAPBOX_TOKEN=pk.your_mapbox_public_token
POLSIA_EMAIL_PROXY_URL=https://polsia.app/api/email
POLSIA_API_KEY=your_api_key
CONTRACTOR_EMAIL=your@email.com
POLSIA_R2_BASE_URL=https://polsia.app/api/r2
POLSIA_R2_KEY=your_r2_key
APP_URL=https://scopilot.polsia.app
```

`SESSION_SECRET` is what the server uses to sign the login cookie. Pick something long and random (e.g. the output of `openssl rand -hex 32`). The server will refuse to start without it.

### 3. Install and run
```bash
npm install
npm run migrate   # creates tables
npm start         # starts server on port 3000
```

### 4. Open the app
- **Homeowner flow:** http://localhost:3000/scope.html
- **Contractor dashboard:** http://localhost:3000/contractor
- **API docs:** http://localhost:3000/api-docs

---

## Architecture

```
Browser (HTML + JS)
    │
    ├── /                     — landing page (EJS)
    ├── /scope.html?c=<slug>  — homeowner scoping wizard
    ├── /territory            — public ZIP availability checker
    ├── /pricing              — public pricing page
    ├── /example              — public example lead (sales tool)
    │
    ├── /login, /signup       — contractor auth pages
    ├── /contractor           — contractor dashboard (login-gated)
    ├── /contractor/opportunities — opportunity board (login-gated)
    │
    └── /api/auth             — login, signup, logout, magic-link, password reset
    └── /api/scope            — homeowner intake (submit, upload photo)
    └── /api/leads            — lead actions (list, detail, status update, pass)
    └── /api/contractors      — contractor's own leads + profile
    └── /api/opportunities    — opportunity board (passed/unclaimed leads)
    └── /api/territory        — ZIP claim, release, public availability check
    └── /api/founding         — founding-member checkout (Stripe via Polsia)
    └── /api/ratings          — homeowner star ratings
    └── /api/events           — client-side conversion event log
    └── /admin                — operator-only admin pages
    └── /api/admin            — admin metrics + logs

    └── /api-docs             — internal API reference docs
```

**Stack:** Node.js + Express, EJS templates, PostgreSQL (Neon), Render.

**No client-side framework** — vanilla JS with Mapbox GL JS for the map UI.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | Long random string used to sign login cookies. Server won't start without it. |
| `ADMIN_PASSWORD` | Yes | Gates the `/admin` panel. No hardcoded fallback — server refuses to start without it. Set with a long random value (`openssl rand -hex 24`). |
| `BILLING_WEBHOOK_SECRET` | Yes (prod) | Long random string shared with Polsia. Required for the subscription webhook receiver to accept events. Server refuses all webhook events if this is unset. See `docs/polsia-billing-integration.md`. |
| `PORT` | No | Server port (default: 3000) |
| `NODE_ENV` | No | Set to `production` in prod — enables secure cookies and trust-proxy |
| `MAPBOX_TOKEN` | Yes | Mapbox public token — map rendering and address autocomplete |
| `POLSIA_EMAIL_PROXY_URL` | Yes (prod) | Polsia email proxy endpoint |
| `POLSIA_API_KEY` | Yes (prod) | API key for email proxy + Stripe payment proxy |
| `POLSIA_API_URL` | Yes (prod) | Polsia payment proxy for Stripe founding-member checkout |
| `CONTRACTOR_EMAIL` | Yes | Email that receives new lead notifications |
| `POLSIA_R2_BASE_URL` | Yes (prod) | Polsia R2 proxy endpoint for photo storage |
| `POLSIA_R2_KEY` | No | R2 auth key |
| `APP_URL` | No | Used in email links (default: https://scopilot.polsia.app) |
| `POLSIA_ANALYTICS_SLUG` | No | Polsia analytics site slug for landing page |

---

## Directory Map

| Directory | What it contains |
|-----------|-------------------|
| `server.js` | Entry point. Middleware setup, route mounts, app.listen. |
| `routes/` | Express Routers — one file per endpoint group |
| `db/` | Named query functions — one file per entity |
| `migrations/` | JS migration files (timestamped) for all schema changes |
| `views/` | EJS templates for landing page and about page |
| `public/` | Static files: HTML pages, CSS, client JS, uploaded images |
| `services/` | Outbound integrations: email sending |
| `lib/` | Shared utilities: landing page context builder |
| `docs/` | Internal developer documentation |
| `migrate.js` | Standalone migration runner — runs on every deploy |

---

## Key Design Decisions

### Why Mapbox?
One SDK handles both the interactive map (draw polygons) and the satellite static image (email hero). One API key covers both use cases. Google Maps would require separate APIs and keys.

### Why GPS-first + polygon drawing?
Rural properties often not have a clean street address. Drawing the project area on a satellite map is faster and more accurate than asking the homeowner to measure. The polygon is overlaid on the satellite view in the contractor email — the contractor can see the exact work site before visiting.

### Why Turf.js client-side for area calculation?
Instant feedback as the user draws. No server round-trip. `turf.area()` returns square meters; converted to sq ft. The GeoJSON polygon is stored and overlaid in the email.

### Why JSONB for `trade_inputs`?
Each vertical (concrete, excavation, drainage...) has a different shape of Q&A data. A typed column would require a new column per vertical. JSONB means adding a new vertical requires only a config change in `questions-config.js` — no schema migration.

### Why server-side estimate recalculation?
The client-side estimate (shown in the scoping wizard) is a rough preview. The server always recalculates on submission — never trust the client. The formula lives in `routes/scope.js`.

### Why fire-and-forget for email?
`sendLeadNotification()` is awaited with `.catch()` — failures log but don't block the HTTP response. Homeowner gets their confirmation immediately even if the email proxy is slow or down.

### How contractor login works
Contractors have full accounts now (`contractors` table). They can log in three ways:

1. **Email + password** — standard `POST /api/auth/login`. On success the server sets a `connect.sid` cookie and redirects the browser to `/contractor`.
2. **Magic link** — contractor enters their email, gets a one-click link that expires in 15 minutes (rate-limited to 3 per hour). The link logs them in directly.
3. **Forgot password** — sends a 1-hour reset link. After they set a new password, they're logged in.

Login state lives in a database-backed session (Postgres `session` table via `connect-pg-simple`). The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in production. Every login flow regenerates the session ID before binding the contractor — this blocks "session fixation," where an attacker plants a cookie and waits for you to log in.

`/contractor` and `/contractor/opportunities` are blocked at the server before the page even loads — anonymous visits redirect to `/login`.

### Important: there is no localStorage fallback
An earlier version of the app stored the session ID in `localStorage` as a workaround for cookies not persisting. **That entire workaround has been removed.** If cookies stop working on a deploy, the real fix is to check the `SameSite` / `Secure` / `trust proxy` config in `server.js` — don't reinstate the fallback. (XSS exposure was the reason it had to go.)

---

## Deploy Process

Render auto-deploys on every push to `main`.

```
git push origin main
```

1. Render receives the push
2. `npm install`
3. `npm run migrate` — runs `migrate.js` (creates tables + runs pending migrations)
4. `npm start` — starts `server.js`

**Render health check:** `GET /health` returns `{ "status": "healthy" }`.

---

## Database Schema

See [docs/schema.md](docs/schema.md) for full table-by-table breakdown.

**The main tables (plain English):**
- `contractors` — each contractor's account (business name, email, password hash, trade type, etc.)
- `leads` — every project a homeowner submitted, with address, photos, estimate, and status
- `lead_photos` — photo URLs attached to a lead
- `territory_claims` — which ZIP codes each contractor has claimed
- `contractor_magic_links` — short-lived one-click login tokens (15 minutes)
- `session` — currently logged-in browsers (managed by `connect-pg-simple`)
- `analytics_events` / `lead_events` — what happened and when, for the admin dashboard
- `territory_waitlist` — emails to notify if a claimed ZIP opens up
- `founding_config` — counter of how many founding-member spots are taken
- `users` — homeowner accounts (mostly inactive — homeowners don't log in yet)
- `_migrations` — tracks which database changes have been applied
- `auth_debug_log` — DEPRECATED (was used to debug the old cookie issue; safe to drop)

All schema changes go in `migrations/` as timestamped JS files. `migrate.js` reads them, runs any not yet applied, and records them in `_migrations`.

---

## API Reference

Full route documentation at [docs/api.md](docs/api.md) or visit `/api-docs` on the running app.

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| POST | `/api/auth/signup` | Create contractor account | none |
| POST | `/api/auth/login` | Email+password login | none |
| POST | `/api/auth/logout` | End current session | logged in |
| GET | `/api/auth/me` | Current contractor's profile | logged in |
| POST | `/api/auth/magic-link` | Email a one-click login link (15min, 3/hr) | none |
| GET | `/auth/magic?token=…` | Click-through from magic-link email | token in URL |
| POST | `/api/auth/forgot-password` | Email a password reset link (1hr) | none |
| POST | `/api/auth/reset-password` | Set new password + log in | reset token |
| POST | `/api/scope/submit` | Homeowner: create a lead | none |
| POST | `/api/scope/upload` | Homeowner: upload a photo | none |
| GET | `/api/contractors/me/leads` | List the logged-in contractor's leads | logged in |
| GET | `/api/contractors/me/leads/:id` | Lead detail | logged in |
| PATCH | `/api/contractors/me/leads/:id/status` | Update lead status | logged in |
| POST | `/api/leads/:id/pass` | Send a lead to the opportunity board | logged in |
| GET | `/api/opportunities` | List board leads | logged in |
| POST | `/api/opportunities/:id/claim` | Claim a lead from the board | logged in |
| GET | `/api/territory/check?zip=` | Public ZIP availability check | none |
| POST | `/api/territory/claim` | Claim a ZIP | logged in |
| DELETE | `/api/territory/claim/:id` | Release a claimed ZIP | logged in |
| POST | `/api/founding/checkout` | Start $1,500 founding-member checkout | none |
| GET | `/health` | Health check | none |

---

## Adding a New Project Vertical

1. Add an entry to `public/js/questions-config.js` — `id`, `label`, `icon`, `questions[]`
2. Add pricing rates and calculation logic to `routes/scope.js` → `calculateEstimate()` switch case
3. That's it. No database migration needed — `trade_inputs` is JSONB.

Questions per project type are defined in `questions-config.js` — a plain JSON object. Pricing rates (used for ballpark estimates) are also there. Update both `questions-config.js` (for client-side preview) and `routes/scope.js` (for server-side final calculation) when changing prices.

---

## Email Notifications

Outbound email goes via Polsia email proxy. If `POLSIA_EMAIL_PROXY_URL` is not set, lead submission still works — email is skipped and a console log is written.

The notification email includes:
- Satellite map of the property (Mapbox Static API) with polygon overlay if drawn
- Address + GPS coordinates
- Ballpark estimate range
- Homeowner contact (name, email — click-to-reply, phone — click-to-call)
- Project specifications rendered from `trade_inputs` using `questions-config.js` labels
- Photo gallery (up to 6 photos, 2-up grid)
- Notes section
- Dashboard CTA + Reply-to-Homeowner mailto link

Plain-text fallback is included for email clients that block images or HTML.