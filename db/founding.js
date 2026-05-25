/**
 * Owns: founding member DB operations — count, provision, flag.
 * Does NOT own: HTTP routing, email sending, Stripe API calls.
 */
const pool = require('./index');

const FOUNDING_LIMIT = 50;

/** Get current founding member count from config table. */
async function getFoundingCount() {
  const result = await pool.query(
    `SELECT value FROM founding_config WHERE key = 'founding_count'`
  );
  if (!result.rows.length) return 0;
  return parseInt(result.rows[0].value, 10) || 0;
}

/** Atomically increment founding count. Returns new count. */
async function incrementFoundingCount() {
  const result = await pool.query(`
    UPDATE founding_config
    SET value = (value::integer + 1)::text, updated_at = NOW()
    WHERE key = 'founding_count'
    RETURNING value::integer AS count
  `);
  return result.rows[0]?.count || 0;
}

/** Mark a contractor as a founding member. Creates account if not exists. */
async function provisionFoundingContractor({ business_name, email, stripe_customer_id, stripe_payment_intent_id, login_token, login_token_expires_at }) {
  // Upsert: create new contractor row with founding fields, or update existing one
  const result = await pool.query(`
    INSERT INTO contractors (
      business_name, owner_name, email, password_hash, trade_type,
      unique_slug, founding_member, plan, founding_purchased_at,
      stripe_customer_id, stripe_payment_intent_id, login_token, login_token_expires_at
    ) VALUES (
      $1, $1, $2, '', 'general',
      $3, true, 'lifetime', NOW(),
      $4, $5, $6, $7
    )
    ON CONFLICT (email) DO UPDATE SET
      founding_member = true,
      plan = 'lifetime',
      founding_purchased_at = COALESCE(contractors.founding_purchased_at, NOW()),
      stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, contractors.stripe_customer_id),
      stripe_payment_intent_id = COALESCE(EXCLUDED.stripe_payment_intent_id, contractors.stripe_payment_intent_id),
      login_token = EXCLUDED.login_token,
      login_token_expires_at = EXCLUDED.login_token_expires_at
    RETURNING id, business_name, email, unique_slug, founding_member, plan, login_token
  `, [
    business_name,
    email,
    generateFoundingSlug(business_name, email),
    stripe_customer_id || null,
    stripe_payment_intent_id || null,
    login_token || null,
    login_token_expires_at || null
  ]);
  return result.rows[0];
}

/** Look up contractor by their one-time login token. */
async function getContractorByLoginToken(token) {
  const result = await pool.query(
    `SELECT id, business_name, email, unique_slug, plan, founding_member, login_token_expires_at
     FROM contractors
     WHERE login_token = $1 AND login_token_expires_at > NOW()`,
    [token]
  );
  return result.rows[0] || null;
}

/** Clear the login token once used. */
async function clearLoginToken(contractorId) {
  await pool.query(
    `UPDATE contractors SET login_token = NULL, login_token_expires_at = NULL WHERE id = $1`,
    [contractorId]
  );
}

function generateFoundingSlug(businessName, email) {
  const base = (businessName || email.split('@')[0])
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40);
  const suffix = Date.now().toString(36).slice(-4);
  return `${base}-${suffix}`;
}

module.exports = {
  getFoundingCount,
  incrementFoundingCount,
  provisionFoundingContractor,
  getContractorByLoginToken,
  clearLoginToken,
  FOUNDING_LIMIT
};
