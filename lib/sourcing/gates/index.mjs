// Download gates — the third-party pages a "Free Download" link lands on.
//
// A gate is walked in the same Chrome the likes were read from, so the
// SoundCloud session it asks for is already there. Each host gets a walker
// that knows its markup (see hypeddit.mjs); anything else, and any walker
// that stalls, can hand the tab to the person at the keyboard (`assistMs`)
// and simply wait for the file. Either way the outcome is a download event
// caught here, saved to a temp file, and filed by downloads.mjs.

import path from 'path';
import { walkHypeddit } from './hypeddit.mjs';
import { walkGeneric } from './generic.mjs';
import { walkBandcamp } from './bandcamp.mjs';
import { walkDroploud } from './droploud.mjs';
import { walkSublair } from './sublair.mjs';
import { walkInfluencePlanner } from './influenceplanner.mjs';
import { walkSmartlink, walkFacebook } from './smartlink.mjs';
import { walkDropbox, walkDrive } from './filehosts.mjs';
import { hostOf } from '../soundcloud.mjs';
import { safeFilename, downloadUrlToFile } from '../downloads.mjs';

export const WALKERS = {
  'hypeddit.com': walkHypeddit,
  'bandcamp.com': walkBandcamp,
  'droploud.com': walkDroploud,
  'sublair.com': walkSublair,
  // ipln.io short links land here; runGate picks the walker after the redirect.
  'influenceplanner.com': walkInfluencePlanner,
  'ipln.io': walkInfluencePlanner,
  // Linkfire-style store pickers: followed through to a real gate when they
  // list one, otherwise reported as not free.
  'lnk.to': walkSmartlink,
  'smarturl.it': walkSmartlink,
  'ffm.to': walkSmartlink,
  'fanlink.to': walkSmartlink,
  'fanlink.tv': walkSmartlink,
  'artist.link': walkSmartlink,
  'facebook.com': walkFacebook,
  // File hosts: the direct-download form of the shared link.
  'dropbox.com': walkDropbox,
  'drive.google.com': walkDrive,
};

/** The walker for a URL's host, or the generic fallback. */
export function walkerFor(url) {
  const host = hostOf(url) || '';
  return Object.entries(WALKERS).find(([h]) => host === h || host.endsWith('.' + h))?.[1] || walkGeneric;
}

/** Press through SoundCloud's app-connect page (ToneDen, gaterush, Droploud,
 *  Sublair) until it redirects away or closes. Returns true if it was one. */
export async function approveSoundCloudConnect(p, { timeoutMs = 20000 } = {}) {
  const isConnect = () => !p.isClosed() && /(^|\.)soundcloud\.com$/i.test(hostOf(p.url()) || '') && /connect|authorize|oauth/i.test(p.url());
  if (!isConnect()) return false;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until && isConnect()) {
    await p.locator('button:has-text("Connect"), button:has-text("Authorize"), button:has-text("Allow"), button[type=submit]').first().click({ timeout: 1000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));
  }
  return true;
}

/** Hosts whose pop-ups a gate opens for "support" steps. They are closed once
 *  the click has been counted; anything else that opens stays, in case it is
 *  the file. */
const POPUP_HOSTS = /(^|\.)(soundcloud\.com|youtube\.com|instagram\.com|facebook\.com|twitter\.com|x\.com|tiktok\.com|apple\.com|deezer\.com|beatport\.com)$/i;

/** Resolve with the first download event from any page in the context. */
export function awaitDownload(ctx, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const pages = new Set();
    let done = false;
    const onDownload = d => { if (done) return; done = true; cleanup(); resolve(d); };
    const attach = p => { if (pages.has(p)) return; pages.add(p); p.on('download', onDownload); };
    const onPage = p => attach(p);
    const cleanup = () => {
      clearTimeout(timer);
      ctx.off('page', onPage);
      for (const p of pages) { try { p.off('download', onDownload); } catch { /* gone */ } }
    };
    const timer = setTimeout(() => { if (done) return; done = true; cleanup(); reject(new Error('no download within ' + Math.round(timeoutMs / 1000) + 's')); }, timeoutMs);
    ctx.on('page', onPage);
    for (const p of ctx.pages()) attach(p);
  });
}

/** Close the social pop-ups a gate opens, a moment after they open, unless a
 *  download starts on them. Returns a stop function. */
export function popupJanitor(ctx, { graceMs = 2500, log = () => {}, spotifyLoginWaitMs = 180000 } = {}) {
  const onPage = async p => {
    let downloading = false;
    p.once('download', () => { downloading = true; });
    await new Promise(r => setTimeout(r, graceMs));
    if (downloading || p.isClosed()) return;
    const host = hostOf(p.url()) || '';
    // Spotify's step is a real OAuth round trip: closing the pop-up early
    // leaves the gate locked at its final Download (7 of 7 stalls, 2026-10-30).
    // Press Agree if it asks, then let it redirect back and close itself.
    if (/(^|\.)spotify\.com$/i.test(host)) {
      // Signed out, Spotify shows its login page instead of Agree, and the
      // gate stays locked. The first time in a run, leave the pop-up up for a
      // person to log in (closing it after a few seconds made that impossible,
      // 2026-11-05); after that, say so (spotifySignedOut) and move on.
      const signedOut = async () => !p.isClosed() && (/\/login\b/i.test(p.url())
        || await p.locator('#login-username, input[name=username]').first().isVisible({ timeout: 1500 }).catch(() => false));
      if (await signedOut()) {
        if (!ctx.spotifyLoginWaited) {
          ctx.spotifyLoginWaited = true;
          log(`          Spotify is signed out in this browser: log in in the Spotify pop-up (waiting up to ${Math.round(spotifyLoginWaitMs / 60000)} min)`);
          await p.bringToFront().catch(() => {});
          const deadline = Date.now() + spotifyLoginWaitMs;
          while (Date.now() < deadline && await signedOut()) await new Promise(r => setTimeout(r, 1500));
        }
        if (await signedOut()) {
          ctx.spotifySignedOut = true;
          await p.close().catch(() => {});
          return;
        }
      }
      const until = Date.now() + 20000;
      while (Date.now() < until && !p.isClosed()) {
        await p.locator('[data-testid="auth-accept"], #auth-accept, button:has-text("Agree")').first().click({ timeout: 1000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 1000));
      }
      if (!p.isClosed() && !downloading) await p.close().catch(() => {});
      return;
    }
    // SoundCloud's app-connect page (ToneDen, gaterush) is the same round trip.
    if (await approveSoundCloudConnect(p)) {
      if (!p.isClosed() && !downloading) await p.close().catch(() => {});
      return;
    }
    if (POPUP_HOSTS.test(host) || p.url() === 'about:blank') await p.close().catch(() => {});
  };
  ctx.on('page', onPage);
  return () => ctx.off('page', onPage);
}

/**
 * Walk one gate. Returns
 *   { status: 'downloaded', tmpPath, filename, via }
 *   { status: 'emailed' | 'needs-email' | 'needs-you' | 'stalled' | 'failed', reason }
 *   { status: 'not-free', reason }   the link turned out to sell or stream, not give
 */
export async function runGate(ctx, row, opts) {
  const { log = () => {}, tmpDir, assistMs = 0, gateTimeoutMs = 90000 } = opts;
  const gate = row.free?.gate;
  if (!gate?.url) return { status: 'failed', reason: 'no gate url' };

  const page = await ctx.newPage();
  const stopJanitor = popupJanitor(ctx, { log });
  let result = { status: 'failed', reason: 'gate did not load' };
  try {
    // Armed before the navigation: on many of these hosts just opening the
    // link starts the file. page.goto then throws "Download is starting".
    // It has to outlast the whole walk: a social step can take a minute, and
    // the file then arrives in a pop-up that closes itself within a second.
    const early = awaitDownload(ctx, { timeoutMs: gateTimeoutMs + 30000 }).catch(() => null);
    await page.goto(gate.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(err => {
      if (!/download is starting/i.test(err.message)) throw err;
    });
    // Shorteners land anywhere, so pick the walker from where the link ended up.
    const walker = walkerFor(page.url());
    try {
      result = await walker(ctx, page, row, { ...opts, gateTimeoutMs, early });
    } catch (err) {
      result = { status: 'failed', reason: `walker error: ${err.message}` };
    }

    if (!['downloaded', 'emailed', 'not-free'].includes(result.status) && assistMs > 0 && !page.isClosed()) {
      log(`          ${result.reason} — finish this gate in the Chrome window (waiting ${Math.round(assistMs / 1000)}s): ${gate.url}`);
      await page.bringToFront().catch(() => {});
      try {
        const download = await awaitDownload(ctx, { timeoutMs: assistMs });
        result = await saveDownload(download, tmpDir, 'assisted');
      } catch {
        result = { ...result, status: result.status === 'stalled' || result.status === 'needs-you' ? 'needs-you' : result.status, reason: `${result.reason}; no download arrived while waiting` };
      }
    }
    return result;
  } finally {
    stopJanitor();
    await page.close().catch(() => {});
  }
}

/** Save a Playwright download to the temp dir.
 *  The tab that started the download may close itself before the copy is
 *  done (Chrome closes a pop-up whose only act was a download), which cancels
 *  Playwright's copy — the signed file URL still answers plain HTTP, so fetch
 *  it directly when that happens. */
export async function saveDownload(download, tmpDir, via = 'walker') {
  const filename = download.suggestedFilename() || 'download.bin';
  const tmpPath = path.join(tmpDir, `${Date.now()}-${safeFilename(filename)}`);
  try {
    await download.saveAs(tmpPath);
    return { status: 'downloaded', tmpPath, filename, via };
  } catch (err) {
    const url = download.url();
    if (!/^https?:/i.test(url || '')) throw err;
    const dl = await downloadUrlToFile(url, tmpDir);
    return { status: 'downloaded', tmpPath: dl.tmpPath, filename: filename !== 'download.bin' ? filename : dl.filename, via: `${via}+url`, note: `browser copy failed (${err.message.split('\n')[0]}); fetched the file URL directly` };
  }
}

/** Shared by the walkers: is a locator's first match on screen, and fire its
 *  own click() (gate overlays intercept real pointer clicks). */
export const visible = async loc => { try { return await loc.first().isVisible(); } catch { return false; } };
export const jsClick = async loc => { try { await loc.first().evaluate(el => el.click()); return true; } catch { return false; } };
