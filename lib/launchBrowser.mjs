// Shared browser launcher for scripts that hit external sites (Splice,
// Qobuz, Beatport, etc).
//
// Why this exists: the default `chromium.launch()` uses Playwright's bundled
// Chrome-for-Testing build, which Cloudflare and other anti-bot stacks
// fingerprint and block. We instead launch the user's real installed
// Google Chrome with a persistent profile, so the browser looks like a
// returning human user — same fingerprint, same prior cookies, no obvious
// "automation" signals.
//
// Use `launchSiteBrowser({ profile: 'splice' })` for any external-site
// script. For internal screenshots against localhost the default
// `chromium.launch()` is still fine — anti-bot doesn't apply there.

import { chromium } from 'playwright';
import os from 'os';
import path from 'path';
import fs from 'fs';

const PROFILE_ROOT = path.join(os.homedir(), '.cache', 'candybar-manager', 'playwright-profiles');

/**
 * Launch real Google Chrome with a persistent profile. Returns the
 * BrowserContext directly (persistent contexts have no separate Browser
 * object). Caller does `const page = await ctx.newPage()` etc.
 *
 * @param {object} opts
 * @param {string} opts.profile          Profile name; pick one per site
 *                                       (e.g. "splice", "qobuz") so logins
 *                                       don't collide.
 * @param {boolean} [opts.headless=false] Headless mode. Off by default —
 *                                       interactive login is the common case.
 * @param {string[]} [opts.extraArgs=[]] Extra Chrome flags.
 */
export async function launchSiteBrowser({ profile, headless = false, extraArgs = [] }) {
  if (!profile) throw new Error('launchSiteBrowser: profile name is required');
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
