/**
 * Owns: all DB queries for contractors table — auth, CRUD, slug generation, legacy provisioning.
 * Does NOT own: HTTP handling, session management, password reset.
 *
 * legacy_free flag: permanent, no-cost account granted by operator. Bypasses Stripe checks.
 * Grants founding-member-equivalent privileges: 3 ZIP territory cap, no billing, no renewal.
 */
const pool = require('./index');

function generateSlug(businessName, tradeType) {
  const base = businessName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40);
  const trade = tradeType.replace(/[^a-z]/g, '').substring(0, 8);
  return `${base}-${trade}`;
}

async function createContractor({ business_name, owner_name, email, password_hash, phone, trade_type, service_area, unique_slug }) {
  // New signups land on the 'free' plan — board access only, zero owned zips.
  // To claim any zip the contractor has to upgrade. The cap check in
  // routes/territory.js will surface that prompt the moment they try.
  const result = await pool.query(
    `INSERT INTO contractors (business_name, owner_name, email, password_hash, phone, trade_type, service_area, unique_slug, plan)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'free')
     RETURNING id, business_name, owner_name, email, phone, trade_type, service_area, unique_slug, plan, created_at`,
    [business_name, owner_name, email, password_hash, phone || '', trade_type, service_area || '', unique_slug]
  );
  return result.rows[0];
}

/**
 * Provision a legacy_free contractor account. Upserts on email.
 * Sets legacy_free=true, founding_member=true (equivalent privileges), email_verified=true.
 * No Stripe fields required — billing is permanently free for these accounts.
 * Also sets a one-time login_token (magic link) so they can log in without a password.
 */
async function createLegacyContractor({ business_name, owner_name, email, trade_type, service_area, unique_slug, login_token, login_token_expires_at }) {
  const result = await pool.query(
    `INSERT INTO contractors
       (business_name, owner_name, email, password_hash, trade_type, service_area, unique_slug,
        legacy_free, founding_member, plan, login_token, login_token_expires_at)
     VALUES ($1, $2, $3, '', $4, $5, $6, true, true, 'legacy', $7, $8)
     ON CONFLICT (email) DO UPDATE SET
       legacy_free = true,
       founding_member = true,
       plan = 'legacy',
       business_name = EXCLUDED.business_name,
       trade_type = EXCLUDED.trade_type,
       login_token = EXCLUDED.login_token,
       login_token_expires_at = EXCLUDED.login_token_expires_at
     RETURNING id, business_name, owner_name, email, trade_type, unique_slug, legacy_free, plan, login_token`,
    [business_name, owner_name || business_name, email, trade_type, service_area || 'Owensboro, KY', unique_slug, login_token || null, login_token_expires_at || null]
  );
  return result.rows[0];
}

async function getContractorByEmail(email) {
  const result = await pool.query(
    `SELECT id, business_name, owner_name, email, password_hash, phone, trade_type, service_area, unique_slug, created_at
     FROM contractors WHERE email = $1`,
    [email]
  );
  return result.rows[0] || null;
}

async function getContractorById(id) {
  // founding_member + legacy_free are needed so the dashboard knows whether to
  // show the "Become a Founding Member" upsell card.
  // plan is needed for the cap check in routes/territory.js to look up which
  // subscription tier the contractor is on (see PLAN_CAPS in db/territory.js).
  const result = await pool.query(
    `SELECT id, business_name, owner_name, email, phone, trade_type, service_area,
            unique_slug, founding_member, legacy_free, plan, created_at
     FROM contractors WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function getContractorBySlug(slug) {
  const result = await pool.query(
    `SELECT id, business_name, owner_name, email, phone, trade_type, service_area, unique_slug, created_at
     FROM contractors WHERE unique_slug = $1`,
    [slug]
  );
  return result.rows[0] || null;
}

/**
 * Admin-level: all contractors with territory claim count and lead count.
 */
async function getAllContractorsForAdmin() {
  const result = await pool.query(`
    SELECT
      c.id,
      c.business_name,
      c.owner_name,
      c.email,
      c.phone,
      c.trade_type,
      c.service_area,
      c.unique_slug,
      c.plan,
      c.founding_member,
      c.legacy_free,
      c.founding_purchased_at,
      c.is_suspended,
      c.created_at,
      COALESCE((
        SELECT COUNT(*)
        FROM territory_claims tc
        WHERE tc.contractor_id = c.id AND tc.status = 'active'
      ), 0)::int AS territory_claims_count,
      COALESCE((
        SELECT COUNT(*)
        FROM leads l
        WHERE l.contractor_id = c.id
      ), 0)::int AS leads_count
    FROM contractors c
    ORDER BY c.created_at DESC
  `);
  return result.rows;
}

/**
 * Suspend a contractor account (admin action).
 */
async function suspendContractor(contractorId) {
  const result = await pool.query(
    `UPDATE contractors SET is_suspended = true WHERE id = $1 RETURNING *`,
    [contractorId]
  );
  return result.rows[0] || null;
}

/**
 * Activate a suspended contractor account (admin action).
 */
async function activateContractor(contractorId) {
  const result = await pool.query(
    `UPDATE contractors SET is_suspended = false WHERE id = $1 RETURNING *`,
    [contractorId]
  );
  return result.rows[0] || null;
}

/**
 * Contractor count breakdown for admin analytics.
 */
async function getContractorCounts() {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE is_suspended = false) AS active,
      COUNT(*) FILTER (WHERE is_suspended = true) AS suspended,
      COUNT(*) FILTER (WHERE founding_member = true) AS founding,
      COUNT(*) AS total
    FROM contractors
  `);
  return result.rows[0];
}

async function updatePassword(contractorId, passwordHash) {
  await pool.query(
    `UPDATE contractors SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
    [passwordHash, contractorId]
  );
}

/**
 * Returns contractors who signed up 24–48h ago, haven't claimed founding,
 * and haven't received a nurture email yet. Excludes legacy_free accounts.
 */
async function getContractorsForNurtureEmail() {
  const result = await pool.query(`
    SELECT id, business_name, owner_name, email, created_at
    FROM contractors
    WHERE created_at < NOW() - INTERVAL '24 hours'
      AND created_at > NOW() - INTERVAL '48 hours'
      AND COALESCE(founding_member, false) = false
      AND nurture_sent_at IS NULL
      AND COALESCE(legacy_free, false) = false
    ORDER BY created_at ASC
  `);
  return result.rows;
}

/**
 * Stamp nurture_sent_at for a contractor after email accepted by Postmark.
 * Idempotent — safe to call once; subsequent calls are no-ops due to WHERE check.
 */
async function markNurtureSent(contractorId) {
  await pool.query(
    `UPDATE contractors SET nurture_sent_at = NOW() WHERE id = $1 AND nurture_sent_at IS NULL`,
    [contractorId]
  );
}

/**
 * Update a contractor's subscription plan + Stripe linkage. Called from the
 * post-checkout /billing/welcome handler (initial subscription) and the
 * /api/billing/webhook handler (subsequent subscription changes).
 *
 * - plan: one of 'free' | 'base' | 'plus_1' | 'plus_2' | 'plus_3' | 'lifetime' | 'legacy'
 * - stripeCustomerId / stripeSubscriptionId: stamped on first subscription start.
 *   Pass null to skip updating those fields (e.g. when only the plan changed).
 * - planPeriodEnd: timestamp when the current period ends, so the admin panel
 *   can show "renews on X". Pass null to skip.
 */
async function setContractorPlan(contractorId, { plan, stripeCustomerId, stripeSubscriptionId, planPeriodEnd }) {
  // COALESCE on every column means "if the new value is null/undefined, keep
  // the existing one." That lets callers update only the fields they have —
  // e.g. a past_due webhook that wants to update period_end but NOT plan.
  // To intentionally clear plan, callers should pass 'free' (not null).
  await pool.query(
    `UPDATE contractors
     SET plan = COALESCE($2, plan),
         stripe_customer_id = COALESCE($3, stripe_customer_id),
         stripe_subscription_id = COALESCE($4, stripe_subscription_id),
         plan_period_end = COALESCE($5, plan_period_end),
         updated_at = NOW()
     WHERE id = $1`,
    [contractorId, plan || null, stripeCustomerId || null, stripeSubscriptionId || null, planPeriodEnd || null]
  );
}

/**
 * Look up a contractor by their Stripe subscription ID. Used by the webhook
 * handler to find which contractor a subscription event belongs to when the
 * payload doesn't include our internal contractor id.
 */
async function getContractorByStripeSubscriptionId(stripeSubscriptionId) {
  const result = await pool.query(
    `SELECT id, business_name, email, plan, stripe_customer_id, stripe_subscription_id
     FROM contractors WHERE stripe_subscription_id = $1`,
    [stripeSubscriptionId]
  );
  return result.rows[0] || null;
}

module.exports = {
  createContractor,
  createLegacyContractor,
  getContractorByEmail,
  getContractorById,
  getContractorBySlug,
  generateSlug,
  getAllContractorsForAdmin,
  suspendContractor,
  activateContractor,
  getContractorCounts,
  updatePassword,
  getContractorsForNurtureEmail,
  markNurtureSent,
  setContractorPlan,
  getContractorByStripeSubscriptionId,
};