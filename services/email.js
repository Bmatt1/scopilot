/**
 * Owns: outbound email sending for lead notifications.
 * Does NOT own: DB queries, HTTP routing, file storage.
 *
 * Uses Polsia email proxy (POLSIA_EMAIL_URL) when configured.
 * Falls back to console logging so lead submission still works without email config.
 */

const APP_URL = process.env.APP_URL || 'https://scopilot.polsia.app';
const QUESTION_CONFIG = require('../public/js/questions-config');

function formatMoney(n) {
  if (!n) return '$0';
  return '$' + Number(n).toLocaleString('en-US');
}

function formatLabel(str) {
  if (!str) return '—';
  return String(str).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Build a Mapbox Static Images URL for the property satellite view.
 * If a project polygon was drawn, overlays it as a filled GeoJSON path.
 */
function buildMapboxStaticUrl(lead) {
  const token = process.env.MAPBOX_TOKEN;
  if (!token || !lead.latitude || !lead.longitude) return null;

  const lat = parseFloat(lead.latitude);
  const lng = parseFloat(lead.longitude);
  const zoom = 18;
  const width = 600;
  const height = 320;

  // Marker pin at property coords
  const pin = `pin-l-home+c8960c(${lng},${lat})`;

  // If a polygon was drawn, overlay it
  let overlays = pin;
  if (lead.project_area_geojson) {
    try {
      const geojson = typeof lead.project_area_geojson === 'string'
        ? JSON.parse(lead.project_area_geojson)
        : lead.project_area_geojson;

      // Mapbox GeoJSON overlay: fill with semi-transparent gold, stroke white
      const geoOverlay = {
        type: 'Feature',
        properties: { fill: '#c8960c', 'fill-opacity': 0.35, stroke: '#ffffff', 'stroke-width': 2 },
        geometry: geojson.type === 'Feature' ? geojson.geometry : geojson
      };
      const encoded = encodeURIComponent(JSON.stringify(geoOverlay));
      overlays = `geojson(${encoded}),${pin}`;
    } catch (_) {
      // Malformed GeoJSON — just use the pin
    }
  }

  return `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/static/${overlays}/${lng},${lat},${zoom}/${width}x${height}@2x?access_token=${token}`;
}

function buildLeadEmailHtml(lead, photos) {
  const mapUrl = buildMapboxStaticUrl(lead);
  const dashboardUrl = `${APP_URL}/contractor`;

  // Photo grid — max 6, 2-up layout
  const displayPhotos = (photos || []).slice(0, 6);
  const photoGrid = displayPhotos.length
    ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px; border-collapse:collapse;">
      <tr><td colspan="2" style="padding-bottom:12px;">
        <span style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#5c5c6e;">PROJECT PHOTOS</span>
      </td></tr>
      ${chunkArray(displayPhotos, 2).map(row => `
      <tr>
        ${row.map(url => `
        <td width="50%" style="padding:4px; vertical-align:top;">
          <a href="${url}" style="display:block; border:2px solid #d4d4cc; border-radius:3px; overflow:hidden; line-height:0;">
            <img src="${url}" alt="Project photo" width="100%" style="display:block; width:100%; max-width:260px; height:160px; object-fit:cover; border-radius:2px;" />
          </a>
        </td>`).join('')}
        ${row.length === 1 ? '<td width="50%"></td>' : ''}
      </tr>`).join('')}
    </table>`
    : '';

  // Q&A block — use trade_inputs + QUESTION_CONFIG for vertical-specific labels,
  // fall back to legacy fields for leads submitted before this feature shipped
  const typeCfg = QUESTION_CONFIG[lead.project_type];
  const typeLabel = typeCfg ? typeCfg.label : formatLabel(lead.project_type);
  const ti = (lead.trade_inputs && typeof lead.trade_inputs === 'object') ? lead.trade_inputs : {};

  const qaRows = [{ label: 'Project Type', value: typeLabel }];

  if (typeCfg && typeCfg.questions && Object.keys(ti).length > 0) {
    typeCfg.questions.forEach(q => {
      const raw = ti[q.id];
      if (!raw) return;
      const opt = q.options.find(o => o.value === raw);
      const display = opt ? opt.label : formatLabel(raw);
      qaRows.push({ label: q.label, value: display });
    });
  } else {
    // Legacy fallback for pre-trade_inputs leads
    if (lead.tear_out !== undefined) qaRows.push({ label: 'Tear-Out Required', value: lead.tear_out ? 'Yes' : 'No' });
    if (lead.reinforcement) qaRows.push({ label: 'Reinforcement', value: formatLabel(lead.reinforcement) || 'None' });
    if (lead.finish_type) qaRows.push({ label: 'Finish Type', value: formatLabel(lead.finish_type) || 'Standard Broom' });
    if (lead.has_drainage !== undefined) qaRows.push({ label: 'Drainage Work', value: lead.has_drainage ? 'Yes' : 'No' });
  }

  const qaSection = `
    <div style="margin-top:28px;">
      <div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#5c5c6e; padding-bottom:10px; border-bottom:2px solid #1a1a2e; margin-bottom:0;">
        PROJECT SPECIFICATIONS
      </div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:14px;">
        ${qaRows.map((r, i) => `
        <tr style="background:${i % 2 === 0 ? '#ffffff' : '#f5f5f0'};">
          <td style="padding:10px 14px; color:#5c5c6e; width:45%; border-bottom:1px solid #e8e8e4;">${r.label}</td>
          <td style="padding:10px 14px; font-weight:600; color:#1a1a2e; border-bottom:1px solid #e8e8e4;">${r.value}</td>
        </tr>`).join('')}
      </table>
    </div>`;

  const notesSection = lead.notes
    ? `<div style="margin-top:20px; padding:16px 20px; background:#fffbf0; border-left:3px solid #c8960c; border-radius:0 3px 3px 0;">
        <div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#c8960c; margin-bottom:6px;">HOMEOWNER NOTES</div>
        <p style="margin:0; color:#1a1a2e; font-size:14px; line-height:1.6;">${escapeHtml(lead.notes)}</p>
       </div>`
    : '';

  // Build the "Reply to Homeowner" mailto link. The email and the subject value
  // both go inside the href URL, so they need URL-encoding (not HTML-escaping —
  // a `&` in an address breaks the subject when HTML-escaped). The href
  // attribute itself we then HTML-escape so quotes can't break out of it.
  const mailtoLink = lead.homeowner_email
    ? (() => {
        const subj = encodeURIComponent(`Re: Your ${formatLabel(lead.project_type)} Project at ${lead.address}`);
        const to = encodeURIComponent(lead.homeowner_email);
        const href = escapeHtml(`mailto:${to}?subject=${subj}`);
        return `<a href="${href}" style="display:inline-block; margin-left:12px; background:transparent; color:#1a1a2e; padding:14px 24px; font-weight:700; font-size:14px; text-decoration:none; border:2px solid #1a1a2e; border-radius:3px;">Reply to Homeowner</a>`;
      })()
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>New Lead — Scopilot</title>
<style>
  @media only screen and (max-width: 620px) {
    .email-container { width: 100% !important; min-width: 100% !important; }
    .hero-map { height: 200px !important; }
    .cta-block { text-align: center !important; }
    .cta-block a { display: block !important; margin: 0 0 10px 0 !important; width: 100% !important; box-sizing: border-box !important; }
    .photo-cell { display: block !important; width: 100% !important; padding: 4px 0 !important; }
    .photo-cell img { max-width: 100% !important; height: 200px !important; }
    .summary-grid td { display: block !important; width: 100% !important; }
  }
</style>
</head>
<body style="margin:0; padding:0; background-color:#e8e8e4; font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#e8e8e4; padding: 20px 0 40px;">
  <tr>
    <td align="center">

      <!-- Email container -->
      <table role="presentation" class="email-container" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background:#ffffff; border-radius:4px; overflow:hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.12);">

        <!-- Header -->
        <tr>
          <td style="background:#1a1a2e; padding:20px 32px; line-height:1;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td>
                  <span style="font-family: Georgia, 'Times New Roman', serif; font-size:24px; font-weight:700; color:#f5f5f0; letter-spacing:-0.5px;">Scopilot</span>
                </td>
                <td align="right">
                  <span style="background:#c8960c; color:#1a1a2e; font-size:10px; font-weight:800; letter-spacing:0.12em; text-transform:uppercase; padding:5px 10px; border-radius:2px;">NEW LEAD</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Satellite Map Hero -->
        ${mapUrl ? `
        <tr>
          <td style="padding:0; line-height:0; background:#1a1a2e;">
            <a href="${dashboardUrl}" style="display:block; line-height:0;">
              <img class="hero-map" src="${mapUrl}" alt="Satellite view of ${escapeHtml(lead.address)}" width="600" style="display:block; width:100%; height:320px; object-fit:cover;" />
            </a>
          </td>
        </tr>` : ''}

        <!-- Address banner over map -->
        <tr>
          <td style="background:#1a1a2e; padding:14px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td>
                  <div style="font-size:16px; font-weight:700; color:#f5f5f0;">${escapeHtml(lead.address)}</div>
                  ${lead.latitude && lead.longitude ? (() => {
                    // Use signed hemisphere labels rather than hardcoded "N, W" —
                    // a negative latitude is the southern hemisphere, etc.
                    const lat = parseFloat(lead.latitude);
                    const lng = parseFloat(lead.longitude);
                    const latLabel = `${Math.abs(lat).toFixed(6)}° ${lat >= 0 ? 'N' : 'S'}`;
                    const lngLabel = `${Math.abs(lng).toFixed(6)}° ${lng >= 0 ? 'E' : 'W'}`;
                    return `<div style="font-size:12px; color:#9a9aaa; margin-top:3px;">${latLabel}, ${lngLabel}</div>`;
                  })() : ''}
                </td>
                <td align="right" style="white-space:nowrap;">
                  <div style="font-size:20px; font-weight:800; color:#c8960c;">${formatMoney(lead.estimate_low)} – ${formatMoney(lead.estimate_high)}</div>
                  <div style="font-size:10px; color:#9a9aaa; text-align:right; margin-top:2px;">BALLPARK RANGE</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Main content -->
        <tr>
          <td style="padding:28px 32px 0; background:#f5f5f0;">

            <!-- Lead summary block -->
            <div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#5c5c6e; padding-bottom:10px; border-bottom:2px solid #1a1a2e; margin-bottom:0;">
              HOMEOWNER CONTACT
            </div>
            <table role="presentation" class="summary-grid" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:14px;">
              <tr>
                <td style="padding:10px 0 10px 14px; color:#5c5c6e; width:45%; border-bottom:1px solid #e8e8e4;">Name</td>
                <td style="padding:10px 14px 10px 0; font-weight:600; color:#1a1a2e; border-bottom:1px solid #e8e8e4;">${escapeHtml(lead.homeowner_name)}</td>
              </tr>
              <tr>
                <td style="padding:10px 0 10px 14px; color:#5c5c6e; border-bottom:1px solid #e8e8e4;">Email</td>
                <td style="padding:10px 14px 10px 0; border-bottom:1px solid #e8e8e4;">
                  <a href="${escapeHtml('mailto:' + encodeURIComponent(lead.homeowner_email))}" style="color:#c8960c; font-weight:600; text-decoration:none;">${escapeHtml(lead.homeowner_email)}</a>
                </td>
              </tr>
              ${lead.homeowner_phone ? `<tr>
                <td style="padding:10px 0 10px 14px; color:#5c5c6e; border-bottom:1px solid #e8e8e4;">Phone</td>
                <td style="padding:10px 14px 10px 0; font-weight:600; color:#1a1a2e; border-bottom:1px solid #e8e8e4;">
                  <a href="${escapeHtml('tel:' + String(lead.homeowner_phone).replace(/[^0-9+]/g, ''))}" style="color:#1a1a2e; text-decoration:none;">${escapeHtml(lead.homeowner_phone)}</a>
                </td>
              </tr>` : ''}
              <tr>
                <td style="padding:10px 0 10px 14px; color:#5c5c6e; border-bottom:1px solid #e8e8e4;">Sq Footage</td>
                <td style="padding:10px 14px 10px 0; font-weight:600; color:#1a1a2e; border-bottom:1px solid #e8e8e4;">${lead.sq_footage ? Number(lead.sq_footage).toLocaleString('en-US') + ' sq ft' : '—'}</td>
              </tr>
              <tr>
                <td style="padding:10px 0 10px 14px; color:#5c5c6e;">Submitted</td>
                <td style="padding:10px 14px 10px 0; color:#1a1a2e;">${new Date().toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}</td>
              </tr>
            </table>

            ${qaSection}
            ${notesSection}
            ${photoGrid}

          </td>
        </tr>

        <!-- CTA block -->
        <tr>
          <td style="padding:28px 32px 32px; background:#f5f5f0;">
            <div class="cta-block" style="text-align:center; padding-top:8px; border-top:1px solid #d4d4cc;">
              <a href="${dashboardUrl}" style="display:inline-block; background:#c8960c; color:#1a1a2e; padding:14px 32px; font-weight:800; font-size:15px; text-decoration:none; border-radius:3px; letter-spacing:0.02em;">View Lead in Dashboard →</a>
              ${mailtoLink}
            </div>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#1a1a2e; padding:20px 32px; text-align:center;">
            <p style="margin:0; font-size:12px; color:#5c5c6e;">
              You're receiving this because you're registered as a contractor on
              <a href="${APP_URL}" style="color:#c8960c; text-decoration:none;">Scopilot</a>.
              Lead #${lead.id || '—'}
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>

</body>
</html>`;
}

// Helper: chunk array into rows of n
function chunkArray(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Basic HTML escaping for user-supplied strings
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Build plain-text Q&A lines for trade_inputs
function buildTradeInputsText(lead) {
  const typeCfg = QUESTION_CONFIG[lead.project_type];
  const ti = (lead.trade_inputs && typeof lead.trade_inputs === 'object') ? lead.trade_inputs : {};
  const lines = [];

  if (typeCfg && typeCfg.questions && Object.keys(ti).length > 0) {
    typeCfg.questions.forEach(q => {
      const raw = ti[q.id];
      if (!raw) return;
      const opt = q.options.find(o => o.value === raw);
      const display = opt ? opt.label : formatLabel(raw);
      lines.push(`${q.label.padEnd(22)} ${display}`);
    });
  } else {
    if (lead.tear_out !== undefined) lines.push(`Tear-Out:              ${lead.tear_out ? 'Yes' : 'No'}`);
    if (lead.reinforcement)          lines.push(`Reinforcement:         ${formatLabel(lead.reinforcement) || 'None'}`);
    if (lead.finish_type)            lines.push(`Finish Type:           ${formatLabel(lead.finish_type) || 'Standard'}`);
    if (lead.has_drainage !== undefined) lines.push(`Drainage:              ${lead.has_drainage ? 'Yes' : 'No'}`);
  }
  return lines;
}

function buildLeadEmailText(lead, photos) {
  const lines = [
    'SCOPILOT — NEW LEAD',
    '===================',
    '',
    `Address: ${lead.address}`,
    lead.latitude && lead.longitude ? `GPS: ${lead.latitude}, ${lead.longitude}` : null,
    '',
    'HOMEOWNER',
    `---------`,
    `Name:    ${lead.homeowner_name}`,
    `Email:   ${lead.homeowner_email}`,
    lead.homeowner_phone ? `Phone:   ${lead.homeowner_phone}` : null,
    '',
    'PROJECT DETAILS',
    '---------------',
    `Type:          ${(QUESTION_CONFIG[lead.project_type] || {}).label || formatLabel(lead.project_type)}`,
    `Sq Footage:    ${lead.sq_footage ? lead.sq_footage + ' sq ft' : 'Not provided'}`,
    ...buildTradeInputsText(lead),
    '',
    `Ballpark Estimate: ${formatMoney(lead.estimate_low)} – ${formatMoney(lead.estimate_high)}`,
    '',
  ];

  if (lead.notes) {
    lines.push('HOMEOWNER NOTES', '---------------', lead.notes, '');
  }

  if (photos && photos.length) {
    lines.push('PHOTOS', '------');
    photos.forEach((url, i) => lines.push(`${i + 1}. ${url}`));
    lines.push('');
  }

  lines.push(
    'VIEW LEAD IN DASHBOARD',
    '----------------------',
    `${APP_URL}/contractor`,
    ''
  );

  if (lead.homeowner_email) {
    lines.push(
      'REPLY TO HOMEOWNER',
      '------------------',
      lead.homeowner_email,
      ''
    );
  }

  return lines.filter(l => l !== null).join('\n');
}

// Strip any CR/LF from a string before it becomes an email subject or other
// header value. Prevents header-injection attacks where a value like
// "X\r\nBcc: attacker@example.com" would tack a Bcc onto the outbound email.
// Polsia probably handles this too, but defense in depth is cheap.
function sanitizeHeaderValue(s) {
  return String(s || '').replace(/[\r\n]+/g, ' ').trim();
}

// Reject any photo URL that is a base64 `data:` URI before building the email.
// These show up when /api/scope/upload falls back to returning the raw data
// URL (POLSIA_R2_BASE_URL unset). Gmail and most major clients block
// data: image sources, so attaching them just makes the email look broken.
function filterEmailablePhotos(photos) {
  return (photos || []).filter(u => typeof u === 'string' && !u.startsWith('data:'));
}

async function sendLeadNotification(lead, photos) {
  // Support both POLSIA_EMAIL_PROXY_URL (the current name) and POLSIA_EMAIL_URL
  // (the original name kept as a deprecated fallback).
  const emailUrl = process.env.POLSIA_EMAIL_PROXY_URL || process.env.POLSIA_EMAIL_URL;
  const emailKey = process.env.POLSIA_EMAIL_KEY || process.env.POLSIA_API_KEY;
  const toEmail = lead.contractor_email || process.env.CONTRACTOR_EMAIL || process.env.NOTIFY_EMAIL;

  if (!toEmail) {
    console.log('No contractor email configured — lead notification skipped. Lead ID:', lead.id);
    return;
  }

  const safePhotos = filterEmailablePhotos(photos);
  const subject = sanitizeHeaderValue(`New Lead: ${lead.address} — ${formatLabel(lead.project_type)} project`);
  const html = buildLeadEmailHtml(lead, safePhotos);
  const text = buildLeadEmailText(lead, safePhotos);

  if (!emailUrl) {
    console.log('Email proxy URL not configured (POLSIA_EMAIL_PROXY_URL) — lead notification skipped for lead', lead.id);
    console.log('Would have sent to:', toEmail, '|', subject);
    return;
  }

  const resp = await fetch(emailUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(emailKey ? { 'Authorization': `Bearer ${emailKey}` } : {})
    },
    body: JSON.stringify({
      to: toEmail,
      subject,
      body: text,
      html
    })
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Email proxy error ${resp.status}: ${body}`);
  }
}

/**
 * Send a founding member welcome email with scoping link, dashboard link, and magic login link.
 */
async function sendFoundingWelcomeEmail({ email, businessName, scopingLink, dashboardLink, setPasswordLink }) {
  const emailUrl = process.env.POLSIA_EMAIL_PROXY_URL || process.env.POLSIA_EMAIL_URL || 'https://polsia.com/api/proxy/email/send';
  const emailKey = process.env.POLSIA_EMAIL_KEY || process.env.POLSIA_API_KEY;

  const subject = "Welcome to Scopilot — you're a founding member";

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Welcome to Scopilot</title></head>
<body style="margin:0;padding:0;background:#e8e8e4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e8e8e4;padding:20px 0 40px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:4px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.12);">
<tr><td style="background:#1a1a2e;padding:20px 32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td><span style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:700;color:#f5f5f0;">Scopilot</span></td>
    <td align="right"><span style="background:#c8960c;color:#1a1a2e;font-size:10px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;padding:5px 10px;border-radius:2px;">FOUNDING MEMBER</span></td>
  </tr></table>
</td></tr>
<tr><td style="background:#1a1a2e;padding:32px 32px 28px;text-align:center;">
  <h1 style="margin:0;font-size:26px;font-weight:800;color:#f5f5f0;letter-spacing:-0.5px;">You're in. Welcome.</h1>
  <p style="margin:12px 0 0;font-size:15px;color:#9a9aaa;line-height:1.6;">Your $1,500 founding membership is confirmed.<br>Lifetime access. No monthly fees. Ever.</p>
</td></tr>
<tr><td style="padding:32px 32px 0;background:#f5f5f0;">
  <p style="margin:0 0 20px;font-size:14px;color:#5c5c6e;line-height:1.7;">Hi ${escapeHtml(businessName)}, here are your three links — everything you need to start getting qualified leads.</p>
  <div style="background:#ffffff;border:1px solid #d4d4cc;border-radius:4px;padding:20px 24px;margin-bottom:16px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#c8960c;margin-bottom:8px;">YOUR HOMEOWNER SCOPING LINK</div>
    <p style="font-size:13px;color:#5c5c6e;margin:0 0 10px;">Share this link. Homeowners scope their project in 5 min, you get the lead.</p>
    <a href="${scopingLink}" style="display:block;font-family:'Courier New',monospace;font-size:12px;color:#1a1a2e;background:#f0f0ec;padding:10px 14px;border-radius:3px;text-decoration:none;word-break:break-all;">${scopingLink}</a>
  </div>
  <div style="background:#fffbf0;border:1px solid #e8d4a0;border-radius:4px;padding:20px 24px;margin-bottom:16px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#c8960c;margin-bottom:8px;">SET YOUR PASSWORD (expires 7 days)</div>
    <p style="font-size:13px;color:#5c5c6e;margin:0 0 12px;">Log in and set a permanent password for your account.</p>
    <a href="${setPasswordLink}" style="display:inline-block;background:#c8960c;color:#1a1a2e;padding:12px 24px;border-radius:3px;text-decoration:none;font-size:14px;font-weight:800;">Log In & Set Password →</a>
  </div>
</td></tr>
<tr><td style="padding:0 32px 32px;background:#f5f5f0;text-align:center;">
  <a href="${dashboardLink}" style="display:inline-block;background:#c8960c;color:#1a1a2e;padding:16px 40px;font-weight:800;font-size:15px;text-decoration:none;border-radius:3px;">Open Dashboard →</a>
</td></tr>
<tr><td style="background:#1a1a2e;padding:20px 32px;text-align:center;">
  <p style="margin:0;font-size:12px;color:#5c5c6e;">Questions? Contact <a href="mailto:support@polsia.com" style="color:#c8960c;text-decoration:none;">support@polsia.com</a></p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    "SCOPILOT — WELCOME, FOUNDING MEMBER",
    "====================================",
    "",
    `Hi ${businessName},`,
    "",
    "Your $1,500 founding membership is confirmed. Lifetime access. No monthly fees. Ever.",
    "",
    "YOUR LINKS",
    "----------",
    `Scoping Link:  ${scopingLink}`,
    `Dashboard:     ${dashboardLink}`,
    `Set Password:  ${setPasswordLink}`,
    "",
    "1. Set your password using the link above (expires in 7 days).",
    "2. Share your scoping link on your website, Google Business Profile, and social media.",
    "3. Homeowners scope in 5 minutes — you get a qualified lead with full details.",
    "",
    "Questions? Contact support@polsia.com"
  ].join('\n');

  // Normalise: ensure URL ends at /send endpoint
  const sendUrl = emailUrl.replace(/\/?$/, '').endsWith('/send')
    ? emailUrl
    : emailUrl.replace(/\/?$/, '') + '/send';

  const resp = await fetch(sendUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(emailKey ? { Authorization: `Bearer ${emailKey}` } : {})
    },
    body: JSON.stringify({ to: email, subject, body: text, html })
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Founding welcome email error ${resp.status}: ${errBody}`);
  }
}

/**
 * Send "new lead on the board" notification emails to neighboring contractors.
 * Fires once when a lead is passed — recipients hold territory in the same or adjacent zip.
 *
 * @param {object} lead  - the passed lead row
 * @param {Array}  targets - [{id, email, business_name, claimed_zip}]
 */
async function sendPassNotificationEmails(lead, targets) {
  const emailUrl = process.env.POLSIA_EMAIL_PROXY_URL || process.env.POLSIA_EMAIL_URL;
  const emailKey = process.env.POLSIA_EMAIL_KEY || process.env.POLSIA_API_KEY;

  if (!emailUrl) {
    console.log('[email] POLSIA_EMAIL_URL not set — pass notification skipped for lead', lead.id);
    return;
  }

  const boardUrl = `${APP_URL}/contractor/opportunities`;
  const tradeLabel = (QUESTION_CONFIG[lead.project_type] || {}).label || formatLabel(lead.project_type);

  for (const target of targets) {
    const subject = `New lead available near zip ${lead.zip_code} — Scopilot`;
    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>New Lead — Scopilot</title></head>
<body style="margin:0;padding:0;background:#e8e8e4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e8e8e4;padding:20px 0 40px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:4px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.12);">
<tr><td style="background:#1a1a2e;padding:20px 32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td><span style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:700;color:#f5f5f0;">Scopilot</span></td>
    <td align="right"><span style="background:#c8960c;color:#1a1a2e;font-size:10px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;padding:5px 10px;border-radius:2px;">BOARD ALERT</span></td>
  </tr></table>
</td></tr>
<tr><td style="background:#1a1a2e;padding:28px 32px 24px;text-align:center;">
  <h1 style="margin:0;font-size:22px;font-weight:800;color:#f5f5f0;">New Lead Available Near You</h1>
  <p style="margin:10px 0 0;font-size:14px;color:#9a9aaa;">A ${escapeHtml(tradeLabel)} lead in zip <strong style="color:#c8960c;">${escapeHtml(lead.zip_code || '—')}</strong> is now on the board.</p>
</td></tr>
<tr><td style="padding:28px 32px;background:#f5f5f0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;border:1px solid #d4d4cc;border-radius:4px;overflow:hidden;">
    <tr style="background:#ffffff;">
      <td style="padding:10px 14px;color:#5c5c6e;width:45%;border-bottom:1px solid #e8e8e4;">Zip Code</td>
      <td style="padding:10px 14px;font-weight:700;color:#1a1a2e;border-bottom:1px solid #e8e8e4;">${escapeHtml(lead.zip_code || '—')}</td>
    </tr>
    <tr style="background:#f5f5f0;">
      <td style="padding:10px 14px;color:#5c5c6e;border-bottom:1px solid #e8e8e4;">Trade</td>
      <td style="padding:10px 14px;font-weight:700;color:#1a1a2e;border-bottom:1px solid #e8e8e4;">${escapeHtml(tradeLabel)}</td>
    </tr>
    <tr style="background:#ffffff;">
      <td style="padding:10px 14px;color:#5c5c6e;border-bottom:1px solid #e8e8e4;">Sq Footage</td>
      <td style="padding:10px 14px;font-weight:700;color:#1a1a2e;border-bottom:1px solid #e8e8e4;">${lead.sq_footage ? Number(lead.sq_footage).toLocaleString('en-US') + ' sq ft' : '—'}</td>
    </tr>
    <tr style="background:#f5f5f0;">
      <td style="padding:10px 14px;color:#5c5c6e;">Estimate</td>
      <td style="padding:10px 14px;font-weight:700;color:#c8960c;">${formatMoney(lead.estimate_low)} – ${formatMoney(lead.estimate_high)}</td>
    </tr>
  </table>
  <p style="margin:20px 0 0;font-size:13px;color:#5c5c6e;line-height:1.6;">First contractor to claim it gets the full homeowner contact details. Leads on the board are first-come, first-served.</p>
</td></tr>
<tr><td style="padding:0 32px 32px;background:#f5f5f0;text-align:center;">
  <a href="${boardUrl}" style="display:inline-block;background:#c8960c;color:#1a1a2e;padding:14px 32px;font-weight:800;font-size:15px;text-decoration:none;border-radius:3px;">View Opportunity Board →</a>
</td></tr>
<tr><td style="background:#1a1a2e;padding:20px 32px;text-align:center;">
  <p style="margin:0;font-size:12px;color:#5c5c6e;">
    You're receiving this because you hold territory near zip ${escapeHtml(lead.zip_code || '—')} on
    <a href="${APP_URL}" style="color:#c8960c;text-decoration:none;">Scopilot</a>.
  </p>
</td></tr>
</table></td></tr></table>
</body></html>`;

    const text = [
      'SCOPILOT — NEW LEAD ON THE BOARD',
      '=================================',
      '',
      `A ${tradeLabel} lead in zip ${lead.zip_code || '—'} is available.`,
      '',
      `Sq Footage: ${lead.sq_footage ? lead.sq_footage + ' sq ft' : '—'}`,
      `Estimate:   ${formatMoney(lead.estimate_low)} – ${formatMoney(lead.estimate_high)}`,
      '',
      'First contractor to claim gets full homeowner contact details.',
      '',
      `View the board: ${boardUrl}`,
    ].join('\n');

    try {
      const resp = await fetch(emailUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(emailKey ? { Authorization: `Bearer ${emailKey}` } : {})
        },
        body: JSON.stringify({ to: target.email, subject, body: text, html })
      });
      if (!resp.ok) {
        const errBody = await resp.text();
        console.error(`[email] pass notification error for ${target.email} — ${resp.status}: ${errBody}`);
      }
    } catch (err) {
      console.error(`[email] pass notification fetch error for ${target.email}:`, err.message);
    }
  }
}

/**
 * Send a magic login link email to a contractor.
 * Token is 15-minute, single-use — spelled out clearly in the email.
 */
async function sendMagicLoginEmail({ email, businessName, magicUrl }) {
  const emailUrl = process.env.POLSIA_EMAIL_PROXY_URL || process.env.POLSIA_EMAIL_URL || 'https://polsia.com/api/proxy/email/send';
  const emailKey = process.env.POLSIA_EMAIL_KEY || process.env.POLSIA_API_KEY;

  const subject = 'Your Scopilot login link';

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Your Scopilot login link</title></head>
<body style="margin:0;padding:0;background:#e8e8e4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e8e8e4;padding:20px 0 40px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:4px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.12);">
<tr><td style="background:#1a1a2e;padding:20px 32px;">
  <span style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:700;color:#f5f5f0;">Scopilot</span>
</td></tr>
<tr><td style="padding:36px 32px 28px;background:#f5f5f0;">
  <h1 style="margin:0 0 12px;font-size:22px;font-weight:800;color:#1a1a2e;letter-spacing:-0.5px;">Your login link</h1>
  <p style="margin:0 0 24px;font-size:15px;color:#5c5c6e;line-height:1.6;">Hi ${escapeHtml(businessName || 'there')},<br><br>Click the button below to sign in to your Scopilot dashboard. This link expires in <strong>15 minutes</strong> and can only be used once.</p>
  <div style="text-align:center;margin:28px 0;">
    <a href="${magicUrl}" style="display:inline-block;background:#c8960c;color:#1a1a2e;padding:16px 40px;font-weight:800;font-size:15px;text-decoration:none;border-radius:3px;letter-spacing:0.02em;">Sign In to Dashboard &#x2192;</a>
  </div>
  <p style="margin:0;font-size:13px;color:#9a9aaa;line-height:1.6;">If you didn't request this, ignore this email — your account is safe.<br>Link expires: 15 minutes from when this email was sent.</p>
  <div style="margin-top:20px;padding:12px 16px;background:#f0f0ec;border-radius:4px;word-break:break-all;">
    <span style="font-size:11px;color:#9a9aaa;">Or copy this URL: </span>
    <a href="${magicUrl}" style="font-size:11px;color:#c8960c;text-decoration:none;">${magicUrl}</a>
  </div>
</td></tr>
<tr><td style="background:#1a1a2e;padding:20px 32px;text-align:center;">
  <p style="margin:0;font-size:12px;color:#5c5c6e;">Questions? <a href="mailto:support@polsia.com" style="color:#c8960c;text-decoration:none;">support@polsia.com</a></p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    'SCOPILOT — YOUR LOGIN LINK',
    '==========================',
    '',
    `Hi ${businessName || 'there'},`,
    '',
    'Click the link below to sign in. Expires in 15 minutes, single use.',
    '',
    magicUrl,
    '',
    "If you didn't request this, ignore this email.",
    '',
    'Questions? support@polsia.com'
  ].join('\n');

  const sendUrl = emailUrl.replace(/\/?$/, '').endsWith('/send')
    ? emailUrl
    : emailUrl.replace(/\/?$/, '') + '/send';

  const resp = await fetch(sendUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(emailKey ? { Authorization: `Bearer ${emailKey}` } : {})
    },
    body: JSON.stringify({ to: email, subject, body: text, html })
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Magic login email error ${resp.status}: ${errBody}`);
  }
}

/**
 * Send a password reset email to a contractor.
 * Token is 1-hour, single-use — spelled out clearly in the email.
 */
async function sendPasswordResetEmail({ email, businessName, resetUrl }) {
  const emailUrl = process.env.POLSIA_EMAIL_PROXY_URL || process.env.POLSIA_EMAIL_URL || 'https://polsia.com/api/proxy/email/send';
  const emailKey = process.env.POLSIA_EMAIL_KEY || process.env.POLSIA_API_KEY;

  const subject = 'Reset your Scopilot password';

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Reset your Scopilot password</title></head>
<body style="margin:0;padding:0;background:#e8e8e4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e8e8e4;padding:20px 0 40px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:4px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.12);">
<tr><td style="background:#1a1a2e;padding:20px 32px;">
  <span style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:700;color:#f5f5f0;">Scopilot</span>
</td></tr>
<tr><td style="padding:36px 32px 28px;background:#f5f5f0;">
  <h1 style="margin:0 0 12px;font-size:22px;font-weight:800;color:#1a1a2e;letter-spacing:-0.5px;">Reset your password</h1>
  <p style="margin:0 0 24px;font-size:15px;color:#5c5c6e;line-height:1.6;">Hi ${escapeHtml(businessName || 'there')},<br><br>Click the button below to set a new password for your Scopilot account. This link expires in <strong>1 hour</strong> and can only be used once.</p>
  <div style="text-align:center;margin:28px 0;">
    <a href="${resetUrl}" style="display:inline-block;background:#c8960c;color:#1a1a2e;padding:16px 40px;font-weight:800;font-size:15px;text-decoration:none;border-radius:3px;letter-spacing:0.02em;">Set New Password &#x2192;</a>
  </div>
  <p style="margin:0;font-size:13px;color:#9a9aaa;line-height:1.6;">If you didn't request a password reset, ignore this email — your account is safe.<br>Link expires: 1 hour from when this email was sent.</p>
  <div style="margin-top:20px;padding:12px 16px;background:#f0f0ec;border-radius:4px;word-break:break-all;">
    <span style="font-size:11px;color:#9a9aaa;">Or copy this URL: </span>
    <a href="${resetUrl}" style="font-size:11px;color:#c8960c;text-decoration:none;">${resetUrl}</a>
  </div>
</td></tr>
<tr><td style="background:#1a1a2e;padding:20px 32px;text-align:center;">
  <p style="margin:0;font-size:12px;color:#5c5c6e;">Questions? <a href="mailto:support@polsia.com" style="color:#c8960c;text-decoration:none;">support@polsia.com</a></p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    'SCOPILOT — PASSWORD RESET',
    '=========================',
    '',
    `Hi ${businessName || 'there'},`,
    '',
    'Click the link below to set a new password. Expires in 1 hour, single use.',
    '',
    resetUrl,
    '',
    "If you didn't request this, ignore this email.",
    '',
    'Questions? support@polsia.com'
  ].join('\n');

  const sendUrl = emailUrl.replace(/\/?$/, '').endsWith('/send')
    ? emailUrl
    : emailUrl.replace(/\/?$/, '') + '/send';

  const resp = await fetch(sendUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(emailKey ? { Authorization: `Bearer ${emailKey}` } : {})
    },
    body: JSON.stringify({ to: email, subject, body: text, html })
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Password reset email error ${resp.status}: ${errBody}`);
  }
}

/**
 * Send a "we got your project" confirmation email to the HOMEOWNER right after
 * they submit their lead. Warm, reassuring tone. Echoes back the project
 * details they entered so they can verify nothing went sideways.
 *
 * Sets the expectation that a contractor will reach out within ~24 hours, and
 * gives a fallback support email if they don't hear back.
 *
 * Fire-and-forget from routes/scope.js; failure logs but does not block the
 * homeowner-facing 200 response.
 */
async function sendLeadConfirmation(lead, photos) {
  const emailUrl = process.env.POLSIA_EMAIL_PROXY_URL || process.env.POLSIA_EMAIL_URL;
  const emailKey = process.env.POLSIA_EMAIL_KEY || process.env.POLSIA_API_KEY;

  const toEmail = lead.homeowner_email;
  if (!toEmail) {
    // Should be caught by upstream validation; defense in depth.
    console.log('[email] homeowner confirmation skipped — no homeowner_email on lead', lead.id);
    return;
  }

  const safePhotos = filterEmailablePhotos(photos);
  const firstName = (lead.homeowner_name || '').split(/\s+/)[0] || 'there';
  const subject = sanitizeHeaderValue(`We got your project — ${formatLabel(lead.project_type)} at ${lead.address}`);
  const html = buildHomeownerConfirmationHtml(lead, safePhotos, firstName);
  const text = buildHomeownerConfirmationText(lead, safePhotos, firstName);

  if (!emailUrl) {
    console.log('[email] proxy URL not configured — homeowner confirmation skipped for lead', lead.id);
    return;
  }

  const resp = await fetch(emailUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(emailKey ? { Authorization: `Bearer ${emailKey}` } : {})
    },
    body: JSON.stringify({ to: toEmail, subject, body: text, html })
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Email proxy error ${resp.status}: ${body}`);
  }
}

// Plain-text body — important fallback for email clients that block HTML/images.
function buildHomeownerConfirmationText(lead, photos, firstName) {
  const typeLabel = (QUESTION_CONFIG[lead.project_type] || {}).label || formatLabel(lead.project_type);
  const lines = [
    `Hi ${firstName},`,
    '',
    'Thanks for scoping your project on Scopilot. We received everything and a',
    'qualified local contractor will reach out within 24 hours to discuss next steps.',
    '',
    'WHAT YOU SUBMITTED',
    '──────────────────',
    `Project:    ${typeLabel}`,
    `Address:    ${lead.address}`,
    lead.sq_footage ? `Sq footage: ~${Number(lead.sq_footage).toLocaleString('en-US')} sq ft` : null,
    lead.estimate_low ? `Ballpark:   ${formatMoney(lead.estimate_low)} – ${formatMoney(lead.estimate_high)}` : null,
    photos && photos.length ? `Photos:     ${photos.length} attached` : null,
    '',
    'NEED TO REACH US?',
    '──────────────────',
    "If you don't hear back within 24 hours, or you need to change anything",
    'about your project, reply to this email or write to support@polsia.com.',
    '',
    '— The Scopilot team',
  ];
  return lines.filter(Boolean).join('\n');
}

function buildHomeownerConfirmationHtml(lead, photos, firstName) {
  const typeCfg = QUESTION_CONFIG[lead.project_type];
  const typeLabel = typeCfg ? typeCfg.label : formatLabel(lead.project_type);
  const ti = (lead.trade_inputs && typeof lead.trade_inputs === 'object') ? lead.trade_inputs : {};
  const mapUrl = buildMapboxStaticUrl(lead);

  // Q&A rows for the summary block — keep concise (max 5 rows).
  const qaRows = [];
  if (typeCfg && typeCfg.questions && Object.keys(ti).length > 0) {
    for (const q of typeCfg.questions) {
      if (qaRows.length >= 5) break;
      const raw = ti[q.id];
      if (!raw || raw === 'no' || raw === false) continue;
      const opt = q.options && q.options.find(o => o.value === raw);
      qaRows.push({ label: q.label, value: opt ? opt.label : formatLabel(raw) });
    }
  }

  const photoGrid = photos && photos.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px; border-collapse:collapse;">
         ${chunkArray(photos.slice(0, 4), 2).map(row => `
         <tr>
           ${row.map(url => `
             <td width="50%" style="padding:4px; vertical-align:top;">
               <img src="${escapeHtml(url)}" alt="Project photo" width="100%" style="display:block; width:100%; max-width:260px; height:140px; object-fit:cover; border-radius:4px;" />
             </td>`).join('')}
           ${row.length === 1 ? '<td width="50%"></td>' : ''}
         </tr>`).join('')}
       </table>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>We got your project — Scopilot</title>
<style>
  @media only screen and (max-width: 620px) {
    .email-container { width: 100% !important; min-width: 100% !important; }
    .summary-grid td { display: block !important; width: 100% !important; }
  }
</style>
</head>
<body style="margin:0; padding:0; background-color:#e8e8e4; font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#e8e8e4; padding: 20px 0 40px;">
  <tr><td align="center">
    <table role="presentation" class="email-container" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background:#ffffff; border-radius:4px; overflow:hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.12);">

      <!-- Header -->
      <tr><td style="background:#1a1a2e; padding:20px 32px;">
        <span style="font-family:Georgia,'Times New Roman',serif; font-size:24px; font-weight:700; color:#f5f5f0;">Scopilot</span>
      </td></tr>

      <!-- Reassurance hero -->
      <tr><td style="padding:36px 32px 24px; background:#f5f5f0;">
        <h1 style="margin:0 0 8px; font-size:24px; font-weight:800; color:#1a1a2e; letter-spacing:-0.5px;">We got your project, ${escapeHtml(firstName)}.</h1>
        <p style="margin:0; font-size:15px; color:#5c5c6e; line-height:1.6;">A qualified local contractor will reach out within <strong style="color:#1a1a2e;">24 hours</strong> to discuss your ${escapeHtml(typeLabel.toLowerCase())} project. No follow-ups from us in the meantime — just a quick confirmation of what you sent.</p>
      </td></tr>

      ${mapUrl ? `
      <tr><td style="padding:0 32px 0; background:#f5f5f0;">
        <img src="${escapeHtml(mapUrl)}" alt="Satellite view of your project" width="100%" style="display:block; width:100%; max-height:200px; object-fit:cover; border-radius:4px; border:1px solid #d4d4cc;" />
      </td></tr>` : ''}

      <!-- Summary block -->
      <tr><td style="padding:24px 32px 0; background:#f5f5f0;">
        <div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#5c5c6e; padding-bottom:10px; border-bottom:2px solid #1a1a2e;">Your project</div>
        <table role="presentation" class="summary-grid" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:14px;">
          <tr>
            <td style="padding:10px 0 10px 14px; color:#5c5c6e; width:40%; border-bottom:1px solid #e8e8e4;">Project type</td>
            <td style="padding:10px 14px 10px 0; font-weight:600; color:#1a1a2e; border-bottom:1px solid #e8e8e4;">${escapeHtml(typeLabel)}</td>
          </tr>
          <tr>
            <td style="padding:10px 0 10px 14px; color:#5c5c6e; border-bottom:1px solid #e8e8e4;">Address</td>
            <td style="padding:10px 14px 10px 0; font-weight:600; color:#1a1a2e; border-bottom:1px solid #e8e8e4;">${escapeHtml(lead.address)}</td>
          </tr>
          ${lead.sq_footage ? `<tr>
            <td style="padding:10px 0 10px 14px; color:#5c5c6e; border-bottom:1px solid #e8e8e4;">Sq footage</td>
            <td style="padding:10px 14px 10px 0; font-weight:600; color:#1a1a2e; border-bottom:1px solid #e8e8e4;">~${Number(lead.sq_footage).toLocaleString('en-US')} sq ft</td>
          </tr>` : ''}
          ${lead.estimate_low ? `<tr>
            <td style="padding:10px 0 10px 14px; color:#5c5c6e;">Ballpark range</td>
            <td style="padding:10px 14px 10px 0; font-weight:700; color:#c8960c;">${formatMoney(lead.estimate_low)} – ${formatMoney(lead.estimate_high)}</td>
          </tr>` : ''}
        </table>

        ${qaRows.length ? `
        <div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#5c5c6e; padding:20px 0 10px; border-bottom:2px solid #1a1a2e;">Details you shared</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:14px;">
          ${qaRows.map((r, i) => `
          <tr style="background:${i % 2 === 0 ? '#ffffff' : '#f5f5f0'};">
            <td style="padding:8px 14px; color:#5c5c6e; width:40%; border-bottom:1px solid #e8e8e4;">${escapeHtml(r.label)}</td>
            <td style="padding:8px 14px; font-weight:600; color:#1a1a2e; border-bottom:1px solid #e8e8e4;">${escapeHtml(r.value)}</td>
          </tr>`).join('')}
        </table>` : ''}

        ${photoGrid}
      </td></tr>

      <!-- "What happens next" -->
      <tr><td style="padding:24px 32px 28px; background:#f5f5f0;">
        <div style="background:#ffffff; border-left:3px solid #c8960c; padding:16px 18px; border-radius:0 3px 3px 0;">
          <div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#c8960c; margin-bottom:6px;">What happens next</div>
          <p style="margin:0; font-size:14px; color:#1a1a2e; line-height:1.6;">A vetted contractor in your area will reach out within 24 hours. They'll have all the details you sent — no need to re-explain anything. They may follow up with a few clarifying questions and a more precise quote.</p>
        </div>
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#1a1a2e; padding:20px 32px; text-align:center;">
        <p style="margin:0; font-size:12px; color:#9a9aaa; line-height:1.5;">
          Need to change anything or haven't heard back?<br>
          Reply to this email or write to <a href="mailto:support@polsia.com" style="color:#c8960c; text-decoration:none;">support@polsia.com</a>.
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

module.exports = { sendLeadNotification, sendLeadConfirmation, buildLeadEmailHtml, buildLeadEmailText, sendFoundingWelcomeEmail, sendPassNotificationEmails, sendMagicLoginEmail, sendPasswordResetEmail };
