/**
 * Owns: /admin/* — operator admin panel pages and API endpoints.
 * Does NOT own: contractor auth, lead submission, territory billing (those live in their own routes).
 */
const express = require('express');
const router = express.Router();
const {
  getPageViewCounts,
  getTopPages,
  getTopReferrers,
  getLeadEventCounts,
  getLeadSubmissionCounts
} = require('../db/analytics');
const { getFoundingFunnel, getScopeFunnel, getSignupFunnel } = require('../db/events');
const { getAllLeadsForAdmin, getLeadStatusCounts } = require('../db/leads');
const { getAllContractorsForAdmin, suspendContractor, activateContractor, getContractorCounts } = require('../db/contractors');
const { getAllClaimsForMap } = require('../db/territory');
const { getFoundingCount, FOUNDING_LIMIT } = require('../db/founding');
const { getAuthLogs } = require('../db/auth-logs');

// ADMIN_PASSWORD is required (enforced at boot in server.js). No hardcoded
// fallback — the previous default ('scopilot-admin-2026') leaked through the
// repo, so anyone who read the source could log into /admin if the env var
// hadn't been rotated.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || '';

// ── Mapbox geocoding helper (shared with territory routes) ────────────────────

/**
 * Fetch the lat/lng centroid for a ZIP using Mapbox Geocoding API.
 * Returns { lat, lng } or null if not found.
 */
async function getZipCentroid(zip) {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) return null;
  try {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${zip}.json?country=US&types=postcode&limit=1&access_token=${encodeURIComponent(token)}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.features || !data.features.length) return null;
    const [lng, lat] = data.features[0].center;
    return { lat, lng };
  } catch {
    return null;
  }
}

/**
 * Geocode all unique ZIPs from active territory claims.
 * Returns a Map: zip_code → { lat, lng }.
 * Falls back to null for ZIPs that fail to geocode.
 */
async function geocodeZipCentroids(claims) {
  const uniqueZips = [...new Set(claims.filter(c => c.status === 'active').map(c => c.zip_code))];
  const centroidMap = {};
  await Promise.all(uniqueZips.map(async (zip) => {
    centroidMap[zip] = await getZipCentroid(zip);
  }));
  return centroidMap;
}

// ── Auth Middleware ─────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  // Path 1: contractor logged in AND flagged as admin. This is the preferred
  // path — the operator opens /admin in a browser where they're already
  // signed in to their contractor account, no password key needed.
  if (req.session && req.session.isAdmin) return next();

  // Path 2: URL key matches ADMIN_PASSWORD env var. Kept for backwards
  // compat (scripts, curl, situations where there's no session). When the
  // env var is unset, this path is unreachable — only session-based admin
  // works.
  if (ADMIN_PASSWORD && req.query.key === ADMIN_PASSWORD) return next();

  // Path 3: HTTP Basic Auth — same env var, useful for curl.
  const authHeader = req.headers.authorization;
  if (ADMIN_PASSWORD && authHeader && authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
    const [, password] = decoded.split(':');
    if (password === ADMIN_PASSWORD) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Scopilot Admin"');
  res.status(401).send('Authentication required — log in as an admin contractor or supply a valid ?key=…');
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function num(v) {
  return Number(v || 0).toLocaleString();
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function statusBadge(status) {
  const map = {
    routed: ['routed', '#10b981'],
    passed: ['passed', '#f59e0b'],
    claimed_from_board: ['claimed', '#3b82f6'],
    expired: ['expired', '#6b7280'],
  };
  const [label, color] = map[status] || [status || 'new', '#6b7280'];
  return `<span style="background:${color}22;color:${color};border:1px solid ${color}44;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600">${label}</span>`;
}

function planBadge(contractor) {
  // legacy_free: operator-gifted permanent account — always shown first
  if (contractor.legacy_free) return `<span style="background:#7c3aed22;color:#a78bfa;border:1px solid #7c3aed44;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600">LEGACY</span>`;
  if (contractor.founding_member) return `<span style="background:#d4a01733;color:#d4a017;border:1px solid #d4a01744;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600">★ Founding</span>`;
  const plan = contractor.plan || 'free';
  if (plan === 'lifetime') return `<span style="background:#10b98122;color:#10b981;border:1px solid #10b98144;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600">Lifetime</span>`;
  return `<span style="background:#374151;color:#9ca3af;border:1px solid #374151;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600">${plan}</span>`;
}

// ── Nav Layout Wrapper ───────────────────────────────────────────────────────

function adminLayout({ title, section, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} — Scopilot Admin</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e0e0e0; min-height: 100vh; }
    :root { --gold: #d4a017; --bg: #0f1117; --card: #1a1d28; --border: #2a2d3a; --text: #e0e0e0; --muted: #888; }
    .topbar { background: #14161e; border-bottom: 1px solid var(--border); padding: 0 24px; display: flex; align-items: center; gap: 0; height: 56px; position: sticky; top: 0; z-index: 50; }
    .topbar-logo { color: var(--gold); font-size: 1rem; font-weight: 700; letter-spacing: 1px; text-decoration: none; padding-right: 24px; border-right: 1px solid var(--border); margin-right: 24px; white-space: nowrap; }
    .topbar-logo span { color: var(--muted); font-weight: 400; font-size: 0.75rem; }
    .nav-links { display: flex; gap: 4px; flex-wrap: wrap; }
    .nav-link { color: var(--muted); text-decoration: none; padding: 6px 14px; border-radius: 6px; font-size: 0.8rem; font-weight: 500; transition: all 0.15s; }
    .nav-link:hover { color: var(--text); background: var(--border); }
    .nav-link.active { color: var(--gold); background: #d4a01715; }
    .main { padding: 28px 24px; max-width: 1400px; margin: 0 auto; }
    h1 { color: var(--gold); font-size: 1.4rem; margin-bottom: 4px; }
    .subtitle { color: var(--muted); font-size: 0.8rem; margin-bottom: 28px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-bottom: 20px; }
    .card h2 { color: var(--gold); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.5px; }
    td { padding: 10px 12px; border-bottom: 1px solid #1e2130; font-size: 0.825rem; vertical-align: middle; }
    tr:hover td { background: #1e2130; }
    .num { text-align: right; font-variant-numeric: tabular-nums; color: #fff; }
    .truncate { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
    .section-nav { display: flex; gap: 8px; margin-bottom: 24px; flex-wrap: wrap; }
    .section-btn { padding: 8px 20px; border-radius: 8px; font-size: 0.8rem; font-weight: 600; text-decoration: none; border: 1px solid var(--border); color: var(--muted); background: var(--card); transition: all 0.15s; }
    .section-btn:hover { color: var(--text); border-color: var(--gold); }
    .section-btn.active { background: var(--gold); color: #0f1117; border-color: var(--gold); }
    .action-btn { padding: 4px 12px; border-radius: 6px; font-size: 0.75rem; font-weight: 600; border: 1px solid; cursor: pointer; text-decoration: none; display: inline-block; }
    .action-btn.suspend { color: #ef4444; border-color: #ef444444; background: #ef444411; }
    .action-btn.suspend:hover { background: #ef444422; }
    .action-btn.activate { color: #10b981; border-color: #10b98144; background: #10b98111; }
    .action-btn.activate:hover { background: #10b98122; }
    .detail-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 10px; }
    .detail-label { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
    .detail-value { color: var(--text); font-size: 0.85rem; }
    .photo-grid { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .photo-grid img { width: 100px; height: 80px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border); }
    .lead-detail { display: none; padding: 16px; background: #14161e; border-radius: 8px; margin: 8px 0; border: 1px solid var(--border); }
    .lead-detail.open { display: block; }
    .lead-row { cursor: pointer; }
    .lead-row:hover { background: #1e2130; }
    .lead-expand-icon { color: var(--gold); margin-right: 8px; transition: transform 0.2s; }
    .lead-detail.open .lead-expand-icon { transform: rotate(90deg); }
    #map { height: 500px; border-radius: 8px; }
    .map-info { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 20px; }
    .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 20px; }
    .stat-card .big { font-size: 1.75rem; color: #fff; font-weight: 700; line-height: 1; }
    .stat-card .label { color: var(--muted); font-size: 0.75rem; margin-top: 4px; }
    .stat-card .sub { color: var(--gold); font-size: 0.75rem; margin-top: 8px; }
    .badge { padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
    .badge-suspended { background: #ef444422; color: #ef4444; border: 1px solid #ef444444; }
    .tabs { display: flex; gap: 8px; margin-bottom: 24px; }
    .tab { padding: 8px 16px; border-radius: 6px; font-size: 0.8rem; font-weight: 600; text-decoration: none; border: 1px solid var(--border); color: var(--muted); }
    .tab:hover { color: var(--text); }
    .tab.active { background: var(--gold); color: #0f1117; border-color: var(--gold); }
    @media (max-width: 768px) {
      body { padding: 0; }
      .main { padding: 16px 12px; }
      .topbar { padding: 0 12px; }
      .nav-link { font-size: 0.75rem; padding: 5px 10px; }
      .detail-row { grid-template-columns: 1fr; }
      #map { height: 350px; }
    }
  </style>
</head>
<body>
  <div class="topbar">
    <a href="/admin" class="topbar-logo">SCOPILOT ADMIN <span>Operator Panel</span></a>
    <nav class="nav-links">
      <a href="/admin/leads" class="nav-link ${section === 'leads' ? 'active' : ''}">Leads</a>
      <a href="/admin/contractors" class="nav-link ${section === 'contractors' ? 'active' : ''}">Contractors</a>
      <a href="/admin/territory" class="nav-link ${section === 'territory' ? 'active' : ''}">Territory</a>
      <a href="/admin/analytics" class="nav-link ${section === 'analytics' ? 'active' : ''}">Analytics</a>
      <a href="/admin/metrics" class="nav-link">Metrics</a>
      <a href="/admin/funnel" class="nav-link">Funnel</a>
      <a href="/admin/logs" class="nav-link ${section === 'logs' ? 'active' : ''}">Logs</a>
    </nav>
  </div>
  <div class="main">
    ${body}
  </div>
</body>
</html>`;
}

// ── GET /admin — Index ───────────────────────────────────────────────────────

router.get('/', requireAdmin, async (req, res) => {
  try {
    const section = 'home';
    const [
      pageViews, leadSubmissions, leadStatusCounts, contractorCounts, territoryClaims, foundingClaimed
    ] = await Promise.all([
      getPageViewCounts(),
      getLeadSubmissionCounts(),
      getLeadStatusCounts(),
      getContractorCounts(),
      getAllClaimsForMap(),
      getFoundingCount()
    ]);
    const foundingRemaining = Math.max(0, FOUNDING_LIMIT - foundingClaimed);

    const activeTerritories = territoryClaims.filter(c => c.status === 'active').length;
    const uniqueZips = new Set(territoryClaims.filter(c => c.status === 'active').map(c => c.zip_code)).size;

    const body = `
      <h1>Scopilot Admin</h1>
      <p class="subtitle">Platform overview — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</p>

      <div class="map-info">
        <div class="stat-card">
          <div class="big">${num(leadStatusCounts.total)}</div>
          <div class="label">Total Leads</div>
          <div class="sub">${num(leadSubmissions.leads_7d)} this week · ${num(leadSubmissions.leads_30d)} this month</div>
        </div>
        <div class="stat-card">
          <div class="big">${num(contractorCounts.total)}</div>
          <div class="label">Contractors</div>
          <div class="sub">${num(contractorCounts.active)} active · ${num(contractorCounts.suspended)} suspended · ${num(contractorCounts.founding)} founding</div>
        </div>
        <div class="stat-card">
          <div class="big">${uniqueZips}</div>
          <div class="label">Claimed ZIPs</div>
          <div class="sub">${activeTerritories} active claims across all contractors</div>
        </div>
        <div class="stat-card">
          <div class="big">${num(pageViews.views_30d)}</div>
          <div class="label">Page Views (30d)</div>
          <div class="sub">${num(pageViews.unique_30d)} unique sessions</div>
        </div>
        <div class="stat-card" style="border-color: rgba(212,160,23,0.4);">
          <div class="big" style="color:#d4a017">${foundingRemaining}</div>
          <div class="label">Founding Spots Remaining</div>
          <div class="sub">${foundingClaimed} of ${FOUNDING_LIMIT} claimed · <a href="/founding" target="_blank" style="color:#d4a017;text-decoration:none;">View Page →</a></div>
        </div>
      </div>

      <h1 style="font-size:1rem;margin-top:28px;margin-bottom:12px;color:#888;text-transform:uppercase;letter-spacing:1px">Quick Actions</h1>
      <div class="section-nav">
        <a href="/admin/leads" class="section-btn ${section === 'leads' ? 'active' : ''}">📋 Lead Overview →</a>
        <a href="/admin/contractors" class="section-btn ${section === 'contractors' ? 'active' : ''}">👷 Contractor Accounts →</a>
        <a href="/admin/territory" class="section-btn ${section === 'territory' ? 'active' : ''}">🗺️ Territory Map →</a>
        <a href="/admin/analytics" class="section-btn ${section === 'analytics' ? 'active' : ''}">📊 Analytics Summary →</a>
      </div>

      <h1 style="font-size:1rem;margin-top:28px;margin-bottom:12px;color:#888;text-transform:uppercase;letter-spacing:1px">Lead Status Breakdown</h1>
      <div class="card">
        <h2>Leads by Status</h2>
        <table>
          <thead><tr><th>Status</th><th style="text-align:right">Count</th><th style="text-align:right">%</th></tr></thead>
          <tbody>
            ${[
              { label: 'Routed / New', key: 'routed', count: leadStatusCounts.routed },
              { label: 'Passed', key: 'passed', count: leadStatusCounts.passed },
              { label: 'Claimed from Board', key: 'claimed_from_board', count: leadStatusCounts.claimed_from_board },
              { label: 'Expired', key: 'expired', count: leadStatusCounts.expired },
            ].map(s => {
              const pct = leadStatusCounts.total > 0 ? Math.round((s.count / leadStatusCounts.total) * 100) : 0;
              return `<tr><td>${s.label}</td><td class="num">${num(s.count)}</td><td class="num" style="color:var(--muted)">${pct}%</td></tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    res.send(adminLayout({ title: 'Admin Home', section: 'home', body }));
  } catch (err) {
    console.error('Admin index error:', err);
    res.status(500).send('Failed to load admin home');
  }
});

// ── GET /admin/leads — Lead Overview ────────────────────────────────────────

router.get('/leads', requireAdmin, async (req, res) => {
  try {
    const leads = await getAllLeadsForAdmin({ limit: 500 });

    const rows = leads.map(lead => {
      const estimateRange = lead.estimate_low && lead.estimate_high
        ? `$${Number(lead.estimate_low).toLocaleString()}–$${Number(lead.estimate_high).toLocaleString()}`
        : lead.estimate_low ? `$${Number(lead.estimate_low).toLocaleString()}+` : '—';
      const photos = JSON.parse(JSON.stringify(lead.photos || []));

      return `
      <tr class="lead-row" onclick="toggleDetail(${lead.id})">
        <td><span class="lead-expand-icon">▶</span>${fmtDate(lead.created_at)}</td>
        <td>${esc(lead.homeowner_name || '—')}</td>
        <td><span class="truncate" title="${esc(lead.address || '')}">${esc(lead.address || '—')}</span><span style="color:var(--muted);font-size:0.75rem">${lead.zip_code ? ' · ' + lead.zip_code : ''}</span></td>
        <td>${esc(lead.project_type || '—')}</td>
        <td class="num">${lead.sq_footage ? num(lead.sq_footage) + ' sf' : '—'}</td>
        <td class="num">${estimateRange}</td>
        <td>${statusBadge(lead.lead_status)}</td>
        <td>${esc(lead.contractor_name || '—')}</td>
      </tr>
      <tr>
        <td colspan="8" style="padding:0;border-bottom:none">
          <div class="lead-detail" id="detail-${lead.id}">
            <div class="detail-row">
              <div><div class="detail-label">Homeowner</div><div class="detail-value">${esc(lead.homeowner_name || '—')}</div></div>
              <div><div class="detail-label">Email</div><div class="detail-value">${esc(lead.homeowner_email || '—')}</div></div>
              <div><div class="detail-label">Phone</div><div class="detail-value">${esc(lead.homeowner_phone || '—')}</div></div>
              <div><div class="detail-label">Submitted</div><div class="detail-value">${fmtDate(lead.created_at)}</div></div>
              <div><div class="detail-label">Trade Type</div><div class="detail-value">${esc(lead.project_type || '—')}</div></div>
              <div><div class="detail-label">Sq Footage</div><div class="detail-value">${lead.sq_footage ? num(lead.sq_footage) + ' sq ft' : '—'}</div></div>
              <div><div class="detail-label">Estimate Range</div><div class="detail-value">${estimateRange}</div></div>
              <div><div class="detail-label">ZIP Code</div><div class="detail-value">${lead.zip_code || '—'}</div></div>
              <div><div class="detail-label">Lead Status</div><div class="detail-value">${statusBadge(lead.lead_status)}</div></div>
              <div><div class="detail-label">Assigned Contractor</div><div class="detail-value">${esc(lead.contractor_name || 'Unassigned')} ${lead.contractor_email ? '(' + lead.contractor_email + ')' : ''}</div></div>
              ${lead.first_response_at ? `<div><div class="detail-label">First Response</div><div class="detail-value">${fmtDate(lead.first_response_at)}</div></div>` : ''}
              ${lead.homeowner_rating ? `<div><div class="detail-label">Homeowner Rating</div><div class="detail-value">${'★'.repeat(lead.homeowner_rating)}${'☆'.repeat(5 - lead.homeowner_rating)} (${lead.homeowner_rating}/5)</div></div>` : ''}
              ${lead.passed_at ? `<div><div class="detail-label">Passed At</div><div class="detail-value">${fmtDate(lead.passed_at)}</div></div>` : ''}
            </div>
            ${lead.trade_inputs ? `
            <div style="margin-top:12px">
              <div class="detail-label">Q&amp;A Responses</div>
              <pre style="background:#0f1117;border:1px solid var(--border);border-radius:6px;padding:12px;font-size:0.8rem;white-space:pre-wrap;color:#c0c0d0;margin-top:6px">${esc(JSON.stringify(JSON.parse(JSON.stringify(lead.trade_inputs)), null, 2))}</pre>
            </div>` : ''}
            ${lead.notes ? `<div style="margin-top:12px"><div class="detail-label">Notes</div><div class="detail-value" style="margin-top:4px">${esc(lead.notes)}</div></div>` : ''}
            ${photos.length > 0 ? `
            <div style="margin-top:12px">
              <div class="detail-label">Photos (${photos.length})</div>
              <div class="photo-grid">
                ${photos.map(p => `<img src="${esc(p)}" alt="Lead photo" loading="lazy" onerror="this.style.display='none'">`).join('')}
              </div>
            </div>` : ''}
          </div>
        </td>
      </tr>`;
    }).join('');

    const body = `
      <h1>Lead Overview</h1>
      <p class="subtitle">${num(leads.length)} total leads — click any row to expand details</p>

      <div class="card" style="overflow-x:auto">
        <table>
          <thead><tr>
            <th>Date</th>
            <th>Homeowner</th>
            <th>Address / ZIP</th>
            <th>Trade</th>
            <th style="text-align:right">Sq Ft</th>
            <th style="text-align:right">Estimate</th>
            <th>Status</th>
            <th>Contractor</th>
          </tr></thead>
          <tbody>
            ${rows || '<tr><td colspan="8" style="color:var(--muted);text-align:center;padding:32px">No leads yet</td></tr>'}
          </tbody>
        </table>
      </div>

      <script>
      function toggleDetail(id) {
        var el = document.getElementById('detail-' + id);
        var rows = document.querySelectorAll('.lead-detail');
        rows.forEach(function(r) { if (r !== el) r.classList.remove('open'); });
        el.classList.toggle('open');
      }
      </script>
    `;

    res.send(adminLayout({ title: 'Lead Overview', section: 'leads', body }));
  } catch (err) {
    console.error('Admin leads error:', err);
    res.status(500).send('Failed to load leads');
  }
});

// ── GET /admin/contractors — Contractor Accounts ─────────────────────────────

router.get('/contractors', requireAdmin, async (req, res) => {
  try {
    const contractors = await getAllContractorsForAdmin();

    const rows = contractors.map(c => `
      <tr>
        <td><strong>${esc(c.business_name)}</strong>${c.is_suspended ? ' <span class="badge badge-suspended">Suspended</span>' : ''}</td>
        <td>${esc(c.email)}</td>
        <td>${planBadge(c)}</td>
        <td>${esc(c.trade_type)}</td>
        <td class="num">${c.territory_claims_count}</td>
        <td class="num">${c.leads_count}</td>
        <td>${fmtDate(c.created_at)}</td>
        <td>
          ${c.is_suspended
            ? `<a href="/admin/contractors/${c.id}/activate?key=${ADMIN_PASSWORD}" class="action-btn activate" onclick="return confirm('Activate this contractor?')">Activate</a>`
            : `<a href="/admin/contractors/${c.id}/suspend?key=${ADMIN_PASSWORD}" class="action-btn suspend" onclick="return confirm('Suspend this contractor?')">Suspend</a>`
          }
        </td>
      </tr>
    `).join('');

    const body = `
      <h1>Contractor Accounts</h1>
      <p class="subtitle">${num(contractors.length)} total contractors</p>

      <div class="card" style="overflow-x:auto">
        <table>
          <thead><tr>
            <th>Business Name</th>
            <th>Email</th>
            <th>Plan</th>
            <th>Trade</th>
            <th style="text-align:right">Territory Zips</th>
            <th style="text-align:right">Leads</th>
            <th>Signup Date</th>
            <th>Actions</th>
          </tr></thead>
          <tbody>
            ${rows || '<tr><td colspan="8" style="color:var(--muted);text-align:center;padding:32px">No contractors yet</td></tr>'}
          </tbody>
        </table>
      </div>
    `;

    res.send(adminLayout({ title: 'Contractor Accounts', section: 'contractors', body }));
  } catch (err) {
    console.error('Admin contractors error:', err);
    res.status(500).send('Failed to load contractors');
  }
});

// ── POST /admin/contractors/:id/suspend ─────────────────────────────────────

router.post('/contractors/:id/suspend', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const result = await suspendContractor(id);
    if (!result) return res.status(404).send('Contractor not found');
    res.redirect(`/admin/contractors?key=${ADMIN_PASSWORD}`);
  } catch (err) {
    console.error('Suspend contractor error:', err);
    res.status(500).send('Failed to suspend contractor');
  }
});

// ── POST /admin/contractors/:id/activate ────────────────────────────────────

router.post('/contractors/:id/activate', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const result = await activateContractor(id);
    if (!result) return res.status(404).send('Contractor not found');
    res.redirect(`/admin/contractors?key=${ADMIN_PASSWORD}`);
  } catch (err) {
    console.error('Activate contractor error:', err);
    res.status(500).send('Failed to activate contractor');
  }
});

// ── GET /admin/territory — Territory Map ────────────────────────────────────

router.get('/territory', requireAdmin, async (req, res) => {
  try {
    const claims = await getAllClaimsForMap();

    const activeClaims = claims.filter(c => c.status === 'active');
    const uniqueZips = [...new Set(activeClaims.map(c => c.zip_code))];
    const contractors = [...new Set(activeClaims.map(c => c.contractor_id))];

    // Build contractor color map
    const contractorColors = {};
    const colorPalette = ['#d4a017', '#10b981', '#3b82f6', '#ef4444', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4'];
    const contractorNames = {};
    activeClaims.forEach(c => {
      if (!contractorColors[c.contractor_id]) {
        const idx = Object.keys(contractorColors).length % colorPalette.length;
        contractorColors[c.contractor_id] = colorPalette[idx];
      }
      contractorNames[c.contractor_id] = c.contractor_name;
    });

    // Geocode all unique ZIPs to real lat/lng centroids — skip approximation
    const centroidMap = await geocodeZipCentroids(claims);

    // Build zip data for Mapbox with real coordinates
    const zipData = activeClaims.map(c => ({
      zip: c.zip_code,
      contractor_id: c.contractor_id,
      contractor_name: c.contractor_name,
      color: contractorColors[c.contractor_id],
      status: c.status,
      claimed_at: c.claimed_at,
      leads_received: c.leads_received,
      lat: centroidMap[c.zip_code]?.lat ?? null,
      lng: centroidMap[c.zip_code]?.lng ?? null,
    }));

    // Compute map center from geocoded ZIPs, fallback to US center
    const validCoords = zipData.filter(z => z.lat != null && z.lng != null);
    const mapCenter = validCoords.length > 0
      ? [
          validCoords.reduce((s, z) => s + z.lng, 0) / validCoords.length,
          validCoords.reduce((s, z) => s + z.lat, 0) / validCoords.length,
        ]
      : [-98.5, 39.8];

    // Zoom in to relevant region when we have ZIPs to show
    const mapZoom = validCoords.length > 0 ? 7 : 4;

    const mapScript = MAPBOX_TOKEN ? `
    <script src="https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.js"></script>
    <link href="https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.css" rel="stylesheet" />
    ` : '';

    const mapInit = MAPBOX_TOKEN ? `
    <script>
    mapboxgl.accessToken = ${JSON.stringify(MAPBOX_TOKEN)};
    const map = new mapboxgl.Map({ container: 'map', style: 'mapbox://styles/mapbox/dark-v11', center: ${JSON.stringify(mapCenter)}, zoom: ${mapZoom} });
    const claims = ${JSON.stringify(zipData)};
    const colorMap = ${JSON.stringify(contractorColors)};

    // Add claim markers at real Mapbox-geocoded ZIP centroids
    claims.forEach(function(claim) {
      if (claim.lat == null || claim.lng == null) return; // skip un-geocoded ZIPs

      const el = document.createElement('div');
      el.style.cssText = 'width:28px;height:28px;background:' + claim.color + ';border:2px solid #0f1117;border-radius:50%;cursor:pointer;box-shadow:0 0 8px ' + claim.color + '80';
      el.title = claim.zip + ' — ' + claim.contractor_name;

      new mapboxgl.Marker(el)
        .setLngLat([claim.lng, claim.lat])
        .setPopup(new mapboxgl.Popup({ offset: 15 }).setHTML(
          '<div style="padding:8px;font-family:system-ui;font-size:13px;line-height:1.5">' +
          '<strong style="color:#d4a017;font-size:15px">' + claim.zip + '</strong><br>' +
          '<span style="color:#10b981;font-weight:600">' + claim.contractor_name + '</span><br>' +
          '<span style="color:#888;font-size:11px">Claimed: ' + new Date(claim.claimed_at).toLocaleDateString() + '</span><br>' +
          '<span style="color:#888;font-size:11px">Leads received: ' + claim.leads_received + '</span>' +
          '</div>'
        ))
        .addTo(map);
    });
    </script>` : '';

    const body = `
      <h1>Territory Map</h1>
      <p class="subtitle">${uniqueZips.length} claimed ZIPs · ${contractors.length} contractors · ${activeClaims.length} active claims</p>

      <div class="map-info">
        <div class="stat-card"><div class="big">${uniqueZips.length}</div><div class="label">Unique ZIPs Claimed</div></div>
        <div class="stat-card"><div class="big">${contractors.length}</div><div class="label">Contractors with Territory</div></div>
        <div class="stat-card"><div class="big">${activeClaims.length}</div><div class="label">Total Active Claims</div></div>
      </div>

      ${MAPBOX_TOKEN ? '<div id="map" style="height:500px;border-radius:10px;border:1px solid #2a2d3a;margin-bottom:24px"></div>__MAP_PLACEHOLDER__' : ''}

      <h1 style="font-size:1rem;margin-bottom:12px;color:#888;text-transform:uppercase;letter-spacing:1px">Claimed ZIPs by Contractor</h1>
      <div class="card" style="overflow-x:auto">
        <table>
          <thead><tr>
            <th>ZIP</th>
            <th>Contractor</th>
            <th>Status</th>
            <th>Claimed At</th>
            <th style="text-align:right">Leads</th>
            <th>Plan</th>
          </tr></thead>
          <tbody>
            ${activeClaims.map(c => `
            <tr>
              <td><strong>${esc(c.zip_code)}</strong></td>
              <td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${contractorColors[c.contractor_id]};margin-right:6px;vertical-align:middle"></span>${esc(c.contractor_name)}</td>
              <td>${statusBadge(c.status)}</td>
              <td>${fmtDate(c.claimed_at)}</td>
              <td class="num">${c.leads_received}</td>
              <td>${c.is_included_in_plan ? '<span style="color:#10b981;font-size:11px">Included</span>' : '<span style="color:#d4a017;font-size:11px">$' + (c.monthly_price_cents / 100) + '/mo</span>'}</td>
            </tr>`).join('')}
            ${activeClaims.length === 0 ? '<tr><td colspan="6" style="color:#888;text-align:center;padding:32px">No active territory claims</td></tr>' : ''}
          </tbody>
        </table>
      </div>
    `;

    const html = adminLayout({ title: 'Territory Map', section: 'territory', body });
    let response = html;
    if (MAPBOX_TOKEN) {
      response = response.replace('</head>', mapScript + '</head>');
      response = response.replace('__MAP_PLACEHOLDER__', mapInit);
    } else {
      response = response.replace('__MAP_PLACEHOLDER__', '');
    }
    res.send(response);
  } catch (err) {
    console.error('Admin territory error:', err);
    res.status(500).send('Failed to load territory');
  }
});

// ── GET /admin/analytics — Analytics Summary ────────────────────────────────

router.get('/analytics', requireAdmin, async (req, res) => {
  try {
    const [
      pageViews, leadSubmissions, leadStatusCounts,
      contractorCounts, territoryClaims
    ] = await Promise.all([
      getPageViewCounts(),
      getLeadSubmissionCounts(),
      getLeadStatusCounts(),
      getContractorCounts(),
      getAllClaimsForMap()
    ]);

    const activeClaims = territoryClaims.filter(c => c.status === 'active');
    const uniqueZips = new Set(activeClaims.map(c => c.zip_code)).size;
    const totalLeads = parseInt(leadStatusCounts.total, 10);

    const body = `
      <h1>Analytics Summary</h1>
      <p class="subtitle">Platform-wide metrics — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</p>

      <div class="map-info">
        <div class="stat-card">
          <div class="big">${num(totalLeads)}</div>
          <div class="label">Total Leads (All Time)</div>
          <div class="sub">${num(leadSubmissions.leads_7d)} this week · ${num(leadSubmissions.leads_30d)} this month</div>
        </div>
        <div class="stat-card">
          <div class="big">${num(contractorCounts.total)}</div>
          <div class="label">Total Contractors</div>
          <div class="sub">${num(contractorCounts.active)} active · ${num(contractorCounts.suspended)} suspended</div>
        </div>
        <div class="stat-card">
          <div class="big">${uniqueZips}</div>
          <div class="label">Covered ZIPs</div>
          <div class="sub">${activeClaims.length} total active claims</div>
        </div>
        <div class="stat-card">
          <div class="big">${num(pageViews.views_30d)}</div>
          <div class="label">Page Views (30d)</div>
          <div class="sub">${num(pageViews.unique_30d)} unique sessions</div>
        </div>
      </div>

      <h1 style="font-size:1rem;margin-top:28px;margin-bottom:12px;color:#888;text-transform:uppercase;letter-spacing:1px">Leads by Status</h1>
      <div class="card">
        <h2>Lead Status Breakdown</h2>
        <table>
          <thead><tr><th>Status</th><th style="text-align:right">Count</th><th style="text-align:right">% of Total</th></tr></thead>
          <tbody>
            ${[
              { label: 'Routed / New', count: leadStatusCounts.routed },
              { label: 'Passed', count: leadStatusCounts.passed },
              { label: 'Claimed from Board', count: leadStatusCounts.claimed_from_board },
              { label: 'Expired', count: leadStatusCounts.expired },
            ].map(s => {
              const pct = totalLeads > 0 ? Math.round((s.count / totalLeads) * 100) : 0;
              const barWidth = totalLeads > 0 ? Math.max(2, (s.count / totalLeads) * 100) : 0;
              return `<tr>
                <td>${s.label}</td>
                <td class="num">${num(s.count)}</td>
                <td style="min-width:160px">
                  <div style="height:6px;background:#2a2d3a;border-radius:3px;overflow:hidden;margin-top:6px">
                    <div style="height:100%;width:${barWidth}%;background:#d4a017;border-radius:3px"></div>
                  </div>
                  <div style="color:var(--muted);font-size:11px;margin-top:2px">${pct}%</div>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>

      <h1 style="font-size:1rem;margin-top:28px;margin-bottom:12px;color:#888;text-transform:uppercase;letter-spacing:1px">Contractor Breakdown</h1>
      <div class="card">
        <h2>Contractors by Type</h2>
        <table>
          <thead><tr><th>Type</th><th style="text-align:right">Count</th><th style="text-align:right">% of Total</th></tr></thead>
          <tbody>
            ${[
              { label: 'Active', count: contractorCounts.active },
              { label: 'Suspended', count: contractorCounts.suspended },
              { label: 'Founding Members', count: contractorCounts.founding },
            ].map(s => {
              const pct = contractorCounts.total > 0 ? Math.round((s.count / contractorCounts.total) * 100) : 0;
              const barWidth = contractorCounts.total > 0 ? Math.max(2, (s.count / contractorCounts.total) * 100) : 0;
              return `<tr>
                <td>${s.label}</td>
                <td class="num">${num(s.count)}</td>
                <td style="min-width:160px">
                  <div style="height:6px;background:#2a2d3a;border-radius:3px;overflow:hidden;margin-top:6px">
                    <div style="height:100%;width:${barWidth}%;background:#d4a017;border-radius:3px"></div>
                  </div>
                  <div style="color:var(--muted);font-size:11px;margin-top:2px">${pct}%</div>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>

      <div class="tabs">
        <a href="/admin/metrics" class="tab">Detailed Metrics →</a>
        <a href="/admin/funnel" class="tab">Conversion Funnel →</a>
      </div>
    `;

    res.send(adminLayout({ title: 'Analytics Summary', section: 'analytics', body }));
  } catch (err) {
    console.error('Admin analytics error:', err);
    res.status(500).send('Failed to load analytics');
  }
});

// ── Legacy metrics/funnel routes (preserved from original) ─────────────────

router.get('/metrics', requireAdmin, async (req, res) => {
  try {
    const [pageViews, topPages, topReferrers, leadEvents, leadSubmissions] = await Promise.all([
      getPageViewCounts(),
      getTopPages(30, 10),
      getTopReferrers(30, 10),
      getLeadEventCounts(),
      getLeadSubmissionCounts()
    ]);

    const pv = pageViews;
    const le = leadEvents;
    const ls = leadSubmissions;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Scopilot — Admin Metrics</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e0e0e0; padding: 24px; }
    h1 { color: #d4a017; margin-bottom: 8px; font-size: 1.5rem; }
    .subtitle { color: #888; margin-bottom: 32px; font-size: 0.875rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; margin-bottom: 32px; }
    .card { background: #1a1d28; border: 1px solid #2a2d3a; border-radius: 10px; padding: 20px; }
    .card h2 { color: #d4a017; font-size: 0.875rem; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 8px 12px; border-bottom: 1px solid #2a2d3a; color: #888; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; }
    td { padding: 8px 12px; border-bottom: 1px solid #1e2130; font-size: 0.875rem; }
    .num { text-align: right; font-variant-numeric: tabular-nums; color: #fff; font-weight: 600; }
    .big-num { font-size: 1.75rem; color: #fff; font-weight: 700; line-height: 1; }
    .label { color: #888; font-size: 0.75rem; margin-top: 4px; }
    .stat-row { display: flex; gap: 24px; margin-bottom: 12px; }
    .stat { flex: 1; }
    .funnel-bar { height: 6px; background: #2a2d3a; border-radius: 3px; margin-top: 6px; overflow: hidden; }
    .funnel-fill { height: 100%; background: #d4a017; border-radius: 3px; }
    .truncate { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .nav { display: flex; gap: 12px; margin-bottom: 24px; }
    .nav a { color: #d4a017; text-decoration: none; font-size: 0.875rem; }
    @media (max-width: 600px) { body { padding: 12px; } .stat-row { flex-direction: column; gap: 12px; } }
  </style>
</head>
<body>
  <div class="nav">
    <a href="/admin">← Admin Home</a>
    <a href="/admin/funnel">Conversion Funnel →</a>
  </div>
  <h1>Scopilot Metrics</h1>
  <p class="subtitle">Updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</p>

  <div class="grid">
    <div class="card">
      <h2>Page Views</h2>
      <div class="stat-row">
        <div class="stat"><div class="big-num">${num(pv.views_today)}</div><div class="label">Today</div></div>
        <div class="stat"><div class="big-num">${num(pv.views_7d)}</div><div class="label">7 days</div></div>
        <div class="stat"><div class="big-num">${num(pv.views_30d)}</div><div class="label">30 days</div></div>
      </div>
    </div>
    <div class="card">
      <h2>Unique Sessions</h2>
      <div class="stat-row">
        <div class="stat"><div class="big-num">${num(pv.unique_today)}</div><div class="label">Today</div></div>
        <div class="stat"><div class="big-num">${num(pv.unique_7d)}</div><div class="label">7 days</div></div>
        <div class="stat"><div class="big-num">${num(pv.unique_30d)}</div><div class="label">30 days</div></div>
      </div>
    </div>
    <div class="card">
      <h2>Lead Submissions</h2>
      <div class="stat-row">
        <div class="stat"><div class="big-num">${num(ls.leads_today)}</div><div class="label">Today</div></div>
        <div class="stat"><div class="big-num">${num(ls.leads_7d)}</div><div class="label">7 days</div></div>
        <div class="stat"><div class="big-num">${num(ls.leads_30d)}</div><div class="label">30 days</div></div>
      </div>
    </div>
    <div class="card">
      <h2>Lead Funnel</h2>
      ${funnelRow('Submitted', le.total_submitted, le.total_submitted)}
      ${funnelRow('Viewed', le.total_viewed, le.total_submitted)}
      ${funnelRow('Contacted', le.total_contacted, le.total_submitted)}
      ${funnelRow('Quoted', le.total_quoted, le.total_submitted)}
      ${funnelRow('Won', le.total_won, le.total_submitted)}
      ${funnelRow('Lost', le.total_lost, le.total_submitted)}
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Top Pages (30d)</h2>
      <table>
        <thead><tr><th>Path</th><th style="text-align:right">Views</th></tr></thead>
        <tbody>
          ${topPages.map(p => `<tr><td class="truncate">${esc(p.path)}</td><td class="num">${num(p.views)}</td></tr>`).join('')}
          ${topPages.length === 0 ? '<tr><td colspan="2" style="color:#666">No data yet</td></tr>' : ''}
        </tbody>
      </table>
    </div>
    <div class="card">
      <h2>Top Referrers (30d)</h2>
      <table>
        <thead><tr><th>Referrer</th><th style="text-align:right">Views</th></tr></thead>
        <tbody>
          ${topReferrers.map(r => `<tr><td class="truncate">${esc(r.referrer)}</td><td class="num">${num(r.views)}</td></tr>`).join('')}
          ${topReferrers.length === 0 ? '<tr><td colspan="2" style="color:#666">No referrer data yet</td></tr>' : ''}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;
    res.send(html);
  } catch (err) {
    console.error('Admin metrics error:', err);
    res.status(500).send('Failed to load metrics');
  }
});

function funnelRow(label, count, total) {
  const c = Number(count || 0);
  const t = Number(total || 0);
  const pct = t > 0 ? Math.round((c / t) * 100) : 0;
  const width = t > 0 ? Math.max(2, (c / t) * 100) : 0;
  return `
    <div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:0.8rem">
        <span>${label}</span>
        <span class="num">${num(c)}${t > 0 && label !== 'Submitted' ? ` (${pct}%)` : ''}</span>
      </div>
      <div class="funnel-bar"><div class="funnel-fill" style="width:${width}%"></div></div>
    </div>`;
}

router.get('/funnel', requireAdmin, async (req, res) => {
  const days = req.query.days === '7' ? 7 : 30;
  try {
    const [foundingFunnel, scopeFunnel, signupFunnel] = await Promise.all([
      getFoundingFunnel(days),
      getScopeFunnel(days),
      getSignupFunnel(days)
    ]);
    res.send(renderFunnelPage({ foundingFunnel, scopeFunnel, signupFunnel, days }));
  } catch (err) {
    console.error('Admin funnel error:', err);
    res.status(500).send('Failed to load funnel');
  }
});

function renderFunnelPage({ foundingFunnel, scopeFunnel, signupFunnel, days }) {
  function funnelTable(title, steps, labelMap) {
    const topCount = steps[0]?.count || 0;
    const rows = steps.map((step, i) => {
      const pct = topCount > 0 ? Math.round((step.count / topCount) * 100) : 0;
      const label = labelMap[step.event_type] || step.event_type;
      const dropPct = i > 0 && steps[i-1].count > 0
        ? Math.round((1 - step.count / steps[i-1].count) * 100)
        : null;
      const barWidth = topCount > 0 ? Math.max(1, (step.count / topCount) * 100) : 0;
      return `
        <tr>
          <td style="padding:10px 12px;font-size:13px;color:#c8c8e0">${label}</td>
          <td style="padding:10px 12px;text-align:right;font-variant-numeric:tabular-nums;color:#fff;font-weight:600">${step.count.toLocaleString()}</td>
          <td style="padding:10px 12px;text-align:right;color:${i === 0 ? '#888' : pct > 50 ? '#4caf50' : '#e57373'}">${i === 0 ? '—' : pct + '%'}</td>
          <td style="padding:10px 12px;text-align:right;color:#888;font-size:12px">${dropPct !== null && i > 0 ? '-' + dropPct + '%' : '—'}</td>
          <td style="padding:10px 12px;min-width:140px">
            <div style="height:6px;background:#2a2d3a;border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${barWidth}%;background:#d4a017;border-radius:3px"></div>
            </div>
          </td>
        </tr>`;
    }).join('');
    return `
      <div class="card" style="margin-bottom:24px">
        <h2>${esc(title)}</h2>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr>
              <th style="text-align:left;padding:8px 12px;border-bottom:1px solid #2a2d3a;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Step</th>
              <th style="text-align:right;padding:8px 12px;border-bottom:1px solid #2a2d3a;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Count</th>
              <th style="text-align:right;padding:8px 12px;border-bottom:1px solid #2a2d3a;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.5px">vs Top</th>
              <th style="text-align:right;padding:8px 12px;border-bottom:1px solid #2a2d3a;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Drop</th>
              <th style="padding:8px 12px;border-bottom:1px solid #2a2d3a;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Bar</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  const foundingLabels = {
    founding_page_view: '① Page View',
    founding_cta_click: '② CTA Click',
    founding_checkout_started: '③ Checkout Started',
    founding_checkout_completed: '④ Checkout Completed'
  };
  const scopeLabels = {
    scope_started: '① Scope Started',
    scope_address_confirmed: '② Address Confirmed',
    scope_area_drawn: '③ Area Drawn',
    scope_photos_uploaded: '④ Photos Uploaded',
    scope_submitted: '⑤ Submitted'
  };
  const signupLabels = {
    contractor_signup_started: '① Signup Started',
    contractor_signup_completed: '② Signup Completed'
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Scopilot — Conversion Funnel</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f1117;color:#e0e0e0;padding:24px}
    h1{color:#d4a017;margin-bottom:6px;font-size:1.4rem}
    .subtitle{color:#888;margin-bottom:24px;font-size:.875rem}
    .tabs{display:flex;gap:8px;margin-bottom:28px}
    .tab{padding:6px 16px;border-radius:4px;font-size:.8rem;font-weight:600;text-decoration:none;border:1px solid #2a2d3a;color:#888}
    .tab:hover{color:#e0e0e0}
    .tab.active{background:#d4a017;color:#0f1117;border-color:#d4a017}
    .nav{color:#d4a017;text-decoration:none;font-size:.875rem;margin-bottom:16px;display:inline-block}
    .card{background:#1a1d28;border:1px solid #2a2d3a;border-radius:10px;padding:20px;margin-bottom:28px}
    .card h2{color:#d4a017;font-size:.8rem;text-transform:uppercase;letter-spacing:1px;margin-bottom:14px}
    @media(max-width:600px){body{padding:12px}}
  </style>
</head>
<body>
  <a href="/admin" class="nav">← Admin Home</a>
  <h1>Conversion Funnel</h1>
  <p class="subtitle">Last ${days} days — updated ${new Date().toISOString().slice(0,16).replace('T',' ')} UTC</p>
  <div class="tabs">
    <a href="/admin/funnel?days=7" class="tab ${days === 7 ? 'active' : ''}">Last 7 days</a>
    <a href="/admin/funnel?days=30" class="tab ${days === 30 ? 'active' : ''}">Last 30 days</a>
    <a href="/admin/metrics" class="tab">← Metrics</a>
  </div>
  ${funnelTable('Founding Page Conversion', foundingFunnel, foundingLabels)}
  ${funnelTable('Homeowner Scope Funnel', scopeFunnel, scopeLabels)}
  ${funnelTable('Contractor Signup Funnel', signupFunnel, signupLabels)}
</body>
</html>`;
}

// ── Help Page ────────────────────────────────────────────────────────────────

router.get('/help', requireAdmin, (req, res) => {
  const key = req.query.key || '';
  const keyParam = key ? `?key=${encodeURIComponent(key)}` : '';
  res.send(buildHelpPage(keyParam));
});

function buildHelpPage(keyParam) {
  const nav = (path, label) =>
    `<a href="/admin${path}${keyParam}" class="nav-link">${label}</a>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Scopilot — Access &amp; Testing Guide</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #e5e7eb; line-height: 1.6; }
    .header { background: #1a1a1a; border-bottom: 1px solid #333; padding: 16px 32px; display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
    .header h1 { font-size: 18px; font-weight: 700; color: #f5d76e; }
    .nav-link { color: #9ca3af; text-decoration: none; font-size: 13px; }
    .nav-link:hover { color: #f5d76e; }
    .print-btn { margin-left: auto; background: #f5d76e; color: #0f0f0f; border: none; padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .print-btn:hover { background: #ecc94b; }
    .container { max-width: 900px; margin: 40px auto; padding: 0 24px 80px; }
    h2 { font-size: 22px; font-weight: 700; color: #f5d76e; margin: 40px 0 12px; border-bottom: 1px solid #333; padding-bottom: 8px; }
    h3 { font-size: 16px; font-weight: 600; color: #d1d5db; margin: 24px 0 8px; }
    p { color: #9ca3af; margin: 8px 0; font-size: 14px; }
    a { color: #60a5fa; }
    code { background: #1f2937; color: #fbbf24; padding: 2px 6px; border-radius: 4px; font-size: 13px; font-family: 'Courier New', monospace; }
    pre { background: #1a1a1a; border: 1px solid #374151; border-radius: 8px; padding: 16px; overflow-x: auto; margin: 12px 0; }
    pre code { background: none; padding: 0; color: #86efac; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
    th { background: #1f2937; color: #f3f4f6; font-weight: 600; text-align: left; padding: 10px 12px; border: 1px solid #374151; }
    td { padding: 9px 12px; border: 1px solid #2d3748; color: #d1d5db; vertical-align: top; }
    tr:hover td { background: #1a1a2e; }
    .warn { background: #3b1c00; border-left: 3px solid #f59e0b; padding: 10px 14px; border-radius: 0 6px 6px 0; margin: 12px 0; font-size: 13px; color: #fcd34d; }
    .tip { background: #0c2340; border-left: 3px solid #3b82f6; padding: 10px 14px; border-radius: 0 6px 6px 0; margin: 12px 0; font-size: 13px; color: #93c5fd; }
    @media print {
      .header .print-btn { display: none; }
      body { background: white; color: black; }
      .header { background: #f9f9f9; border-bottom: 1px solid #ccc; }
      h2 { color: #333; border-color: #ccc; }
      h3 { color: #555; }
      code { background: #f3f4f6; color: #92400e; }
      pre { background: #f9fafb; border-color: #e5e7eb; }
      pre code { color: #065f46; }
      p, td { color: #374151; }
      th { background: #f3f4f6; color: #111; }
      .warn { background: #fffbeb; color: #92400e; }
      .tip { background: #eff6ff; color: #1e40af; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>📋 Scopilot — Access &amp; Testing Guide</h1>
    ${nav('', 'Home')}
    ${nav('/leads', 'Leads')}
    ${nav('/contractors', 'Contractors')}
    ${nav('/territory', 'Territory')}
    ${nav('/analytics', 'Analytics')}
    <button class="print-btn" onclick="window.print()">🖨 Print</button>
  </div>

  <div class="container">

    <h2>Environments</h2>
    <table>
      <tr><th>Item</th><th>Value</th></tr>
      <tr><td>Production URL</td><td><a href="https://scopilot.polsia.app" target="_blank">https://scopilot.polsia.app</a></td></tr>
      <tr><td>Render logs</td><td><a href="https://dashboard.render.com" target="_blank">dashboard.render.com</a> → Services → scopilot → Logs</td></tr>
      <tr><td>Email sender</td><td>Polsia email proxy — configured via <code>POLSIA_EMAIL_PROXY_URL</code></td></tr>
      <tr><td>Database</td><td>Neon PostgreSQL — <code>DATABASE_URL</code> env var</td></tr>
    </table>

    <h2>Admin Panel</h2>
    <h3>Auth</h3>
    <p>Two methods — both check the <code>ADMIN_PASSWORD</code> env var (set on Render; not hard-coded in source):</p>
    <ul style="margin:8px 0 8px 20px;color:#9ca3af;font-size:14px">
      <li><strong>Query param:</strong> <code>/admin?key=&lt;ADMIN_PASSWORD&gt;</code></li>
      <li><strong>Basic Auth:</strong> <code>Authorization: Basic &lt;base64(:password)&gt;</code></li>
    </ul>
    <div class="tip">Tip: append <code>?key=…</code> to every admin URL — it persists for that browser tab.</div>

    <h3>Sections</h3>
    <table>
      <tr><th>Section</th><th>Path</th><th>What it shows</th></tr>
      <tr><td>Home stats</td><td><code>/admin</code></td><td>KPIs: total leads, contractors, territory claims, weekly volume</td></tr>
      <tr><td>Leads</td><td><code>/admin/leads</code></td><td>All submitted leads — expandable rows with photos, Q&amp;A, satellite map</td></tr>
      <tr><td>Contractors</td><td><code>/admin/contractors</code></td><td>All accounts — suspend/activate, lead count, territory count</td></tr>
      <tr><td>Territory map</td><td><code>/admin/territory</code></td><td>Mapbox map with claimed ZIP markers by contractor color</td></tr>
      <tr><td>Analytics</td><td><code>/admin/analytics</code></td><td>Lead status breakdown, contractor stats</td></tr>
      <tr><td>Metrics</td><td><code>/admin/metrics</code></td><td>Page views, top pages, referrers, lead counts</td></tr>
      <tr><td>Funnel</td><td><code>/admin/funnel</code></td><td>Conversion funnels: founding page, scope, signup</td></tr>
    </table>

    <h2>Test Credentials</h2>
    <div class="warn">⚠️ Test accounts are seeded by <code>npm run seed:test-contractors</code> (see <code>scripts/seed-test-contractors.js</code> for the credentials). Run the seed locally — credentials are no longer hardcoded in HTML the admin panel serves so they can't be scraped from the public repo.</div>
    <p>To re-seed: <code>npm run seed:test-contractors</code></p>

    <h2>Contractor Dashboard</h2>
    <h3>Signup &amp; Login</h3>
    <p>Signup: <a href="https://scopilot.polsia.app/signup" target="_blank">https://scopilot.polsia.app/signup</a> — password-based only (no magic links)</p>
    <p>Login: <a href="https://scopilot.polsia.app/login" target="_blank">https://scopilot.polsia.app/login</a></p>

    <h3>Dashboard Sections</h3>
    <table>
      <tr><th>Section</th><th>What it shows</th></tr>
      <tr><td>Active Leads</td><td>Routed leads — expandable detail, map, contact info</td></tr>
      <tr><td>Territory Claims</td><td>Claimed ZIPs, status badges (green=active / amber=at_risk / red=suspended)</td></tr>
      <tr><td>Your Performance</td><td>Rolling 10-lead response time vs 48h goal; avg rating vs 4.0 goal</td></tr>
      <tr><td>Founding CTA</td><td>Shown only to non-founding contractors</td></tr>
    </table>

    <h2>Homeowner Flow</h2>
    <p>Go to <a href="https://scopilot.polsia.app/scope.html" target="_blank">https://scopilot.polsia.app/scope.html</a></p>
    <ol style="margin:8px 0 8px 20px;color:#9ca3af;font-size:14px">
      <li>Enter address (autocomplete — Mapbox)</li>
      <li>Draw project area on satellite map</li>
      <li>Answer guided project questions</li>
      <li>Upload photos (optional)</li>
      <li>Submit — generates estimate and routes lead</li>
    </ol>
    <h3>Test Addresses</h3>
    <table>
      <tr><th>Scenario</th><th>Address</th><th>Expected outcome</th></tr>
      <tr><td>Urban (routed)</td><td>123 Main St, Denver, CO 80202</td><td>Lead routed to contractor who claimed that ZIP</td></tr>
      <tr><td>Rural (unrouted)</td><td>Rural Route 1, Glenwood Springs, CO 81601</td><td>Lead goes to Opportunity Board (no territory claim)</td></tr>
    </table>

    <h2>Territory + SLA Testing</h2>
    <h3>Claim a ZIP</h3>
    <ol style="margin:8px 0 8px 20px;color:#9ca3af;font-size:14px">
      <li>Log in as test contractor → Dashboard → Territory card</li>
      <li>Enter 5-digit ZIP → click "Check Availability"</li>
      <li>Click "Claim" — 1st ZIP is free; additional ZIPs are $79/mo via Stripe</li>
    </ol>

    <h3>Force a 48h SLA Breach</h3>
<pre><code>-- Replace &lt;lead_id&gt; with actual lead ID
UPDATE leads
SET first_response_at = NOW() - INTERVAL '50 hours'
WHERE id = &lt;lead_id&gt;;</code></pre>

    <h3>Run SLA Check Job Manually</h3>
<pre><code>node jobs/sla-check.js</code></pre>
    <p>Normally runs at 2 AM UTC. Transitions: active → at_risk → suspended → released. Sends contractor alert emails.</p>

    <h3>Run Rating Email Job Manually</h3>
<pre><code>node jobs/rating-email.js</code></pre>
    <p>Normally runs at 9 AM UTC. Sends 1-click star rating to homeowners on leads 7+ days old.</p>

    <h2>Opportunity Board Testing</h2>
    <h3>Pass a Lead</h3>
    <ol style="margin:8px 0 8px 20px;color:#9ca3af;font-size:14px">
      <li>Log in as Test Contractor 1 → open a routed lead detail</li>
      <li>Click <strong>Pass</strong> → enter optional reason → confirm</li>
      <li>Lead status → <code>passed</code>; neighboring contractors notified by email</li>
    </ol>

    <h3>Claim from the Board</h3>
    <ol style="margin:8px 0 8px 20px;color:#9ca3af;font-size:14px">
      <li>Log in as Test Contractor 2 → <a href="https://scopilot.polsia.app/contractor/opportunities" target="_blank">/contractor/opportunities</a></li>
      <li>Find the passed lead (use "All" filter) → click Claim</li>
      <li>Contact info reveals; lead status → <code>claimed_from_board</code></li>
    </ol>

    <h2>Rating System</h2>
    <h3>Trigger Rating Email</h3>
<pre><code>node jobs/rating-email.js</code></pre>

    <h3>Submit via Token URL</h3>
    <p>Format: <code>https://scopilot.polsia.app/rate/&lt;token&gt;?r=5</code> (r = 1–5)</p>
    <p>Get test tokens from DB:</p>
<pre><code>SELECT id, rating_token FROM leads WHERE homeowner_rating IS NULL LIMIT 5;</code></pre>

    <h2>Common SQL Snippets</h2>
    <h3>List all contractors</h3>
<pre><code>SELECT id, business_name, email, trade_type, created_at FROM contractors ORDER BY created_at DESC;</code></pre>

    <h3>List claimed ZIPs</h3>
<pre><code>SELECT tc.zip_code, tc.status, c.business_name, c.email
FROM territory_claims tc
JOIN contractors c ON c.id = tc.contractor_id
WHERE tc.status = 'active'
ORDER BY tc.created_at DESC;</code></pre>

    <h3>List leads by status</h3>
<pre><code>SELECT id, address, project_type, lead_status, zip_code, created_at
FROM leads ORDER BY created_at DESC LIMIT 50;</code></pre>

    <h3>Reset a contractor's territory</h3>
<pre><code>UPDATE territory_claims
SET status = 'released'
WHERE contractor_id = &lt;contractor_id&gt;
  AND status IN ('active', 'at_risk', 'suspended');</code></pre>

    <h2>Environment Variables</h2>
    <table>
      <tr><th>Variable</th><th>Purpose</th><th>Default</th></tr>
      <tr><td><code>DATABASE_URL</code></td><td>Neon PostgreSQL connection</td><td>— (required)</td></tr>
      <tr><td><code>ADMIN_PASSWORD</code></td><td>Admin panel gate</td><td>— (required, no fallback)</td></tr>
      <tr><td><code>SESSION_SECRET</code></td><td>Session cookie signing</td><td>— (required, no fallback)</td></tr>
      <tr><td><code>MAPBOX_TOKEN</code></td><td>Map tiles + address autocomplete</td><td>—</td></tr>
      <tr><td><code>POLSIA_API_URL</code></td><td>Polsia API base (payment verify)</td><td>—</td></tr>
      <tr><td><code>POLSIA_API_KEY</code></td><td>Polsia API auth key</td><td>—</td></tr>
      <tr><td><code>POLSIA_EMAIL_PROXY_URL</code></td><td>Email proxy endpoint</td><td>—</td></tr>
      <tr><td><code>APP_URL</code></td><td>Public app URL for email links</td><td><code>https://scopilot.polsia.app</code></td></tr>
    </table>

  </div>
</body>
</html>`;
}

// ── GET /admin/logs — Auth Log Viewer ────────────────────────────────────────

router.get('/logs', requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const path = req.query.path || 'all';
  const statusRange = req.query.status || 'all';

  const keyParam = `?key=${ADMIN_PASSWORD}`;
  const baseUrl = `/admin/logs${keyParam}`;

  const filterUrl = (updates) => {
    const params = new URLSearchParams({ page, path, status: statusRange, ...updates });
    return `/admin/logs${keyParam}&${params.toString()}`;
  };

  try {
    const { rows, total, totalPages } = await getAuthLogs({ path, statusRange, page, limit: 25 });

    const navLinks = (section) => `
      <a href="/admin/leads${keyParam}" class="nav-link ${section === 'leads' ? 'active' : ''}">Leads</a>
      <a href="/admin/contractors${keyParam}" class="nav-link ${section === 'contractors' ? 'active' : ''}">Contractors</a>
      <a href="/admin/territory${keyParam}" class="nav-link ${section === 'territory' ? 'active' : ''}">Territory</a>
      <a href="/admin/analytics${keyParam}" class="nav-link ${section === 'analytics' ? 'active' : ''}">Analytics</a>
      <a href="/admin/metrics${keyParam}" class="nav-link">Metrics</a>
      <a href="/admin/funnel${keyParam}" class="nav-link">Funnel</a>
      <a href="/admin/logs${keyParam}" class="nav-link active">Logs</a>`;

    const topbar = `<div class="topbar">
      <a href="/admin${keyParam}" class="topbar-logo">SCOPILOT ADMIN <span>Operator Panel</span></a>
      <nav class="nav-links">${navLinks('logs')}</nav>
    </div>`;

    const statusColor = (code) => {
      if (code >= 500) return '#ef4444';
      if (code >= 400) return '#f59e0b';
      return '#10b981';
    };

    function formatTs(ts) {
      const d = new Date(ts);
      return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    }

    function truncate(str, len = 120) {
      if (!str) return '';
      return str.length > len ? str.slice(0, len) + '…' : str;
    }

    function methodBadge(method) {
      const color = { GET: '#3b82f6', POST: '#10b981', PUT: '#f59e0b', PATCH: '#8b5cf6', DELETE: '#ef4444' }[method] || '#888';
      return `<span style="color:${color};font-weight:700;font-size:0.75rem">${method}</span>`;
    }

    const tableRows = rows.length === 0
      ? `<tr><td colspan="7" style="color:#888;text-align:center;padding:40px">No auth logs yet</td></tr>`
      : rows.map(log => `
        <tr class="log-row" onclick="toggleLog('log-${log.id}')" style="cursor:pointer">
          <td style="white-space:nowrap;font-size:0.75rem;color:#888">${formatTs(log.timestamp)}</td>
          <td>${methodBadge(log.method)}</td>
          <td style="font-size:0.8rem"><code style="background:#1a1d28;padding:2px 6px;border-radius:4px;color:#c8c8e0">${esc(log.path)}</code></td>
          <td style="white-space:nowrap"><span style="background:${statusColor(log.status_code)}22;color:${statusColor(log.status_code)};border:1px solid ${statusColor(log.status_code)}44;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600">${log.status_code}</span></td>
          <td class="num" style="color:${log.duration_ms > 1000 ? '#ef4444' : log.duration_ms > 500 ? '#f59e0b' : '#888'};font-size:0.8rem">${log.duration_ms}ms</td>
          <td style="font-size:0.75rem;color:#666;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(log.session_id || '—')}</td>
          <td style="font-size:0.75rem;color:#ef4444">${log.error_stack ? '⚠' : log.response_summary?.error ? '⚠' : '—'}</td>
        </tr>
        <tr>
          <td colspan="7" style="padding:0;border-bottom:none">
            <div class="lead-detail" id="log-${log.id}" style="display:none">
              <div style="padding:16px;background:#14161e;border-radius:8px;margin:8px 0;border:1px solid #2a2d3a">
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px">
                  <div><div class="detail-label">Timestamp</div><div class="detail-value" style="font-size:0.8rem">${formatTs(log.timestamp)}</div></div>
                  <div><div class="detail-label">IP</div><div class="detail-value" style="font-size:0.8rem">${esc(log.ip || '—')}</div></div>
                  <div><div class="detail-label">Session ID</div><div class="detail-value" style="font-size:0.8rem;font-family:monospace">${esc(log.session_id || '—')}</div></div>
                  <div><div class="detail-label">Duration</div><div class="detail-value" style="font-size:0.8rem">${log.duration_ms}ms</div></div>
                  <div><div class="detail-label">Method</div><div class="detail-value" style="font-size:0.8rem">${esc(log.method)}</div></div>
                  <div><div class="detail-label">Status</div><div class="detail-value"><span style="color:${statusColor(log.status_code)};font-weight:700">${log.status_code}</span></div></div>
                </div>
                ${log.user_agent ? `<div style="margin-bottom:12px"><div class="detail-label">User-Agent</div><div class="detail-value" style="font-size:0.75rem;color:#888;word-break:break-all">${esc(log.user_agent)}</div></div>` : ''}
                ${log.request_body ? `<div style="margin-bottom:12px"><div class="detail-label">Request Body</div><pre style="background:#0f1117;border:1px solid #2a2d3a;border-radius:6px;padding:10px;font-size:0.75rem;white-space:pre-wrap;color:#86efac;max-height:200px;overflow:auto">${esc(JSON.stringify(log.request_body, null, 2))}</pre></div>` : ''}
                ${log.response_summary?.error ? `<div style="margin-bottom:12px"><div class="detail-label">Error Message</div><div class="detail-value" style="color:#f59e0b;font-size:0.85rem">${esc(log.response_summary.error)}</div></div>` : ''}
                ${log.error_stack ? `<div><div class="detail-label">Error Stack</div><pre style="background:#0f1117;border:1px solid #ef444444;border-radius:6px;padding:10px;font-size:0.75rem;white-space:pre-wrap;color:#ef4444;max-height:200px;overflow:auto">${esc(log.error_stack)}</pre></div>` : ''}
              </div>
            </div>
          </td>
        </tr>`).join('');

    const pagination = totalPages > 1 ? `
      <div style="display:flex;align-items:center;gap:12px;margin:16px 0;font-size:0.8rem;color:#888">
        <span>Page ${page} of ${totalPages} — ${total} total logs</span>
        <div style="display:flex;gap:8px;margin-left:auto">
          ${page > 1 ? `<a href="${filterUrl({ page: page - 1 })}" style="color:#d4a017;text-decoration:none;padding:4px 12px;border:1px solid #2a2d3a;border-radius:6px">← Prev</a>` : ''}
          ${page < totalPages ? `<a href="${filterUrl({ page: page + 1 })}" style="color:#d4a017;text-decoration:none;padding:4px 12px;border:1px solid #2a2d3a;border-radius:6px">Next →</a>` : ''}
        </div>
      </div>` : `<div style="margin:16px 0;font-size:0.8rem;color:#888">${total} total logs</div>`;

    const body = `
      <h1>Auth Logs</h1>
      <p class="subtitle">Request/response logs from /api/auth/* and /api/events — click any row to expand</p>

      <div style="display:flex;gap:16px;align-items:center;margin-bottom:20px;flex-wrap:wrap">
        <div>
          <label style="color:#888;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px">Path Filter</label>
          <select onchange="window.location='/admin/logs${keyParam}&path=' + this.value + '&status=${statusRange}'" style="background:#1a1d28;color:#e0e0e0;border:1px solid #2a2d3a;border-radius:6px;padding:6px 12px;font-size:0.8rem">
            <option value="all" ${path === 'all' ? 'selected' : ''}>All paths</option>
            <option value="/api/auth/login" ${path === '/api/auth/login' ? 'selected' : ''}>/api/auth/login</option>
            <option value="/api/auth/signup" ${path === '/api/auth/signup' ? 'selected' : ''}>/api/auth/signup</option>
            <option value="/api/auth/forgot-password" ${path === '/api/auth/forgot-password' ? 'selected' : ''}>/api/auth/forgot-password</option>
            <option value="/api/auth/reset-password" ${path === '/api/auth/reset-password' ? 'selected' : ''}>/api/auth/reset-password</option>
            <option value="/api/events" ${path === '/api/events' ? 'selected' : ''}>/api/events</option>
          </select>
        </div>
        <div>
          <label style="color:#888;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px">Status Filter</label>
          <select onchange="window.location='/admin/logs${keyParam}&path=${path}&status=' + this.value" style="background:#1a1d28;color:#e0e0e0;border:1px solid #2a2d3a;border-radius:6px;padding:6px 12px;font-size:0.8rem">
            <option value="all" ${statusRange === 'all' ? 'selected' : ''}>All statuses</option>
            <option value="2xx" ${statusRange === '2xx' ? 'selected' : ''}>2xx (Success)</option>
            <option value="4xx" ${statusRange === '4xx' ? 'selected' : ''}>4xx (Client Error)</option>
            <option value="5xx" ${statusRange === '5xx' ? 'selected' : ''}>5xx (Server Error)</option>
          </select>
        </div>
      </div>

      <div class="card" style="overflow-x:auto">
        ${pagination}
        <table>
          <thead><tr>
            <th>Timestamp</th>
            <th>Method</th>
            <th>Path</th>
            <th>Status</th>
            <th style="text-align:right">Duration</th>
            <th>Session ID</th>
            <th>Err</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
        ${pagination}
      </div>

      <script>
      function toggleLog(id) {
        var el = document.getElementById(id);
        var rows = document.querySelectorAll('.lead-detail');
        rows.forEach(function(r) { if (r !== el && r.style.display !== 'none') r.style.display = 'none'; });
        el.style.display = el.style.display === 'none' ? 'block' : 'none';
      }
      </script>
    `;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Auth Logs — Scopilot Admin</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e0e0e0; min-height: 100vh; }
    :root { --gold: #d4a017; --bg: #0f1117; --card: #1a1d28; --border: #2a2d3a; --text: #e0e0e0; --muted: #888; }
    .topbar { background: #14161e; border-bottom: 1px solid var(--border); padding: 0 24px; display: flex; align-items: center; gap: 0; height: 56px; position: sticky; top: 0; z-index: 50; }
    .topbar-logo { color: var(--gold); font-size: 1rem; font-weight: 700; letter-spacing: 1px; text-decoration: none; padding-right: 24px; border-right: 1px solid var(--border); margin-right: 24px; white-space: nowrap; }
    .topbar-logo span { color: var(--muted); font-weight: 400; font-size: 0.75rem; }
    .nav-links { display: flex; gap: 4px; flex-wrap: wrap; }
    .nav-link { color: var(--muted); text-decoration: none; padding: 6px 14px; border-radius: 6px; font-size: 0.8rem; font-weight: 500; transition: all 0.15s; }
    .nav-link:hover { color: var(--text); background: var(--border); }
    .nav-link.active { color: var(--gold); background: #d4a01715; }
    .main { padding: 28px 24px; max-width: 1400px; margin: 0 auto; }
    h1 { color: var(--gold); font-size: 1.4rem; margin-bottom: 4px; }
    .subtitle { color: var(--muted); font-size: 0.8rem; margin-bottom: 28px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.5px; }
    td { padding: 10px 12px; border-bottom: 1px solid #1e2130; font-size: 0.825rem; vertical-align: middle; }
    tr:hover td { background: #1e2130; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .detail-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 10px; }
    .detail-label { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
    .detail-value { color: var(--text); font-size: 0.85rem; }
  </style>
</head>
<body>
  ${topbar}
  <div class="main">${body}</div>
</body>
</html>`;

    res.send(html);
  } catch (err) {
    console.error('Admin logs error:', err);
    res.status(500).send('Failed to load auth logs');
  }
});

module.exports = router;