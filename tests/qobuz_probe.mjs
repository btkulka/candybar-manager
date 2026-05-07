import { _electron as electron } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k === 'ELECTRON_RUN_AS_NODE') continue;
  if (typeof v === 'string') env[k] = v;
}
env.ELECTRON_DISABLE_SANDBOX = '1';

console.log('Building...');
execSync('npx electron-vite build', { cwd: ROOT, stdio: 'inherit' });

console.log('Launching...');
const app = await electron.launch({ args: ['.'], cwd: ROOT, env, timeout: 30000 });
const page = await app.firstWindow({ timeout: 15000 });
await page.waitForLoadState('domcontentloaded');
page.on('console', (msg) => console.log(`[renderer ${msg.type()}]`, msg.text()));
page.on('pageerror', (err) => console.error('[pageerror]', err.message));
await page.waitForTimeout(1500);

console.log('Qobuz login status:');
console.log(await page.evaluate(() => window.candybar.storeLoginStatus()));

console.log('Probing Qobuz...');
const probe = await page.evaluate(() => window.candybar.probeQobuzPurchases());
if (!probe.success) {
  console.error('Probe failed:', probe.error);
} else {
  for (const r of probe.results || []) {
    console.log(`${r.status} ${r.method.padEnd(4)} len=${r.bodyLength} hasItems=${r.hasListItems ?? '-'} keys=${(r.jsonTopLevelKeys||[]).join(',') || '-'} ${r.url}`);
    console.log(`  body: ${r.bodySnippet.slice(0, 200).replace(/\s+/g, ' ')}`);
  }
}

await app.close();
console.log('Done.');
