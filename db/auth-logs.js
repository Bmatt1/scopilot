/**
 * Owns: auth_logs table queries.
 * Does NOT own: request-logger.js business logic.
 */
const pool = require('./index');

/**
 * Insert a new auth log entry. Fire-and-forget — never blocks caller.
 */
async function insertAuthLog(entry) {
  try {
    await pool.query(
      `INSERT INTO auth_logs
        (method, path, status_code, duration_ms, session_id, ip, user_agent, request_body, response_summary, error_stack)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        entry.method,
        entry.path,
        entry.status_code,
        entry.duration_ms || null,
        entry.session_id || null,
        entry.ip || null,
        entry.user_agent || null,
        entry.request_body || null,
        entry.response_summary || null,
        entry.error_stack || null
      ]
    );
  } catch (err) {
    // Never throw — logging must not affect request flow
    console.error('[auth-logs] insert failed:', err.message);
  }
}

/**
 * Fetch paginated auth logs with optional filters.
 * @param {object} opts
 * @param {string} opts.path - filter by exact path prefix (e.g., '/api/auth/login')
 * @param {string} opts.statusRange - '2xx', '4xx', '5xx', or 'all'
 * @param {number} opts.page - 1-indexed page number
 * @param {number} opts.limit - rows per page (default 25)
 */
async function getAuthLogs({ path, statusRange, page = 1, limit = 25 } = {}) {
  const offset = (Math.max(1, page) - 1) * limit;
  const params = [];
  const conditions = [];

  if (path && path !== 'all') {
    params.push(path);
    conditions.push(`path = $${params.length}`);
  }

  if (statusRange && statusRange !== 'all') {
    const range = statusRange.toLowerCase();
    if (range === '2xx') {
      params.push(200, 299);
      conditions.push(`status_code BETWEEN $${params.length - 1} AND $${params.length}`);
    } else if (range === '4xx') {
      params.push(400, 499);
      conditions.push(`status_code BETWEEN $${params.length - 1} AND $${params.length}`);
    } else if (range === '5xx') {
      params.push(500, 599);
      conditions.push(`status_code BETWEEN $${params.length - 1} AND $${params.length}`);
    }
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const p = params.length;

  params.push(limit, offset);

  const [rows, countResult] = await Promise.all([
    pool.query(
      `SELECT id, timestamp, method, path, status_code, duration_ms,
              session_id, ip, user_agent, request_body, response_summary, error_stack
       FROM auth_logs ${where}
       ORDER BY timestamp DESC
       LIMIT $${p + 1} OFFSET $${p + 2}`,
      params
    ),
    pool.query(`SELECT COUNT(*) as total FROM auth_logs ${where}`, params.slice(0, p))
  ]);

  return {
    rows: rows.rows,
    total: parseInt(countResult.rows[0].total, 10),
    page,
    limit,
    totalPages: Math.ceil(parseInt(countResult.rows[0].total, 10) / limit)
  };
}

module.exports = { insertAuthLog, getAuthLogs };