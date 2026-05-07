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

const TRACK_ID = process.argv[2] || '24508685'; // ANOTR "Talk To You" Extended Mix
const ORDER_ITEM_ID = process.argv[3] || '588961276'; // from raw listing

console.log('Building...');
execSync('npx electron-vite build', { cwd: ROOT, stdio: 'inherit' });

console.log('Launching...');
const app = await electron.launch({ args: ['.'], cwd: ROOT, env, timeout: 30000 });
const page = await app.firstWindow({ timeout: 15000 });
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(1500);

console.log(`Probing download endpoints for trackId=${TRACK_ID}...`);
const probe = await page.evaluate(([id, oid]) => window.candybar.probeBeatportDownloadLink(id, oid), [TRACK_ID, ORDER_ITEM_ID]);
if (!probe.success) {
  console.error('Probe failed:', probe.error);
} else {
  for (const r of probe.results || []) {
    console.log(`${r.status} ${r.auth.padEnd(6)} ${r.url}`);
    console.log(`  keys: ${(r.topLevelKeys || []).join(',')}`);
    console.log(`  body: ${r.bodySnippet.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
}

await app.close();
console.log('Done.');
