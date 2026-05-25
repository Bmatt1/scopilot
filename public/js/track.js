/**
 * Scopilot client-side event tracking.
 * Usage: Scopilot.track('event_type', { key: 'value' })
 * Auto-fires page_view on load.
 *
 * Events are batched and sent to POST /api/events.
 * Session ID is a UUID stored in localStorage (no PII).
 */
(function (global) {
  'use strict';

  // ── Session ID ───────────────────────────────────────────────────────────
  function getSessionId() {
    var key = 'scp_sid';
    var sid = localStorage.getItem(key);
    if (!sid) {
      sid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
      localStorage.setItem(key, sid);
    }
    return sid;
  }

  // ── UTM extraction ───────────────────────────────────────────────────────
  function getUtmParams() {
    var params = {};
    var search = global.location.search;
    var pairs = search.replace(/^\?/, '').split('&');
    pairs.forEach(function (pair) {
      var kv = pair.split('=');
      var k = decodeURIComponent(kv[0] || '');
      if (k.indexOf('utm_') === 0 || k === 'ref') {
        params[k] = decodeURIComponent(kv[1] || '');
      }
    });
    return params;
  }

  // ── Queue & flush ────────────────────────────────────────────────────────
  var queue = [];
  var flushTimer = null;

  function flush() {
    if (queue.length === 0) return;
    var batch = queue.splice(0);
    navigator.sendBeacon
      ? navigator.sendBeacon('/api/events', JSON.stringify({ events: batch }))
      : fetch('/api/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events: batch }),
          keepalive: true
        }).catch(function () {});
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      flush();
    }, 500); // 500ms debounce — batches rapid consecutive calls
  }

  // ── Public API ────────────────────────────────────────────────────────────
  function track(eventType, properties) {
    var sid = getSessionId();
    queue.push({
      event_type: eventType,
      session_id: sid,
      properties: Object.assign({}, properties || {}),
      referrer: document.referrer || '',
      ts: Date.now()
    });
    scheduleFlush();
  }

  // Flush on page hide (mobile background / tab close)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  // ── Auto page_view ────────────────────────────────────────────────────────
  function autoPageView() {
    var utms = getUtmParams();
    track('page_view', Object.assign({
      path: global.location.pathname,
      search: global.location.search
    }, utms));
  }

  // Fire immediately if DOM ready, otherwise wait
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoPageView);
  } else {
    autoPageView();
  }

  // ── Export ────────────────────────────────────────────────────────────────
  global.Scopilot = global.Scopilot || {};
  global.Scopilot.track = track;
  global.Scopilot._flush = flush; // for tests / manual trigger
  global.Scopilot._sessionId = getSessionId;

}(typeof window !== 'undefined' ? window : this));
