/**
 * Owns: Express middleware that logs page views to the analytics tables.
 * Does NOT own: the DB schema or query logic — those live in db/analytics.js.
 *
 * Skips /health, static assets (/css, /js, /images, /uploads, favicon), and API endpoints.
 * Uses SHA-256(IP + User-Agent) as session_hash for privacy — no raw PII stored.
 * Parses UTM params from query string and writes to analytics_events table.
 */
const crypto = require('crypto');
const { logPageView } = require('../db/analytics');
const { logAnalyticsEvent } = require('../db/analytics');

// Paths/prefixes to skip — health checks, static assets, API calls
const SKIP_PREFIXES = ['/health', '/css/', '/js/', '/images/', '/uploads/', '/favicon'];
const SKIP_EXTENSIONS = ['.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.map'];

function trackPageView(req, res, next) {
  const p = req.path;

  // Skip non-page requests
  if (SKIP_PREFIXES.some(prefix => p.startsWith(prefix))) return next();
  if (SKIP_EXTENSIONS.some(ext => p.endsWith(ext))) return next();
  if (p.startsWith('/api/')) return next();

  // Build session hash: SHA-256 of IP + User-Agent (privacy-safe unique visitor signal)
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const ua = req.headers['user-agent'] || '';
  const sessionHash = crypto.createHash('sha256').update(ip + ua).digest('hex');
  const referrer = req.headers['referer'] || req.headers['referrer'] || null;

  // Parse UTM params from query string
  const utmSource = req.query.utm_source || null;
  const utmMedium = req.query.utm_medium || null;
  const utmCampaign = req.query.utm_campaign || null;

  // Fire-and-forget — don't slow down the response
  logPageView({
    path: p,
    referrer,
    userAgent: ua.slice(0, 1024),
    sessionHash
  }).catch(err => console.error('Page view tracking error:', err.message));

  // Also write to the new unified analytics_events table
  logAnalyticsEvent({
    eventType: 'page_view',
    pageUrl: p,
    referrer,
    utmSource,
    utmMedium,
    utmCampaign,
    userAgent: ua.slice(0, 1024),
    sessionId: sessionHash,
    contractorId: req.session?.contractorId || null,
    metadata: {}
  }).catch(err => console.error('Analytics event tracking error:', err.message));

  next();
}

/**
 * Fire-and-forget event tracker for use in route handlers.
 * Call this at the point of an action (lead started, signup completed, etc.)
 * Never awaits — does not block the response.
 */
function trackEvent({ eventType, pageUrl, contractorId, metadata, req }) {
  const ip = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '';
  const ua = req?.headers?.['user-agent'] || '';
  const sessionHash = crypto.createHash('sha256').update(ip + ua).digest('hex');
  const referrer = req?.headers?.['referer'] || req?.headers?.['referrer'] || null;

  const utmSource = req?.query?.utm_source || null;
  const utmMedium = req?.query?.utm_medium || null;
  const utmCampaign = req?.query?.utm_campaign || null;

  logAnalyticsEvent({
    eventType,
    pageUrl,
    referrer,
    utmSource,
    utmMedium,
    utmCampaign,
    userAgent: ua.slice(0, 1024),
    sessionId: sessionHash,
    contractorId: contractorId || req?.session?.contractorId || null,
    metadata
  }).catch(err => console.error('Track event error:', err.message));
}

module.exports = trackPageView;
module.exports.trackEvent = trackEvent;
