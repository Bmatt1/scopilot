/**
 * Debug script: step-by-step walkthrough of the login flow
 * to find where the session gets lost.
 */
const { chromium } = require('playwright');

const BASE = 'https://scopilot.polsia.app';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Capture all requests/responses
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('/api/auth/') || url === BASE + '/contractor') {
      const headers = resp.headers();
      const setCookie = headers['set-cookie'];
      console.log(`\n[${resp.status()}] ${resp.url()}`);
      if (setCookie) console.log('  Set-Cookie:', setCookie);
    }
  });

  // Capture all console messages
  page.on('console', msg => {
    console.log('  [console]', msg.type(), msg.text());
  });

  // Capture page errors
  page.on('pageerror', err => {
    console.log('  [pageerror]', err.message);
  });

  // 1. Create a fresh test contractor
  const timestamp = Date.now();
  const testEmail = `debug-test-${timestamp}@test.com`;
  const testPassword = 'TestPassword123!';
  const testBusiness = `Debug Test ${timestamp}`;

  console.log('\n=== STEP 1: Create test contractor ===');
  console.log('Email:', testEmail);

  const signupResp = await page.request.post(BASE + '/api/auth/signup', {
    data: {
      business_name: testBusiness,
      owner_name: 'Debug Tester',
      email: testEmail,
      password: testPassword,
      trade_type: 'concrete',
      service_area: 'Owensboro, KY'
    }
  });

  const signupJson = await signupResp.json();
  console.log('Signup status:', signupResp.status());
  console.log('Signup response:', JSON.stringify(signupJson, null, 2));

  // Check cookies after signup
  const cookiesAfterSignup = await context.cookies(BASE);
  console.log('Cookies after signup:', cookiesAfterSignup.map(c => c.name + '=' + c.value.slice(0,20) + '...'));

  // 2. Now logout
  console.log('\n=== STEP 2: Logout ===');
  await page.request.post(BASE + '/api/auth/logout');

  // 3. Login with the test account
  console.log('\n=== STEP 3: Login with test account ===');
  const loginResp = await page.request.post(BASE + '/api/auth/login', {
    data: { email: testEmail, password: testPassword }
  });

  const loginJson = await loginResp.json();
  console.log('Login status:', loginResp.status());
  console.log('Login response:', JSON.stringify(loginJson, null, 2));

  // Check cookies after login
  const cookiesAfterLogin = await context.cookies(BASE);
  console.log('Cookies after login:', cookiesAfterLogin.map(c => ({
    name: c.name,
    value: c.value.slice(0, 30) + '...',
    domain: c.domain,
    path: c.path,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    secure: c.secure
  })));

  // 4. Navigate to /contractor
  console.log('\n=== STEP 4: Navigate to /contractor ===');
  const navResp = await page.goto(BASE + '/contractor', { waitUntil: 'networkidle' });
  console.log('Navigation URL:', page.url());
  console.log('Page title:', await page.title());

  // Check final cookies
  const finalCookies = await context.cookies(BASE);
  console.log('Final cookies:', finalCookies.map(c => c.name));

  // Wait 5 seconds to see if it kicks out
  console.log('\n=== STEP 5: Wait 5s and check ===');
  await page.waitForTimeout(5000);
  console.log('URL after 5s:', page.url());
  console.log('Page title after 5s:', await page.title());

  // 6. Try /api/auth/me directly
  console.log('\n=== STEP 6: /api/auth/me ===');
  const meResp = await page.request.get(BASE + '/api/auth/me');
  const meJson = await meResp.json();
  console.log('/api/auth/me status:', meResp.status());
  console.log('/api/auth/me response:', JSON.stringify(meJson, null, 2));

  await browser.close();
}

main().catch(e => {
  console.error('Script error:', e.message);
  process.exit(1);
});