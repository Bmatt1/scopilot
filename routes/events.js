/**
 * Owns: POST /api/events and POST /api/analytics/event — event ingestion endpoints.
 * Does NOT own: analytics queries (db/events.js, db/analytics.js), admin rendering,
 * lead events (db/analytics.js), page view middleware (lib/track-pageview.js).
 */
const express = require('express');
const router = express.Router();
const { insertEvents } = require('../db/events');
const { logAnalyticsEvent } = require('../db/analytics');

// Allowed event types — explicit allowlist prevents junk accumulation in DB
const ALLOWED_EVENTS = new Set([
  'page_view',
  'founding_page_view',
  'founding_cta_click',
  'founding_checkout_started',
  'founding_checkout_completed',
  'scope_started',
  'scope_address_confirmed',
  'scope_area_drawn',
  'scope_photos_uploaded',
  'scope_submitted',
  'contractor_signup_started',
  'contractor_signup_completed',
  'lead_status_changed',
  // Client-side form interaction events
  'form_view',
  'form_started',
  'scroll_depth'
]);

/**
 * POST /api/events
 * Body: { events: [ { event_type, session_id, properties, referrer, ts } ] }
 * Accepts up to 20 events per request to prevent abuse.
 */
router.post('/', async (req, res) => {
  try {
    const { events } = req.body || {};
    if (!Array.isArray(events) || events.length === 0) {
      console.error(JSON.stringify({
        type: 'http_req',
        ts: new Date().toISOString(),
        method: 'POST',
        path: '/api/events',
        status: 400,
        ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress,
        session_id: req.sessionID || null,
        user_agent: req.headers['user-agent'] || '',
        req_body: req.body ? JSON.stringify(req.body).slice(0, 500) : null,
        err: 'events array missing or empty'
      }));
      return res.status(400).json({ error: 'events array required' });
    }

    // Filter, validate, and enrich with server-side context
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || '';

    const valid = events
      .slice(0, 20) // cap per-batch
      .filter(ev => ev && typeof ev.event_type === 'string' && ALLOWED_EVENTS.has(ev.event_type))
      .map(ev => ({
        event_type: ev.event_type,
        session_id: typeof ev.session_id === 'string' ? ev.session_id.slice(0, 128) : null,
        contractor_id: Number.isInteger(ev.contractor_id) ? ev.contractor_id : null,
        properties: typeof ev.properties === 'object' && ev.properties !== null ? ev.properties : {},
        ip,
        user_agent: userAgent,
        referrer: typeof ev.referrer === 'string' ? ev.referrer.slice(0, 2048) : null
      }));

    if (valid.length > 0) {
      await insertEvents(valid);
    }

    // 204 keeps the response tiny — client doesn't need a body
    res.status(204).end();
  } catch (err) {
    console.error(JSON.stringify({
      type: 'http_req',
      ts: new Date().toISOString(),
      method: 'POST',
      path: '/api/events',
      status: 500,
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress,
      session_id: req.sessionID || null,
      user_agent: req.headers['user-agent'] || '',
      req_body: req.body ? JSON.stringify(req.body).slice(0, 500) : null,
      err: err.message,
      stack: err.stack
    }));
    res.status(204).end();
  }
});

/**
 * POST /api/analytics/event
 * Lightweight single-event ingestion for client-side interactions:
 *   form_view, form_started, scroll_depth, etc.
 * Async write — does not block response. No auth required.
 * Body: { event_type, page_url?, session_id?, scroll_depth?, referrer?, utm_source?, utm_medium?, utm_campaign? }
 */
router.post('/event', async (req, res) => {
  try {
    const { event_type, page_url, session_id, scroll_depth, referrer,
            utm_source, utm_medium, utm_campaign } = req.body || {};

    if (!event_type || typeof event_type !== 'string') {
      return res.status(400).json({ error: 'event_type is required' });
    }

    if (!ALLOWED_EVENTS.has(event_type)) {
      return res.status(400).json({ error: `Unknown event type: ${event_type}` });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    const ua = req.headers['user-agent'] || '';

    // Use provided session_id or derive from IP+UA
    let sessionId = session_id;
    if (!sessionId) {
      const crypto = require('crypto');
      sessionId = crypto.createHash('sha256').update(ip + ua).digest('hex');
    }

    const metadata = {};
    if (event_type === 'scroll_depth' && typeof scroll_depth === 'number') {
      metadata.scroll_depth = Math.min(100, Math.max(0, scroll_depth));
    }

    logAnalyticsEvent({
      eventType: event_type,
      pageUrl: typeof page_url === 'string' ? page_url.slice(0, 2048) : null,
      referrer: typeof referrer === 'string' ? referrer.slice(0, 2048) : null,
      utmSource: typeof utm_source === 'string' ? utm_source.slice(0, 255) : null,
      utmMedium: typeof utm_medium === 'string' ? utm_medium.slice(0, 255) : null,
      utmCampaign: typeof utm_campaign === 'string' ? utm_campaign.slice(0, 255) : null,
      userAgent: ua.slice(0, 1024),
      sessionId: String(sessionId).slice(0, 128),
      contractorId: req.session?.contractorId || null,
      metadata
    }).catch(err => console.error('analytics event error:', err.message));

    // 204 — client doesn't need a response body
    res.status(204).end();
  } catch (err) {
    console.error('POST /api/analytics/event error:', err.message);
    res.status(204).end();
  }
});

module.exports = router;
