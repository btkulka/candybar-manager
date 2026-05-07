#!/usr/bin/env node
/**
 * Out-of-process Qobuz credential sniffer.
 *
 * Runs Playwright's bundled Chromium in a separate Node process so that the
 * heavy `play.qobuz.com` SPA — which reproducibly crashes Electron's renderer
 * when loaded in an in-process BrowserWindow (Network service + GPU process
 * exits) — is isolated from the main candybar-manager app.
 *
 * Usage: node tools/sniff-qobuz-worker.mjs <cookiesJsonPath> <mode>
 *   mode = "headless" | "interactive"
 *
 * Protocol:
 *   - Reads Playwright-shaped cookies from cookiesJsonPath.
 *   - Navigates to https://play.qobuz.com/ in a freshly-seeded context.
 *   - Intercepts requests; when any request carries both `x-app-id` and
 *     `x-user-auth-token` headers, captures them.
 *   - On success: prints a single line of JSON `{"ok":true,"appId":"…","userAuthToken":"…"}` to stdout, exits 0.
 *   - On failure: prints `{"ok":false,"error":"…"}` to stdout, exits 1.
 *
 * The parent process provides all environmental context (cookies) and does not
 * depend on the worker sharing its Electron session partition.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const [, , cookiesPath, modeArg] = process.argv;
if (!cookiesPath) {
  console.log(JSON.stringify({ ok: false, error: 'missing cookies path arg' }));
  process.exit(1);
}
const mode = modeArg === 'interactive' ? 'interactive' : 'headless';

function done(result) {
  // stdout gets exactly one JSON line so the parent can trivially parse it.
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.ok ? 0 : 1);
}

let cookies;
try {
  cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
  if (!Array.isArray(cookies)) throw new Error('cookies json is not an array');
} catch (err) {
  done({ ok: false, error: `failed to read cookies: ${err.message}` });
}

let browser;
try {
  browser = await chromium.launch({
    // Interactive mode shows the window so the user can complete any required
    // play.qobuz.com sign-in. Headless is used when we expect the session to
    // already be valid and just want a quick silent probe.
    headless: mode === 'headless',
    args: ['--no-first-run', '--no-default-browser-check'],
  });
} catch (err) {
  done({ ok: false, error: `browser launch failed: ${err.message}` });
}

const ctx = await browser.newContext({ userAgent: USER_AGENT });
try {
  await ctx.addCookies(cookies);
} catch (err) {
  // Cookies may occasionally fail validation (missing domain etc). Not fatal —
  // continue; if the session carries enough the SPA may still authenticate.
  console.error(`[sniff-worker] addCookies warned: ${err.message}`);
}

let foundAppId = null;
let foundToken = null;

// Use request interception to peek at every request's headers. First match of
// both headers wins — we don't need to mutate or block, just observe.
await ctx.route('**/*', async (route) => {
  try {
    const h = route.request().headers();
    const app = h['x-app-id'] || h['X-App-Id'];
    const tok = h['x-user-auth-token'] || h['X-User-Auth-Token'];
    if (app && tok && tok !== 'undefined' && !foundAppId) {
      foundAppId = String(app);
      foundToken = String(tok);
    }
  } catch { /* ignore */ }
  await route.continue();
});

const page = await ctx.newPage();
let closedByUser = false;
page.on('close', () => { closedByUser = true; });
ctx.on('close', () => { closedByUser = true; });

// Surface URL changes to stderr so the parent log shows whether we landed on a
// logged-in SPA or got bounced to a sign-in page.
let lastUrl = '';
page.on('framenavigated', (frame) => {
  if (frame === page.mainFrame() && frame.url() !== lastUrl) {
    console.error(`[sniff-worker] navigated: ${frame.url()}`);
    lastUrl = frame.url();
  }
});

console.error(`[sniff-worker] loaded ${cookies.length} cookies, mode=${mode}, launching page…`);
try {
  await page.goto('https://play.qobuz.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.error(`[sniff-worker] initial URL after goto: ${page.url()}`);
} catch (err) {
  console.error(`[sniff-worker] nav warn: ${err.message}`);
}

// Poll while waiting: periodically report what we see on the page so the
// parent can diagnose why the sniff doesn't fire.
const FAST_MS = 10000;
const INTERACTIVE_MS = 5 * 60 * 1000;
const deadline = Date.now() + (mode === 'interactive' ? INTERACTIVE_MS : FAST_MS);
let lastReportAt = 0;
while (Date.now() < deadline && !foundAppId && !closedByUser) {
  await new Promise(r => setTimeout(r, 500));
  // Report visible page state every 10 seconds so we know what's happening.
  if (Date.now() - lastReportAt > 10_000) {
    lastReportAt = Date.now();
    try {
      const state = await page.evaluate(() => {
        const authCookie = document.cookie.split(';').map(s => s.trim()).find(s => /^(userCookie|lantern|user_auth_token)=/.test(s));
        const inLocalStorage = {
          user: !!window.localStorage?.getItem('user'),
          user_auth_token: !!window.localStorage?.getItem('user_auth_token'),
          zuser: !!window.localStorage?.getItem('z:user'),
        };
        // Heuristic: SPA usually exposes a 'user' object once signed in.
        return {
          url: window.location.href,
          title: document.title.slice(0, 80),
          cookieAuth: !!authCookie,
          ls: inLocalStorage,
          bodyLen: document.body ? document.body.innerText.length : 0,
        };
      });
      console.error(`[sniff-worker] state: ${JSON.stringify(state)}`);
    } catch (err) {
      console.error(`[sniff-worker] state probe failed: ${err.message}`);
    }
  }
}

try { await browser.close(); } catch { /* already closed */ }

if (foundAppId && foundToken) done({ ok: true, appId: foundAppId, userAuthToken: foundToken });
done({ ok: false, error: 'no authenticated API call intercepted within timeout' });
