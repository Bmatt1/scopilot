# User Flows

## Homeowner Flow: Scoping a Project

**URL:** `/scope.html`

A homeowner completes a project scope in 5 minutes, guided by vertical-specific questions. Here's the full sequence:

---

### Step 1: Project Type Selection

The page opens with 8 vertical cards (concrete, excavation, drainage, retaining wall, demolition, land clearing, gravel delivery, fence). The homeowner picks one. This selection drives everything downstream — question set, estimate formula, email output.

---

### Step 2: Property Location

Two ways to set the location:
- **Address autocomplete** — Mapbox Search API. User types, picks from dropdown, lat/lng + formatted address populate.
- **GPS pin drop** — User clicks "Use my location" or drops a pin on the map. Useful for rural properties without a clean street address.

Either way, the result is `latitude`, `longitude`, and `address` stored on the lead.

**Why Mapbox:** Handles both autocomplete and satellite map rendering in one SDK. One API key covers both use cases.

---

### Step 3: Project Area

User draws a polygon on the Mapbox satellite map to outline the project area. As they draw, `sq_footage` updates in real-time using **Turf.js** (client-side, no server round-trip). The polygon GeoJSON is stored as `project_area_geojson`.

**Why GPS-first + polygon:** Homeowners often don't know sq footage. Drawing the area is faster and more accurate than asking them to measure. The polygon is also overlaid on the satellite view in the contractor email, so the contractor can see the exact site before visiting.

**Why Turf.js client-side:** Instant feedback as the user draws. No network latency. `turf.area()` returns square meters, converted to sq ft.

---

### Step 4: Vertical-Specific Questions

Based on `project_type`, the UI shows a dynamic question flow defined in `public/js/questions-config.js`. Each question has an `id` (stored in `trade_inputs`) and answer `options`.

Questions are specific to each vertical. E.g., concrete asks about thickness and reinforcement; drainage asks about linear footage and problem type.

**Why JSONB for trade_inputs:** Each vertical has a different shape of data. Storing per-vertical answers in a typed column would require a new column per vertical. JSONB lets us add verticals without any schema change — just update `questions-config.js`.

---

### Step 5: Photos

Up to 3 photos can be uploaded. Client-side compression before upload (max ~500KB per photo). Photos are uploaded via `POST /api/scope/upload` which proxies to R2. The returned URL is added to `lead_photos` table after lead creation.

---

### Step 6: Contact Info + Estimate Preview

Homeowner enters name, email, phone. The ballpark estimate is shown — a live calculation based on `sq_footage` × $/sqft rate + vertical-specific modifiers from `trade_inputs`.

The estimate is shown as a range (low–high). This preview is client-side only (from `questions-config.js` pricing data) to set expectations before submission.

---

### Step 7: Submit

`POST /api/scope/submit` with all data. Server:
1. Validates required fields (address, name, email)
2. Calculates `estimate_low` / `estimate_high` server-side using the same formula (never trust client-calculated estimates)
3. Inserts the lead
4. Attaches any photo URLs
5. Fires `sendLeadNotification()` asynchronously (fire-and-forget — failure logs but doesn't block the response)
6. Returns `{ success, lead_id, estimate_low, estimate_high }`

Homeowner sees a confirmation screen with the estimate and a "Share your project" prompt.

---

## Contractor Flow

**URL:** `/contractor`

---

### Getting Access

Contractors have full accounts. They sign up at `/signup` (or are seeded by the operator), and log in at `/login` by one of three paths:

1. **Email + password.** Standard form post to `POST /api/auth/login`.
2. **Magic link.** Enter email at `/login` → click the "send me a link" option → server emails a one-click URL good for 15 minutes (rate-limited 3/hour).
3. **Password reset.** "Forgot password" link emails a 1-hour reset URL.

After a successful login the server sets a `connect.sid` cookie and redirects to `/contractor`. The cookie is the only thing that proves who you are — there's no API key and no localStorage fallback. The `/contractor` and `/contractor/opportunities` pages are gated server-side: anonymous visits are redirected to `/login` before the page even loads.

---

### Viewing Leads

`GET /api/contractors/me/leads` returns only the logged-in contractor's leads, newest first. Each lead includes a `photos` array (aggregated from `lead_photos` via SQL LEFT JOIN).

The dashboard shows:
- Status filter tabs: All / New / Contacted / Quoted / Won / Lost
- Lead cards with address, project type, sq footage, estimate range, submission date
- Photos thumbnail strip

---

### Lead Detail

Clicking a lead card opens a detail panel showing:
- Address + satellite map (same Mapbox static image used in the email)
- Homeowner contact (name, email — click to reply via mailto:, phone — click to call)
- Estimate range
- **Project specifications** — rendered from `trade_inputs` using `questions-config.js` labels. Falls back to legacy columns (tear_out, reinforcement, finish_type) for leads submitted before the vertical-specific feature shipped.
- Photo gallery (up to 6 photos, 2-up grid)
- Notes section (if present)
- Status badge with action buttons to change status

---

### Status Updates

Contractor clicks a status button (Contacted, Quoted, Won, Lost). `PATCH /api/contractors/me/leads/:id/status` updates the lead. The card moves to the corresponding filter tab.

**Status lifecycle:** new → contacted → quoted → won/lost. Lost leads are soft-delete — they remain in the DB with status="lost" for historical tracking.

### Passing leads to the Opportunity Board

If a contractor can't take a lead, they can "pass" it via `POST /api/leads/:id/pass` with an optional reason. The lead moves off their dashboard and onto the Opportunity Board (`/contractor/opportunities`), where any other contractor in range can claim it. This is what the `lead_pass_reasons` table tracks.

---

### Email Notifications

When a new lead arrives, the contractor receives an email with:
- Satellite map of the property (with polygon overlay if drawn)
- Address + GPS coordinates
- Ballpark estimate range
- Homeowner contact info
- Full project specifications (vertical-specific Q&A rendered as rows)
- Photos (up to 6, grid layout)
- Notes
- "View Lead in Dashboard" CTA button
- "Reply to Homeowner" mailto link

The email is plain HTML with a plain-text fallback (for email clients that block images or HTML).

---

## Data Flow Summary

```
Homeowner browser
  → POST /api/scope/submit
    → db/leads.createLead()    → INSERT leads
    → db/leads.addLeadPhoto()  → INSERT lead_photos (multiple)
    → services/email.js        → POST to Polsia email proxy → contractor inbox
    → response → confirmation screen

Contractor login
  → POST /api/auth/login       → bcrypt compare → req.session.regenerate() → set cookie
  → 303 redirect to /contractor

Contractor browser (logged in)
  → GET  /api/contractors/me/leads        → db/leads.getLeads()        → SELECT with photos (filtered to that contractor)
  → GET  /api/contractors/me/leads/:id    → db/leads.getLeadById()     → SELECT one with photos
  → PATCH /api/contractors/me/leads/:id/status → db/leads.updateLeadStatus() → UPDATE
  → POST /api/leads/:id/pass              → moves lead to Opportunity Board
  → GET  /api/opportunities               → list board leads
  → POST /api/opportunities/:id/claim     → claim a board lead
```