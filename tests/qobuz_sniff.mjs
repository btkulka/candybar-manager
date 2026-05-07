import { _electron as electron } from 'playwright';
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

console.log('Sniffing XHRs from play.qobuz.com/user/purchases (window will open; wait ~10s)...');
const result = await page.evaluate(() => window.candybar.sniffQobuzHeaders());
console.log('sniff result:', { success: result.success, capturedCount: result.capturedCount, totalUrls: result.totalUrls, outPath: result.outPath });
if (result.urlSample) {
  console.log('First 20 URLs the page fetched:');
  result.urlSample.forEach(u => console.log('  ' + u));
}
if (result.sample) {
  console.log('First few captured requests:');
  for (const r of result.sample) {
    console.log(' URL:', r.url);
    const interesting = {};
    for (const k of Object.keys(r.headers)) {
      if (k.toLowerCase().includes('app') || k.toLowerCase().includes('auth') || k.toLowerCase().includes('user') || k.toLowerCase().includes('token')) {
        interesting[k] = r.headers[k].slice(0, 40);
      }
    }
    console.log(' interesting headers:', interesting);
  }
}

await app.close();
console.log('Done. Full capture at /tmp/qobuz_captured_requests.json');
