// Capture the GraphQL query Splice's web app uses to load a single sample's
// detail (and the download URL). We need this because their schema shifted
// and our SAMPLE_ASSET_FILES_QUERY now 400s with "invalid UUID length: 64".
//
// Usage:
//   node scripts/capture-splice-asset.mjs
// Then in the browser that opens:
//   1. Click any sample in your library (or anywhere in the catalog)
//   2. The script captures asset-detail GraphQL calls and prints them
//   3. Close the window when you see "captured" messages

import { launchSiteBrowser } from '../lib/launchBrowser.mjs';

const ctx = await launchSiteBrowser({ profile: 'splice', headless: false });
const page = await ctx.newPage();

const captured = new Map();

page.on('request', (req) => {
  if (!req.url().startsWith('https://surfaces-graphql.splice.com/graphql')) return;
  const post = req.postData();
  if (!post) return;
  try {
    const body = JSON.parse(post);
    const op = body.operationName;
    if (!op) return;
    // Anything to do with single-asset lookup or files
    if (!/asset|file|download/i.test(op)) return;
    if (captured.has(op)) return;
    captured.set(op, body);
    console.log(`\n\n=== captured ${op} ===\n`);
    console.log(JSON.stringify(body, null, 2));
    console.log(`\n=== end ${op} ===\n`);
  } catch (err) {
    console.error('parse error:', err.message);
  }
});

console.log('Opening Splice library. Click any sample to fetch its detail/download.');
console.log('Captured operations so far will print as they fire. Close window when done.');

try {
  await page.goto('https://splice.com/sounds/your-sounds/samples', {
    waitUntil: 'domcontentloaded',
  });
} catch (err) {
  console.error('navigation error:', err.message);
}

await new Promise((resolve) => ctx.on('close', resolve));
console.log(`\nTotal captured operations: ${captured.size}`);
process.exit(captured.size > 0 ? 0 : 1);
