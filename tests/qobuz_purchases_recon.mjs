import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT_DIR = '/tmp/qobuz-recon';
fs.mkdirSync(OUT_DIR, { recursive: true });

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SIGNIN = 'https://www.qobuz.com/signin';
const PURCHASES_URLS = [
  'https://www.qobuz.com/us-en/account/purchases/tracks',
  'https://www.qobuz.com/us-en/account/purchases/albums',
  'https://www.qobuz.com/us-en/account/purchases',
  'https://www.qobuz.com/us-en/account/downloads',
];

function log(s) { console.log(`[recon] ${s}`); }

const browser = await chromium.launch({ headless: false, args: ['--no-first-run'] });
const ctx = await browser.newContext({ userAgent: USER_AGENT });
const page = await ctx.newPage();

log(`Opening ${SIGNIN} — sign in with whichever Qobuz account, then the script will auto-navigate to the purchases pages.`);
await page.goto(SIGNIN, { waitUntil: 'domcontentloaded', timeout: 30000 });

// Dismiss cookie banner if present so it doesn't cover the form
await page.locator('#didomi-notice-agree-button').click({ timeout: 3000 }).catch(() => {});

// Wait for a qobuz-session or userCookie cookie to appear
const deadline = Date.now() + 5 * 60 * 1000;
let loggedIn = false;
while (Date.now() < deadline) {
  const cookies = await ctx.cookies();
  if (cookies.some(c => c.domain.includes('qobuz') && (c.name === 'qobuz-session' || c.name === 'userCookie' || c.name === 'lantern'))) {
    loggedIn = true; break;
  }
  await new Promise(r => setTimeout(r, 2000));
}
if (!loggedIn) { log('Timed out waiting for sign-in'); await browser.close(); process.exit(1); }
log('Sign-in detected. Fetching purchase pages…');

for (const url of PURCHASES_URLS) {
  log(`GET ${url}`);
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (err) {
    log(`  nav timed out: ${err.message}`);
  }
  // Let any client-side rendering happen
  await page.waitForTimeout(3000);
  const title = await page.title();
  const html = await page.content();
  const bodyLen = html.length;
  const slug = url.replace(/[^a-zA-Z0-9]/g, '_').slice(-80);
  fs.writeFileSync(`${OUT_DIR}/${slug}.html`, html);
  // Heuristic: list of selectors that might contain track/album tiles
  const probes = await page.evaluate(() => {
    const probe = (sel) => ({ sel, count: document.querySelectorAll(sel).length });
    return [
      probe('.ListItem'),
      probe('[data-qa="track-row"]'),
      probe('[data-testid]'),
      probe('.table tr'),
      probe('tr[data-track-id], tr[data-album-id]'),
      probe('a[href*="/us-en/track/"]'),
      probe('a[href*="/us-en/album/"]'),
      probe('.sc-'),
      probe('[class*="Track"]'),
      probe('[class*="Purchase"]'),
    ].filter(p => p.count > 0);
  });
  log(`  title="${title}" bytes=${bodyLen} probes=${JSON.stringify(probes)}`);
  // Also save the final URL to see any redirects
  log(`  finalUrl=${page.url()}`);
}

log(`HTML snapshots written to ${OUT_DIR}`);
log('Browser open — close manually or Ctrl+C this script.');
await new Promise(() => {});
