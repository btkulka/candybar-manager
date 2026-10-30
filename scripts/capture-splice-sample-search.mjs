// Capture the *exact* GraphQL request Splice's web app fires when you type
// a specific sample name into search. Our current `filepath` filter is
// returning unrelated popular results, so we need to see what variable
// shape they're actually using now.
//
// Usage: node scripts/capture-splice-sample-search.mjs
//
// In the browser:
//   1. The page opens at sounds search
//   2. Type a specific sample basename (e.g. "KSHMR_Stadium_Kick")
//   3. The script captures every SamplesSearch request and prints variables
//   4. Close window when you've seen captures of the search you care about

import { launchSiteBrowser } from '../lib/launchBrowser.mjs';

// Use a separate profile name so Chrome doesn't hand off to an already-
// running browser using the main `splice` profile. We don't need
// authenticated state to capture variable shapes — anonymous search works.
const ctx = await launchSiteBrowser({ profile: 'splice-capture', headless: false });
const page = await ctx.newPage();

let count = 0;

page.on('request', (req) => {
  if (!req.url().startsWith('https://surfaces-graphql.splice.com/graphql')) return;
  const post = req.postData();
  if (!post) return;
  try {
    const body = JSON.parse(post);
    if (body.operationName !== 'SamplesSearch') return;
    count++;
    console.log(`\n=== capture #${count} (variables only) ===`);
    console.log(JSON.stringify(body.variables, null, 2));
  } catch (err) {
    console.error('parse error:', err.message);
  }
});

console.log('Opening Splice sounds search.');
console.log('Type a SPECIFIC sample basename in the search box (e.g. "KSHMR_Stadium_Kick_04_Ouch") and watch what variables fire.');
console.log('Try a few different searches if the first one is too vague.');

try {
  await page.goto('https://splice.com/sounds/search', {
    waitUntil: 'domcontentloaded',
  });
} catch (err) {
  console.error('navigation error:', err.message);
}

await new Promise((resolve) => ctx.on('close', resolve));
console.log(`\nTotal SamplesSearch captures: ${count}`);
process.exit(count > 0 ? 0 : 1);
