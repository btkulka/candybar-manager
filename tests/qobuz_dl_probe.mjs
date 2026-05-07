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

const TRACK_ID = process.argv[2] || '3872634'; // Grouplove — Tongue Tied (known owned)

execSync('npx electron-vite build', { cwd: ROOT, stdio: 'inherit' });

const app = await electron.launch({ args: ['.'], cwd: ROOT, env, timeout: 30000 });
const page = await app.firstWindow({ timeout: 15000 });
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(1500);

console.log(`Probing Qobuz download endpoints for track ${TRACK_ID}...`);
const probe = await page.evaluate((id) => window.candybar.probeQobuzDownload(id), TRACK_ID);
if (!probe.success) {
  console.error('Probe failed:', probe.error);
} else {
  for (const r of probe.results || []) {
    console.log(`${r.status} ${r.url}`);
    console.log(`  body: ${r.body.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
}

await app.close();
