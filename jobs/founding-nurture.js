/**
 * Founding-offer nurture email job.
 * Runs hourly via polsia.toml [[crons]] — never inline in server.js.
 *
 * Finds contractors who signed up 24–48h ago, haven't claimed founding,
 * and haven't received this email. Sends once, stamps nurture_sent_at immediately
 * after Postmark accepts the send to prevent double-sends on retries.
 *
 * Safety: skips legacy_free accounts and stops entirely if founding is sold out.
 */
require('dotenv').config();

const { getContractorsForNurtureEmail, markNurtureSent } = require('../db/contractors');
const { getFoundingCount, FOUNDING_LIMIT } = require('../db/founding');
const { logEmailSend } = require('../db/email-log');

const APP_URL = process.env.APP_URL || 'https://scopilot.polsia.app';
const FOUNDING_URL = `${APP_URL}/founding`;

function buildNurtureHtml(contractor, spotsLeft) {
  const firstName = (contractor.owner_name || contractor.business_name || 'there').split(' ')[0];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>50 founding spots. ${spotsLeft} left. — Scopilot</title>
</head>
<body style="margin:0;padding:0;background:#121212;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#121212;padding:32px 0 48px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#1a1a2e;border-radius:6px;overflow:hidden;">

      <!-- Header -->
      <tr><td style="background:#1a1a2e;padding:24px 36px 20px;border-bottom:1px solid #2a2a40;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td><span style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;color:#f5f5f0;letter-spacing:-0.02em;">Scopilot</span></td>
          <td align="right">
            <span style="background:#c8960c;color:#1a1a2e;font-size:9px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;padding:5px 10px;border-radius:2px;">FOUNDING OFFER</span>
          </td>
        </tr></table>
      </td></tr>

      <!-- Scarcity banner -->
      <tr><td style="background:#c8960c;padding:12px 36px;text-align:center;">
        <p style="margin:0;font-size:13px;font-weight:800;color:#1a1a2e;letter-spacing:0.05em;">
          ${spotsLeft} founding spot${spotsLeft === 1 ? '' : 's'} left out of 50
        </p>
      </td></tr>

      <!-- Body -->
      <tr><td style="padding:36px 36px 28px;">
        <p style="margin:0 0 20px;font-size:16px;color:#e8e8dc;line-height:1.5;">
          Hey ${firstName},
        </p>
        <p style="margin:0 0 20px;font-size:16px;color:#e8e8dc;line-height:1.5;">
          You signed up yesterday. The founding offer's still open — for now.
        </p>
        <p style="margin:0 0 20px;font-size:16px;color:#e8e8dc;line-height:1.5;">
          Still on the fence? Here's the math:
        </p>

        <!-- Math block -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f1e;border:1px solid #2a2a40;border-radius:4px;margin-bottom:24px;">
          <tr><td style="padding:20px 24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:6px 0;font-size:14px;color:#9a9aaa;">Founding price:</td>
                <td style="padding:6px 0;font-size:14px;color:#f5f5f0;font-weight:700;text-align:right;">$1,500 once — forever</td>
              </tr>
              <tr>
                <td style="padding:6px 0;font-size:14px;color:#9a9aaa;">Monthly plan (annual):</td>
                <td style="padding:6px 0;font-size:14px;color:#9a9aaa;text-align:right;">$249/mo × 12 = $2,988/yr</td>
              </tr>
              <tr>
                <td colspan="2" style="padding:10px 0 4px;border-top:1px solid #2a2a40;margin-top:8px;"></td>
              </tr>
              <tr>
                <td style="padding:4px 0;font-size:14px;color:#c8960c;font-weight:700;">Pays for itself in:</td>
                <td style="padding:4px 0;font-size:15px;color:#c8960c;font-weight:800;text-align:right;">7 months. Then it's free forever.</td>
              </tr>
            </table>
          </td></tr>
        </table>

        <p style="margin:0 0 16px;font-size:16px;color:#e8e8dc;line-height:1.5;">
          What's included with founding:
        </p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
          <tr><td style="padding:6px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="color:#c8960c;font-size:16px;padding-right:10px;vertical-align:top;">✓</td>
              <td style="font-size:14px;color:#e8e8dc;line-height:1.5;"><strong style="color:#f5f5f0;">3 ZIPs locked</strong> — no one else gets your territory, ever</td>
            </tr></table>
          </td></tr>
          <tr><td style="padding:6px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="color:#c8960c;font-size:16px;padding-right:10px;vertical-align:top;">✓</td>
              <td style="font-size:14px;color:#e8e8dc;line-height:1.5;"><strong style="color:#f5f5f0;">Lifetime access</strong> — pay once, no recurring fees, no surprises</td>
            </tr></table>
          </td></tr>
          <tr><td style="padding:6px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="color:#c8960c;font-size:16px;padding-right:10px;vertical-align:top;">✓</td>
              <td style="font-size:14px;color:#e8e8dc;line-height:1.5;"><strong style="color:#f5f5f0;">Full refund commitment</strong> — if Scopilot ever shuts down, you get your money back. That's in writing.</td>
            </tr></table>
          </td></tr>
          <tr><td style="padding:6px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="color:#c8960c;font-size:16px;padding-right:10px;vertical-align:top;">✓</td>
              <td style="font-size:14px;color:#e8e8dc;line-height:1.5;"><strong style="color:#f5f5f0;">Founding badge</strong> — visible to homeowners. Credibility from day one.</td>
            </tr></table>
          </td></tr>
        </table>

        <!-- CTA -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
          <tr><td align="center">
            <a href="${FOUNDING_URL}" style="display:inline-block;background:#c8960c;color:#1a1a2e;font-size:16px;font-weight:800;letter-spacing:0.03em;text-decoration:none;padding:15px 36px;border-radius:3px;">
              Claim your founding spot →
            </a>
          </td></tr>
        </table>

        <!-- Soft close -->
        <p style="margin:0 0 8px;font-size:14px;color:#9a9aaa;line-height:1.6;">
          If you'd rather start on a monthly plan, reply to this email and I'll set you up.
        </p>
        <p style="margin:0;font-size:14px;color:#9a9aaa;">
          — Brad &nbsp;·&nbsp; Scopilot
        </p>
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#0f0f1e;padding:16px 36px;text-align:center;border-top:1px solid #2a2a40;">
        <p style="margin:0;font-size:11px;color:#5c5c6e;">
          You created a Scopilot account. This is a one-time follow-up — you won't receive further nurture emails.
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function buildNurtureText(contractor, spotsLeft) {
  const firstName = (contractor.owner_name || contractor.business_name || 'there').split(' ')[0];

  return [
    'SCOPILOT — FOUNDING OFFER',
    '==========================',
    '',
    `Hey ${firstName},`,
    '',
    "You signed up yesterday. The founding offer's still open — for now.",
    `${spotsLeft} founding spot${spotsLeft === 1 ? '' : 's'} left out of 50.`,
    '',
    'Still on the fence? The math:',
    '  Founding price:       $1,500 once — forever',
    '  Monthly plan annual:  $249/mo x 12 = $2,988/yr',
    '  Pays for itself in:   7 months. Then free forever.',
    '',
    "What's included:",
    '  ✓ 3 ZIPs locked — your territory, permanently',
    '  ✓ Lifetime access — pay once, no recurring fees',
    '  ✓ Full refund commitment — if Scopilot closes, you get your money back',
    '  ✓ Founding badge — visible to homeowners',
    '',
    `Claim your founding spot: ${FOUNDING_URL}`,
    '',
    "If you'd rather start on a monthly plan, reply to this email and I'll set you up.",
    '',
    '— Brad · Scopilot',
  ].join('\n');
}

async function run() {
  console.log('[founding-nurture] Starting:', new Date().toISOString());

  const emailUrl = process.env.POLSIA_EMAIL_PROXY_URL || process.env.POLSIA_EMAIL_URL;
  const emailKey = process.env.POLSIA_EMAIL_KEY || process.env.POLSIA_API_KEY;

  if (!emailUrl) {
    console.warn('[founding-nurture] POLSIA_EMAIL_URL not set — exiting');
    process.exit(0);
  }

  const sendUrl = emailUrl.replace(/\/?$/, '').endsWith('/send')
    ? emailUrl
    : emailUrl.replace(/\/?$/, '') + '/send';

  // Safety: don't send if founding is sold out
  let foundingCount;
  try {
    foundingCount = await getFoundingCount();
  } catch (err) {
    console.error('[founding-nurture] Failed to read founding count:', err.message);
    process.exit(1);
  }

  const spotsLeft = Math.max(0, FOUNDING_LIMIT - foundingCount);

  if (spotsLeft <= 0) {
    console.log('[founding-nurture] Founding sold out — no nurture emails will be sent');
    process.exit(0);
  }

  // Fetch eligible contractors
  let contractors;
  try {
    contractors = await getContractorsForNurtureEmail();
  } catch (err) {
    console.error('[founding-nurture] Failed to query contractors:', err.message);
    process.exit(1);
  }

  console.log(`[founding-nurture] ${contractors.length} contractor(s) eligible. Spots left: ${spotsLeft}`);

  let sent = 0;
  let errors = 0;

  for (const contractor of contractors) {
    const subject = `50 founding spots. ${spotsLeft} left.`;
    const html = buildNurtureHtml(contractor, spotsLeft);
    const text = buildNurtureText(contractor, spotsLeft);

    let postmarkMessageId = null;
    let errorMsg = null;

    try {
      const resp = await fetch(sendUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(emailKey ? { Authorization: `Bearer ${emailKey}` } : {}),
        },
        body: JSON.stringify({
          to: contractor.email,
          subject,
          body: text,
          html,
        }),
      });

      if (resp.ok) {
        // Try to extract Postmark message ID from response
        try {
          const data = await resp.json();
          postmarkMessageId = data.MessageID || data.messageId || data.message_id || null;
        } catch (_) {
          // Response may not be JSON — that's fine
        }

        // Stamp nurture_sent_at BEFORE logging — prevents double-send on retry
        await markNurtureSent(contractor.id);

        await logEmailSend({
          recipient: contractor.email,
          template: 'founding-nurture',
          postmarkMessageId,
          metadata: { contractor_id: contractor.id, spots_left: spotsLeft },
        });

        sent++;
        console.log(`[founding-nurture] Sent to contractor ${contractor.id} (${contractor.email}) — MessageID: ${postmarkMessageId || 'n/a'}`);
      } else {
        const body = await resp.text();
        errorMsg = `HTTP ${resp.status}: ${body}`;
        console.error(`[founding-nurture] Email error for contractor ${contractor.id}: ${errorMsg}`);
        errors++;

        await logEmailSend({
          recipient: contractor.email,
          template: 'founding-nurture',
          error: errorMsg,
          metadata: { contractor_id: contractor.id },
        });
      }
    } catch (err) {
      errorMsg = err.message;
      console.error(`[founding-nurture] Fetch error for contractor ${contractor.id}:`, err.message);
      errors++;

      try {
        await logEmailSend({
          recipient: contractor.email,
          template: 'founding-nurture',
          error: errorMsg,
          metadata: { contractor_id: contractor.id },
        });
      } catch (_) {
        // Log failure is non-fatal
      }
    }
  }

  console.log(`[founding-nurture] Done. sent=${sent} errors=${errors}`);
  process.exit(0);
}

run().catch(err => {
  console.error('[founding-nurture] Fatal:', err);
  process.exit(1);
});
