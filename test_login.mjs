/**
 * One-off Playwright smoke test for the contractor login flow.
 *
 * Reads credentials and the (optional) remote browser endpoint from env vars
 * so nothing sensitive is committed.
 *
 * Required env vars:
 *   TEST_EMAIL     — contractor email to log in with
 *   TEST_PASSWORD  — that contractor's password
 *
 * Optional env vars:
 *   TEST_BROWSER_WS — Anchor/remote Chrome CDP URL.
 *                     If unset, launches a local Chromium (you must
 *                     `npx playwright install chromium` first).
 *   TEST_BASE_URL   — defaults to https://scopilot.polsia.app
 *
 * Run:
 *   TEST_EMAIL=you@example.com TEST_PASSWORD=yourpw node test_login.mjs
 */
import { chromium } from 'playwright';

const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;
const BROWSER_WS = process.env.TEST_BROWSER_WS || '';
const BASE_URL = process.env.TEST_BASE_URL || 'https://scopilot.polsia.app';

if (!EMAIL || !PASSWORD) {
  console.error('TEST_EMAIL and TEST_PASSWORD env vars are required.');
  console.error('Example: TEST_EMAIL=you@example.com TEST_PASSWORD=yourpw node test_login.mjs');
  process.exit(2);
}

async function test() {
  let browser;
  try {
    browser = BROWSER_WS
      ? await chromium.connectOverCDP(BROWSER_WS)
      : await chromium.launch({ headless: true });
    const page = await browser.newPage();

    const loginResponses = [];
    let loginRespStatus = null;
    let loginRespHeaders = null;

    page.on('response', resp => {
      const url = resp.url();
      if (url.includes('/api/auth') || url.includes('/login') || url.includes('/contractor')) {
        loginResponses.push({ url, status: resp.status() });
        if (url.includes('/api/auth/login')) {
          loginRespStatus = resp.status();
          loginRespHeaders = resp.headers();
        }
      }
    });

    console.log('1. Loading /login...');
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle', timeout: 15000 });
    console.log('   URL:', page.url(), '| Title:', await page.title());

    await page.fill('#email', EMAIL);
    await page.fill('#password', PASSWORD);
    console.log('2. Credentials filled');

    await page.click('#submitBtn');
    console.log('3. Form submitted');

    await page.waitForTimeout(3000);

    console.log('4. Current URL:', page.url());

    const cookies = await page.context().cookies();
    const sessionCookies = cookies.filter(c => c.name.includes('sid') || c.name.includes('scopilot'));
    console.log('5. Session cookies:');
    if (sessionCookies.length === 0) {
      console.log('   ❌ No session cookies found!');
    } else {
      sessionCookies.forEach(c => {
        console.log(`   ✓ ${c.name}: httpOnly=${c.httpOnly}, sameSite=${c.sameSite}, secure=${c.secure}`);
      });
    }

    const meResult = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/auth/me');
        return { status: r.status, ok: r.ok };
      } catch (e) {
        return { error: e.message };
      }
    });
    console.log('6. /api/auth/me:', JSON.stringify(meResult));

    console.log('\nAll responses:');
    loginResponses.forEach(r => console.log(`  ${r.status} ${r.url}`));

    console.log('\nLogin response headers (Set-Cookie):');
    if (loginRespHeaders && loginRespHeaders['set-cookie']) {
      console.log('  ✓ Set-Cookie:', loginRespHeaders['set-cookie']);
    } else {
      console.log('  ❌ No Set-Cookie in response headers');
    }
    console.log('Login response status:', loginRespStatus);
  } catch (e) {
    console.log('ERROR:', e.message);
  } finally {
    if (browser) await browser.close();
  }
}

test();
