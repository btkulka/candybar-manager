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
await page.waitForTimeout(1000);

// If already logged in from a previous session, skip the window
const initialStatus = await page.evaluate(() => window.candybar.storeLoginStatus());
if (initialStatus.qobuz) {
  console.log('Qobuz already logged in — skipping login window.');
} else {
console.log('Opening Qobuz signin in a visible BrowserWindow...');

// We trigger the main-process login helper indirectly — by calling storeLogin('qobuz')
// which triggers loginQobuzWindow (visible BrowserWindow) when no creds provided.
// But our loginQobuz(email,password) calls loginQobuzApi (hidden). So we need to force the window path.
// Workaround: simply open a visible window by evaluating on main via a BrowserView trick — or
// run the storeLogin IPC which we know uses the visible login flow path.
const loginResult = await page.evaluate(async () => {
  return await window.candybar.openQobuzLoginWindow();
});
console.log('openQobuzLoginWindow result:', loginResult);

// Poll until logged in (user must complete form in the window)
console.log('Waiting for you to complete Qobuz login in the window...');
const deadline = Date.now() + 180_000; // 3 minutes
let loggedIn = false;
while (Date.now() < deadline) {
  const st = await page.evaluate(() => window.candybar.storeLoginStatus());
  if (st.qobuz) { loggedIn = true; break; }
  await new Promise(r => setTimeout(r, 2000));
  process.stdout.write('.');
}
console.log('');

if (!loggedIn) {
  console.error('Timed out waiting for Qobuz login.');
  await app.close();
  process.exit(1);
}
}

console.log('Qobuz logged in. Running probe...');
const probe = await page.evaluate(() => window.candybar.probeQobuzPurchases());
if (!probe.success) {
  console.error('Probe failed:', probe.error);
} else {
  for (const r of probe.results || []) {
    console.log(`${r.status} ${r.method.padEnd(4)} len=${r.bodyLength} hasItems=${r.hasListItems ?? '-'} keys=${(r.jsonTopLevelKeys||[]).join(',') || '-'} ${r.url}`);
    console.log(`  body: ${r.bodySnippet.slice(0, 300).replace(/\s+/g, ' ')}`);
  }
}

await app.close();
console.log('Done.');
