/**
 * Owns: request/response logging for all /api/auth/* and /api/events endpoints.
 * Does NOT own: business logic, session handling, or DB queries.
 *
 * Logs structured JSON to stdout — one JSON object per log line — so Render
 * logs are searchable and parseable. Redacts password fields in request bodies.
 * Persists logs to the auth_logs table so they're accessible via the admin panel.
 */

// Fields that are redacted in request bodies
const REDACTED_KEYS = new Set(['password', 'password_hash', 'token', 'reset_token']);

// Deep-redact redacted keys in an object
function redact(body) {
  if (body == null) return null;
  if (typeof body !== 'object') return typeof body;
  if (Array.isArray(body)) return body.map(item => typeof item === 'object' ? redact(item) : item);
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    out[k] = REDACTED_KEYS.has(k) ? '[REDACTED]' : (typeof v === 'object' && v !== null ? redact(v) : v);
  }
  return out;
}

// Truncate large strings to avoid Render log noise
function truncate(val, max = 500) {
  if (typeof val !== 'string') return val;
  return val.length > max ? val.slice(0, max) + '...' : val;
}

// Capture body before route handlers consume it (express.json runs before, but
// we capture the raw body from req.body since middleware order is set up)
function captureBody(body) {
  if (!body) return null;
  const redacted = redact(body);
  return truncate(JSON.stringify(redacted), 500);
}

// session ID shortcut
function sessionId(req) {
  return req.sessionID || (req.session ? req.session.id : null) || null;
}

// Lazy DB insert to avoid import cycles (db/index.js creates Pool at module load)
// Fire-and-forget — never blocks the response.
let _insertAuthLog;
function getInsertAuthLog() {
  if (!_insertAuthLog) {
    try {
      const { insertAuthLog } = require('../db/auth-logs');
      _insertAuthLog = insertAuthLog;
    } catch {
      return null;
    }
  }
  return _insertAuthLog;
}

/**
 * Middleware: logs incoming request, captures start time.
 * Attaches log metadata to req so the response logger can fire on res.finish.
 */
function requestLogger(req, res, next) {
  req._reqLog = {
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.path,
    query: Object.keys(req.query).length > 0 ? req.query : undefined,
    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress,
    userAgent: req.headers['user-agent'] || '',
    sessionId: sessionId(req),
    reqBody: req.method !== 'GET' ? captureBody(req.body) : undefined
  };

  const startTime = Date.now();

  res.on('finish', () => {
    const meta = req._reqLog || {};
    const durationMs = Date.now() - startTime;
    const logEntry = {
      type: 'http_req',
      ts: meta.timestamp,
      method: meta.method,
      path: meta.path,
      status: res.statusCode,
      duration_ms: durationMs,
      session_id: meta.sessionId || null,
      ip: meta.ip || null,
      user_agent: meta.userAgent || null,
      req_body: meta.reqBody || null,
      err: res.statusCode >= 500 ? (res.errMessage || 'Internal server error') : null
    };

    // Always log to stderr
    console.error(JSON.stringify(logEntry));

    // Persist to DB asynchronously — never blocks response
    const insert = getInsertAuthLog();
    if (insert) {
      insert({
        method: meta.method,
        path: meta.path,
        status_code: res.statusCode,
        duration_ms: durationMs,
        session_id: meta.sessionId || null,
        ip: meta.ip || null,
        user_agent: meta.userAgent || null,
        request_body: meta.reqBody ? JSON.parse(meta.reqBody) : null,
        response_summary: { status: res.statusCode, error: logEntry.err || null },
        error_stack: res.errStack || null
      }).catch(err => {
        console.error('[request-logger] DB insert failed:', err.message);
      });
    }
  });

  next();
}

module.exports = { requestLogger };