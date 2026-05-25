# Database Schema

Scopilot uses PostgreSQL (Neon). All schema changes go in `migrations/` as timestamped JS files — never in runtime code.

---

## contractors

The people who log into the dashboard. One row per business.

| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PRIMARY KEY | |
| business_name | VARCHAR | E.g. "Henderson Concrete" |
| owner_name | VARCHAR | Name on the account |
| email | VARCHAR(255) | Login email. Unique. |
| password_hash | VARCHAR(255) | bcrypt, cost 12. Never stored in plain text. |
| trade_type | VARCHAR(50) | concrete / excavation / drainage / etc. |
| service_area | TEXT | Free-form area description |
| unique_slug | VARCHAR | Used in `/scope.html?c=<slug>` so homeowners attribute to them |
| legacy_free | BOOLEAN | Operator-gifted permanent free account |
| nurture_sent_at | TIMESTAMPTZ | When the founding-offer nurture email was sent |
| created_at | TIMESTAMPTZ | |

---

## session

Active logins. Managed by `connect-pg-simple` — you typically don't touch this table directly. Each row is one logged-in browser cookie. Rows expire and get pruned automatically.

| Column | Type | Notes |
|--------|------|-------|
| sid | VARCHAR PK | The opaque session ID stored in the `connect.sid` cookie |
| sess | JSON | `{ contractorId, contractorSlug, ... }` |
| expire | TIMESTAMP | When the row stops being valid |

---

## contractor_magic_links

Short-lived one-click login tokens. 15-minute expiry, rate-limited to 3 per hour per contractor.

| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| contractor_id | FK | → contractors(id) |
| token | VARCHAR | The opaque token put in the email link |
| expires_at | TIMESTAMPTZ | 15 minutes after creation |
| used_at | TIMESTAMPTZ | NULL until clicked, then stamped |

---

## territory_claims

Which ZIPs each contractor owns.

| Column | Type | Notes |
|--------|------|-------|
| contractor_id | FK | → contractors(id) |
| zip_code | VARCHAR(10) | |
| status | ENUM | active / at_risk / suspended / released |
| monthly_price_cents | INT | NULL if included in the plan |
| is_included_in_plan | BOOLEAN | True = free (1st ZIP). False = paid via Stripe subscription. |
| stripe_subscription_id | VARCHAR | Set when paid via Polsia/Stripe |

---

## users

Homeowner accounts. Mostly inactive right now — homeowners don't log in yet. The Polsia integration keeps this synced for subscription tracking; the `password_hash` column exists but isn't written to.

| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PRIMARY KEY | |
| email | VARCHAR(255) NOT NULL | Case-insensitive unique index |
| name | VARCHAR(255) | Optional display name |
| password_hash | VARCHAR(255) | Unused. Reserved for future homeowner auth. |
| created_at | TIMESTAMPTZ | Defaults to NOW() |
| updated_at | TIMESTAMPTZ | |
| stripe_subscription_id | VARCHAR(255) | Set by Polsia when customer subscribes |
| subscription_status | VARCHAR(50) | active / canceled / past_due |
| subscription_plan | VARCHAR(255) | Plan name or ID |
| subscription_expires_at | TIMESTAMPTZ | |
| subscription_updated_at | TIMESTAMPTZ | |

**Indexes:**
- `users_email_unique_idx` on `LOWER(email)` — unique constraint
- `users_stripe_subscription_id_idx` on `stripe_subscription_id`

---

## leads

Homeowner project scoping submissions. Core of the product.

| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PRIMARY KEY | |
| address | TEXT NOT NULL | Full street address as entered |
| latitude | NUMERIC(10,7) | From Mapbox autocomplete or GPS click |
| longitude | NUMERIC(10,7) | From Mapbox autocomplete or GPS click |
| project_area_geojson | JSONB | GeoJSON Polygon drawn on map. Used for satellite overlay in email. |
| sq_footage | NUMERIC(10,2) | Calculated by Turf.js when polygon is drawn |
| project_type | VARCHAR(50) | concrete, excavation, drainage, retaining_wall, demolition, land_clearing, gravel_delivery, fence |
| trade_inputs | JSONB | Per-vertical Q&A answers as `{ field_id: value }`. New verticals need no schema change. |
| tear_out | BOOLEAN | Legacy field — concrete-specific. Kept for backwards compat with older clients. |
| reinforcement | VARCHAR(50) | Legacy concrete field. |
| finish_type | VARCHAR(50) | Legacy concrete field. |
| has_drainage | BOOLEAN | Legacy drainage field. |
| notes | TEXT | Free-text from homeowner |
| homeowner_name | VARCHAR(255) | |
| homeowner_email | VARCHAR(255) | Used for email reply-to |
| homeowner_phone | VARCHAR(50) | |
| estimate_low | INTEGER | Server-calculated lower bound in USD |
| estimate_high | INTEGER | Server-calculated upper bound in USD |
| status | VARCHAR(50) | new → contacted → quoted → won / lost |
| contractor_email | VARCHAR(255) | Email the notification was sent to |
| created_at | TIMESTAMPTZ | Defaults to NOW() |

**No explicit indexes** — all queries use the primary key or status filter.

---

## lead_photos

Photo attachments. Photos are stored externally (R2); this table just holds URLs.

| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PRIMARY KEY | |
| lead_id | INTEGER NOT NULL | FK → leads(id), CASCADE delete |
| photo_url | TEXT NOT NULL | Full URL to R2-hosted image |
| created_at | TIMESTAMPTZ | Defaults to NOW() |

**Indexes:**
- `lead_photos_lead_id_idx` on `lead_id`

---

## _migrations

Tracks which migration files have been applied. Created and managed by `migrate.js`.

| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PRIMARY KEY | |
| name | VARCHAR(255) NOT NULL | Matches `name` field in migration JS file |
| applied_at | TIMESTAMP | Defaults to NOW() |

---

## Migration File Format

All schema changes live in `migrations/`. File naming: `{unix_timestamp}_{name}.js`

```js
module.exports = {
  name: 'add_new_column',
  up: async (client) => {
    await client.query(`ALTER TABLE leads ADD COLUMN new_col TEXT`);
  }
};
```

`migrate.js` reads all `.js` files in `migrations/`, sorted by name, and runs any not yet in `_migrations`. Each runs in a transaction — failure rolls back.

**Adding a new vertical:** No migration needed. `trade_inputs` is a JSONB catch-all. Add the vertical to `public/js/questions-config.js` and it works immediately.