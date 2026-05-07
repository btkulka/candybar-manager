import { chromium } from 'playwright';
import fs from 'fs';

const OUT = '/tmp/qobuz-login-state.json';
const LOG = '/tmp/qobuz-login-log.txt';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

fs.writeFileSync(LOG, '');
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
}

const browser = await chromium.launch({
  headless: false,
  args: ['--no-first-run', '--no-default-browser-check'],
});
const ctx = await browser.newContext({ userAgent: USER_AGENT });
const page = await ctx.newPage();

log('Opening https://www.qobuz.com/signin');
await page.goto('https://www.qobuz.com/signin', { waitUntil: 'domcontentloaded', timeout: 30000 });

let lastUrl = page.url();
page.on('framenavigated', (frame) => {
  if (frame === page.mainFrame()) {
    const u = frame.url();
    if (u !== lastUrl) {
      log(`navigated: ${u}`);
      lastUrl = u;
    }
  }
});

async function dump(label) {
  try {
    const cookies = await ctx.cookies();
    const qobuz = cookies.filter(c => c.domain.includes('qobuz'));
    const ls = await page.evaluate(() => {
      const out = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (!k) continue;
        const v = window.localStorage.getItem(k);
        out[k] = (v && v.length > 300) ? v.slice(0, 300) + `… [${v.length}]` : v;
      }
      return out;
    }).catch(() => ({}));

    const state = {
      label,
      url: page.url(),
      title: await page.title().catch(() => ''),
      qobuzCookieNames: qobuz.map(c => c.name).sort(),
      qobuzCookies: qobuz.map(c => ({
        name: c.name,
        value: c.value.length > 60 ? c.value.slice(0, 60) + `… [${c.value.length}]` : c.value,
        domain: c.domain,
      })),
      localStorageKeys: Object.keys(ls).sort(),
      localStorage: ls,
    };
    fs.writeFileSync(OUT, JSON.stringify(state, null, 2));
    log(`[${label}] dumped. qobuzCookies=${state.qobuzCookieNames.length}, ls=${Object.keys(ls).length}`);
  } catch (err) {
    log(`[${label}] dump error: ${err.message}`);
  }
}

// Dump every 5s so even if our "logged in" heuristic misses, we still see
// what's on the page at any given moment.
const deadline = Date.now() + 10 * 60 * 1000;
let loop = 0;
let detected = false;
while (Date.now() < deadline) {
  loop++;
  try {
    const cookies = await ctx.cookies();
    const qobuz = cookies.filter(c => c.domain.includes('qobuz'));
    const names = new Set(qobuz.map(c => c.name));
    const authSignals = ['userCookie', 'lantern', 'customer_id', 'user_id', 'user_token', 'userToken', 'auth_token'];
    const cookieHits = authSignals.filter(n => names.has(n));

    const lsKeys = await page.evaluate(() => Object.keys(window.localStorage || {})).catch(() => []);
    const lsHits = lsKeys.filter(k => /token|auth|user/i.test(k));

    const url = page.url();
    const offSignin = !url.includes('/signin') && !url.includes('/login');
    log(`tick ${loop}: url=${url} cookies=${qobuz.length} cookieHits=[${cookieHits.join(',')}] lsHits=[${lsHits.join(',')}]`);

    if (!detected && offSignin && (cookieHits.length || lsHits.length)) {
      detected = true;
      log('*** LOGIN DETECTED ***');
      await dump('login-detected');
    }
  } catch (err) {
    log(`tick ${loop} error: ${err.message}`);
  }
  await new Promise(r => setTimeout(r, 5000));
}

log('Final dump.');
await dump('final');
log('Closing.');
await browser.close();
