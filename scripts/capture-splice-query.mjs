// Open Splice with our authed profile, navigate to a search results page,
// and capture the *current* SamplesSearch GraphQL query body. The schema
// has shifted under us; this prints what their web app is sending today
// so we can paste it back into lib/spliceClient.mjs.
//
// Usage: node scripts/capture-splice-query.mjs

import { launchSiteBrowser } from '../lib/launchBrowser.mjs';

const ctx = await launchSiteBrowser({ profile: 'splice', headless: false });
const page = await ctx.newPage();

let captured = null;

page.on('request', (req) => {
  if (captured) return;
  if (!req.url().startsWith('https://surfaces-graphql.splice.com/graphql')) return;
  const post = req.postData();
  if (!post) return;
  try {
    const body = JSON.parse(post);
    if (body.operationName !== 'SamplesSearch') return;
    captured = body;
    console.log('\n\n=== captured SamplesSearch ===\n');
    console.log(JSON.stringify(body, null, 2));
    console.log('\n=== end ===\n');
    console.log('You can close the browser window now.');
  } catch (err) {
    console.error('parse error:', err.message);
  }
});

console.log('Opening Splice search page. The script will print the query and exit when SamplesSearch fires.');
console.log('Steps:');
console.log('  1. The page may open Splice home — navigate to Sounds and run any search (e.g. type "kick").');
console.log('  2. Once results render, the script captures the GraphQL request and prints it.');
console.log('  3. Close the browser window when done.');

try {
  await page.goto('https://splice.com/sounds/search', { waitUntil: 'domcontentloaded' });
} catch (err) {
  console.error('navigation error (continuing — manual nav still works):', err.message);
}

await new Promise((resolve) => ctx.on('close', resolve));
process.exit(captured ? 0 : 1);
