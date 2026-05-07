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

console.log('Opening my.beatport.com/downloads... CLICK "DOWNLOAD" ON ANY TRACK IN THE WINDOW to capture the exact download request. You have 30 seconds.');
const result = await page.evaluate(() => window.candybar.sniffBeatportHeaders());
console.log('Sniff result:', { success: result.success, capturedCount: result.capturedCount, totalUrls: result.totalUrls });

// Show captured api.beatport.com requests
const captured = JSON.parse(fs.readFileSync(result.outPath, 'utf8'));
const interesting = captured.filter(c => /download|order/i.test(c.url));
console.log(`\nRequests mentioning download/order (${interesting.length}):`);
for (const c of interesting.slice(0, 20)) {
  console.log(`  ${c.method} ${c.url}`);
}

await app.close();
console.log('Done.');
