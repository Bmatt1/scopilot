# API Routes

Base URL: `https://scopilot.polsia.app/api`

---

## Authentication overview

Most contractor-facing endpoints require an active login session. The browser gets a `connect.sid` cookie when the contractor logs in; that cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in production. The cookie is what proves who you are on every request — there is no API key, no Authorization header, no localStorage fallback. If you're calling these endpoints from a non-browser client, you need to log in first and carry the cookie back on later requests.

A protected endpoint that doesn't see a valid session returns:
```json
{ "error": "Not authenticated" }
```
with status `401`.

---

## POST /auth/signup

Create a contractor account and log them in. Server sets the session cookie on success.

**Request body (JSON):**
```json
{
  "business_name": "Henderson Concrete",
  "owner_name": "Jane Henderson",
  "email": "jane@hendersonconcrete.com",
  "password": "at-least-8-chars",
  "trade_type": "concrete",
  "service_area": "Owensboro KY"
}
```

**Response `200`:** `{ "success": true, "contractor": { ... } }`
**Response `400`:** Missing field or password too short.
**Response `409`:** An account with that email already exists.

---

## POST /auth/login

Log in with email and password.

- Browser form submit (urlencoded body): server responds with `303 redirect` to `/contractor`. The cookie lands on the redirect; the browser follows carrying it.
- JSON client (`Content-Type: application/json`): server responds with `{ "success": true }` and sets the cookie.

**Request body:** `{ "email": "...", "password": "..." }`

**Response `401`:** Invalid email or password.

---

## POST /auth/logout

Ends the session. Server destroys the row in the `session` table and clears the cookie.

**Response `200`:** `{ "success": true }`

---

## GET /auth/me

Returns the logged-in contractor's profile.

**Response `200`:** `{ "contractor": { ... } }`
**Response `401`:** Not logged in.

---

## POST /auth/magic-link

Email a one-click login link to a contractor.

**Request body:** `{ "email": "jane@hendersonconcrete.com" }`

**Response `200`:** Always success — the response never reveals whether the email matches an account, so attackers can't probe for valid emails.

The link expires after 15 minutes. Rate limited to 3 per hour per contractor.

When clicked, the link hits `GET /auth/magic?token=...` which validates the token, regenerates a session, and redirects to `/contractor`.

---

## POST /auth/forgot-password

Email a password-reset link.

**Request body:** `{ "email": "jane@hendersonconcrete.com" }`

**Response `200`:** Always success (same anti-enumeration pattern as magic-link).

Token expires after 1 hour. The link opens `/reset-password?token=...` which serves a form, which then POSTs to `/auth/reset-password`.

---

## POST /auth/reset-password

Set a new password and log the contractor in.

**Request body:** `{ "token": "...", "password": "new-password" }`

**Response `200`:** `{ "success": true, "redirectUrl": "/contractor" }`
**Response `400`:** Token invalid/expired, or password too short.

---

## POST /scope/submit

Create a new lead from a homeowner project scope submission.

**Request body (JSON):**
```json
{
  "address": "123 Main St, Owensboro KY 42301",
  "latitude": 37.7719,
  "longitude": -87.1117,
  "project_area_geojson": { "type": "Polygon", "coordinates": [...] },
  "sq_footage": 850,
  "project_type": "concrete",
  "trade_inputs": { "tear_out": "yes", "thickness": "4in", "finish_type": "broom" },
  "notes": "Cracks in existing driveway, about 10 years old",
  "homeowner_name": "Jane Doe",
  "homeowner_email": "jane@example.com",
  "homeowner_phone": "270-555-0142",
  "photo_urls": ["https://pub-...r2.dev/photo1.jpg"]
}
```

**All fields optional except `address`, `homeowner_name`, `homeowner_email`.**

Legacy clients (pre-vertical-Q&A) can omit `trade_inputs` and pass `tear_out`, `reinforcement`, `finish_type`, `has_drainage` as top-level fields. The server merges these into `trade_inputs` automatically.

**Response `200`:**
```json
{
  "success": true,
  "lead_id": 42,
  "estimate_low": 5100,
  "estimate_high": 8500
}
```

**Response `400`:**
```json
{ "error": "address, homeowner_name, and homeowner_email are required" }
```

**Response `500`:**
```json
{ "error": "Failed to submit project scope" }
```

---

## POST /scope/upload

Upload a photo and return a public URL. Used during the scoping flow before the lead is created.

**Request body (JSON):**
```json
{
  "data_url": "data:image/jpeg;base64,/9j/4AAQSkZJR...",
  "filename": "driveway-photo.jpg"
}
```

`data_url` must be a base64 data URI. `filename` is optional — defaults to `lead-photo-{timestamp}.jpg`.

**Response `200`:**
```json
{ "url": "https://pub-...r2.dev/lead-photo-1716400000000.jpg" }
```

**No R2 configured:** If `POLSIA_R2_BASE_URL` is not set, returns `{ "url": "data:image/..." }` — the original data URL. Not recommended for production.

---

## GET /leads

List all leads, newest first. Used by the contractor dashboard.

**Query params:**
| Param | Default | Description |
|-------|---------|-------------|
| status | — | Filter by status: `new`, `contacted`, `quoted`, `won`, `lost` |
| limit | 50 | Max leads to return |
| offset | 0 | Pagination offset |

**Response `200`:**
```json
{
  "leads": [
    {
      "id": 42,
      "address": "123 Main St, Owensboro KY 42301",
      "latitude": "37.7719000",
      "longitude": "-87.1117000",
      "sq_footage": "850.00",
      "project_type": "concrete",
      "trade_inputs": { "tear_out": "yes", "thickness": "4in" },
      "estimate_low": 5100,
      "estimate_high": 8500,
      "status": "new",
      "homeowner_name": "Jane Doe",
      "homeowner_email": "jane@example.com",
      "homeowner_phone": "270-555-0142",
      "photos": ["https://pub-...r2.dev/photo1.jpg"],
      "created_at": "2026-05-22T14:00:00.000Z"
    }
  ]
}
```

`photos` is an array of URLs from `lead_photos`, ordered by `created_at`.

---

## GET /leads/:id

Single lead with full detail.

**Response `200`:**
```json
{ "lead": { ... } }
```

Same shape as `GET /leads` item.

**Response `404`:**
```json
{ "error": "Lead not found" }
```

---

## PATCH /leads/:id/status

Update a lead's status. Used by the contractor dashboard.

**Request body (JSON):**
```json
{ "status": "contacted" }
```

Valid statuses: `new`, `contacted`, `quoted`, `won`, `lost`

**Response `200`:**
```json
{ "lead": { ... } }
```

Updated lead object.

**Response `400`:**
```json
{ "error": "status must be one of: new, contacted, quoted, won, lost" }
```

**Response `404`:**
```json
{ "error": "Lead not found" }
```

---

## Health Check

**GET /health**

Returns `200 { "status": "healthy" }`. No auth required. Used by Render for deploy health checks.