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

console.log('\n======================================================');
console.log('A play.qobuz.com window will open.');
console.log('  1. Log in if not already (top right)');
console.log('  2. Go to your Profile -> Purchases');
console.log('  3. Click DOWNLOAD on any track you own');
console.log('You have 2 minutes.');
console.log('======================================================\n');

const result = await page.evaluate(() => window.candybar.sniffQobuzHeaders());
console.log('Sniff result:', { success: result.success, capturedCount: result.capturedCount, totalUrls: result.totalUrls });

// Analyze capture
const captured = JSON.parse(fs.readFileSync(result.outPath, 'utf8'));
const allUrls = fs.readFileSync('/tmp/qobuz_all_urls.txt', 'utf8').split('\n');

const downloadRelated = allUrls.filter(u => /download|purchase|getFileUrl|fileDownload|signedUrl/i.test(u));
console.log(`\nDownload/purchase-related URLs (${downloadRelated.length}):`);
for (const u of downloadRelated.slice(0, 30)) console.log('  ' + u);

console.log(`\nAll unique qobuz.com API paths:`);
const paths = new Set();
for (const u of allUrls) {
  if (/qobuz\.com/.test(u) && !/\.(css|js|ttf|woff|png|jpg|gif|svg|ico)(\?|$)/.test(u)) {
    try {
      const parsed = new URL(u);
      paths.add(`${parsed.hostname}${parsed.pathname}`);
    } catch {}
  }
}
[...paths].sort().forEach(p => console.log('  ' + p));

console.log(`\nRequests with Authorization or X-App-Id (${captured.filter(c => Object.keys(c.headers).some(k => /authorization|app[-_]?id|user[-_]?auth/i.test(k))).length}):`);
for (const c of captured) {
  const auth = Object.entries(c.headers).filter(([k]) => /authorization|app[-_]?id|user[-_]?auth|token/i.test(k));
  if (auth.length) {
    console.log(`  ${c.url}`);
    auth.forEach(([k, v]) => console.log(`    ${k}: ${String(v).slice(0, 40)}`));
  }
}

await app.close();
console.log('\nFull capture at /tmp/qobuz_captured_requests.json + /tmp/qobuz_all_urls.txt');
