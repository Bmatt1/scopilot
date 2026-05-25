/**
 * Owns: email_log table access — insert send records, query history.
 * Does NOT own: sending emails, HTTP calls, or business logic.
 */
const pool = require('./index');

/**
 * Log an outbound email send attempt.
 * Call after every send, success or failure.
 */
async function logEmailSend({ recipient, template, postmarkMessageId, error, metadata }) {
  await pool.query(
    `INSERT INTO email_log (recipient, template, sent_at, postmark_message_id, error, metadata)
     VALUES ($1, $2, NOW(), $3, $4, $5)`,
    [recipient, template, postmarkMessageId || null, error || null, metadata ? JSON.stringify(metadata) : null]
  );
}

module.exports = { logEmailSend };
