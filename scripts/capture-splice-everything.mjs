// Permissive network capture: records EVERY HTTP request to Splice (any
// host) plus every GraphQL operation by name, even ones the targeted
// scripts filtered out. Use when the targeted captures come up empty.
//
// Usage: node scripts/capture-splice-everything.mjs

import { launchSiteBrowser } from '../lib/launchBrowser.mjs';

// Use a dedicated profile so we don't fight any running Chrome
// (Electron, prior captures, etc) using the main `splice` profile.
const ctx = await launchSiteBrowser({ profile: 'splice', headless: false });
const page = await ctx.newPage();

const seenOps = new Set();
const seenHosts = new Map();

page.on('request', (req) => {
  try {
    const url = new URL(req.url());
    const host = url.hostname;
    if (!/splice\.com$|splicecore\b|spliceblob/i.test(host)) return;

    const method = req.method();
    const post = req.postData();

    // GraphQL: log operationName for any unique combo we haven't seen
    if (url.pathname.endsWith('/graphql') && post) {
      try {
        const body = JSON.parse(post);
        const op = body.operationName || '<anon>';
        const key = `gql:${op}::${JSON.stringify(body.variables || {})}`;
        if (!seenOps.has(key)) {
          seenOps.add(key);
          console.log(`\n=== GQL ${op} ===`);
          console.log('vars:', JSON.stringify(body.variables, null, 2));
          // Only print first 300 chars of the query — we mostly want
          // operationName + vars to identify which call to copy.
          const q = (body.query || '').replace(/\s+/g, ' ').slice(0, 300);
          console.log('query:', q);
        }
        return;
      } catch {
        // fall through to URL log
      }
    }

    // Any non-GraphQL request — just log unique paths per host so we
    // can spot REST endpoints used for purchases or balance.
    const pathKey = `${host}${url.pathname}`;
    const count = (seenHosts.get(pathKey) || 0) + 1;
    seenHosts.set(pathKey, count);
    if (count === 1) {
      console.log(`\n[REST] ${method} ${pathKey}`);
      if (post && post.length < 400) {
        console.log('  body:', post);
      }
    }
  } catch (err) {
    console.error('handler error:', err.message);
  }
});

console.log('CAPTURING EVERYTHING from splice.com hosts. Steps:');
console.log('  1. Click any sample you don\'t own');
console.log('  2. Click the buy/license/use-credit button — confirm if you want, otherwise cancel before final');
console.log('  3. Close the window when done');
console.log('');

try {
  await page.goto('https://splice.com/sounds', { waitUntil: 'domcontentloaded' });
} catch (err) {
  console.error('navigation error:', err.message);
}

await new Promise((resolve) => ctx.on('close', resolve));
console.log(`\nUnique GQL ops captured: ${seenOps.size}`);
console.log(`Unique REST paths captured: ${seenHosts.size}`);
process.exit((seenOps.size + seenHosts.size) > 0 ? 0 : 1);
