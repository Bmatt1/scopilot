/**
 * Owns: auth_debug_log table — captures 401 responses from /me for analysis.
 * Does NOT own: auth sessions, login flow, or session cookies.
 */
const pool = require('./index');

/**
 * Insert an auth debug record.
 * @param {object} data
 * @param {string} data.endpoint        e.g. "/api/auth/me"
 * @param {number} data.status           HTTP status code (401, etc.)
 * @param {string} [data.response_body]  Raw response body text
 * @param {boolean} [data.cookie_present] Whether a session cookie was sent
 * @param {string} [data.document_cookie]  window.document.cookie value
 * @param {string} [data.local_storage]   Relevant localStorage keys (not all keys)
 * @param {string} [data.session_storage] Relevant sessionStorage keys
 */
async function logAuthDebug({ endpoint, status, response_body, cookie_present, document_cookie, local_storage, session_storage }) {
  await pool.query(
    `INSERT INTO auth_debug_log (endpoint, status, response_body, cookie_present, document_cookie, local_storage, session_storage)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [endpoint, status, response_body || null, cookie_present || null, document_cookie || null, local_storage || null, session_storage || null]
  );
}

module.exports = { logAuthDebug };