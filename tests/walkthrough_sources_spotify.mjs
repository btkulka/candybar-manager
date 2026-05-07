// Walkthrough driver: launches candybar-manager, goes to Sources, runs a
// Spotify-playlist search, adds matches to carts, opens the Qobuz/Beatport
// cart panels. Leaves the app running so the user can complete checkout.
//
// Usage:  node tests/walkthrough_sources_spotify.mjs "<spotify-playlist-url>"

import { _electron as electron } from 'playwright';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHOT_DIR = '/tmp/candybar-walkthrough';
fs.mkdirSync(SHOT_DIR, { recursive: true });

const PLAYLIST_URL = process.argv[2]
  ?? 'https://open.spotify.com/playlist/2sLXgUsV6DtgdbI4NcxDf6?si=bde1538b3f0e4459';

function log(step, msg) { console.log(`[${step}] ${msg}`); }
async function shot(page, name) {
  const p = path.join(SHOT_DIR, `${name}.png`);
  try { await page.screenshot({ path: p, fullPage: false }); log('shot', p); }
  catch (e) { log('shot', `skipped ${name}: ${e.message}`); }
}

const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k === 'ELECTRON_RUN_AS_NODE') continue;
  if (typeof v === 'string') env[k] = v;
}
env.ELECTRON_DISABLE_SANDBOX = '1';

log('boot', 'launching Electron app');
const app = await electron.launch({ args: ['.'], cwd: ROOT, env, timeout: 30000 });
const page = await app.firstWindow({ timeout: 15000 });

page.on('console', (m) => {
  const txt = m.text();
  if (/\bcart-fail|Beatport|Qobuz|cart:/i.test(txt)) {
    console.log(`[renderer.${m.type()}] ${txt}`);
  } else if (m.type() === 'error') {
    console.error('[renderer.error]', txt);
  }
});
page.on('pageerror', (e) => console.error('[renderer.pageerror]', e.message));

await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(600);
await shot(page, '01-boot');

log('nav', 'clicking Sources');
await page.click('[data-page="source"]');
await page.waitForSelector('#page-source.active', { timeout: 5000 });
await page.waitForTimeout(500);
await shot(page, '02-source-page');

log('source-type', 'switching to Spotify');
// The Check page also renders a [data-source-type="spotify"] button with the
// same markup, and some `.source-type-btn` nodes aren't reported "visible" by
// Playwright depending on layout state. Click via JS scoped to page-source.
const toggled = await page.evaluate(() => {
  const scope = document.getElementById('page-source');
  if (!scope) return { ok: false, reason: 'no #page-source' };
  const btn = scope.querySelector('[data-source-type="spotify"]');
  if (!btn) return { ok: false, reason: 'no Spotify button inside #page-source' };
  btn.click();
  return { ok: true, active: btn.classList.contains('active') };
});
log('source-type', `toggle result: ${JSON.stringify(toggled)}`);
if (!toggled.ok) throw new Error(`source-type toggle failed: ${toggled.reason}`);
await page.waitForTimeout(200);

log('input', `entering playlist URL: ${PLAYLIST_URL}`);
// Use direct DOM assignment + dispatch input event so the debounce handler fires.
await page.evaluate((url) => {
  const input = document.getElementById('source-spotify-playlist-url');
  if (!input) throw new Error('spotify input missing');
  input.value = url;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}, PLAYLIST_URL);
// debounce is 250ms in source.ts
await page.waitForTimeout(400);
await shot(page, '03-url-entered');

// Wait until Find Sources is enabled
await page.waitForFunction(() => {
  const btn = document.getElementById('run-source-search');
  return btn && !btn.disabled;
}, { timeout: 5000 });

log('search', 'clicking Find Sources');
await page.click('#run-source-search');

// Wait for results section to appear (search finished successfully)
log('search', 'waiting for results (up to 5 min)');
await page.waitForSelector('#source-results-section', {
  state: 'visible',
  timeout: 5 * 60 * 1000,
});
await page.waitForTimeout(800);
await shot(page, '04-results');

// Inspect result counts
const counts = await page.evaluate(() => ({
  total: document.getElementById('source-stat-total')?.textContent ?? '?',
  qobuz: document.getElementById('source-stat-qobuz')?.textContent ?? '?',
  beatport: document.getElementById('source-stat-beatport')?.textContent ?? '?',
  notfound: document.getElementById('source-stat-notfound')?.textContent ?? '?',
  cartBtnVisible: (document.getElementById('source-add-to-cart') )?.offsetParent !== null,
}));
log('results', JSON.stringify(counts));

if (counts.cartBtnVisible) {
  log('cart', 'Add to Cart visible — clicking');
  await page.click('#source-add-to-cart');

  // The Playwright automation inside the app can take a while (especially if
  // a login window pops up). Poll for terminal toasts ourselves so we can
  // surface progress along the way.
  log('cart', 'waiting for cart update toast (up to 15 min) — log in if a Qobuz/Beatport window opens');
  const deadline = Date.now() + 15 * 60 * 1000;
  const seen = new Set();
  let terminal = null;
  while (Date.now() < deadline) {
    const toasts = await page.evaluate(() =>
      [...document.querySelectorAll('.toast-container .toast')].map(t => (t.textContent || '').replace(/\s+/g, ' ').trim())
    );
    for (const t of toasts) {
      if (!t || seen.has(t)) continue;
      seen.add(t);
      log('cart.toast', t.slice(0, 400));
      if (/Cart Updated|Partially Added|Cart Failed/i.test(t)) terminal = t;
    }
    if (terminal) break;
    await page.waitForTimeout(1000);
  }
  if (!terminal) {
    log('cart', 'timed out waiting for terminal toast — continuing to check open-cart button state');
  } else {
    log('cart', `terminal toast: ${terminal.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  // Dump the full list of toasts so per-track failure details (Beatport 400
  // bodies, Qobuz errors, etc.) make it into the walkthrough log.
  const allToasts = await page.evaluate(() =>
    [...document.querySelectorAll('.toast-container .toast')].map(t => (t.textContent || '').replace(/\s+/g, ' ').trim())
  );
  for (const t of allToasts) log('cart.toast', t.slice(0, 400));
  await shot(page, '05-cart-result');

  // Which Open Cart buttons are now visible?
  const openState = await page.evaluate(() => ({
    qobuzOpenVisible: document.getElementById('source-open-qobuz-cart')?.offsetParent !== null,
    beatportOpenVisible: document.getElementById('source-open-beatport-cart')?.offsetParent !== null,
  }));
  log('cart', `open-cart buttons: ${JSON.stringify(openState)}`);

  // Open the carts that have items. If both, open Qobuz first then Beatport.
  if (openState.qobuzOpenVisible) {
    log('open-cart', 'opening Qobuz cart panel');
    await page.click('#source-open-qobuz-cart');
    await page.waitForTimeout(1500);
    await shot(page, '06-qobuz-cart-panel');
  }
  if (openState.beatportOpenVisible) {
    log('open-cart', 'opening Beatport cart panel');
    await page.click('#source-open-beatport-cart');
    await page.waitForTimeout(1500);
    await shot(page, '07-beatport-cart-panel');
  }
} else {
  log('cart', 'Add to Cart button NOT visible — no auto-selected matches. Check confidence threshold.');
  await shot(page, '05-no-cart-btn');
}

log('done', 'walkthrough finished. App left open — complete checkout manually.');
log('done', `screenshots in ${SHOT_DIR}`);

// Keep the process alive so the Electron app stays running. Exit when the
// user closes the app window or the close event fires.
await new Promise((resolve) => {
  app.on('close', resolve);
  // Safety timeout: 2 hours
  setTimeout(resolve, 2 * 60 * 60 * 1000);
});
log('exit', 'app closed');
