// Capture every GraphQL operation Splice's web app fires while the user
// browses their owned/library page. We're hunting for an exact-filename
// lookup mechanism — `SamplesSearch` no longer matches by name, so there
// must be a different endpoint (or a different variable shape) for the
// "find a specific sample I own" flow.
//
// Usage: node scripts/capture-splice-library.mjs
//
// In the browser:
//   1. The page opens at /sounds/your-sounds/samples
//   2. Browse / scroll / use any filter UI you can find
//   3. If there's a search box on this page, type a specific basename
//   4. Close the window when you've exercised the obvious surfaces

import { launchSiteBrowser } from '../lib/launchBrowser.mjs';

const ctx = await launchSiteBrowser({ profile: 'splice', headless: false });
const page = await ctx.newPage();

const seen = new Map();

page.on('request', (req) => {
  if (!req.url().startsWith('https://surfaces-graphql.splice.com/graphql')) return;
  const post = req.postData();
  if (!post) return;
  try {
    const body = JSON.parse(post);
    const op = body.operationName;
    if (!op) return;
    const key = `${op}::${JSON.stringify(body.variables || {})}`;
    if (seen.has(key)) return;
    seen.set(key, body);
    console.log(`\n=== ${op} ===`);
    console.log('variables:', JSON.stringify(body.variables, null, 2));
    // Trim query string for readability — print first 400 chars
    const q = (body.query || '').replace(/\s+/g, ' ').slice(0, 500);
    console.log('query (truncated):', q);
  } catch (err) {
    console.error('parse error:', err.message);
  }
});

console.log('Opening Splice library. Try the in-page search/filter if there is one.');
console.log('Captured operations stream below — close the window when done.');

try {
  await page.goto('https://splice.com/sounds/your-sounds/samples', {
    waitUntil: 'domcontentloaded',
  });
} catch (err) {
  console.error('navigation error:', err.message);
}

await new Promise((resolve) => ctx.on('close', resolve));
console.log(`\nUnique operation/variable combos: ${seen.size}`);
process.exit(seen.size > 0 ? 0 : 1);
