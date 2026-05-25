/**
 * Owns: all DB queries for the `events` table — conversion tracking, funnel analysis.
 * Does NOT own: page_views/lead_events (db/analytics.js), HTTP routing, session management.
 */
const pool = require('./index');

/**
 * Persist one or more events. Each event: { event_type, session_id, contractor_id, properties, ip, user_agent, referrer }
 * Batch-inserts for efficiency when called from the client batch endpoint.
 */
async function insertEvents(events) {
  if (!events || events.length === 0) return;

  // Build parameterised multi-row insert
  const values = [];
  const placeholders = events.map((ev, i) => {
    const base = i * 7;
    values.push(
      ev.event_type,
      ev.contractor_id || null,
      ev.session_id || null,
      JSON.stringify(ev.properties || {}),
      ev.ip || null,
      ev.user_agent || null,
      ev.referrer || null
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
  });

  await pool.query(
    `INSERT INTO events (event_type, contractor_id, session_id, properties, ip, user_agent, referrer)
     VALUES ${placeholders.join(', ')}`,
    values
  );
}

/**
 * Count events grouped by type, within a given day window.
 * Returns { event_type: count, ... }
 */
async function getEventCounts(eventTypes, days = 30) {
  const result = await pool.query(
    `SELECT event_type, COUNT(*) AS count
     FROM events
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
 * Founding funnel: views → cta_clicks → checkout_started → checkout_completed
 * Returns ordered step rows for display.
 */
async function getFoundingFunnel(days = 30) {
  const steps = [
    'founding_page_view',
    'founding_cta_click',
    'founding_checkout_started',
    'founding_checkout_completed'
  ];
  const counts = await getEventCounts(steps, days);
  return steps.map(s => ({ event_type: s, count: counts[s] || 0 }));
}

/**
 * Homeowner scope funnel: started → address_confirmed → area_drawn → photos_uploaded → submitted
 */
async function getScopeFunnel(days = 30) {
  const steps = [
    'scope_started',
    'scope_address_confirmed',
    'scope_area_drawn',
    'scope_photos_uploaded',
    'scope_submitted'
  ];
  const counts = await getEventCounts(steps, days);
  return steps.map(s => ({ event_type: s, count: counts[s] || 0 }));
}

/**
 * Contractor signup funnel: started → completed
 */
async function getSignupFunnel(days = 30) {
  const steps = ['contractor_signup_started', 'contractor_signup_completed'];
  const counts = await getEventCounts(steps, days);
  return steps.map(s => ({ event_type: s, count: counts[s] || 0 }));
}

module.exports = {
  insertEvents,
  getEventCounts,
  getFoundingFunnel,
  getScopeFunnel,
  getSignupFunnel
};
