#!/usr/bin/env node
// Playwright-driven end-to-end walkthrough of the Restore wizard.
// Launches the Electron app, navigates Source → Restore, fills the XML path
// without the native file dialog, disables USB/Beatport/SoundCloud so only
// Qobuz runs, and streams progress events to a log file.
//
// Run:   node tests/restore_walkthrough.mjs
// Logs:  /tmp/restore-walkthrough.log  (console + progress stream)
//        /tmp/restore-progress.jsonl   (one progress event per line, raw JSON)
//
// When Qobuz login windows pop up, the driver just waits — the user is expected
// to sign into those windows interactively. Re-run after fixing code.

import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const XML_PATH = '/Volumes/Time Machin/rekordbox/export.xml';
const LOG = '/tmp/restore-walkthrough.log';
const PROGRESS = '/tmp/restore-progress.jsonl';

fs.writeFileSync(LOG, '');
fs.writeFileSync(PROGRESS, '');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
}

function logProgress(obj) {
  fs.appendFileSync(PROGRESS, JSON.stringify(obj) + '\n');
}

// Inherit env but strip ELECTRON_RUN_AS_NODE which Playwright sets wrong for Electron.
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k === 'ELECTRON_RUN_AS_NODE') continue;
  if (typeof v === 'string') env[k] = v;
}
env.ELECTRON_DISABLE_SANDBOX = '1';

log(`Building…`);
execSync('npx electron-vite build', { cwd: ROOT, stdio: 'pipe' });

log(`Launching Electron from ${ROOT}`);
const app = await electron.launch({ args: ['.'], cwd: ROOT, env, timeout: 30000 });
const page = await app.firstWindow({ timeout: 15000 });
await page.waitForLoadState('domcontentloaded');

// Pipe the main-process stdout/stderr into our log so our restoreLibrary /
// storePurchase `mainLog` (electron-log) messages are visible during diagnosis.
try {
  const proc = app.process();
  proc.stdout?.on('data', d => String(d).split(/\r?\n/).filter(Boolean).forEach(line => log(`[main] ${line}`)));
  proc.stderr?.on('data', d => String(d).split(/\r?\n/).filter(Boolean).forEach(line => log(`[main:stderr] ${line}`)));
} catch (err) { log(`process pipe setup failed: ${err.message}`); }

page.on('console', msg => log(`[renderer ${msg.type()}] ${msg.text()}`));
page.on('pageerror', err => log(`[pageerror] ${err.message}\n${err.stack || ''}`));
page.on('crash', () => log('[page crashed]'));
page.on('close', () => log('[page closed]'));

// Inject a progress capture hook BEFORE we hit Start — writes every event to
// both the console (caught above) and a file via fetch so we have a durable log.
await page.evaluate(() => {
  const orig = window.candybar.onRestoreProgress;
  window.__restoreEvents = [];
  window.candybar.onRestoreProgress = (cb) => {
    return orig((p) => {
      window.__restoreEvents.push(p);
      // Echo a compact line to console so the driver sees it.
      const compact = {
        phase: p.phase,
        ps: p.phaseStatus,
        msg: p.message.slice(0, 120),
        rec: p.totals.recovered,
        missing: p.totals.stillMissing,
        rate: p.rate ? Number(p.rate.toFixed(2)) : null,
        eta: p.estRemainingSec ? Math.round(p.estRemainingSec) : null,
        el: Math.round(p.elapsedSec),
        log: p.log ? `[${p.log.level}] ${p.log.message}` : null,
        accounts: p.perAccount ? p.perAccount.length : 0,
      };
      console.log('PROGRESS ' + JSON.stringify(compact));
      cb(p);
    });
  };
});

// ---------- Stage 1: Configure ----------
log('Navigating to Restore tab…');
await page.click('button.nav-link[data-page="restore"]', { timeout: 8000 });
await page.waitForSelector('#restore-stepper', { timeout: 8000 });

// Force the Restore .page container active *and* the Configure wiz-stage visible.
// Nav click alone sometimes leaves the outer .page container without its `active`
// class, which hides everything inside via display:none.
await page.evaluate(() => {
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  const restorePage = document.getElementById('page-restore');
  if (restorePage) restorePage.classList.add('active');
  document.querySelectorAll('.wiz-stage').forEach(el => {
    const active = el.getAttribute('data-stage') === 'configure';
    el.classList.toggle('is-active', active);
    el.style.display = active ? '' : 'none';
  });
});
// Wait for the Review button to be visible so we know the page is live.
try {
  await page.waitForSelector('#restore-to-review:visible', { timeout: 5000 });
} catch (err) {
  await page.screenshot({ path: '/tmp/restore-debug-configure.png' }).catch(() => {});
  const diag = await page.evaluate(() => {
    const page = document.getElementById('page-restore');
    const stage = document.querySelector('[data-stage="configure"]');
    const btn = document.getElementById('restore-to-review');
    return {
      pageClasses: page ? Array.from(page.classList) : null,
      pageDisplay: page ? getComputedStyle(page).display : null,
      stageClasses: stage ? Array.from(stage.classList) : null,
      stageDisplay: stage ? getComputedStyle(stage).display : null,
      btnExists: !!btn,
      btnDisplay: btn ? getComputedStyle(btn).display : null,
      btnRect: btn ? btn.getBoundingClientRect().toJSON() : null,
    };
  });
  log(`Configure-visibility diag: ${JSON.stringify(diag)}`);
  throw err;
}
log('On Restore page, Configure stage visible.');

// Bypass native file dialog — just shove the path into the input element.
log(`Setting XML path via evaluate: ${XML_PATH}`);
await page.evaluate((p) => {
  const el = document.getElementById('restore-xml-path');
  if (el) { el.removeAttribute('readonly'); el.value = p; el.dispatchEvent(new Event('input', { bubbles: true })); }
}, XML_PATH);

// Uncheck USB / Beatport / SoundCloud — Qobuz-only run. Use evaluate rather
// than Playwright clicks; clicking hidden or semi-visible checkboxes has been
// flaky (target crashes). Evaluate sets the value directly and dispatches a
// synthetic change so the restore.ts change handler still fires.
log('Configuring sources: Qobuz only');
await page.evaluate(() => {
  const want = {
    'restore-src-usb': false,
    'restore-src-beatport': false,
    'restore-src-qobuz': true,
    'restore-src-soundcloud': false,
  };
  for (const [id, v] of Object.entries(want)) {
    const el = document.getElementById(id);
    if (!(el instanceof HTMLInputElement)) continue;
    if (el.checked !== v) {
      el.checked = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
});

// Log current account connection status before Review so we can see whether the
// last login attempt left cookies in the right partitions.
const statusBefore = await page.evaluate(() => window.candybar.storeLoginStatus());
log(`Auth status BEFORE review: ${JSON.stringify(statusBefore)}`);

// ---------- Stage 2: Review ----------
const preClick = await page.evaluate(() => {
  const stages = Array.from(document.querySelectorAll('.wiz-stage')).map(el => ({
    stage: el.getAttribute('data-stage'),
    classes: Array.from(el.classList),
    inlineDisplay: (el).style.display,
    computedDisplay: getComputedStyle(el).display,
  }));
  return { stages };
});
log(`Pre-click stage state: ${JSON.stringify(preClick)}`);

log('Clicking Review plan…');
await page.click('#restore-to-review');

// Poll for Review becoming visible instead of a strict waitForSelector — more
// forgiving if setStage has a timing quirk.
let reviewVisible = false;
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 200));
  reviewVisible = await page.evaluate(() => {
    const el = document.getElementById('restore-stage-review');
    if (!el) return false;
    return getComputedStyle(el).display !== 'none';
  });
  if (reviewVisible) break;
}
if (!reviewVisible) {
  const post = await page.evaluate(() => {
    const stages = Array.from(document.querySelectorAll('.wiz-stage')).map(el => ({
      stage: el.getAttribute('data-stage'),
      classes: Array.from(el.classList),
      inlineDisplay: (el).style.display,
      computedDisplay: getComputedStyle(el).display,
    }));
    return {
      stages,
      pageRestoreClasses: Array.from(document.getElementById('page-restore')?.classList ?? []),
      pageRestoreDisplay: document.getElementById('page-restore') ? getComputedStyle(document.getElementById('page-restore')).display : null,
      reviewBtnExists: !!document.getElementById('restore-to-review'),
    };
  });
  log(`Review never visible. Post-click state: ${JSON.stringify(post)}`);
  throw new Error('Review stage did not become visible');
}

const planLines = await page.locator('#review-plan li').allTextContents();
log(`Plan lines:\n  - ${planLines.join('\n  - ')}`);
const warnings = await page.locator('#review-warnings li').allTextContents().catch(() => []);
if (warnings.length) log(`Warnings:\n  - ${warnings.join('\n  - ')}`);

// ---------- Stage 3: Start ----------
// Wait for any auto-kicked library-health scan to finish before starting the
// restore. Running both concurrently has reproducibly crashed the renderer
// (GPU process exit + network service crash) — they both walk 1670 files.
log('Waiting for background library scan to settle before Start…');
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const scanning = await page.evaluate(() => {
    const s = document.getElementById('library-scan-status');
    if (!s) return false;
    const hidden = s.style.display === 'none';
    const len = (s.textContent || '').trim().length;
    return !hidden && len > 0;
  }).catch(() => false);
  if (!scanning) break;
}

log('Clicking Start restore — this will open Qobuz login window(s) for any disconnected accounts. Please sign in when prompted.');
await page.click('#restore-start');
await page.waitForSelector('#restore-stage-running.is-active', { timeout: 5000 });
log('Run stage active. Streaming progress; this may take a while.');

// Wait for Run to complete — detected via the Report stage becoming active,
// or by a terminal error toast. 30-minute hard cap.
const deadline = Date.now() + 30 * 60 * 1000;
let finishedReason = null;
while (Date.now() < deadline) {
  try {
    const reportVisible = await page.locator('#restore-stage-report.is-active').isVisible().catch(() => false);
    if (reportVisible) { finishedReason = 'report-visible'; break; }
    // Also peek at the current phase — 'complete' with 'end' status means done.
    const done = await page.evaluate(() => {
      const ev = window.__restoreEvents || [];
      const last = ev[ev.length - 1];
      return last && last.phase === 'complete' && last.phaseStatus === 'end';
    });
    if (done) { finishedReason = 'complete-phase'; break; }
  } catch (err) {
    log(`poll error: ${err.message}`);
  }
  await new Promise(r => setTimeout(r, 2000));
}

if (finishedReason) {
  log(`Run finished (${finishedReason}).`);
  // Dump the full progress event series to file.
  const events = await page.evaluate(() => window.__restoreEvents || []);
  for (const e of events) logProgress(e);
  log(`Captured ${events.length} progress events to ${PROGRESS}`);

  // Dump the report summary visible in the UI.
  const hero = await page.locator('#restore-report-hero').textContent().catch(() => '');
  const byAccount = await page.locator('#report-by-account').textContent().catch(() => '');
  const failures = await page.locator('#report-failures').textContent().catch(() => '');
  log(`HERO: ${hero.trim()}`);
  log(`BY ACCOUNT: ${byAccount.trim()}`);
  log(`FAILURES: ${failures.trim()}`);
} else {
  log('Run did not finish within 30 minutes. Leaving app open for inspection.');
}

// Leave the app running so the user can inspect. Close when they hit Ctrl+C or
// when this script is killed.
log('Driver idle. Electron app still open. Press Ctrl+C to close.');
await new Promise(() => { /* park */ });
