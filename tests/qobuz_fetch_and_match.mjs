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
page.on('pageerror', (err) => console.error('[pageerror]', err.message));
await page.waitForTimeout(1500);

console.log('Login status:', await page.evaluate(() => window.candybar.storeLoginStatus()));

console.log('Fetching Qobuz purchases (will sniff X-App-Id/X-User-Auth-Token from persist:qobuz)...');
const t0 = Date.now();
const result = await page.evaluate(() => window.candybar.fetchStorePurchases('qobuz'));
console.log(`Fetched in ${Date.now() - t0}ms:`, { success: result.success, count: result.count, error: result.error });

if (result.success && result.owned) {
  fs.writeFileSync('/tmp/owned_qobuz.json', JSON.stringify(result.owned, null, 2));
  console.log(`Wrote ${result.owned.length} tracks to /tmp/owned_qobuz.json`);
  console.log('Sample:');
  console.log(JSON.stringify(result.owned.slice(0, 3), null, 2));
}

await app.close();
console.log('Done.');
