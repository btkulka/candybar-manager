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

const DEST_DIR = '/Volumes/Time Machin/tracks_to_organize/qobuz_redownloads';
const CONCURRENCY = 5;

console.log('Building...');
execSync('npx electron-vite build', { cwd: ROOT, stdio: 'inherit' });

const plan = JSON.parse(fs.readFileSync('/tmp/redownload_qobuz.json', 'utf8'));
const matches = plan.map(p => ({
  input: { artist: p.missing.artist, title: p.missing.title, album: p.missing.album },
  trackId: p.owned.trackId,
  title: p.owned.title,
  artist: p.owned.artist,
  album: '', label: '', price: '', quality: 'FLAC', format: 'FLAC',
  lossless: true, rx3Compatible: false, confidence: p.score, url: '',
  source: 'qobuz',
}));
console.log(`Planning to re-download ${matches.length} Qobuz tracks to ${DEST_DIR} with concurrency=${CONCURRENCY}`);

const app = await electron.launch({ args: ['.'], cwd: ROOT, env, timeout: 30000 });
const page = await app.firstWindow({ timeout: 15000 });
await page.waitForLoadState('domcontentloaded');
page.on('pageerror', (err) => console.error('[pageerror]', err.message));
await page.waitForTimeout(1500);

console.log('Login status:', await page.evaluate(() => window.candybar.storeLoginStatus()));

await page.evaluate(() => {
  window.__qProgress = [];
  window.candybar.onDownloadQobuzProgress?.((p) => window.__qProgress.push(p));
});

const pollInterval = setInterval(async () => {
  try {
    const recent = await page.evaluate(() => {
      const all = window.__qProgress || [];
      const unread = all.slice(window.__qProgressRead || 0);
      window.__qProgressRead = all.length;
      return unread;
    });
    for (const p of recent) {
      if (p.current % 5 === 0 || p.phase === 'complete') {
        console.log(`  ${p.current}/${p.total} ${p.phase}`);
      }
    }
  } catch {}
}, 5000);

const t0 = Date.now();
const result = await page.evaluate(async ({ matches, destDir, concurrency }) => {
  return await window.candybar.downloadQobuzMatchesConcurrent(matches, destDir, concurrency);
}, { matches, destDir: DEST_DIR, concurrency: CONCURRENCY });
clearInterval(pollInterval);

console.log(`Done in ${Date.now() - t0}ms — success=${result.success} downloaded=${result.downloaded?.length || 0} failed=${result.failed?.length || 0}`);
if (result.failed?.length) {
  console.log('First 10 failures:');
  result.failed.slice(0, 10).forEach(f => console.log(`  ${f.artist} — ${f.title}: ${f.error}`));
}
fs.writeFileSync('/tmp/qobuz_download_result.json', JSON.stringify(result, null, 2));

await app.close();
