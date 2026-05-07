import { _electron as electron } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k === 'ELECTRON_RUN_AS_NODE') continue;
  if (typeof v === 'string') env[k] = v;
}
env.ELECTRON_DISABLE_SANDBOX = '1';

import { execSync } from 'child_process';
console.log('Building electron-vite...');
execSync('npx electron-vite build', { cwd: ROOT, stdio: 'inherit' });

console.log('Launching Electron app...');
const app = await electron.launch({
  args: ['.'],
  cwd: ROOT,
  env,
  timeout: 30000,
});

const page = await app.firstWindow({ timeout: 15000 });
await page.waitForLoadState('domcontentloaded');

page.on('console', (msg) => console.log(`[renderer ${msg.type()}]`, msg.text()));
page.on('pageerror', (err) => console.error('[pageerror]', err.message));

await page.waitForTimeout(1500);
const hasBinding = await page.evaluate(() => typeof window.candybar?.fetchStorePurchases === 'function');
console.log('fetchStorePurchases binding present?', hasBinding);

if (!hasBinding) {
  console.error('Binding missing — build stale.');
  await app.close();
  process.exit(1);
}

const loginStatus = await page.evaluate(() => window.candybar.storeLoginStatus());
console.log('Login status:', loginStatus);

console.log('Running probe first...');
const probe = await page.evaluate(() => window.candybar.probeBeatportPurchases());
const probeHit = probe.results?.find(r => r.ok && r.count);
if (probeHit) {
  console.log(`Probe: endpoint ${probeHit.url} (${probeHit.auth}) reports count=${probeHit.count}`);
} else {
  console.log('Probe: no working endpoint');
  console.log('Probe results:');
  for (const r of probe.results || []) console.log(` ${r.status} ${r.auth} ${r.url} — ${r.bodySnippet.slice(0,100)}`);
}

console.log('Now calling fetchStorePurchases("beatport")...');
const t0 = Date.now();
const result = await page.evaluate(() => window.candybar.fetchStorePurchases('beatport'));
const ms = Date.now() - t0;
console.log(`Done in ${ms}ms — success=${result.success}, count=${result.count}`);

if (result.success && result.owned) {
  const outPath = '/tmp/owned_beatport.json';
  fs.writeFileSync(outPath, JSON.stringify(result.owned, null, 2));
  console.log(`Wrote ${result.owned.length} tracks to ${outPath}`);
  console.log('Sample (first 3):');
  console.log(JSON.stringify(result.owned.slice(0, 3), null, 2));
} else {
  console.error('Failed:', result.error);
}

await app.close();
console.log('Done.');
