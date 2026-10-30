// Capture the GraphQL operations Splice fires to (a) read the user's
// credit balance and (b) purchase a sample with credits. We need both
// to wire up the credits-buying flow.
//
// Usage: node scripts/capture-splice-credits.mjs
//
// In the browser:
//   1. The page opens at sounds. Look at the top bar — there's usually
//      a credits indicator. Captures fire as it loads.
//   2. Click into a sample you don't own and try the "Add to Library /
//      Use 1 Credit" button. The purchase mutation will fire.
//   3. Optionally cancel before confirming if you don't want to spend
//      a credit. We just need the operation name + variable shape.
//   4. Close the window when done.

import { launchSiteBrowser } from '../lib/launchBrowser.mjs';

// Use a dedicated profile so we don't fight any running Chrome instance
// using the main `splice` profile.
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
    // Filter to credit/purchase/license/buy ops + a few common balance
    // operations. Splice's naming is unpredictable so cast a wide net.
    if (!/credit|purchase|license|buy|balance|wallet|subscription|user/i.test(op)) return;
    const key = `${op}::${JSON.stringify(body.variables || {})}`;
    if (seen.has(key)) return;
    seen.set(key, body);
    console.log(`\n=== ${op} ===`);
    console.log('variables:', JSON.stringify(body.variables, null, 2));
    const q = (body.query || '').replace(/\s+/g, ' ').slice(0, 800);
    console.log('query (truncated):', q);
  } catch (err) {
    console.error('parse error:', err.message);
  }
});

console.log('Opening Splice. Captures will print as relevant ops fire.');
console.log('STEPS:');
console.log('  1. Wait for the page to load (credit balance should appear top-right).');
console.log('  2. Click into ANY sample you don\'t own.');
console.log('  3. Hover or click the "Use 1 Credit" / purchase button (you can cancel before confirming).');
console.log('  4. Close window when done.\n');

try {
  await page.goto('https://splice.com/sounds', {
    waitUntil: 'domcontentloaded',
  });
} catch (err) {
  console.error('navigation error:', err.message);
}

await new Promise((resolve) => ctx.on('close', resolve));
console.log(`\nUnique operation/variable combos captured: ${seen.size}`);
process.exit(seen.size > 0 ? 0 : 1);
