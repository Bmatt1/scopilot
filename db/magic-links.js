/**
 * Owns: contractor_magic_links table — token generation, validation, rate limiting.
 * Does NOT own: session management, email sending, HTTP routing.
 *
 * Rate limit: max 3 tokens per email per hour enforced at DB query level.
 */
const pool = require('./index');
const crypto = require('crypto');

const TOKEN_TTL_MINUTES = 15;
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_HOURS = 1;

/**
 * Count recent magic link requests for a contractor within the rate limit window.
 * Returns the count so the caller can gate before creating a new token.
 */
async function countRecentMagicLinks(contractorId) {
  const result = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM contractor_magic_links
     WHERE contractor_id = $1
       AND created_at > NOW() - INTERVAL '${RATE_LIMIT_WINDOW_HOURS} hours'`,
    [contractorId]
  );
  return parseInt(result.rows[0].cnt, 10);
}

/**
 * Create a new magic link token for a contractor.
 * Returns the token string.
 */
async function createMagicLink(contractorId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000);

  await pool.query(
    `INSERT INTO contractor_magic_links (contractor_id, token, expires_at)
     VALUES ($1, $2, $3)`,
    [contractorId, token, expiresAt]
  );

  return token;
}

/**
 * Look up and validate a magic link token.
 * Returns the contractor row (id, unique_slug) if valid; null otherwise.
 * "Valid" means: exists, not expired, not used.
 */
async function validateMagicLink(token) {
  const result = await pool.query(
    `SELECT ml.id AS link_id, ml.contractor_id, c.unique_slug
     FROM contractor_magic_links ml
     JOIN contractors c ON c.id = ml.contractor_id
     WHERE ml.token = $1
       AND ml.expires_at > NOW()
       AND ml.used_at IS NULL`,
    [token]
  );
  return result.rows[0] || null;
}

/**
 * Mark a token as used (single-use enforcement).
 */
async function consumeMagicLink(linkId) {
  await pool.query(
    `UPDATE contractor_magic_links SET used_at = NOW() WHERE id = $1`,
    [linkId]
  );
}

module.exports = {
  countRecentMagicLinks,
  createMagicLink,
  validateMagicLink,
  consumeMagicLink,
  TOKEN_TTL_MINUTES,
  RATE_LIMIT_MAX,
};
