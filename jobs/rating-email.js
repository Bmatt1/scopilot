/**
 * Nightly rating email job.
 * Runs via polsia.toml [[crons]] — never inline in server.js.
 *
 * Finds leads that are 7+ days old, have a homeowner email,
 * haven't been rated yet, and haven't had a rating email sent.
 * Sends a one-click 1–5 star rating link to the homeowner.
 */
require('dotenv').config();

const { getLeadsForRatingEmail, ensureRatingToken, markRatingEmailSent } = require('../db/sla');

const APP_URL = process.env.APP_URL || 'https://scopilot.polsia.app';

function formatLabel(str) {
  if (!str) return 'your project';
  return String(str).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function buildRatingEmailHtml(lead, ratingToken, contractorName) {
  const ratingUrl = (star) => `${APP_URL}/rate/${ratingToken}?r=${star}`;
  const stars = [1, 2, 3, 4, 5];
  const starEmoji = ['😠', '😞', '😐', '😊', '🤩'];
  const starLabel = ['Terrible', 'Poor', 'OK', 'Good', 'Excellent'];

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>How did it go? — Scopilot</title></head>
<body style="margin:0;padding:0;background:#e8e8e4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e8e8e4;padding:20px 0 40px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:4px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.12);">
<tr><td style="background:#1a1a2e;padding:20px 32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td><span style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:700;color:#f5f5f0;">Scopilot</span></td>
    <td align="right"><span style="background:#c8960c;color:#1a1a2e;font-size:10px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;padding:5px 10px;border-radius:2px;">QUICK REVIEW</span></td>
  </tr></table>
</td></tr>
<tr><td style="background:#1a1a2e;padding:28px 32px 24px;text-align:center;">
  <h1 style="margin:0;font-size:22px;font-weight:800;color:#f5f5f0;">How did it go?</h1>
  <p style="margin:10px 0 0;font-size:14px;color:#9a9aaa;">Rate your experience with ${contractorName ? contractorName : 'the contractor'} on your ${formatLabel(lead.project_type)} project.</p>
</td></tr>
<tr><td style="padding:32px 32px 24px;background:#f5f5f0;text-align:center;">
  <p style="margin:0 0 24px;font-size:14px;color:#5c5c6e;">Click a star below — it takes 2 seconds and helps homeowners like you find great contractors.</p>
  <table role="presentation" cellpadding="0" cellspacing="0" align="center">
    <tr>
      ${stars.map((s, i) => `
      <td style="padding:0 6px;text-align:center;">
        <a href="${ratingUrl(s)}" style="display:block;text-decoration:none;">
          <div style="font-size:38px;line-height:1;margin-bottom:6px;">${starEmoji[i]}</div>
          <div style="font-size:11px;font-weight:700;color:#5c5c6e;text-transform:uppercase;letter-spacing:0.05em;">${starLabel[i]}</div>
          <div style="font-size:13px;font-weight:800;color:#1a1a2e;margin-top:4px;">${s} ★</div>
        </a>
      </td>`).join('')}
    </tr>
  </table>
</td></tr>
<tr><td style="background:#1a1a2e;padding:20px 32px;text-align:center;">
  <p style="margin:0;font-size:12px;color:#5c5c6e;">
    You submitted a project scope on <a href="${APP_URL}" style="color:#c8960c;text-decoration:none;">Scopilot</a>.
    This is a one-time request — you won't receive further rating emails.
  </p>
</td></tr>
</table></td></tr></table></body></html>`;
}

function buildRatingEmailText(lead, ratingToken, contractorName) {
  const ratingUrl = (star) => `${APP_URL}/rate/${ratingToken}?r=${star}`;
  return [
    'SCOPILOT — HOW DID IT GO?',
    '==========================',
    '',
    `How was your experience with ${contractorName || 'the contractor'} on your ${formatLabel(lead.project_type)} project?`,
    '',
    'Click a link to rate:',
    `1 star (Terrible): ${ratingUrl(1)}`,
    `2 stars (Poor):     ${ratingUrl(2)}`,
    `3 stars (OK):       ${ratingUrl(3)}`,
    `4 stars (Good):     ${ratingUrl(4)}`,
    `5 stars (Excellent): ${ratingUrl(5)}`,
    '',
    'This is a one-time request.',
  ].join('\n');
}

async function run() {
  console.log('[rating-email] Starting rating email run:', new Date().toISOString());

  const emailUrl = process.env.POLSIA_EMAIL_PROXY_URL || process.env.POLSIA_EMAIL_URL;
  const emailKey = process.env.POLSIA_EMAIL_KEY || process.env.POLSIA_API_KEY;

  if (!emailUrl) {
    console.log('[rating-email] POLSIA_EMAIL_URL not set — exiting');
    process.exit(0);
  }

  const sendUrl = emailUrl.replace(/\/?$/, '').endsWith('/send')
    ? emailUrl
    : emailUrl.replace(/\/?$/, '') + '/send';

  let leads;
  try {
    leads = await getLeadsForRatingEmail();
  } catch (err) {
    console.error('[rating-email] Failed to fetch leads:', err.message);
    process.exit(1);
  }

  console.log(`[rating-email] ${leads.length} lead(s) queued for rating email`);

  let sent = 0;
  let errors = 0;

  for (const lead of leads) {
    try {
      // Ensure rating token exists
      const ratingToken = await ensureRatingToken(lead.id);

      const contractorName = lead.contractor_business_name || null;
      const subject = `How did your ${formatLabel(lead.project_type)} project go? (Quick 2-sec rating)`;
      const html = buildRatingEmailHtml(lead, ratingToken, contractorName);
      const text = buildRatingEmailText(lead, ratingToken, contractorName);

      const resp = await fetch(sendUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(emailKey ? { Authorization: `Bearer ${emailKey}` } : {}),
        },
        body: JSON.stringify({ to: lead.homeowner_email, subject, body: text, html }),
      });

      if (resp.ok) {
        await markRatingEmailSent(lead.id);
        sent++;
        console.log(`[rating-email] Sent to lead ${lead.id} (${lead.homeowner_email})`);
      } else {
        const body = await resp.text();
        console.error(`[rating-email] Email error for lead ${lead.id}: ${resp.status} ${body}`);
        errors++;
      }
    } catch (err) {
      console.error(`[rating-email] Error for lead ${lead.id}:`, err.message);
      errors++;
    }
  }

  console.log(`[rating-email] Done. sent=${sent} errors=${errors}`);
  process.exit(0);
}

run().catch(err => {
  console.error('[rating-email] Fatal error:', err);
  process.exit(1);
});
