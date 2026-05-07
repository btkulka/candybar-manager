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
await page.waitForTimeout(1500);

console.log('\n======================================================');
console.log('A Beatport-session browser window will open.');
console.log('Navigate to YOUR LIBRARY / DOWNLOADS and click DOWNLOAD on any track.');
console.log('You have 90 seconds. Everything Beatport fires will be captured.');
console.log('======================================================\n');

const result = await page.evaluate(() => window.candybar.sniffBeatportHeaders());
console.log('Sniff result:', { success: result.success, capturedCount: result.capturedCount, totalUrls: result.totalUrls });

// Analyze: look for requests that likely caused a download
const captured = JSON.parse(fs.readFileSync(result.outPath, 'utf8'));
const allUrls = fs.readFileSync('/tmp/beatport_all_urls.txt', 'utf8').split('\n');

console.log(`\nAll URLs captured (${allUrls.length}):`);
const downloadRelated = allUrls.filter(u => /download|order|asset|signed|my[-_]?(library|beatport|music)/i.test(u));
console.log(`Download/library-related URLs (${downloadRelated.length}):`);
for (const u of downloadRelated) console.log('  ' + u);

console.log(`\napi.beatport.com / /api/ requests with auth headers (${captured.length}):`);
for (const c of captured) {
  const authLike = Object.keys(c.headers).filter(k => /auth|token/i.test(k)).reduce((o, k) => (o[k] = c.headers[k].slice(0, 40), o), {});
  console.log(`  ${c.method} ${c.url}`);
  if (Object.keys(authLike).length) console.log('    auth:', authLike);
}

await app.close();
console.log('\nFull capture at /tmp/beatport_captured_requests.json + /tmp/beatport_all_urls.txt');
