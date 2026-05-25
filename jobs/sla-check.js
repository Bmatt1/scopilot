/**
 * Nightly SLA evaluation job.
 * Runs every night via polsia.toml [[crons]] — never inline in server.js.
 *
 * Logic:
 *   1. For every contractor with an active or at_risk territory claim, compute SLA stats.
 *   2. If at_risk_reason and their claims are 'active': transition → at_risk, email contractor.
 *   3. If at_risk_reason and their claims are already 'at_risk': transition → suspended.
 *   4. On suspended: auto-release all claims, email contractor, log territory_released event.
 */
require('dotenv').config();

const {
  getContractorSlaStats,
  getContractorsWithActiveTerritories,
  transitionTerritoryStatus,
  getSlaEvaluationState,
} = require('../db/sla');
const { insertEvents } = require('../db/events');

const APP_URL = process.env.APP_URL || 'https://scopilot.polsia.app';

async function sendSlaEmail(contractor, subject, html, text) {
  const emailUrl = process.env.POLSIA_EMAIL_PROXY_URL || process.env.POLSIA_EMAIL_URL;
  const emailKey = process.env.POLSIA_EMAIL_KEY || process.env.POLSIA_API_KEY;

  if (!emailUrl) {
    console.log(`[sla-check] Email not configured — skipping notification to ${contractor.email}`);
    return;
  }

  const sendUrl = emailUrl.replace(/\/?$/, '').endsWith('/send')
    ? emailUrl
    : emailUrl.replace(/\/?$/, '') + '/send';

  const resp = await fetch(sendUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(emailKey ? { Authorization: `Bearer ${emailKey}` } : {}),
    },
    body: JSON.stringify({ to: contractor.email, subject, body: text, html }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`[sla-check] Email error for ${contractor.email}: ${resp.status} ${body}`);
  }
}

function buildAtRiskEmail(contractor, stats, zips) {
  const subject = `Action required: Your Scopilot territory is at risk — ${zips.join(', ')}`;

  const reasons = [];
  if (stats.at_risk_reason && stats.at_risk_reason.includes('response_time')) {
    reasons.push(`Response time: ${stats.rolling_avg_response_hours ?? '—'}h avg (goal: under ${stats.sla_response_hours}h)`);
  }
  if (stats.at_risk_reason && stats.at_risk_reason.includes('rating')) {
    reasons.push(`Homeowner rating: ${stats.rolling_rating_pct ?? '—'}% 4+ star (goal: ${stats.sla_rating_min}%+)`);
  }

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Territory At Risk — Scopilot</title></head>
<body style="margin:0;padding:0;background:#e8e8e4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e8e8e4;padding:20px 0 40px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:4px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.12);">
<tr><td style="background:#1a1a2e;padding:20px 32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td><span style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:700;color:#f5f5f0;">Scopilot</span></td>
    <td align="right"><span style="background:#e67e22;color:#fff;font-size:10px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;padding:5px 10px;border-radius:2px;">TERRITORY AT RISK</span></td>
  </tr></table>
</td></tr>
<tr><td style="background:#1a1a2e;padding:28px 32px 24px;text-align:center;">
  <h1 style="margin:0;font-size:22px;font-weight:800;color:#f5f5f0;">Your Territory Needs Attention</h1>
  <p style="margin:10px 0 0;font-size:14px;color:#9a9aaa;">Zip code${zips.length > 1 ? 's' : ''} <strong style="color:#e67e22;">${zips.join(', ')}</strong> — at risk of auto-release.</p>
</td></tr>
<tr><td style="padding:28px 32px;background:#f5f5f0;">
  <p style="margin:0 0 16px;font-size:14px;color:#1a1a2e;line-height:1.6;">Hi ${contractor.business_name}, your territory performance is below our SLA thresholds. One more evaluation window at this level will auto-release your zip code${zips.length > 1 ? 's' : ''}.</p>
  <div style="background:#fffbf0;border:1px solid #e8d4a0;border-radius:4px;padding:18px 20px;margin-bottom:20px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#c8960c;margin-bottom:10px;">WHAT NEEDS IMPROVEMENT</div>
    ${reasons.map(r => `<p style="margin:4px 0;font-size:14px;color:#1a1a2e;">• ${r}</p>`).join('')}
  </div>
  <p style="margin:0;font-size:13px;color:#5c5c6e;line-height:1.6;">To recover: respond to leads within 48 hours and maintain a 75%+ rating from homeowners. Check your dashboard for your current performance metrics.</p>
</td></tr>
<tr><td style="padding:0 32px 32px;background:#f5f5f0;text-align:center;">
  <a href="${APP_URL}/contractor" style="display:inline-block;background:#c8960c;color:#1a1a2e;padding:14px 32px;font-weight:800;font-size:15px;text-decoration:none;border-radius:3px;">View My Performance →</a>
</td></tr>
<tr><td style="background:#1a1a2e;padding:20px 32px;text-align:center;">
  <p style="margin:0;font-size:12px;color:#5c5c6e;">Questions? Contact <a href="mailto:support@polsia.com" style="color:#c8960c;text-decoration:none;">support@polsia.com</a></p>
</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    'SCOPILOT — TERRITORY AT RISK',
    '=============================',
    '',
    `Hi ${contractor.business_name},`,
    '',
    `Your territory (${zips.join(', ')}) is at risk of auto-release.`,
    '',
    'WHAT NEEDS IMPROVEMENT:',
    ...reasons.map(r => `• ${r}`),
    '',
    'Respond within 48 hours and maintain 75%+ homeowner ratings.',
    '',
    `Dashboard: ${APP_URL}/contractor`,
  ].join('\n');

  return { subject, html, text };
}

function buildSuspendedEmail(contractor, zips) {
  const subject = `Your Scopilot territory has been released — ${zips.join(', ')}`;

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Territory Released — Scopilot</title></head>
<body style="margin:0;padding:0;background:#e8e8e4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e8e8e4;padding:20px 0 40px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:4px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.12);">
<tr><td style="background:#1a1a2e;padding:20px 32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td><span style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:700;color:#f5f5f0;">Scopilot</span></td>
    <td align="right"><span style="background:#c0392b;color:#fff;font-size:10px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;padding:5px 10px;border-radius:2px;">TERRITORY RELEASED</span></td>
  </tr></table>
</td></tr>
<tr><td style="background:#1a1a2e;padding:28px 32px 24px;text-align:center;">
  <h1 style="margin:0;font-size:22px;font-weight:800;color:#f5f5f0;">Territory Auto-Released</h1>
  <p style="margin:10px 0 0;font-size:14px;color:#9a9aaa;">Zip code${zips.length > 1 ? 's' : ''} <strong style="color:#c0392b;">${zips.join(', ')}</strong> ${zips.length > 1 ? 'have' : 'has'} returned to the open pool.</p>
</td></tr>
<tr><td style="padding:28px 32px;background:#f5f5f0;">
  <p style="margin:0 0 16px;font-size:14px;color:#1a1a2e;line-height:1.6;">Hi ${contractor.business_name}, your territory was released after two consecutive at-risk evaluation windows. The zip code${zips.length > 1 ? 's are' : ' is'} now available for any contractor to claim.</p>
  <p style="margin:0;font-size:14px;color:#1a1a2e;line-height:1.6;">You can re-claim ${zips.length > 1 ? 'them' : 'it'} from your dashboard if ${zips.length > 1 ? 'they are' : 'it is'} still available.</p>
</td></tr>
<tr><td style="padding:0 32px 32px;background:#f5f5f0;text-align:center;">
  <a href="${APP_URL}/contractor" style="display:inline-block;background:#c8960c;color:#1a1a2e;padding:14px 32px;font-weight:800;font-size:15px;text-decoration:none;border-radius:3px;">Re-Claim Territory →</a>
</td></tr>
<tr><td style="background:#1a1a2e;padding:20px 32px;text-align:center;">
  <p style="margin:0;font-size:12px;color:#5c5c6e;">Questions? Contact <a href="mailto:support@polsia.com" style="color:#c8960c;text-decoration:none;">support@polsia.com</a></p>
</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    'SCOPILOT — TERRITORY RELEASED',
    '==============================',
    '',
    `Hi ${contractor.business_name},`,
    '',
    `Your territory (${zips.join(', ')}) has been auto-released after two at-risk windows.`,
    'The zip codes are now available in the open pool.',
    '',
    `You can re-claim them at: ${APP_URL}/contractor`,
  ].join('\n');

  return { subject, html, text };
}

async function run() {
  console.log('[sla-check] Starting SLA evaluation run:', new Date().toISOString());

  let contractors;
  try {
    contractors = await getContractorsWithActiveTerritories();
  } catch (err) {
    console.error('[sla-check] Failed to fetch contractors:', err.message);
    process.exit(1);
  }

  console.log(`[sla-check] Evaluating ${contractors.length} contractor(s)`);

  let atRiskCount = 0;
  let suspendedCount = 0;
  let releasedCount = 0;

  for (const contractor of contractors) {
    try {
      const stats = await getContractorSlaStats(contractor.contractor_id);
      if (!stats) {
        console.log(`[sla-check] No lead data for contractor ${contractor.contractor_id} — skipping`);
        continue;
      }

      const state = await getSlaEvaluationState(contractor.contractor_id);
      const isAtRisk = state?.is_at_risk || false;

      if (!stats.at_risk_reason) {
        // Performing well — no transition needed
        console.log(`[sla-check] Contractor ${contractor.contractor_id} OK (breach_streak=${stats.breach_streak}, rating=${stats.rolling_rating_pct}%)`);
        continue;
      }

      if (!isAtRisk) {
        // First breach window: active → at_risk
        const affected = await transitionTerritoryStatus(contractor.contractor_id, 'at_risk');
        if (affected.length > 0) {
          atRiskCount++;
          const zips = affected.map(c => c.zip_code);
          console.log(`[sla-check] Contractor ${contractor.contractor_id} → at_risk (zips: ${zips.join(', ')})`);
          const { subject, html, text } = buildAtRiskEmail(contractor, stats, zips);
          await sendSlaEmail(contractor, subject, html, text);

          await insertEvents([{
            event_type: 'territory_at_risk',
            contractor_id: contractor.contractor_id,
            session_id: null,
            ip: null,
            user_agent: 'sla-check-job',
            referrer: null,
            properties: {
              zip_codes: zips,
              reason: stats.at_risk_reason,
              breach_streak: stats.breach_streak,
              rolling_rating_pct: stats.rolling_rating_pct,
            },
          }]).catch(err => console.error('[sla-check] event insert error:', err.message));
        }
      } else {
        // Second consecutive breach window: at_risk → suspended → released
        const suspendedClaims = await transitionTerritoryStatus(contractor.contractor_id, 'suspended');
        if (suspendedClaims.length > 0) {
          suspendedCount++;
          // Immediately release on suspension
          const releasedClaims = await transitionTerritoryStatus(contractor.contractor_id, 'released');
          releasedCount += releasedClaims.length;
          const zips = releasedClaims.map(c => c.zip_code);
          console.log(`[sla-check] Contractor ${contractor.contractor_id} → suspended+released (zips: ${zips.join(', ')})`);

          const { subject, html, text } = buildSuspendedEmail(contractor, zips);
          await sendSlaEmail(contractor, subject, html, text);

          await insertEvents([{
            event_type: 'territory_released',
            contractor_id: contractor.contractor_id,
            session_id: null,
            ip: null,
            user_agent: 'sla-check-job',
            referrer: null,
            properties: {
              zip_codes: zips,
              reason: stats.at_risk_reason,
              auto_released: true,
            },
          }]).catch(err => console.error('[sla-check] event insert error:', err.message));
        }
      }
    } catch (err) {
      console.error(`[sla-check] Error processing contractor ${contractor.contractor_id}:`, err.message);
    }
  }

  console.log(`[sla-check] Done. at_risk=${atRiskCount} suspended=${suspendedCount} released=${releasedCount}`);
  process.exit(0);
}

run().catch(err => {
  console.error('[sla-check] Fatal error:', err);
  process.exit(1);
});
