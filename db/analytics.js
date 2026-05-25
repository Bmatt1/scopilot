/**
 * Owns: all DB queries for page_views and lead_events tables.
 * Does NOT own: HTTP handling, middleware logic, or admin rendering.
 */
const pool = require('./index');

// ── Page Views ──────────────────────────────────────────────────────────────

async function logPageView({ path, referrer, userAgent, sessionHash }) {
  await pool.query(
    `INSERT INTO page_views (path, referrer, user_agent, session_hash)
     VALUES ($1, $2, $3, $4)`,
    [path, referrer || null, userAgent || null, sessionHash]
  );
}

async function getPageViewCounts() {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day')   AS views_today,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')  AS views_7d,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS views_30d,
      COUNT(DISTINCT session_hash) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day')   AS unique_today,
      COUNT(DISTINCT session_hash) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')  AS unique_7d,
      COUNT(DISTINCT session_hash) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS unique_30d
    FROM page_views
  `);
  return result.rows[0];
}

async function getTopPages(days = 30, limit = 10) {
  const result = await pool.query(
    `SELECT path, COUNT(*) AS views
     FROM page_views
     WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
     GROUP BY path
     ORDER BY views DESC
     LIMIT $2`,
    [days, limit]
  );
  return result.rows;
}

async function getTopReferrers(days = 30, limit = 10) {
  const result = await pool.query(
    `SELECT referrer, COUNT(*) AS views
     FROM page_views
     WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
       AND referrer IS NOT NULL AND referrer != ''
     GROUP BY referrer
     ORDER BY views DESC
     LIMIT $2`,
    [days, limit]
  );
  return result.rows;
}

// ── Lead Events ─────────────────────────────────────────────────────────────

async function logLeadEvent({ leadId, contractorId, eventType, metadata }) {
  await pool.query(
    `INSERT INTO lead_events (lead_id, contractor_id, event_type, metadata)
     VALUES ($1, $2, $3, $4)`,
    [leadId, contractorId || null, eventType, JSON.stringify(metadata || {})]
  );
}

async function getLeadEventCounts() {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE event_type = 'submitted')  AS total_submitted,
      COUNT(*) FILTER (WHERE event_type = 'viewed')     AS total_viewed,
      COUNT(*) FILTER (WHERE event_type = 'contacted')  AS total_contacted,
      COUNT(*) FILTER (WHERE event_type = 'quoted')     AS total_quoted,
      COUNT(*) FILTER (WHERE event_type = 'won')        AS total_won,
      COUNT(*) FILTER (WHERE event_type = 'lost')       AS total_lost
    FROM lead_events
  `);
  return result.rows[0];
}

async function getLeadSubmissionCounts() {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day')   AS leads_today,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')  AS leads_7d,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS leads_30d
    FROM lead_events
    WHERE event_type = 'submitted'
  `);
  return result.rows[0];
}

// ── analytics_events table ─────────────────────────────────────────────────

/**
 * Write a single event to the analytics_events table.
 * Used by track-pageview middleware and route handler event tracking.
 * All args optional except eventType.
 */
async function logAnalyticsEvent({
  eventType,
  pageUrl = null,
  referrer = null,
  utmSource = null,
  utmMedium = null,
  utmCampaign = null,
  userAgent = null,
  sessionId = null,
  contractorId = null,
  metadata = {}
}) {
  await pool.query(
    `INSERT INTO analytics_events
       (event_type, page_url, referrer, utm_source, utm_medium, utm_campaign,
        user_agent, session_id, contractor_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      eventType,
      pageUrl,
      referrer,
      utmSource,
      utmMedium,
      utmCampaign,
      userAgent,
      sessionId,
      contractorId,
      JSON.stringify(metadata || {})
    ]
  );
}

/**
 * Count events by type within a day window.
 */
async function getAnalyticsEventCounts(eventTypes, days = 30) {
  const result = await pool.query(
    `SELECT event_type, COUNT(*) AS count
     FROM analytics_events
     WHERE event_type = ANY($1)
       AND created_at >= NOW() - ($2 || ' days')::INTERVAL
     GROUP BY event_type`,
    [eventTypes, days]
  );
  const map = {};
  for (const row of result.rows) map[row.event_type] = parseInt(row.count, 10);
  return map;
}

/**
 * Page view counts from analytics_events (today/7d/30d + unique sessions).
 */
async function getAnalyticsPageViewCounts() {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day')   AS views_today,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')  AS views_7d,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS views_30d,
      COUNT(DISTINCT session_id) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day')   AS unique_today,
      COUNT(DISTINCT session_id) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')  AS unique_7d,
      COUNT(DISTINCT session_id) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS unique_30d
    FROM analytics_events
    WHERE event_type = 'page_view'
  `);
  return result.rows[0];
}

/**
 * Top referrers from analytics_events.
 */
async function getAnalyticsTopReferrers(days = 30, limit = 10) {
  const result = await pool.query(
    `SELECT referrer, COUNT(*) AS views
     FROM analytics_events
     WHERE event_type = 'page_view'
       AND created_at >= NOW() - ($1 || ' days')::INTERVAL
       AND referrer IS NOT NULL AND referrer != ''
     GROUP BY referrer
     ORDER BY views DESC
     LIMIT $2`,
    [days, limit]
  );
  return result.rows;
}

/**
 * UTM source breakdown — useful for campaign performance.
 */
async function getUtmBreakdown(days = 30, limit = 10) {
  const result = await pool.query(
    `SELECT utm_source, utm_medium, utm_campaign, COUNT(*) AS events
     FROM analytics_events
     WHERE event_type = 'page_view'
       AND created_at >= NOW() - ($1 || ' days')::INTERVAL
       AND utm_source IS NOT NULL
     GROUP BY utm_source, utm_medium, utm_campaign
     ORDER BY events DESC
     LIMIT $2`,
    [days, limit]
  );
  return result.rows;
}

module.exports = {
  logPageView,
  getPageViewCounts,
  getTopPages,
  getTopReferrers,
  logLeadEvent,
  getLeadEventCounts,
  getLeadSubmissionCounts,
  logAnalyticsEvent,
  getAnalyticsEventCounts,
  getAnalyticsPageViewCounts,
  getAnalyticsTopReferrers,
  getUtmBreakdown
};
