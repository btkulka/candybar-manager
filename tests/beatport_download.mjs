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

const DEST_DIR = '/Volumes/Time Machin/tracks_to_organize/beatport_redownloads';
const PROGRESS_LOG = '/tmp/beatport_download_progress.log';

console.log('Building...');
execSync('npx electron-vite build', { cwd: ROOT, stdio: 'inherit' });

// Read the redownload plan and convert to StoreMatch shape
const plan = JSON.parse(fs.readFileSync('/tmp/redownload_beatport.json', 'utf8'));
const matches = plan.map(p => ({
  input: { artist: p.missing.artist, title: p.missing.title, album: p.missing.album },
  trackId: p.owned.trackId,
  orderItemDownloadId: p.owned.orderItemDownloadId,
  title: p.owned.title,
  artist: p.owned.artist,
  album: '',
  label: '',
  price: '',
  quality: 'AIFF',
  format: 'AIFF',
  lossless: true,
  rx3Compatible: true,
  confidence: p.score,
  url: '',
  source: 'beatport',
}));
const haveOidd = matches.filter(m => m.orderItemDownloadId).length;
console.log(`${haveOidd}/${matches.length} have orderItemDownloadId`);
if (haveOidd === 0) {
  console.error('None of the matches have orderItemDownloadId. Re-run owned_beatport.json fetch first.');
  process.exit(1);
}
console.log(`Planning to re-download ${matches.length} tracks from Beatport to ${DEST_DIR}`);

console.log('Launching...');
const app = await electron.launch({ args: ['.'], cwd: ROOT, env, timeout: 30000 });
const page = await app.firstWindow({ timeout: 15000 });
await page.waitForLoadState('domcontentloaded');
page.on('pageerror', (err) => console.error('[pageerror]', err.message));
await page.waitForTimeout(1500);

// Set up progress listener via renderer
await page.evaluate(() => {
  window.__bpProgress = [];
  window.candybar.onDownloadBeatportProgress((p) => {
    window.__bpProgress.push(p);
    console.log(`[bp] ${p.current}/${p.total} ${p.phase}: ${p.message}`);
  });
});

console.log('Kicking off downloadBeatportMatches (long-running)...');
const logStream = fs.createWriteStream(PROGRESS_LOG);
logStream.write(`Started at ${new Date().toISOString()} — ${matches.length} tracks\n`);

// Poll renderer's progress array periodically so we can log to file
const pollInterval = setInterval(async () => {
  try {
    const recent = await page.evaluate(() => {
      const all = window.__bpProgress || [];
      const unread = all.slice(window.__bpProgressRead || 0);
      window.__bpProgressRead = all.length;
      return unread;
    });
    for (const p of recent) {
      logStream.write(`[${new Date().toISOString()}] ${p.current}/${p.total} ${p.phase}: ${p.message}\n`);
      if (p.current % 10 === 0 || p.phase === 'complete') {
        console.log(`  ${p.current}/${p.total} ${p.phase}`);
      }
    }
  } catch {}
}, 5000);

const result = await page.evaluate(async (matches) => {
  return await window.candybar.downloadBeatportMatches(matches, '/Volumes/Time Machin/tracks_to_organize/beatport_redownloads');
}, matches);

clearInterval(pollInterval);
logStream.write(`Finished at ${new Date().toISOString()}\n`);
logStream.end();

console.log('Download result:');
console.log({
  success: result.success,
  downloaded: result.downloaded?.length || 0,
  failed: result.failed?.length || 0,
});
if (result.failed && result.failed.length > 0) {
  console.log('First 10 failures:');
  result.failed.slice(0, 10).forEach(f => console.log(`  ${f.artist} — ${f.title}: ${f.error}`));
}

fs.writeFileSync('/tmp/beatport_download_result.json', JSON.stringify(result, null, 2));
console.log('Result saved to /tmp/beatport_download_result.json');

await app.close();
console.log('Done.');
