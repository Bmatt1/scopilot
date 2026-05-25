/**
 * Owns: password_reset_tokens table — token generation, validation, consumption.
 * Does NOT own: email sending, HTTP routing, session management.
 *
 * Tokens are single-use: consumeToken() marks used_at; unused+expired tokens
 * are treated as invalid. 1-hour TTL.
 */
const pool = require('./index');
const crypto = require('crypto');

const RESET_TTL_MINUTES = 60;

/**
 * Create a password reset token for a contractor.
 * Returns the token string.
 */
async function createResetToken(contractorId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000);

  await pool.query(
    `INSERT INTO password_reset_tokens (contractor_id, token, expires_at)
     VALUES ($1, $2, $3)`,
    [contractorId, token, expiresAt]
  );

  return token;
}

/**
 * Look up and validate a reset token.
 * Returns the contractor row (id, email, business_name) if valid; null otherwise.
 * "Valid" means: exists, not expired, not used.
 */
async function validateResetToken(token) {
  const result = await pool.query(
    `SELECT rt.id AS token_id, rt.contractor_id, c.email, c.business_name, c.unique_slug
     FROM password_reset_tokens rt
     JOIN contractors c ON c.id = rt.contractor_id
     WHERE rt.token = $1
       AND rt.expires_at > NOW()
       AND rt.used_at IS NULL`,
    [token]
  );
  return result.rows[0] || null;
}

/**
 * Mark a token as used (single-use enforcement).
 */
async function consumeResetToken(tokenId) {
  await pool.query(
    `UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`,
    [tokenId]
  );
}

module.exports = {
  createResetToken,
  validateResetToken,
  consumeResetToken,
  RESET_TTL_MINUTES,
};