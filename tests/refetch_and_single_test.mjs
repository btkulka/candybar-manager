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

console.log('Refetching Beatport purchases (to capture orderItemDownloadId)...');
const fetchResult = await page.evaluate(() => window.candybar.fetchStorePurchases('beatport'));
console.log(`Fetched ${fetchResult.count} tracks`);
const haveOidd = fetchResult.owned.filter(t => t.orderItemDownloadId).length;
console.log(`  ${haveOidd} have orderItemDownloadId`);
console.log('  Sample:', JSON.stringify(fetchResult.owned[0], null, 2));

// Pick one track — use the same ANOTR track we sniffed
const testTrack = fetchResult.owned.find(t => t.trackId === '24508685') || fetchResult.owned[0];
console.log(`\nTesting single download: ${testTrack.artist} — ${testTrack.title} (trackId=${testTrack.trackId}, oidd=${testTrack.orderItemDownloadId})`);

const match = {
  input: { artist: testTrack.artist, title: testTrack.title },
  trackId: testTrack.trackId,
  orderItemDownloadId: testTrack.orderItemDownloadId,
  title: testTrack.title,
  artist: testTrack.artist,
  album: '', label: '', price: '', quality: 'AIFF', format: 'AIFF',
  lossless: true, rx3Compatible: true, confidence: 1, url: '', source: 'beatport',
};

const result = await page.evaluate(async (m) => {
  return await window.candybar.downloadBeatportMatches([m], '/tmp/beatport_single_test');
}, match);

console.log('Download result:', {
  success: result.success,
  downloaded: result.downloaded?.length || 0,
  failed: result.failed?.length || 0,
});
if (result.failed?.length) console.log('Failure:', result.failed[0]);
if (result.downloaded?.length) console.log('Downloaded to:', result.downloaded[0]);

await app.close();
console.log('Done.');
