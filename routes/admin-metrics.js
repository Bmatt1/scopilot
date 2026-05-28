/**
 * Owns: GET /api/admin/metrics — protected JSON API endpoint.
 * Does NOT own: the admin HTML panel (/admin/*, routes/admin.js), page view logging.
 */
const express = require('express');
const router = express.Router();
const {
  getAnalyticsPageViewCounts,
  getAnalyticsTopReferrers,
  getAnalyticsEventCounts,
  getPageViewCounts,
  getLeadEventCounts,
  getLeadSubmissionCounts
} = require('../db/analytics');
const { getScopeFunnel, getSignupFunnel } = require('../db/events');
const { getLeadStatusCounts } = require('../db/leads');
const { getContractorCounts } = require('../db/contractors');
const { getFoundingCount, FOUNDING_LIMIT } = require('../db/founding');
const { getUtmBreakdown } = require('../db/analytics');

// Required env var (enforced at boot in server.js). See routes/admin.js for the
// reasoning — no hardcoded fallback so the repo can't leak it.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function requireAdmin(req, res, next) {
  // Session-based: logged-in contractor with is_admin=true. Preferred.
  if (req.session && req.session.isAdmin) return next();

  // URL-key / Basic Auth fallback — only when ADMIN_PASSWORD is configured.
  if (ADMIN_PASSWORD && req.query.key === ADMIN_PASSWORD) return next();
  const authHeader = req.headers.authorization;
  if (ADMIN_PASSWORD && authHeader && authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
    const [, password] = decoded.split(':');
    if (password === ADMIN_PASSWORD) return next();
  }
  res.status(401).json({ error: 'Authentication required' });
}

/**
 * GET /api/admin/metrics
 * Protected JSON endpoint returning platform analytics:
 *   - Page view counts (today/7d/30d) + unique visitors
 *   - Lead funnel counts
 *   - Signup counts
 *   - Top referrers
 *   - UTM breakdown
 */
router.get('/metrics', requireAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 30;

    const [
      pageViews,        // from page_views (existing table)
      analyticsPV,      // from analytics_events (new table)
      leadSubmissions,  // from lead_events
      leadStatusCounts, // from leads
      contractorCounts, // from contractors
      topReferrers,     // from analytics_events
      scopeFunnel,      // from events
      signupFunnel,     // from events
      foundingRemaining, // from founding_config
      utmBreakdown      // from analytics_events
    ] = await Promise.all([
      getPageViewCounts(),
      getAnalyticsPageViewCounts(),
      getLeadSubmissionCounts(),
      getLeadStatusCounts(),
      getContractorCounts(),
      getAnalyticsTopReferrers(days, 10),
      getScopeFunnel(days),
      getSignupFunnel(days),
      getFoundingCount(),
      getUtmBreakdown(days, 10)
    ]);

    res.json({
      generated_at: new Date().toISOString(),
      window_days: days,

      page_views: {
        today:     parseInt(pageViews.views_today || 0, 10),
        last_7d:   parseInt(pageViews.views_7d || 0, 10),
        last_30d:  parseInt(pageViews.views_30d || 0, 10)
      },

      unique_visitors: {
        today:     parseInt(pageViews.unique_today || 0, 10),
        last_7d:   parseInt(pageViews.unique_7d || 0, 10),
        last_30d:  parseInt(pageViews.unique_30d || 0, 10)
      },

      // analytics_events-backed page views (UTM-aware)
      analytics_page_views: {
        today:     parseInt(analyticsPV.views_today || 0, 10),
        last_7d:   parseInt(analyticsPV.views_7d || 0, 10),
        last_30d:  parseInt(analyticsPV.views_30d || 0, 10)
      },

      lead_funnel: {
        today:     parseInt(leadSubmissions.leads_today || 0, 10),
        last_7d:   parseInt(leadSubmissions.leads_7d || 0, 10),
        last_30d:  parseInt(leadSubmissions.leads_30d || 0, 10),
        total:     parseInt(leadStatusCounts.total || 0, 10),
        by_status: {
          routed:           parseInt(leadStatusCounts.routed || 0, 10),
          passed:           parseInt(leadStatusCounts.passed || 0, 10),
          claimed_from_board: parseInt(leadStatusCounts.claimed_from_board || 0, 10),
          expired:          parseInt(leadStatusCounts.expired || 0, 10)
        }
      },

      signup_counts: {
        started:   signupFunnel.find(s => s.event_type === 'contractor_signup_started')?.count || 0,
        completed: signupFunnel.find(s => s.event_type === 'contractor_signup_completed')?.count || 0
      },

      scope_funnel: scopeFunnel.map(s => ({
        step:  s.event_type,
        count: s.count
      })),

      top_referrers: topReferrers.map(r => ({
        referrer: r.referrer,
        views:   parseInt(r.views, 10)
      })),

      utm_breakdown: utmBreakdown.map(u => ({
        source:   u.utm_source,
        medium:   u.utm_medium || null,
        campaign: u.utm_campaign || null,
        events:   parseInt(u.events, 10)
      })),

      platform: {
        total_contractors: contractorCounts.total,
        active_contractors: contractorCounts.active,
        founding_spots_remaining: Math.max(0, FOUNDING_LIMIT - foundingRemaining),
        founding_spots_total: FOUNDING_LIMIT
      }
    });
  } catch (err) {
    console.error('GET /api/admin/metrics error:', err);
    res.status(500).json({ error: 'Failed to load metrics' });
  }
});

module.exports = router;