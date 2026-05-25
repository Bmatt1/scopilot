import { chromium } from 'playwright';

const BROWSER_WS = 'wss://connect.anchorbrowser.io/?sessionId=cb4aa239-05e7-4dc2-bcd0-4f5d722503b2';

async function test() {
  let browser;
  try {
    browser = await chromium.connectOverCDP(BROWSER_WS);
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
    
    // Navigate to login page
    console.log('1. Loading /login...');
    await page.goto('https://scopilot.polsia.app/login', { waitUntil: 'networkidle', timeout: 15000 });
    console.log('   URL:', page.url(), '| Title:', await page.title());
    
    // Fill credentials
    await page.fill('#email', 'concretemattingly@gmail.com');
    await page.fill('#password', 'demo1234');
    console.log('2. Credentials filled (concretemattingly@gmail.com / demo1234)');
    
    // Submit
    await page.click('#submitBtn');
    console.log('3. Form submitted');
    
    // Wait for any response
    await page.waitForTimeout(3000);
    
    console.log('4. Current URL:', page.url());
    
    // Check cookies
    const cookies = await page.context().cookies();
    const sessionCookies = cookies.filter(c => c.name.includes('sid') || c.name.includes('scopilot'));
    console.log('5. Session cookies:');
    if (sessionCookies.length === 0) {
      console.log('   ❌ No session cookies found\!');
    } else {
      sessionCookies.forEach(c => {
        console.log(`   ✓ ${c.name}: httpOnly=${c.httpOnly}, sameSite=${c.sameSite}, secure=${c.secure}`);
      });
    }
    
    // Test /api/auth/me
    const meResult = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/auth/me');
        return { status: r.status, ok: r.ok };
      } catch(e) {
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
    
  } catch(e) {
    console.log('ERROR:', e.message);
  } finally {
    if (browser) await browser.close();
  }
}

test();
