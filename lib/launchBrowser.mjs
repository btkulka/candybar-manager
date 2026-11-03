// Shared browser launcher for scripts that hit external sites (Splice,
// Qobuz, Beatport, SoundCloud, etc).
//
// Two modes:
//
//   attach  — a Chrome that is already running with a DevTools port
//             (CANDYBAR_CHROME_CDP=http://127.0.0.1:9222, or that default
//             port when something answers on it). The scripts then work in
//             tabs of the browser you already have signed in: no new window,
//             no second set of logins. Only tabs this process opens are ever
//             touched or closed, and disconnecting never quits Chrome.
//             Note: Chrome 136+ refuses a debugging port on its default data
//             directory, so this needs a Chrome started with --user-data-dir
//             (a dedicated always-on automation Chrome), not the everyday one.
//
//   launch  — the fallback: real installed Google Chrome with a persistent
//             profile per site under ~/.cache/candybar-manager. Why real
//             Chrome: Playwright's bundled Chrome-for-Testing has a fingerprint
//             Cloudflare and friends block. Why a persistent profile: the
//             login survives, so the browser looks like a returning human.
//
// Use `launchSiteBrowser({ profile: 'splice' })` for any external-site
// script. For internal screenshots against localhost the default
// `chromium.launch()` is still fine — anti-bot doesn't apply there.

import { chromium } from 'playwright';
import { EventEmitter } from 'events';
import os from 'os';
import path from 'path';
import fs from 'fs';

const PROFILE_ROOT = path.join(os.homedir(), '.cache', 'candybar-manager', 'playwright-profiles');
const DEFAULT_CDP = 'http://127.0.0.1:9222';

/** The CDP endpoint to attach to, or null. */
export async function findRunningChrome() {
  const env = process.env.CANDYBAR_CHROME_CDP;
  if (env === '0' || env === 'never' || process.env.CANDYBAR_CHROME_ATTACH === '0') return null;
  const url = (env || DEFAULT_CDP).replace(/\/$/, '');
  try {
    const r = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(800) });
    if (!r.ok) return null;
    const j = await r.json();
    return j.webSocketDebuggerUrl ? url : null;
  } catch {
    return null;
  }
}

/**
 * A window onto an already-running Chrome. Looks enough like the persistent
 * BrowserContext the sourcing scripts expect — pages(), newPage(),
 * on('page')/off('page') for pop-ups, close() — but it only ever sees tabs
 * opened through it (or pop-ups of those), and close() disconnects instead of
 * quitting the browser.
 */
class AttachedContext extends EventEmitter {
  constructor(browser, context, endpoint) {
    super();
    this.attached = true;
    this.endpoint = endpoint;
    this.browser = browser;
    this.context = context;
    this.mine = new Set();
    this._onPage = async (p) => {
      let opener = null;
      try { opener = await p.opener(); } catch { /* page already gone */ }
      if (opener && this.mine.has(opener)) {
        this._track(p);
        this.emit('page', p);
      }
    };
    context.on('page', this._onPage);
  }
  _track(p) {
    this.mine.add(p);
    p.once('close', () => this.mine.delete(p));
  }
  pages() { return [...this.mine].filter(p => !p.isClosed()); }
  async newPage() {
    const p = await this.context.newPage();
    this._track(p);
    return p;
  }
  waitForEvent(name, { timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.off(name, h); reject(new Error(`waitForEvent(${name}) timed out`)); }, timeout);
      const h = (v) => { clearTimeout(t); resolve(v); };
      this.once(name, h);
    });
  }
  async close() {
    for (const p of this.pages()) { try { await p.close(); } catch { /* already closed */ } }
    try { this.context.off('page', this._onPage); } catch { /* disconnected */ }
    // For a connected browser this disconnects; Chrome itself keeps running.
    try { await this.browser.close(); } catch { /* already disconnected */ }
  }
}

// ---------- Shared contexts (opt-in, for long-lived callers) ----------
//
// The MCP server runs for hours and calls in here once per tool call. Without
// sharing, every call launched Chrome, opened a window, and quit it again. With
// enableSharedBrowsers(), launchSiteBrowser hands out a lease on ONE context per
// profile: the caller's close() releases the lease (closing only the extra tabs
// it opened, never the last one) and the window stays for the next call. It is
// closed after `idleMs` with no lease, or by closeSharedBrowsers().
//
// Off by default: a one-shot CLI script calls close() expecting Chrome to quit
// so the process can exit.

let sharing = false;
let sharedIdleMs = 10 * 60_000;
/** profile -> { ctxPromise, leases, idleTimer } */
const sharedContexts = new Map();

export function enableSharedBrowsers({ idleMs = 10 * 60_000 } = {}) {
  sharing = true;
  sharedIdleMs = idleMs;
}

/** Close every shared context now (before handing a profile to a child
 *  process, which can't open a profile directory another Chrome holds). */
export async function closeSharedBrowsers() {
  const entries = [...sharedContexts.values()];
  sharedContexts.clear();
  await Promise.all(entries.map(async (entry) => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try { await (await entry.ctxPromise).close(); } catch { /* already gone */ }
  }));
}

function leaseOf(ctx, release) {
  const opened = new Set();
  let released = false;
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop === 'close') {
        return async () => {
          if (released) return;
          released = true;
          // Tidy the tabs this caller opened, but always leave one so the
          // window (and its signed-in session) stays for the next call.
          for (const p of opened) {
            if (p.isClosed()) continue;
            if (target.pages().length <= 1) break;
            try { await p.close(); } catch { /* already closed */ }
          }
          release();
        };
      }
      if (prop === 'newPage') {
        return async (...args) => {
          const p = await target.newPage(...args);
          opened.add(p);
          return p;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Lease the shared context for `profile`, opening it with `open()` if there
 *  isn't one. Exported for tests; callers go through launchSiteBrowser. */
export async function acquireShared(profile, open) {
  let entry = sharedContexts.get(profile);
  if (!entry) {
    entry = { ctxPromise: open(), leases: 0, idleTimer: null };
    const mine = entry;
    sharedContexts.set(profile, mine);
    mine.ctxPromise.then(
      (ctx) => {
        // The user closed the window (or Chrome quit): forget it, relaunch next time.
        ctx.on?.('close', () => { if (sharedContexts.get(profile) === mine) sharedContexts.delete(profile); });
      },
      () => { if (sharedContexts.get(profile) === mine) sharedContexts.delete(profile); },
    );
  }
  const ctx = await entry.ctxPromise;
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  entry.leases++;
  const held = entry;
  return leaseOf(ctx, () => {
    held.leases = Math.max(0, held.leases - 1);
    if (held.leases > 0 || sharedContexts.get(profile) !== held) return;
    held.idleTimer = setTimeout(() => {
      if (sharedContexts.get(profile) !== held || held.leases > 0) return;
      sharedContexts.delete(profile);
      ctx.close().catch(() => { /* already gone */ });
    }, sharedIdleMs);
    held.idleTimer.unref?.();
  });
}

/**
 * Attach to a running Chrome or launch real Chrome with a persistent profile.
 * Returns a BrowserContext (launch) or an AttachedContext (attach) — both
 * offer pages()/newPage()/on('page')/close(); `ctx.attached` tells them apart.
 * After enableSharedBrowsers() it returns a lease on the profile's shared
 * context instead (see above); its close() only releases the lease.
 *
 * @param {object} opts
 * @param {string} opts.profile          Profile name; one per site (e.g.
 *                                       "splice", "qobuz") so logins don't
 *                                       collide. Ignored when attaching.
 * @param {boolean} [opts.headless=false] Headless mode for the launch path.
 *                                       Off by default — interactive login is
 *                                       the common case.
 * @param {string[]} [opts.extraArgs=[]] Extra Chrome flags (launch path).
 * @param {boolean} [opts.attach=true]   Try a running Chrome first.
 */
export async function launchSiteBrowser({ profile, headless = false, extraArgs = [], attach = true }) {
  if (!profile) throw new Error('launchSiteBrowser: profile name is required');
  if (sharing) {
    return acquireShared(profile, () => openSiteBrowser({ profile, headless, extraArgs, attach }));
  }
  return openSiteBrowser({ profile, headless, extraArgs, attach });
}

async function openSiteBrowser({ profile, headless, extraArgs, attach }) {
  if (attach) {
    const endpoint = await findRunningChrome();
    if (endpoint) {
      const browser = await chromium.connectOverCDP(endpoint);
      const context = browser.contexts()[0] || (await browser.newContext());
      return new AttachedContext(browser, context, endpoint);
    }
  }

  const userDataDir = path.join(PROFILE_ROOT, profile);
  fs.mkdirSync(userDataDir, { recursive: true });

  return await chromium.launchPersistentContext(userDataDir, {
    // `channel: 'chrome'` uses the user's installed Google Chrome rather
    // than Playwright's bundled Chrome-for-Testing. Required because CfT
    // ships a "HeadlessChrome"-flavored fingerprint that Cloudflare flags.
    channel: 'chrome',
    headless,
    // Strip Playwright's default `--enable-automation` switch. That switch
    // is what shows the "Chrome is being controlled by automated test
    // software" infobar AND is itself a fingerprint signal anti-bot
    // stacks read.
    ignoreDefaultArgs: ['--enable-automation'],
    // No userAgent override — let real Chrome send its real UA. Hardcoded
    // UAs lag behind the actual browser version and become a fingerprint
    // mismatch (UA says Chrome 131, runtime is Chrome 142).
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      // Removes the `navigator.webdriver === true` flag and a few other
      // automation tells. Same flag the qobuzCart code already sets.
      '--disable-blink-features=AutomationControlled',
      ...extraArgs,
    ],
    // Matches a normal desktop window so viewport-based fingerprinting
    // doesn't flag a default 1280x720.
    viewport: { width: 1440, height: 900 },
  });
}
