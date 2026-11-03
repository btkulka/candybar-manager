/**
 * Store purchase integration for Qobuz and Beatport: sign-in, carts, purchase
 * history and downloads.
 *
 * Everything that needs the user's account runs in that account's own session
 * partition — the interactive sign-in in a login window on the partition, and
 * every signed-in request from inside a hidden page on it (storeBrowser.ts).
 * Nothing copies cookies into a Node fetch. Beatport's API takes the Bearer
 * token that page's session hands over, as the store's own front-end does.
 */

import path from 'path';
import fsSync from 'fs';
import fsp from 'fs/promises';
import crypto from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { BrowserWindow, session } from 'electron';
import { convertToAiff, deleteOriginalAfterConversion } from './trackConverter';
import { createScopedLogger } from './logger';
import { getErrorMessage } from './errorUtils';
import { isTrackDownloaded, recordDownload, getDownloadedTrackPath, isTrackDeleted } from './db';
import { recordWrite } from './writeJournal';
import { sessionFetch, sessionFetchJson, closeStoreBrowsers } from './storeBrowser';
import { getQobuzReleaseTracks, parseQobuzPopin } from './qobuz';
import { bestOwnedMatch, pickReleaseTrack, pickQobuzLosslessTier, withVersion } from './storeMatching';
import { sniffAudio, extFromUrlOrType } from './audioSniff';
import type {
  StoreTrackInput,
  StoreMatch,
  StoreCartResult,
  StoreCartProgress,
  StoreAccount
} from '../types';

const QOBUZ_ORIGIN = 'https://www.qobuz.com';
const BEATPORT_ORIGIN = 'https://www.beatport.com';

const log = createScopedLogger('StorePurchase');

/** Default account id used for the single-account era. Preserves existing electron
 *  session partitions (`persist:qobuz`, `persist:beatport`) so upgraders don't re-login. */
export const LEGACY_ACCOUNT_ID = 'legacy';

export function qobuzPartition(accountId: string): string {
  return accountId === LEGACY_ACCOUNT_ID ? 'persist:qobuz' : `persist:qobuz-${accountId}`;
}

export function beatportPartition(accountId: string): string {
  return accountId === LEGACY_ACCOUNT_ID ? 'persist:beatport' : `persist:beatport-${accountId}`;
}

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ========== Session Login ==========
//
// Unified connect flow for every store. The user's interactive login (password,
// Google/Apple OAuth, 2FA, captcha — whatever the store supports) happens in
// the store's own page; we only care whether a valid session cookie appears.
//
//   - Already logged in (cookies still valid)? → silent no-op.
//   - Otherwise → show the store's login page in a BrowserWindow tied to this
//     account's session partition. Poll for the login-success cookie, close
//     the window, mark connected.

export async function loginQobuz(accountId: string): Promise<boolean> {
  if (await isQobuzLoggedIn(accountId)) {
    log.info(`Qobuz[${accountId}]: session still valid, skipping login window`);
    return true;
  }
  return loginQobuzWindow(accountId);
}

export async function loginBeatport(accountId: string): Promise<boolean> {
  if (await isBeatportLoggedIn(accountId)) {
    log.info(`Beatport[${accountId}]: session still valid, skipping login window`);
    return true;
  }
  return loginBeatportWindow(accountId);
}

// Cached Beatport Bearer tokens, keyed by account id.
const beatportTokens = new Map<string, { token: string; expiry: number }>();

/** Get the current Beatport access token for an account (or null if not logged in) */
export function getBeatportAccessToken(accountId: string): string | null {
  const entry = beatportTokens.get(accountId);
  if (entry && entry.expiry > Date.now() + 60000) return entry.token;
  return null;
}

/** Set Beatport access token from external source (e.g. embedded panel session) */
export function setBeatportToken(accountId: string, token: string, expiresInSeconds: number): void {
  beatportTokens.set(accountId, { token, expiry: Date.now() + expiresInSeconds * 1000 });
  lastBeatportAccountId = accountId;
  log.info(`Beatport[${accountId}]: token set externally, expires in ${Math.round(expiresInSeconds / 60)}m`);
}

let lastBeatportAccountId: string | null = null;

/** Any live Beatport token, preferring the account that set one last. Catalog
 *  search isn't per-account, it just goes faster with a token. */
export function getAnyBeatportAccessToken(): { accountId: string; token: string } | null {
  const order = [lastBeatportAccountId, ...beatportTokens.keys()].filter((id): id is string => !!id);
  for (const accountId of order) {
    const token = getBeatportAccessToken(accountId);
    if (token) return { accountId, token };
  }
  return null;
}

/** The partition catalog search reads the Beatport page from when there's no
 *  token: the last signed-in account's, else the legacy one. */
export function beatportSearchPartition(): string {
  return beatportPartition(lastBeatportAccountId ?? LEGACY_ACCOUNT_ID);
}

/**
 * The Bearer token Beatport's own session hands its front-end, read from a
 * hidden page on the partition — `/api/auth/session` called by the page, with
 * the page's cookies — and only returned once it actually authenticates a
 * user-scoped call (an anonymous session also gets a well-formed token, which
 * 401s on `/v4/my/*`). Null when the partition isn't signed in.
 */
export async function readBeatportSessionToken(partition: string): Promise<{ token: string; expiresIn: number } | null> {
  const res = await sessionFetchJson<{ token?: { accessToken?: string; expiresIn?: number }; access_token?: string; accessToken?: string }>(
    partition, BEATPORT_ORIGIN, '/api/auth/session'
  );
  if (!res.ok || !res.data) {
    log.info(`Beatport ${partition}: /api/auth/session answered ${res.status}`);
    return null;
  }
  const token = res.data.token?.accessToken || res.data.access_token || res.data.accessToken;
  if (!token) return null;
  if (!(await beatportTokenWorks(token))) {
    log.info(`Beatport ${partition}: session token failed the user-scope probe`);
    return null;
  }
  return { token, expiresIn: res.data.token?.expiresIn ?? 3600 };
}

async function beatportTokenWorks(token: string): Promise<boolean> {
  try {
    const res = await beatportApi(token, '/my/account/?per_page=1');
    return res.ok;
  } catch {
    return false;
  }
}

/** api.beatport.com with a Bearer token. It isn't behind Cloudflare and takes
 *  no cookies; the token is the whole credential. */
async function beatportApi(token: string, pathAndQuery: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return fetch(`https://api.beatport.com/v4${pathAndQuery}`, {
    method: init.method ?? 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Origin': BEATPORT_ORIGIN,
      'Referer': `${BEATPORT_ORIGIN}/`,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
}

/** Drop any cached Bearer token for this account. Use before cart-add to force
 *  a fresh token extraction from the partition cookies — avoids replaying a
 *  stale or wrong-account token that happens to still have a valid-looking
 *  signature but that the API rejects with 401. */
export function invalidateBeatportToken(accountId: string): void {
  beatportTokens.delete(accountId);
}

// ========== Browser Window Login ==========

// One login window per account. A second sign-in request while it's open
// waits on the same window and gets the same answer, rather than an instant
// "not logged in" that let a cart add carry on signed out.
const qobuzLoginWindows = new Map<string, { win: BrowserWindow; done: Promise<boolean> }>();
const beatportLoginWindows = new Map<string, { win: BrowserWindow; done: Promise<boolean> }>();

function createLoginWindow(partition: string, url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 800,
    height: 700,
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // CRITICAL for OAuth flows (Google / Apple / Facebook sign-in on Qobuz):
  // the store triggers auth via window.open() popups. Without this handler
  // Electron would create those popups under the *default* session partition,
  // so the auth cookies end up in the wrong jar and our per-account probe
  // keeps returning "not logged in" even after the user signs in.
  //
  // Forwarding the same `partition` into the popup's webPreferences makes the
  // popup share cookies with the main login window — OAuth cookies then land
  // in the account-scoped jar where isQobuzLoggedIn / probeQobuzLoginForPartition
  // can see them.
  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
      },
    },
  }));

  // Propagate the same treatment to any child popups (popups-of-popups — e.g.
  // Google's nested consent dialogs). Without this, a second-level popup would
  // fall back to the default partition.
  win.webContents.on('did-create-window', (child) => {
    child.webContents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: {
        webPreferences: {
          partition,
          nodeIntegration: false,
          contextIsolation: true,
        },
      },
    }));
  });

  win.loadURL(url);
  return win;
}

function loginQobuzWindow(accountId: string): Promise<boolean> {
  const existing = qobuzLoginWindows.get(accountId);
  if (existing && !existing.win.isDestroyed()) {
    existing.win.focus();
    return existing.done;
  }

  const win = createLoginWindow(qobuzPartition(accountId), 'https://www.qobuz.com/signin');

  const done = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (ok) {
        markQobuzConnected(accountId);
        invalidateQobuzAuthCache(accountId);
      }
      resolve(ok);
    };
    // Authoritative server check. Bypass the cached isQobuzLoggedIn so we pick
    // up the first successful sign-in as fast as the poll interval allows,
    // rather than waiting out a stale "not logged in" cache entry.
    let probing = false;
    const pollInterval = setInterval(async () => {
      if (win.isDestroyed()) {
        clearInterval(pollInterval);
        return;
      }
      if (probing) return;
      probing = true;
      try {
        if (await probeQobuzLoginForPartition(qobuzPartition(accountId))) {
          clearInterval(pollInterval);
          log.info(`Qobuz[${accountId}] login detected (shop session verified)`);
          if (!win.isDestroyed()) win.close();
          finish(true);
        }
      } finally {
        probing = false;
      }
    }, 1500);
    win.on('closed', () => {
      clearInterval(pollInterval);
      qobuzLoginWindows.delete(accountId);
      finish(false);
    });
  });
  qobuzLoginWindows.set(accountId, { win, done });
  return done;
}

function loginBeatportWindow(accountId: string): Promise<boolean> {
  const existing = beatportLoginWindows.get(accountId);
  if (existing && !existing.win.isDestroyed()) {
    existing.win.focus();
    return existing.done;
  }

  const partition = beatportPartition(accountId);
  const win = createLoginWindow(partition, 'https://www.beatport.com');

  const done = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (ok) markBeatportConnected(accountId);
      resolve(ok);
    };
    // A session cookie appears first; the sign-in only counts once that
    // session hands over a token that authenticates the user.
    let probing = false;
    const cookieInterval = setInterval(async () => {
      if (win.isDestroyed()) {
        clearInterval(cookieInterval);
        return;
      }
      if (probing) return;
      probing = true;
      try {
        const cookies = await session.fromPartition(partition).cookies.get({ url: BEATPORT_ORIGIN });
        if (!cookies.some(c => isBeatportAuthCookie(c.name))) return;
        const signedIn = await readBeatportSessionToken(partition).catch(() => null);
        if (!signedIn) return;
        setBeatportToken(accountId, signedIn.token, signedIn.expiresIn);
        clearInterval(cookieInterval);
        log.info(`Beatport[${accountId}] login detected (session token verified)`);
        if (!win.isDestroyed()) win.close();
        finish(true);
      } finally {
        probing = false;
      }
    }, 2000);
    win.on('closed', () => {
      clearInterval(cookieInterval);
      beatportLoginWindows.delete(accountId);
      finish(false);
    });
  });
  beatportLoginWindows.set(accountId, { win, done });
  return done;
}

// ========== Session Status ==========

// Runtime connection markers — set when a login window completes successfully.
// Cleared on logout and when an authoritative check fails.
const qobuzKnownConnected = new Set<string>();
const beatportKnownConnected = new Set<string>();

// Cache of auth-verification results so we don't hammer the remote API on
// every pill refresh / login-window poll tick.
const qobuzAuthCache = new Map<string, { loggedIn: boolean; checkedAt: number }>();
const AUTH_CACHE_MS = 5_000;

function hasQobuzAuthCookie(cookies: Electron.Cookie[]): boolean {
  // `qobuz-session` is the modern signal (set after the Google OAuth flow lands
  // you back on qobuz.com); `userCookie` is the classic website auth cookie,
  // still issued by /signin form posts; `lantern` is the older variant.
  return cookies.some(c => {
    if (c.name === 'qobuz-session' || c.name === 'userCookie' || c.name === 'lantern') return true;
    const lower = c.name.toLowerCase();
    return lower.includes('user_auth') || lower.includes('userauth') || lower === 'qb_sid';
  });
}

/**
 * Whether the partition holds a LIVE Qobuz shop session. An auth cookie only
 * says a sign-in happened once; an expired one used to count as signed in, and
 * cart adds then went into an anonymous cart. So once the cookie is there, ask
 * the shop: the cart page bounces a signed-out session to /signin (the same
 * check lib/sourcing/cart.mjs makes before it fills the cart).
 *
 * When the shop can't be reached at all the cookie is the only evidence left,
 * and it's what's returned — a network failure isn't a sign-out.
 */
export async function probeQobuzLoginForPartition(partitionName: string): Promise<boolean> {
  const cookies = await session.fromPartition(partitionName).cookies.get({ url: QOBUZ_ORIGIN });
  if (!hasQobuzAuthCookie(cookies)) return false;
  try {
    const res = await sessionFetch(partitionName, QOBUZ_ORIGIN, '/shopping-cart', { timeoutMs: 20_000 });
    if (res.status === 0) {
      log.warn(`Qobuz[${partitionName}]: couldn't reach the shop to verify the session (${res.text})`);
      return true;
    }
    const signedIn = res.ok && !/\/signin|\/login/.test(res.url);
    log.info(`Qobuz[${partitionName}]: shop session ${signedIn ? 'live' : 'signed out'} (${res.status} ${res.url})`);
    return signedIn;
  } catch (err) {
    log.warn(`Qobuz[${partitionName}]: session check failed:`, err);
    return true;
  }
}

async function verifyQobuzLoggedIn(accountId: string): Promise<boolean> {
  return probeQobuzLoginForPartition(qobuzPartition(accountId));
}

export async function isQobuzLoggedIn(accountId: string): Promise<boolean> {
  const cached = qobuzAuthCache.get(accountId);
  if (cached && Date.now() - cached.checkedAt < AUTH_CACHE_MS) {
    return cached.loggedIn;
  }
  const ok = await verifyQobuzLoggedIn(accountId);
  qobuzAuthCache.set(accountId, { loggedIn: ok, checkedAt: Date.now() });
  if (!ok) qobuzKnownConnected.delete(accountId);
  return ok;
}

function isBeatportAuthCookie(name: string): boolean {
  return name.includes('session-token') || name === 'api_token';
}

export async function isBeatportLoggedIn(accountId: string): Promise<boolean> {
  if (getBeatportAccessToken(accountId)) return true;
  const ses = session.fromPartition(beatportPartition(accountId));
  const cookies = await ses.cookies.get({ url: 'https://www.beatport.com' });
  if (cookies.some(c => isBeatportAuthCookie(c.name))) return true;
  return beatportKnownConnected.has(accountId) && cookies.length > 0;
}

/** Invalidate the cached auth-probe result — e.g. right after a login window closes. */
export function invalidateQobuzAuthCache(accountId?: string): void {
  if (accountId) qobuzAuthCache.delete(accountId);
  else qobuzAuthCache.clear();
}

export function markQobuzConnected(accountId: string): void {
  qobuzKnownConnected.add(accountId);
}

export function markBeatportConnected(accountId: string): void {
  beatportKnownConnected.add(accountId);
}

export function clearQobuzConnected(accountId: string): void {
  qobuzKnownConnected.delete(accountId);
}

export function clearBeatportConnected(accountId: string): void {
  beatportKnownConnected.delete(accountId);
}

// ========== Logout ==========

/** Clear cached Qobuz session for an account: cookies + sniffed API credentials. */
export async function logoutQobuz(accountId: string): Promise<void> {
  qobuzCreds.delete(accountId);
  clearQobuzConnected(accountId);
  invalidateQobuzAuthCache(accountId);
  closeStoreBrowsers(qobuzPartition(accountId));
  try {
    const ses = session.fromPartition(qobuzPartition(accountId));
    await ses.clearStorageData({ storages: ['cookies', 'localstorage'] });
  } catch (err) {
    log.warn(`Qobuz[${accountId}]: failed to clear session storage:`, err);
  }
  log.info(`Qobuz[${accountId}]: logged out`);
}

/** Clear cached Beatport session for an account: OAuth token + cookies. */
export async function logoutBeatport(accountId: string): Promise<void> {
  beatportTokens.delete(accountId);
  clearBeatportConnected(accountId);
  closeStoreBrowsers(beatportPartition(accountId));
  try {
    const ses = session.fromPartition(beatportPartition(accountId));
    await ses.clearStorageData({ storages: ['cookies', 'localstorage'] });
  } catch (err) {
    log.warn(`Beatport[${accountId}]: failed to clear session storage:`, err);
  }
  log.info(`Beatport[${accountId}]: logged out`);
}

// ========== Qobuz Cart ==========
//
// Search hands over RELEASES; the cart takes one track's quality tier. So each
// match is resolved to the track on its release that is the record asked for
// (scored against the request — never the release title, never "the first
// track"), then to that track's best positively-lossless tier. Anything that
// can't be pinned down fails with a reason instead of guessing.

function qobuzXhr(extra: Record<string, string> = {}): Record<string, string> {
  return { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/javascript, */*; q=0.01', ...extra };
}

/** The track id a match should be bought as, resolving its release if search
 *  didn't already. */
async function resolveQobuzCartTrack(match: StoreMatch): Promise<{ trackId: string } | { error: string }> {
  if (match.trackId && !match.albumId) return { trackId: match.trackId };
  if (match.trackId && match.albumId && match.trackId !== match.albumId) return { trackId: match.trackId };
  const albumId = match.albumId || match.trackId;
  if (!albumId) return { error: 'No Qobuz release to look the track up on' };
  const tracks = await getQobuzReleaseTracks(albumId, match.url);
  const releaseArtists = (match.artist || '').split(/\s*,\s*/).filter(Boolean);
  const pick = pickReleaseTrack(match.input, tracks, releaseArtists);
  if (!pick) {
    return { error: `Couldn't find "${match.input.title}" on the Qobuz release (${tracks.length} track${tracks.length === 1 ? '' : 's'} read) — open it and add the track by hand` };
  }
  return { trackId: pick.track.id };
}

export async function addToQobuzCart(
  accountId: string,
  matches: StoreMatch[],
  onProgress?: (p: StoreCartProgress) => void
): Promise<StoreCartResult> {
  const added: StoreMatch[] = [];
  const failed: Array<{ match: StoreMatch; error: string }> = [];
  let totalCost = 0;
  const partition = qobuzPartition(accountId);
  // Two requests can resolve to the same track on the same release.
  const addedTrackIds = new Set<string>();

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const label = `${match.artist} - ${match.title}`;
    onProgress?.({
      current: i + 1, total: matches.length, currentTrack: label,
      phase: 'adding', message: `Adding: ${label}`
    });

    // Lossless only: anything not positively lossless stays out, whatever the
    // caller passed in. The tier check below holds the same line per track.
    if (match.lossless !== true) {
      failed.push({ match, error: 'Excluded: not a confirmed lossless match (lossless only)' });
      continue;
    }

    try {
      const resolved = await resolveQobuzCartTrack(match);
      if ('error' in resolved) {
        failed.push({ match, error: resolved.error });
        continue;
      }
      const trackId = resolved.trackId;
      if (addedTrackIds.has(trackId)) {
        added.push({ ...match, trackId });
        continue;
      }

      const popin = await sessionFetch(partition, QOBUZ_ORIGIN, `/v4/ajax/popin-add-cart/track/${encodeURIComponent(trackId)}`, {
        headers: qobuzXhr({ Accept: 'text/html, */*; q=0.01' }),
      });
      if (!popin.ok) {
        failed.push({ match, error: `Couldn't read Qobuz's quality options (HTTP ${popin.status})` });
        continue;
      }
      const tier = pickQobuzLosslessTier(parseQobuzPopin(popin.text));
      if (!tier) {
        failed.push({ match, error: 'Qobuz offers no lossless (CD or Hi-Res) tier for this track' });
        continue;
      }

      const cart = await sessionFetchJson<{ success?: boolean; message?: string }>(partition, QOBUZ_ORIGIN, tier.cartLink, {
        headers: qobuzXhr(),
      });
      if (cart.data?.success) {
        addedTrackIds.add(trackId);
        const price = tier.price || match.price;
        added.push({ ...match, trackId, articleId: tier.articleId, cartLink: tier.cartLink, price, quality: tier.text });
        const priceNum = parseFloat((price || '').replace(/[^0-9.]/g, ''));
        if (!isNaN(priceNum)) totalCost += priceNum;
      } else if (cart.data) {
        failed.push({ match, error: cart.data.message || 'Qobuz refused the cart add' });
      } else {
        // An HTML answer is the sign-in page, not a cart update.
        failed.push({ match, error: `Qobuz didn't answer as a signed-in cart (HTTP ${cart.status}) — sign in to Qobuz and retry` });
      }
    } catch (err) {
      failed.push({ match, error: getErrorMessage(err, 'Cart add failed') });
    }

    if (i < matches.length - 1) await sleep(800);
  }

  onProgress?.({
    current: matches.length, total: matches.length, currentTrack: '',
    phase: 'complete', message: `Done: ${added.length} added, ${failed.length} failed`
  });

  return { added, failed, totalCost: `$${totalCost.toFixed(2)}` };
}

// ========== Beatport Cart ==========

/** Track ids already in the cart, so a retry never adds a second copy (or the
 *  same track in a second format). Best effort: an unreadable cart reads empty
 *  and the API's own AlreadyInCart answer still holds the line. */
async function beatportCartTrackIds(token: string, cartId: string): Promise<Set<string>> {
  try {
    const res = await beatportApi(token, `/my/carts/${cartId}/`);
    if (!res.ok) return new Set();
    const cart = await res.json() as { tracks?: Array<{ item_id?: number; item?: { id?: number } }> };
    return new Set((cart.tracks ?? []).map(t => String(t.item_id ?? t.item?.id ?? '')).filter(Boolean));
  } catch {
    return new Set();
  }
}

export async function addToBeatportCart(
  accountId: string,
  matches: StoreMatch[],
  onProgress?: (p: StoreCartProgress) => void
): Promise<StoreCartResult> {
  // The Bearer token comes from the account's own session (read in-page by
  // readBeatportSessionToken); with it, api.beatport.com takes cart adds
  // directly. No cookies leave the partition.
  onProgress?.({
    current: 0, total: matches.length, currentTrack: '',
    phase: 'adding', message: 'Authenticating with Beatport…'
  });

  const token = getBeatportAccessToken(accountId);
  if (!token) {
    return {
      added: [],
      failed: matches.map(m => ({ match: m, error: 'Not logged in to Beatport — open Beatport Cart once to complete login' })),
      totalCost: '$0.00',
    };
  }

  // Resolve cart id.
  onProgress?.({
    current: 0, total: matches.length, currentTrack: '',
    phase: 'adding', message: 'Finding your Beatport cart…'
  });
  let cartId: string | null = null;
  let cartDiag = '';
  try {
    const res = await beatportApi(token, '/my/carts/');
    const text = await res.text();
    if (res.ok) {
      type BpCart = { id?: number; cart_id?: number; default?: boolean; name?: string };
      const raw = JSON.parse(text) as BpCart[] | { results?: BpCart[]; carts?: BpCart[] };
      const list: BpCart[] = Array.isArray(raw) ? raw : (raw.results ?? raw.carts ?? []);
      const c = list.find(x => x.default) || list.find(x => x.name === 'cart') || list[0];
      const rawId = c?.id ?? c?.cart_id;
      if (rawId != null) cartId = String(rawId);
      else cartDiag = `200 but no usable id; snippet=${text.slice(0, 180).replace(/\s+/g, ' ')}`;
    } else {
      if (res.status === 401) invalidateBeatportToken(accountId);
      cartDiag = `${res.status}: ${text.slice(0, 180).replace(/\s+/g, ' ')}`;
    }
  } catch (err) {
    cartDiag = `exception: ${getErrorMessage(err, 'cart lookup failed')}`;
  }

  if (!cartId) {
    return {
      added: [],
      failed: matches.map(m => ({ match: m, error: `Could not find cart (${cartDiag})` })),
      totalCost: '$0.00',
    };
  }

  const inCart = await beatportCartTrackIds(token, cartId);

  // Add each track. Iterate known (item_type_id, audio_format_id) permutations
  // per track — stop at the first 2xx. NOTE: only track adds (item_type_id: 1) are
  // attempted; a release add (item_type_id: 2) would need a RELEASE id, and reusing
  // match.trackId there added an unrelated release, so it's intentionally omitted.
  const attempts: Array<{ item_type_id: number; audio_format_id: number }> = [
    { item_type_id: 1, audio_format_id: 14 }, // track + WAV
    { item_type_id: 1, audio_format_id: 5 },  // track + AIFF
    { item_type_id: 1, audio_format_id: 4 },  // track + FLAC
  ];
  const added: StoreMatch[] = [];
  const failed: Array<{ match: StoreMatch; error: string }> = [];
  let totalCost = 0;
  let tokenDead = false;

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    onProgress?.({
      current: i + 1, total: matches.length,
      currentTrack: `${match.artist} - ${match.title}`,
      phase: 'adding', message: `Adding: ${match.title}`
    });

    if (match.lossless !== true) {
      failed.push({ match, error: 'Excluded: not a confirmed lossless match (lossless only)' });
      continue;
    }
    if (tokenDead) {
      failed.push({ match, error: 'Beatport session expired — open the Beatport cart to sign in again, then retry' });
      continue;
    }
    if (inCart.has(String(match.trackId))) {
      added.push(match); // already there — the end state is the one asked for
      continue;
    }

    let ok = false;
    let lastErr = '';
    let alreadyOwned = false;
    for (const a of attempts) {
      try {
        const res = await beatportApi(token, `/my/carts/${cartId}/items/`, {
          method: 'POST',
          body: {
            item_id: Number(match.trackId),
            item_type_id: a.item_type_id,
            audio_format_id: a.audio_format_id,
            purchase_type_id: 1,
            source_type_id: 6,
          },
        });
        if (res.ok) {
          ok = true;
          inCart.add(String(match.trackId));
          added.push(match);
          const priceNum = parseFloat(String(match.price ?? '').replace(/[^0-9.]/g, ''));
          if (!isNaN(priceNum)) totalCost += priceNum;
          break;
        }
        const text = await res.text().catch(() => '');
        // Beatport returns specific 400 shapes we should treat as non-errors:
        //   {"AlreadyInCart": [...] }  → item is already in the cart (desired state)
        //   {"AlreadyPurchased": {...}} → user already owns this track
        if (res.status === 400 && /AlreadyInCart/.test(text)) {
          ok = true;
          inCart.add(String(match.trackId));
          added.push(match);
          break;
        }
        if (res.status === 400 && /AlreadyPurchased/.test(text)) {
          alreadyOwned = true;
          break;
        }
        if (res.status === 401) {
          tokenDead = true;
          invalidateBeatportToken(accountId);
        }
        lastErr = `${res.status} (type=${a.item_type_id}/fmt=${a.audio_format_id}): ${text.slice(0, 140)}`;
        // Only a format this track isn't sold in is worth another format.
        if (res.status !== 400 || !text.includes('Item does not exist')) break;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : 'fetch failed';
        break;
      }
    }
    if (!ok) {
      if (alreadyOwned) failed.push({ match, error: 'Already purchased — you own this track' });
      else failed.push({ match, error: lastErr || 'Cart add failed' });
    }
  }

  onProgress?.({
    current: matches.length, total: matches.length, currentTrack: '',
    phase: 'complete', message: `Done: ${added.length} added, ${failed.length} failed`
  });

  return { added, failed, totalCost: `$${totalCost.toFixed(2)}` };
}

/** The purchase that is the same record as `track`, or null. Best match, not
 *  the first one past the bar; title and artist each have their own floor
 *  (see bestOwnedMatch). */
export function matchesOwnedTrack(
  track: StoreTrackInput,
  owned: OwnedTrack[]
): OwnedTrack | null {
  return bestOwnedMatch(track, owned);
}

// ========== Download Purchases ==========

export type DownloadProgress = {
  current: number;
  total: number;
  currentTrack: string;
  phase: 'fetching' | 'downloading' | 'converting' | 'complete';
  message: string;
};

export type DownloadResult = {
  downloaded: string[];
  failed: Array<{ trackId: string; artist: string; title: string; error: string }>;
  /** Not fetched on purpose: a track you deleted stays deleted. */
  skipped: Array<{ trackId: string; artist: string; title: string; reason: string }>;
  destDir: string;
};

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '').trim().slice(0, 180) || 'untitled';
}

/** Claim "<base>.<ext>", or "<base> (2).<ext>" and so on, by creating it
 *  exclusively — so two downloads running at once can't pick the same name,
 *  and a file already there is never overwritten. */
async function reserveUniquePath(dir: string, base: string, ext: string): Promise<string> {
  for (let n = 1; n < 1000; n++) {
    const candidate = path.join(dir, n === 1 ? `${base}.${ext}` : `${base} (${n}).${ext}`);
    try {
      const fh = await fsp.open(candidate, 'wx');
      await fh.close();
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`No free file name for ${base}.${ext} in ${dir}`);
}

const LOSSLESS_EXTS = new Set(['wav', 'aiff', 'aifc', 'flac']);
const LOSSY_EXTS = new Set(['mp3', 'ogg']);

type SavedDownload = { path: string; ext: string; lossless: boolean | null };

/**
 * Stream a signed download URL to a temp file in `destDir`, read what it
 * really is from its bytes (a URL or a default can claim ".aiff" for a WAV),
 * then rename it to a name nothing else has. Lossy or unidentifiable files go
 * under `destDir/lossy` instead, the way the CLI's free downloads do, so they
 * never pass for keepers. The URL is pre-signed, so no session is involved.
 */
async function downloadToUniqueFile(url: string, destDir: string, baseName: string, context: string): Promise<SavedDownload> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': '*/*' }, signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  await fsp.mkdir(destDir, { recursive: true });
  const tmp = path.join(destDir, `.${crypto.randomUUID()}.part`);
  try {
    await pipeline(Readable.fromWeb(res.body as import('stream/web').ReadableStream), fsSync.createWriteStream(tmp, { flags: 'wx' }));
    const head = Buffer.alloc(16);
    const fh = await fsp.open(tmp, 'r');
    try { await fh.read(head, 0, 16, 0); } finally { await fh.close(); }
    const sniffed = sniffAudio(head);
    const ext = sniffed.ext ?? extFromUrlOrType(res.url || url, res.headers.get('content-type')) ?? 'bin';
    const lossless = sniffed.lossless ?? (LOSSLESS_EXTS.has(ext) ? true : LOSSY_EXTS.has(ext) ? false : null);
    const dir = lossless === true ? destDir : path.join(destDir, 'lossy');
    await fsp.mkdir(dir, { recursive: true });
    const dest = await reserveUniquePath(dir, sanitizeFilename(baseName), ext);
    const bytes = (await fsp.stat(tmp)).size;
    try {
      await fsp.rename(tmp, dest); // replaces only the empty placeholder reserved above
    } catch (err) {
      await fsp.unlink(dest).catch(() => {});
      throw err;
    }
    recordWrite({ op: 'move', src: tmp, dest, bytes, context, outcome: 'ok', detail: { download: new URL(res.url || url).origin, lossless } });
    return { path: dest, ext, lossless };
  } catch (err) {
    try {
      await fsp.unlink(tmp);
      recordWrite({ op: 'delete', src: tmp, context: `${context}-partial`, outcome: 'ok' });
    } catch { /* never created */ }
    throw err;
  }
}

/**
 * Turn a lossless non-AIFF download into AIFF (the original goes the way
 * deleteOriginalAfterConversion sends it). Lossy files are never converted: an
 * AIFF made from an MP3 would pass for lossless from then on.
 */
async function ensureAiff(saved: SavedDownload): Promise<string> {
  if (saved.lossless !== true) return saved.path;
  if (saved.ext === 'aiff' || saved.ext === 'aifc') return saved.path;

  log.info(`Converting ${path.basename(saved.path)} to AIFF...`);
  const result = await convertToAiff(saved.path);
  if (!result.success || !result.outputPath) {
    throw new Error(`AIFF conversion failed: ${result.errorMessage || 'Unknown error'}`);
  }
  await deleteOriginalAfterConversion(saved.path, result.outputPath);
  return result.outputPath;
}

/** What to do with one requested download, before any network call. The
 *  ledger keeps every row: a file that has gone is downloaded again only when
 *  you didn't delete it (organize moves update the row's path, so a moved file
 *  still reads as present). */
function priorDownload(source: 'qobuz' | 'beatport', track: StoreMatch): { reuse: string } | { skip: string } | null {
  if (track.trackId && isTrackDownloaded(source, track.trackId)) {
    const priorPath = getDownloadedTrackPath(source, track.trackId);
    if (priorPath && fsSync.existsSync(priorPath)) return { reuse: priorPath };
  }
  if (isTrackDeleted({ source, trackId: track.trackId || undefined, artist: track.artist, title: track.title })) {
    return { skip: 'You deleted this track, so it is not downloaded again' };
  }
  return null;
}

export async function downloadQobuzPurchases(
  defaultAccountId: string,
  tracks: StoreMatch[],
  destDir: string,
  onProgress?: (p: DownloadProgress) => void,
  concurrency: number = 1
): Promise<DownloadResult> {
  const downloaded: string[] = [];
  const failed: Array<{ trackId: string; artist: string; title: string; error: string }> = [];
  const skipped: DownloadResult['skipped'] = [];
  await fsp.mkdir(destDir, { recursive: true });

  // Credentials are only needed for what actually has to be fetched; tracks
  // can come from different accounts (an OwnedTrack keeps its sourceAccountId).
  const accountOf = (t: StoreMatch) => (t as StoreMatch & { sourceAccountId?: string }).sourceAccountId || defaultAccountId;
  const credError = new Map<string, string>();
  const needed = new Set(tracks.filter(t => !priorDownload('qobuz', t)).map(accountOf));
  for (const aid of needed) {
    if (qobuzCreds.has(aid)) continue;
    try {
      await sniffQobuzCredentials(aid);
    } catch (err) {
      credError.set(aid, getErrorMessage(err, 'Qobuz sign-in failed'));
      log.warn(`Qobuz[${aid}]: no credentials for download:`, err);
    }
  }

  let completed = 0;
  async function handleTrack(track: StoreMatch): Promise<void> {
    const label = `${track.artist} - ${track.title}`;
    const trackAccountId = accountOf(track);
    completed++;
    const progress = { current: completed, total: tracks.length };
    const fail = (error: string) => failed.push({ trackId: track.trackId ?? '', artist: track.artist, title: track.title, error });

    const prior = priorDownload('qobuz', track);
    if (prior && 'reuse' in prior) {
      log.info(`Already downloaded: ${label} (${prior.reuse})`);
      downloaded.push(prior.reuse);
      onProgress?.({ ...progress, currentTrack: label, phase: 'downloading', message: `Already downloaded: ${label}` });
      return;
    }
    if (prior && 'skip' in prior) {
      skipped.push({ trackId: track.trackId ?? '', artist: track.artist, title: track.title, reason: prior.skip });
      onProgress?.({ ...progress, currentTrack: label, phase: 'downloading', message: `Skipped (deleted): ${label}` });
      return;
    }
    onProgress?.({ ...progress, currentTrack: label, phase: 'downloading', message: `Downloading: ${label}` });

    try {
      if (!track.trackId || (track.albumId && track.trackId === track.albumId)) {
        fail('No Qobuz track id — this was a release-level match');
        return;
      }
      if (!qobuzCreds.has(trackAccountId)) {
        fail(credError.get(trackAccountId) ?? `No Qobuz credentials for account ${trackAccountId}`);
        return;
      }

      // Highest quality first: 27 hi-res FLAC, 7 24-bit FLAC, 6 16-bit FLAC.
      let dlUrl: string | null = null;
      let lastStatus = 0;
      for (const fmt of [27, 7, 6]) {
        const res = await qobuzApi<{ url?: string; mime_type?: string; sample?: boolean }>(
          trackAccountId, 'track/getFileUrl', { format_id: fmt, track_id: track.trackId, intent: 'import' }, { sign: true }
        );
        lastStatus = res.status;
        if (res.status === 401) break;
        if (res.ok && res.data?.url && !res.data.sample) {
          dlUrl = res.data.url;
          break;
        }
      }

      if (!dlUrl) {
        fail(lastStatus === 401
          ? 'Qobuz session expired — the next download will ask you to sign in to play.qobuz.com again'
          : 'No download URL from track/getFileUrl (not purchased on this account?)');
        return;
      }

      const saved = await downloadToUniqueFile(dlUrl, destDir, `${track.artist} - ${track.title}`, 'qobuz-download');
      // Remember it either way, so a lossy one isn't fetched again every run.
      recordDownload('qobuz', track.trackId, track.artist, track.title, saved.path);
      if (saved.lossless !== true) {
        fail(`Arrived ${saved.lossless === false ? 'lossy' : 'in an unrecognised format'} (${saved.ext.toUpperCase()}) — kept in ${path.dirname(saved.path)}, not converted`);
        return;
      }
      onProgress?.({ ...progress, currentTrack: label, phase: 'converting', message: `Converting to AIFF: ${label}` });
      const finalPath = await ensureAiff(saved);
      if (finalPath !== saved.path) recordDownload('qobuz', track.trackId, track.artist, track.title, finalPath);
      downloaded.push(finalPath);
    } catch (err) {
      log.error('Qobuz download failed for', label, err);
      fail(err instanceof Error ? err.message : 'Download failed');
    }
  }

  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < tracks.length) {
      const myIdx = next++;
      await handleTrack(tracks[myIdx]);
      if (next < tracks.length) await sleep(300);
    }
  });
  await Promise.allSettled(workers);

  onProgress?.({ current: tracks.length, total: tracks.length, currentTrack: '', phase: 'complete', message: `Done: ${downloaded.length} downloaded, ${failed.length} failed${skipped.length ? `, ${skipped.length} skipped` : ''}` });
  return { downloaded, failed, skipped, destDir };
}

/** track id → order_item_download_id from the account's downloads list. Cart
 *  matches come from search and don't carry one; the purchase does. */
async function beatportOrderItemIds(token: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let page = 1; page <= 200; page++) {
    const res = await beatportApi(token, `/my/downloads/?per_page=100&page=${page}`);
    if (!res.ok) throw new Error(`Beatport downloads list page ${page}: HTTP ${res.status}`);
    const data = await res.json() as { next?: string | null; results?: Array<{ id?: number; order_item_download_id?: number }> };
    for (const r of data.results ?? []) {
      if (r.id != null && r.order_item_download_id != null && !out.has(String(r.id))) {
        out.set(String(r.id), String(r.order_item_download_id));
      }
    }
    if (!data.next || (data.results ?? []).length === 0) break;
    await sleep(200);
  }
  return out;
}

export async function downloadBeatportPurchases(
  defaultAccountId: string,
  tracks: StoreMatch[],
  destDir: string,
  onProgress?: (p: DownloadProgress) => void,
  concurrency: number = 1
): Promise<DownloadResult> {
  const downloaded: string[] = [];
  const failed: Array<{ trackId: string; artist: string; title: string; error: string }> = [];
  const skipped: DownloadResult['skipped'] = [];
  await fsp.mkdir(destDir, { recursive: true });

  // One downloads-list read per account, shared by every track that needs it.
  const orderIds = new Map<string, Promise<Map<string, string>>>();
  const orderIdsFor = (accountId: string, token: string) => {
    let p = orderIds.get(accountId);
    if (!p) { p = beatportOrderItemIds(token); orderIds.set(accountId, p); }
    return p;
  };

  let completed = 0;
  async function handleTrack(track: StoreMatch): Promise<void> {
    const label = `${track.artist} - ${track.title}`;
    const trackAccountId = (track as StoreMatch & { sourceAccountId?: string }).sourceAccountId || defaultAccountId;
    completed++;
    const progress = { current: completed, total: tracks.length };
    const fail = (error: string) => failed.push({ trackId: track.trackId ?? '', artist: track.artist, title: track.title, error });

    const prior = priorDownload('beatport', track);
    if (prior && 'reuse' in prior) {
      log.info(`Already downloaded: ${label} (${prior.reuse})`);
      downloaded.push(prior.reuse);
      onProgress?.({ ...progress, currentTrack: label, phase: 'downloading', message: `Already downloaded: ${label}` });
      return;
    }
    if (prior && 'skip' in prior) {
      skipped.push({ trackId: track.trackId ?? '', artist: track.artist, title: track.title, reason: prior.skip });
      onProgress?.({ ...progress, currentTrack: label, phase: 'downloading', message: `Skipped (deleted): ${label}` });
      return;
    }

    onProgress?.({ ...progress, currentTrack: label, phase: 'downloading', message: `Downloading: ${label}` });

    try {
      if (!track.trackId) {
        fail('No track ID');
        return;
      }
      const token = getBeatportAccessToken(trackAccountId);
      if (!token) {
        fail('Not signed in to Beatport — open the Beatport cart to sign in, then retry');
        return;
      }

      let oidd = (track as StoreMatch & { orderItemDownloadId?: string }).orderItemDownloadId;
      if (!oidd) {
        try {
          oidd = (await orderIdsFor(trackAccountId, token)).get(String(track.trackId));
        } catch (err) {
          fail(`Couldn't read your Beatport downloads: ${getErrorMessage(err)}`);
          return;
        }
        if (!oidd) {
          fail('Not in your Beatport downloads yet — finish checkout, then retry');
          return;
        }
      }

      const res = await beatportApi(token, `/catalog/tracks/purchase-download/?order_item_download_id=${encodeURIComponent(oidd)}`);
      if (!res.ok) {
        fail(`Beatport wouldn't hand over the file (HTTP ${res.status})`);
        return;
      }
      const data = await res.json() as { download_url?: string; url?: string; signed_url?: string };
      const dlUrl = data.download_url || data.url || data.signed_url;
      if (!dlUrl) {
        fail('No download URL found');
        return;
      }

      const saved = await downloadToUniqueFile(dlUrl, destDir, `${track.artist} - ${track.title}`, 'beatport-download');
      recordDownload('beatport', track.trackId, track.artist, track.title, saved.path);
      if (saved.lossless !== true) {
        fail(`Arrived ${saved.lossless === false ? 'lossy' : 'in an unrecognised format'} (${saved.ext.toUpperCase()}) — kept in ${path.dirname(saved.path)}, not converted`);
        return;
      }
      onProgress?.({ ...progress, currentTrack: label, phase: 'converting', message: `Converting to AIFF: ${label}` });
      const finalPath = await ensureAiff(saved);
      if (finalPath !== saved.path) recordDownload('beatport', track.trackId, track.artist, track.title, finalPath);
      downloaded.push(finalPath);
    } catch (err) {
      log.error('Beatport download failed for', label, err);
      fail(err instanceof Error ? err.message : 'Download failed');
    }
  }

  // Worker pool
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < tracks.length) {
      const myIdx = next++;
      await handleTrack(tracks[myIdx]);
      if (next < tracks.length) await sleep(300);
    }
  });
  await Promise.allSettled(workers);

  onProgress?.({ current: tracks.length, total: tracks.length, currentTrack: '', phase: 'complete', message: `Done: ${downloaded.length} downloaded, ${failed.length} failed${skipped.length ? `, ${skipped.length} skipped` : ''}` });
  return { downloaded, failed, skipped, destDir };
}

// ========== Helpers ==========

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== Purchase History ==========

export type OwnedTrack = {
  source: 'qobuz' | 'beatport';
  trackId: string;
  artist: string;
  title: string;
  filePath?: string;
  orderItemDownloadId?: string;
  /** Which configured account this purchase came from — needed to pick the right session for download. */
  sourceAccountId?: string;
};

/** A purchase history plus what couldn't be read. An account whose history
 *  couldn't be read is named in `errors`: "owns nothing" and "couldn't check"
 *  are different answers, and only the first means a track isn't owned. */
export type PurchaseList = OwnedTrack[] & { errors: string[] };

function purchaseList(tracks: OwnedTrack[], errors: string[]): PurchaseList {
  return Object.assign(tracks, { errors });
}

// Cached Qobuz API credentials (app_id + user_auth_token) sniffed from the SPA,
// keyed by account id. Dropped on a 401 so the next use signs in again.
const qobuzCreds = new Map<string, { appId: string; userAuthToken: string }>();

export function getQobuzCredentials(accountId: string): { appId: string | null; userAuthToken: string | null } {
  const entry = qobuzCreds.get(accountId);
  return { appId: entry?.appId ?? null, userAuthToken: entry?.userAuthToken ?? null };
}

export function setQobuzCredentials(accountId: string, appId: string, userAuthToken: string): void {
  qobuzCreds.set(accountId, { appId, userAuthToken });
  log.info(`Qobuz[${accountId}]: credentials cached`);
}

// One sniff per account at a time: everyone who asks meanwhile shares its window.
const qobuzSniffs = new Map<string, { win: BrowserWindow | null; done: Promise<{ appId: string; userAuthToken: string }> }>();

/**
 * Read play.qobuz.com's own `X-App-Id` / `X-User-Auth-Token` by loading the web
 * player in a window on the account's partition and watching the API calls it
 * makes for itself. Already signed in there, the window closes within seconds;
 * otherwise the user signs in in it (up to five minutes).
 *
 * One window per account: a second caller while it's open waits on the same
 * one. The header listener is removed when the sniff ends — the partition
 * outlives the window. Throws when no credentials land (window closed, timed
 * out), so callers can tell "couldn't sign in" from "no purchases".
 *
 * Qobuz's SPA has a hard 1024px minimum viewport — below that it shows a
 * "please use a bigger screen" message instead of the login form.
 */
export function sniffQobuzCredentials(accountId: string, displayName?: string): Promise<{ appId: string; userAuthToken: string }> {
  const pending = qobuzSniffs.get(accountId);
  if (pending) {
    try { if (pending.win && !pending.win.isDestroyed()) pending.win.focus(); } catch { /* ignore */ }
    return pending.done;
  }
  const entry: { win: BrowserWindow | null; done: Promise<{ appId: string; userAuthToken: string }> } = { win: null, done: Promise.resolve({ appId: '', userAuthToken: '' }) };
  entry.done = runQobuzSniff(accountId, displayName, (w) => { entry.win = w; })
    .finally(() => qobuzSniffs.delete(accountId));
  qobuzSniffs.set(accountId, entry);
  return entry.done;
}

async function runQobuzSniff(
  accountId: string,
  displayName: string | undefined,
  onWindow: (win: BrowserWindow) => void
): Promise<{ appId: string; userAuthToken: string }> {
  const partitionName = qobuzPartition(accountId);
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    title: displayName
      ? `Sign in to play.qobuz.com — ${displayName}`
      : `Sign in to play.qobuz.com — account ${accountId.slice(0, 8)}`,
    alwaysOnTop: true,
    webPreferences: { partition: partitionName, nodeIntegration: false, contextIsolation: true },
  });
  onWindow(win);
  try { win.moveTop(); win.focus(); } catch { /* ignore */ }
  setTimeout(() => { try { if (!win.isDestroyed()) win.setAlwaysOnTop(false); } catch { /* ignore */ } }, 3000);

  const REAL_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  win.webContents.setUserAgent(REAL_UA);

  // OAuth pop-ups (rare on Qobuz but possible) should inherit the same partition.
  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      webPreferences: { partition: partitionName, nodeIntegration: false, contextIsolation: true },
    },
  }));

  let foundAppId: string | null = null;
  let foundToken: string | null = null;
  let closedByUser = false;

  const ses = win.webContents.session;
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://*.qobuz.com/api.json/*'] }, (details, cb) => {
    try {
      const h = details.requestHeaders || {};
      const app = h['X-App-Id'] || h['x-app-id'];
      const tok = h['X-User-Auth-Token'] || h['x-user-auth-token'];
      if (app && tok && tok !== 'undefined' && !foundAppId) {
        foundAppId = String(app);
        foundToken = String(tok);
      }
    } catch { /* ignore */ }
    cb({ requestHeaders: details.requestHeaders });
  });
  win.on('closed', () => { closedByUser = true; });
  win.webContents.on('did-navigate', (_e, url) => log.info(`Qobuz[${accountId}] sniff nav: ${url}`));
  win.webContents.on('did-fail-load', (_e, errorCode, errorDesc, validatedURL) => {
    log.warn(`Qobuz[${accountId}] sniff fail-load code=${errorCode} desc=${errorDesc} url=${validatedURL}`);
  });

  const INTERACTIVE_MS = 5 * 60 * 1000;
  try {
    await win.loadURL('https://play.qobuz.com/');
    const deadline = Date.now() + INTERACTIVE_MS;
    while (Date.now() < deadline && !foundAppId && !closedByUser) {
      await sleep(500);
    }
  } finally {
    try { ses.webRequest.onBeforeSendHeaders(null); } catch { /* session gone */ }
    try { if (!win.isDestroyed()) win.close(); } catch { /* already destroyed */ }
  }

  if (foundAppId && foundToken) {
    qobuzCreds.set(accountId, { appId: foundAppId, userAuthToken: foundToken });
    log.info(`Qobuz[${accountId}]: sniffed credentials (appId=${foundAppId})`);
    return { appId: foundAppId, userAuthToken: foundToken };
  }
  throw new Error(closedByUser
    ? 'The play.qobuz.com sign-in window was closed before it signed in'
    : 'Timed out waiting for play.qobuz.com to sign in');
}

// Qobuz app secret for request signing (extracted from play.qobuz.com bundle.js)
const QOBUZ_APP_SECRET = 'abb21364945c0583309667d13ca3d93a';

async function qobuzApi<T = unknown>(accountId: string, path: string, params: Record<string, string | number> = {}, opts: { sign?: boolean } = {}): Promise<{ status: number; ok: boolean; data: T | null; text: string }> {
  const creds = qobuzCreds.get(accountId);
  if (!creds) throw new Error(`Qobuz[${accountId}] credentials not set; call sniffQobuzCredentials() first`);
  const allParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) allParams[k] = String(v);

  if (opts.sign) {
    const ts = Math.floor(Date.now() / 1000);
    // request_id = camelCased path without slashes, e.g. 'track/getFileUrl' -> 'trackgetFileUrl'
    const reqId = path.replace(/\//g, '');
    const sortedKeys = Object.keys(allParams).sort();
    const paramsStr = sortedKeys.map(k => `${k}${allParams[k]}`).join('');
    const sigPayload = reqId + paramsStr + String(ts) + QOBUZ_APP_SECRET;
    const sig = crypto.createHash('md5').update(sigPayload).digest('hex');
    allParams['request_ts'] = String(ts);
    allParams['request_sig'] = sig;
  }

  const qs = new URLSearchParams(allParams).toString();
  const url = `https://www.qobuz.com/api.json/0.2/${path}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, {
    headers: {
      'X-App-Id': creds.appId,
      'X-User-Auth-Token': creds.userAuthToken,
      'Accept': 'application/json',
      'User-Agent': USER_AGENT,
      'Origin': 'https://play.qobuz.com',
      'Referer': 'https://play.qobuz.com/',
    },
    signal: AbortSignal.timeout(30_000),
  });
  // An expired token stays expired: forget it so the next call signs in again.
  if (res.status === 401) {
    qobuzCreds.delete(accountId);
    log.warn(`Qobuz[${accountId}]: ${path} answered 401 — dropped the cached credentials`);
  }
  const text = await res.text();
  let data: T | null = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, ok: res.ok, data, text };
}

/** Every track this Qobuz account bought. Throws when the history can't be
 *  read — a partial list must never pass for the whole one. */
export async function fetchQobuzPurchases(accountId: string, displayName?: string): Promise<OwnedTrack[]> {
  if (!qobuzCreds.has(accountId)) {
    log.info(`Qobuz[${accountId}]: no cached credentials; sniffing from session`);
    await sniffQobuzCredentials(accountId, displayName);
  }

  type QTrack = { id?: number; title?: string; version?: string | null; performer?: { name?: string }; album?: { artist?: { name?: string } } };
  const owned: OwnedTrack[] = [];
  const seen = new Set<string>();
  const add = (t: QTrack, fallbackArtist: string) => {
    if (!t.id || !t.title) return;
    const trackId = String(t.id);
    if (seen.has(trackId)) return;
    seen.add(trackId);
    const artist = t.performer?.name || t.album?.artist?.name || fallbackArtist;
    // Qobuz keeps "HNTR Remix" in `version`; without it a purchased remix reads as the original.
    owned.push({ source: 'qobuz', trackId, artist, title: withVersion(t.title, t.version), sourceAccountId: accountId });
  };

  // Fetch purchased tracks (paginated)
  const limit = 500;
  let offset = 0;
  let total: number | null = null;
  while (true) {
    const res = await qobuzApi<{
      tracks?: { total?: number; items?: QTrack[] };
      albums?: { total?: number; items?: Array<{ id?: string; title?: string; artist?: { name?: string } }> };
    }>(accountId, 'purchase/getUserPurchases', { limit, offset });
    if (!res.ok || !res.data) {
      throw new Error(`Qobuz purchase history (offset ${offset}): HTTP ${res.status}${res.status === 401 ? ' — signed out of play.qobuz.com' : ''}`);
    }
    const trackItems = res.data.tracks?.items || [];
    const albumItems = res.data.albums?.items || [];
    if (offset === 0) {
      const trackTotal = res.data.tracks?.total ?? trackItems.length;
      const albumTotal = res.data.albums?.total ?? albumItems.length;
      total = Math.max(trackTotal, albumTotal);
      log.info(`Qobuz[${accountId}]: fetching ${trackTotal} purchased tracks + ${albumTotal} albums`);
    }
    for (const t of trackItems) add(t, '');
    for (const album of albumItems) {
      if (!album.id) continue;
      const ar = await qobuzApi<{ tracks?: { items?: QTrack[] } }>(accountId, 'album/get', { album_id: album.id, extra: 'tracks' });
      if (!ar.ok) throw new Error(`Qobuz purchased album ${album.id}: HTTP ${ar.status}`);
      for (const t of ar.data?.tracks?.items || []) add(t, album.artist?.name || '');
      await sleep(200);
    }
    if (trackItems.length < limit && albumItems.length < limit) break;
    offset += limit;
    if (total != null && offset >= total) break;
    await sleep(400);
  }

  log.info(`Qobuz[${accountId}]: collected ${owned.length} owned tracks`);
  return owned;
}

/**
 * Log in to each account and aggregate purchase history, deduped by track id.
 * First occurrence wins (so order accounts by preferred source account). An
 * account that couldn't be read is named in `errors`, not counted as empty.
 */
export async function fetchAllQobuzPurchases(accounts: StoreAccount[]): Promise<PurchaseList> {
  const merged: OwnedTrack[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const account of accounts) {
    const name = account.label || account.email || account.id;
    try {
      await loginQobuz(account.id);
      // Prefer label, fall back to email, so the sniff window title tells the
      // user which Qobuz account to sign into when multiple prompts pop up.
      const tracks = await fetchQobuzPurchases(account.id, account.label || account.email || undefined);
      for (const t of tracks) {
        if (seen.has(t.trackId)) continue;
        seen.add(t.trackId);
        merged.push(t);
      }
    } catch (err) {
      log.error(`Qobuz[${account.id}] fetch failed:`, err);
      errors.push(`Qobuz (${name}): ${getErrorMessage(err, 'purchase history unreadable')}`);
    }
  }
  log.info(`Qobuz: aggregated ${merged.length} unique tracks across ${accounts.length} account(s)${errors.length ? `, ${errors.length} unreadable` : ''}`);
  return purchaseList(merged, errors);
}

/** A live Bearer token for the account: the cached one, else whatever its
 *  signed-in session hands over (read in-page, never by copying cookies). */
async function ensureBeatportToken(accountId: string): Promise<string | null> {
  const cached = getBeatportAccessToken(accountId);
  if (cached) return cached;
  const fresh = await readBeatportSessionToken(beatportPartition(accountId)).catch(() => null);
  if (!fresh) return null;
  setBeatportToken(accountId, fresh.token, fresh.expiresIn);
  return fresh.token;
}

/** Every track this Beatport account bought. Throws when the history can't be
 *  read — a partial list must never pass for the whole one. */
export async function fetchBeatportPurchases(accountId: string): Promise<OwnedTrack[]> {
  const token = await ensureBeatportToken(accountId);
  if (!token) throw new Error('Not signed in to Beatport');

  const owned: OwnedTrack[] = [];
  const seen = new Set<string>();
  const perPage = 100;
  let page = 1;
  let totalPages: number | null = null;

  while (true) {
    const res = await beatportApi(token, `/my/downloads/?per_page=${perPage}&page=${page}`);
    if (!res.ok) {
      if (res.status === 401) invalidateBeatportToken(accountId);
      const body = await res.text().catch(() => '');
      throw new Error(`Beatport purchase history page ${page}: HTTP ${res.status} ${body.slice(0, 120)}`);
    }

    const data = await res.json() as {
      count?: number;
      next?: string | null;
      results?: Array<{
        id?: number;
        name?: string;
        mix_name?: string;
        artists?: Array<{ name?: string }>;
        order_item_download_id?: number;
      }>;
    };

    const results = data.results || [];
    if (page === 1) {
      const total = data.count ?? results.length;
      totalPages = Math.ceil(total / perPage);
      log.info(`Beatport: fetching ${total} purchases across ${totalPages} page(s)`);
    }

    for (const t of results) {
      if (!t?.id || !t.name) continue;
      const trackId = String(t.id);
      if (seen.has(trackId)) continue;
      seen.add(trackId);
      const artist = (t.artists || []).map(a => a.name).filter(Boolean).join(', ');
      const titleWithMix = t.mix_name && t.mix_name !== 'Original Mix'
        ? withVersion(t.name, t.mix_name)
        : t.name;
      owned.push({
        source: 'beatport',
        trackId,
        artist,
        title: titleWithMix,
        orderItemDownloadId: t.order_item_download_id != null ? String(t.order_item_download_id) : undefined,
        sourceAccountId: accountId,
      });
    }

    if (!data.next || results.length < perPage) break;
    page++;
    if (totalPages && page > totalPages + 2) break;
    await sleep(300);
  }

  log.info(`Beatport[${accountId}]: collected ${owned.length} owned tracks`);
  return owned;
}

/**
 * Log in to each Beatport account and aggregate purchase history, deduped by track id.
 * Note: `orderItemDownloadId` is per-purchase, so dedupe preserves the first account's
 * orderItemDownloadId — downloads must use that account's token. An account
 * that couldn't be read is named in `errors`, not counted as empty.
 */
export async function fetchAllBeatportPurchases(accounts: StoreAccount[]): Promise<PurchaseList> {
  const merged: OwnedTrack[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const account of accounts) {
    const name = account.label || account.email || account.id;
    try {
      await loginBeatport(account.id);
      const tracks = await fetchBeatportPurchases(account.id);
      for (const t of tracks) {
        if (seen.has(t.trackId)) continue;
        seen.add(t.trackId);
        merged.push(t);
      }
    } catch (err) {
      log.error(`Beatport[${account.id}] fetch failed:`, err);
      errors.push(`Beatport (${name}): ${getErrorMessage(err, 'purchase history unreadable')}`);
    }
  }
  log.info(`Beatport: aggregated ${merged.length} unique tracks across ${accounts.length} account(s)${errors.length ? `, ${errors.length} unreadable` : ''}`);
  return purchaseList(merged, errors);
}
