/**
 * Store purchase integration for Qobuz and Beatport.
 * Authenticates via API endpoints, then uses cookie-based fetch for search + cart.
 * Falls back to BrowserWindow login if credentials aren't provided.
 */

import path from 'path';
import fsSync from 'fs';
import { BrowserWindow, session } from 'electron';
import { JSDOM } from 'jsdom';
import { convertToAiff, deleteOriginalAfterConversion } from './trackConverter';
import { normalizeForComparison } from './stringUtils';
import { createScopedLogger } from './logger';
import { getErrorMessage } from './errorUtils';
import { isTrackDownloaded, recordDownload, getDownloadedTrackPath, forgetDownloadedTrack } from './db';
import fuzzball from 'fuzzball';
import type {
  StoreTrackInput,
  StoreMatch,
  StoreSearchResult,
  StoreCartResult,
  StoreSearchProgress,
  StoreCartProgress,
  StoreAccount
} from '../types';

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
  log.info(`Beatport[${accountId}]: token set externally, expires in ${Math.round(expiresInSeconds / 60)}m`);
}

/** Drop any cached Bearer token for this account. Use before cart-add to force
 *  a fresh token extraction from the partition cookies — avoids replaying a
 *  stale or wrong-account token that happens to still have a valid-looking
 *  signature but that the API rejects with 401. */
export function invalidateBeatportToken(accountId: string): void {
  beatportTokens.delete(accountId);
}

// ========== Browser Window Login ==========

const qobuzLoginWindows = new Map<string, BrowserWindow>();
const beatportLoginWindows = new Map<string, BrowserWindow>();

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
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return Promise.resolve(false);
  }

  const win = createLoginWindow(qobuzPartition(accountId), 'https://www.qobuz.com/signin');
  qobuzLoginWindows.set(accountId, win);

  return new Promise<boolean>((resolve) => {
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
    // Authoritative API probe. Bypass the cached isQobuzLoggedIn so we pick up
    // the first successful sign-in as fast as the poll interval allows, rather
    // than waiting out a stale "not logged in" cache entry.
    const pollInterval = setInterval(async () => {
      if (win.isDestroyed()) {
        clearInterval(pollInterval);
        return;
      }
      if (await probeQobuzLoginForPartition(qobuzPartition(accountId))) {
        clearInterval(pollInterval);
        log.info(`Qobuz[${accountId}] login detected via /user/me probe`);
        if (!win.isDestroyed()) win.close();
        finish(true);
      }
    }, 1500);
    win.on('closed', () => {
      clearInterval(pollInterval);
      qobuzLoginWindows.delete(accountId);
      finish(false);
    });
  });
}

function loginBeatportWindow(accountId: string): Promise<boolean> {
  const existing = beatportLoginWindows.get(accountId);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return Promise.resolve(false);
  }

  const win = createLoginWindow(beatportPartition(accountId), 'https://www.beatport.com');
  beatportLoginWindows.set(accountId, win);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (ok) markBeatportConnected(accountId);
      resolve(ok);
    };
    const cookieInterval = setInterval(async () => {
      if (win.isDestroyed()) {
        clearInterval(cookieInterval);
        return;
      }
      if (await isBeatportLoggedIn(accountId)) {
        clearInterval(cookieInterval);
        log.info(`Beatport[${accountId}] login detected via cookies`);
        await sleep(1000);
        if (!win.isDestroyed()) win.close();
        finish(true);
      }
    }, 2000);
    win.on('closed', () => {
      clearInterval(cookieInterval);
      beatportLoginWindows.delete(accountId);
      finish(false);
    });
  });
}

// ========== Authenticated Fetch ==========

async function fetchWithSession(partition: string, url: string, options: RequestInit = {}): Promise<Response> {
  const ses = session.fromPartition(partition);
  const cookies = await ses.cookies.get({ url });
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  return fetch(url, {
    ...options,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Cookie': cookieHeader,
      ...(options.headers || {})
    }
  });
}

// ========== Session Status ==========

// Runtime connection markers — set when a login window completes successfully.
// Cleared on logout and when an authoritative check fails.
const qobuzKnownConnected = new Set<string>();
const beatportKnownConnected = new Set<string>();

// Public Qobuz web-player app id (not a secret — shipped in their bundle.js).
// Required by /api.json/0.2/* endpoints, including the unauthenticated ones.
const QOBUZ_API_APP_ID = '798273057';

// Cache of auth-verification results so we don't hammer the remote API on
// every pill refresh / login-window poll tick.
const qobuzAuthCache = new Map<string, { loggedIn: boolean; checkedAt: number }>();
const AUTH_CACHE_MS = 5_000;

/**
 * Check whether the Electron session partition holds a valid Qobuz website
 * session. We look for any known Qobuz auth cookie (`userCookie` legacy,
 * `lantern` older, `qobuz-session` current). This matches the ask — the app
 * fetches purchase history by scraping authenticated HTML pages, which only
 * needs the website session cookies, not an API `X-User-Auth-Token`.
 *
 * We previously hit `/api.json/0.2/user/me` but that endpoint demands an
 * `X-User-Auth-Token` header (password-login-flow artifact) which no website
 * login grants. It returned 401 even when the user was fully signed in, making
 * the probe always say "not logged in" and the restore fail to fetch purchases.
 */
export async function probeQobuzLoginForPartition(partitionName: string): Promise<boolean> {
  const ses = session.fromPartition(partitionName);
  const cookies = await ses.cookies.get({ url: 'https://www.qobuz.com' });
  const cookieNames = cookies.map(c => c.name).sort();
  // Inline the auth-cookie predicate so we don't depend on a helper that
  // might drift between branches. `qobuz-session` is the modern signal
  // (set after the Google OAuth flow lands you back on qobuz.com); `userCookie`
  // is the classic website auth cookie, still issued by /signin form posts;
  // `lantern` is the older variant some builds still set.
  const hasAuth = cookies.some(c => {
    if (c.name === 'qobuz-session' || c.name === 'userCookie' || c.name === 'lantern') return true;
    const lower = c.name.toLowerCase();
    return lower.includes('user_auth') || lower.includes('userauth') || lower === 'qb_sid';
  });
  log.info(`Qobuz cookie-check[${partitionName}]: authCookie=${hasAuth} cookies=${cookies.length} names=[${cookieNames.join(',')}]`);
  return hasAuth;
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
  try {
    const ses = session.fromPartition(beatportPartition(accountId));
    await ses.clearStorageData({ storages: ['cookies', 'localstorage'] });
  } catch (err) {
    log.warn(`Beatport[${accountId}]: failed to clear session storage:`, err);
  }
  log.info(`Beatport[${accountId}]: logged out`);
}

// ========== Fuzzy Matching ==========

function scoreMatch(track: StoreTrackInput, candidateArtist: string, candidateTitle: string): number {
  const trackArtist = normalizeForComparison(track.artist);
  const trackTitle = normalizeForComparison(track.title);
  const otherArtist = normalizeForComparison(candidateArtist);
  const otherTitle = normalizeForComparison(candidateTitle);

  const artistScore = Math.max(
    fuzzball.ratio(trackArtist, otherArtist),
    fuzzball.token_set_ratio(trackArtist, otherArtist),
    fuzzball.partial_ratio(trackArtist, otherArtist)
  ) / 100;

  const titleScore = Math.max(
    fuzzball.ratio(trackTitle, otherTitle),
    fuzzball.token_set_ratio(trackTitle, otherTitle),
    fuzzball.partial_ratio(trackTitle, otherTitle)
  ) / 100;

  return titleScore * 0.6 + artistScore * 0.4;
}

// ========== Qobuz Search ==========

export async function searchQobuzStore(
  accountId: string,
  tracks: StoreTrackInput[],
  onProgress?: (p: StoreSearchProgress) => void,
  onMatch?: (match: StoreMatch) => void
): Promise<StoreSearchResult> {
  const matches: StoreMatch[] = [];
  const notFound: StoreTrackInput[] = [];
  const errors: Array<{ input: StoreTrackInput; error: string }> = [];
  const partition = qobuzPartition(accountId);

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    const label = `${track.artist} - ${track.title}`;
    onProgress?.({ current: i + 1, total: tracks.length, currentTrack: label, source: 'qobuz' });

    try {
      const url = `https://www.qobuz.com/us-en/search/tracks/${encodeURIComponent(track.artist + ' ' + track.title)}`;
      const res = await fetchWithSession(partition, url);
      const html = await res.text();

      const dom = new JSDOM(html);
      const doc = dom.window.document;
      const items = doc.querySelectorAll('.ListItem');

      let best: StoreMatch | null = null;
      let bestScore = 0;

      for (const item of items) {
        const title = item.querySelector('.ListItem__title')?.textContent?.trim() || '';
        const artistsText = item.querySelector('.ListItem__artists')?.textContent?.trim() || '';
        const artist = artistsText.split('\u2022')[0].trim();
        const album = artistsText.split('\u2022')[1]?.trim() || '';
        const cartBtn = item.querySelector('.add_to_cart[data-url]');
        const trackId = cartBtn?.getAttribute('data-url')?.split('/').pop() || '';
        const albumLink = item.querySelector('a[href*="/album/"]');
        const albumUrl = albumLink?.getAttribute('href') || '';

        if (!title || !trackId) continue;

        const score = scoreMatch(track, artist, title);
        if (score > bestScore) {
          bestScore = score;
          best = {
            input: track,
            trackId,
            title,
            artist,
            album,
            label: '',
            price: '',
            quality: '',
            format: 'FLAC',
            lossless: false,
            rx3Compatible: false,
            confidence: score,
            url: albumUrl ? `https://www.qobuz.com${albumUrl}` : '',
            source: 'qobuz'
          };
        }
      }

      if (best && bestScore >= 0.50) {
        // Get pricing and quality info from the popin
        try {
          const popinRes = await fetchWithSession(
            partition,
            `https://www.qobuz.com/v4/ajax/popin-add-cart/track/${best.trackId}`,
            { headers: { 'X-Requested-With': 'XMLHttpRequest' } }
          );
          if (popinRes.ok) {
            const popinHtml = await popinRes.text();
            const popinDom = new JSDOM(popinHtml);
            const popinDoc = popinDom.window.document;
            const qualityBtns = [...popinDoc.querySelectorAll('.store-modal__quality')];
            qualityBtns.sort((a, b) =>
              Number(a.getAttribute('data-priority') || 0) - Number(b.getAttribute('data-priority') || 0)
            );

            // Check if any quality option is lossless (CD Quality, Hi-Res, FLAC)
            const hasLossless = qualityBtns.some(btn => {
              const label = (btn.getAttribute('data-label') || '').toLowerCase();
              return label.includes('cd') || label.includes('hi-res') || label.includes('flac') || label.includes('lossless');
            });
            best.lossless = hasLossless;

            // Pick the best lossless option, or fall back to highest priority
            const losslessBtns = qualityBtns.filter(btn => {
              const label = (btn.getAttribute('data-label') || '').toLowerCase();
              return label.includes('cd') || label.includes('hi-res') || label.includes('flac') || label.includes('lossless');
            });
            const bestQuality = losslessBtns.length > 0
              ? losslessBtns[losslessBtns.length - 1]
              : qualityBtns[qualityBtns.length - 1];

            if (bestQuality) {
              best.price = bestQuality.getAttribute('data-price') || '';
              best.quality = bestQuality.getAttribute('data-label') || '';
              best.articleId = bestQuality.getAttribute('data-id') || '';
              best.cartLink = bestQuality.getAttribute('data-cart-link') || '';
            }
          }
        } catch (e) {
          log.warn('Failed to get Qobuz pricing for', best.trackId, e);
        }

        matches.push(best);
        onMatch?.(best);
      } else {
        notFound.push(track);
      }
    } catch (err) {
      log.error('Qobuz search failed for:', label, err);
      errors.push({ input: track, error: getErrorMessage(err, 'Search failed') });
    }

    if (i < tracks.length - 1) await sleep(1500);
  }

  return { matches, notFound, errors };
}

// ========== Beatport Search ==========

export async function searchBeatportStore(
  accountId: string,
  tracks: StoreTrackInput[],
  onProgress?: (p: StoreSearchProgress) => void,
  onMatch?: (match: StoreMatch) => void
): Promise<StoreSearchResult> {
  const matches: StoreMatch[] = [];
  const notFound: StoreTrackInput[] = [];
  const errors: Array<{ input: StoreTrackInput; error: string }> = [];

  const token = getBeatportAccessToken(accountId);
  if (!token) {
    log.error(`Beatport[${accountId}] search: no access token`);
    return { matches, notFound: tracks, errors: [{ input: tracks[0], error: 'Not logged in' }] };
  }

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    const label = `${track.artist} - ${track.title}`;
    onProgress?.({ current: i + 1, total: tracks.length, currentTrack: label, source: 'beatport' });

    try {
      const q = encodeURIComponent(track.artist + ' ' + track.title);
      const res = await fetch(`https://api.beatport.com/v4/catalog/search/?q=${q}&type=tracks&per_page=10`, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API ${res.status}: ${text.slice(0, 100)}`);
      }

      const data = await res.json() as {
        tracks?: Array<{
          id: number;
          name: string;
          mix_name?: string;
          artists?: Array<{ name: string }>;
          release?: { name: string };
          label?: { name: string };
          price?: { display?: string; value?: number };
          slug?: string;
        }>;
      };

      const searchTracks = data.tracks || [];
      let best: StoreMatch | null = null;
      let bestScore = 0;

      for (const st of searchTracks) {
        if (!st.name) continue;
        const artistName = (st.artists || []).map(a => a.name).join(', ');
        const titleWithMix = st.name + (st.mix_name && st.mix_name !== 'Original Mix' ? ` (${st.mix_name})` : '');

        const score = scoreMatch(track, artistName, titleWithMix);
        if (score > bestScore) {
          bestScore = score;
          best = {
            input: track,
            trackId: String(st.id),
            title: titleWithMix,
            artist: artistName,
            album: st.release?.name || '',
            label: st.label?.name || '',
            price: st.price?.display || (st.price?.value ? `$${st.price.value}` : ''),
            quality: 'WAV/AIFF',
            format: 'WAV/AIFF',
            lossless: true,
            rx3Compatible: true,
            confidence: score,
            url: `https://www.beatport.com/track/${st.slug || st.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/${st.id}`,
            source: 'beatport'
          };
        }
      }

      if (best && bestScore >= 0.50) {
        matches.push(best);
        onMatch?.(best);
      } else {
        notFound.push(track);
      }
    } catch (err) {
      log.error('Beatport search failed for:', label, err);
      errors.push({ input: track, error: getErrorMessage(err, 'Search failed') });
    }

    if (i < tracks.length - 1) await sleep(1500);
  }

  return { matches, notFound, errors };
}

// ========== Qobuz Cart ==========

/** Fetch the Qobuz add-to-cart popin for a track ID and return the cart-link
 *  for the highest-quality LOSSLESS option available. Qobuz lists several
 *  quality tiers per track (MP3, CD 16/44, Hi-Res 24-bit, etc.); the popin
 *  DOM's `data-priority` attribute doesn't reliably map to "best" — on many
 *  releases MP3 wins by priority. We score each button by inspecting its
 *  text content + data attributes for format hints and pick the best.
 *
 *  Returns the cart link for the chosen article, or empty string if the popin
 *  has no parseable articles. */
async function fetchQobuzCartLinkForTrack(partition: string, trackId: string): Promise<string> {
  const res = await fetchWithSession(
    partition,
    `https://www.qobuz.com/v4/ajax/popin-add-cart/track/${trackId}`,
    { headers: { 'X-Requested-With': 'XMLHttpRequest' } }
  );
  if (!res.ok) return '';
  const html = await res.text();
  const dom = new JSDOM(html);
  const qualityBtns = [...dom.window.document.querySelectorAll('.store-modal__quality')];
  if (qualityBtns.length === 0) return '';

  // Score each quality button: higher = better. Uses the button's visible
  // text and data attributes to estimate the format. Known ranking for DJ
  // use: Hi-Res (24-bit / 96-192 kHz) > CD (16-bit / 44.1 kHz / FLAC) > MP3.
  const scoreBtn = (btn: Element): number => {
    const texts = [
      btn.textContent ?? '',
      btn.getAttribute('data-format') ?? '',
      btn.getAttribute('data-quality') ?? '',
      btn.getAttribute('data-label') ?? '',
      btn.getAttribute('aria-label') ?? '',
    ].join(' ').toLowerCase();
    // Look for explicit bit-depth / sample-rate tags first
    const bitDepth = /(\d+)\s*[-\s]?bit\b/.exec(texts);
    const sampleRate = /(\d+(?:\.\d+)?)\s*k?hz/i.exec(texts);
    const hasHiRes = /hi[\s-]?res|hires|hi-resolution|24[\s-]?bit|studio master/.test(texts);
    const hasCd = /cd\b|16[\s-]?bit|lossless|flac/.test(texts);
    const hasMp3 = /\bmp3\b|\b320\b|\b256\b|\b128\b|lossy/.test(texts);
    let score = 0;
    if (hasHiRes) score += 1000;
    if (hasCd && !hasMp3) score += 500;
    if (bitDepth) score += Number(bitDepth[1]); // 24 > 16 > 8
    if (sampleRate) score += Number(sampleRate[1]); // 192 > 96 > 44.1
    if (hasMp3 && !hasCd && !hasHiRes) score = Math.min(score, 50);
    // Tie-break on declared priority so we don't regress on popins that only
    // expose data-priority with no format text.
    score += Number(btn.getAttribute('data-priority') || 0) * 0.01;
    return score;
  };

  let bestBtn: Element | null = null;
  let bestScore = -Infinity;
  for (const btn of qualityBtns) {
    const s = scoreBtn(btn);
    if (s > bestScore) {
      bestScore = s;
      bestBtn = btn;
    }
  }
  return bestBtn?.getAttribute('data-cart-link') ?? '';
}

/** Given a Qobuz album URL, scrape track IDs from `.add_to_cart[data-url]` and
 *  pick the track whose title best matches the requested track. Returns the
 *  track ID (or empty string if the page yields no track candidates). */
async function resolveQobuzTrackIdFromAlbumPage(
  partition: string,
  albumUrl: string,
  wantedTitle: string,
  wantedArtist: string
): Promise<string> {
  const res = await fetchWithSession(partition, albumUrl);
  if (!res.ok) return '';
  const html = await res.text();
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // Current Qobuz markup: the add-to-cart trigger is a button whose
  // `data-url` points at the per-track popin endpoint, e.g.
  //   data-url="/v4/ajax/popin-add-cart/track/166510141"
  const candidates: Array<{ id: string; title: string; artist: string }> = [];
  for (const btn of doc.querySelectorAll('[data-url*="popin-add-cart/track"]')) {
    const dataUrl = btn.getAttribute('data-url') || '';
    const id = dataUrl.split('/').pop() || '';
    if (!id) continue;
    const row = btn.closest('.track, .track-list__track, li, tr') as Element | null;
    const title = row?.querySelector('.track__title, .track__name, .title')?.textContent?.trim() || '';
    const artist = row?.querySelector('.track__artist, .track__artists, .artist')?.textContent?.trim() || '';
    candidates.push({ id, title, artist });
  }

  if (candidates.length === 0) return '';
  if (candidates.length === 1) return candidates[0].id;

  // Pick the best title+artist fuzzy match.
  let bestId = candidates[0].id;
  let bestScore = -1;
  for (const c of candidates) {
    const score = scoreMatch(
      { key: '', artist: wantedArtist, title: wantedTitle },
      c.artist,
      c.title
    );
    if (score > bestScore) { bestScore = score; bestId = c.id; }
  }
  return bestId;
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

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const label = `${match.artist} - ${match.title}`;
    onProgress?.({
      current: i + 1, total: matches.length, currentTrack: label,
      phase: 'adding', message: `Adding: ${label}`
    });

    // Enforce the lossless-only invariant server-side: never add a lossy match
    // to the cart, no matter what the caller passed in.
    if (match.lossless === false) {
      failed.push({ match, error: 'Excluded: lossy match (lossless only)' });
      continue;
    }

    try {
      let cartLink = match.cartLink;

      // If no cart link cached, fetch the popin
      if (!cartLink && match.trackId) {
        cartLink = await fetchQobuzCartLinkForTrack(partition, match.trackId);
      }

      // Fallback: Sources search returns album IDs (not track IDs) — the
      // per-track popin returns nothing for those. Fetch the album page and
      // pick the best-matching track from the listing, then retry the popin.
      if (!cartLink && match.url) {
        const resolvedTrackId = await resolveQobuzTrackIdFromAlbumPage(
          partition, match.url, match.title, match.artist
        );
        if (resolvedTrackId) {
          match.trackId = resolvedTrackId;
          cartLink = await fetchQobuzCartLinkForTrack(partition, resolvedTrackId);
        }
      }

      if (!cartLink) {
        failed.push({ match, error: 'No cart link available' });
        continue;
      }

      const cartRes = await fetchWithSession(
        partition,
        `https://www.qobuz.com${cartLink}`,
        { headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' } }
      );
      const cartJson = await cartRes.json() as { success: boolean; message?: string };

      if (cartJson.success) {
        added.push(match);
        const priceNum = parseFloat((match.price || '').replace(/[^0-9.]/g, ''));
        if (!isNaN(priceNum)) totalCost += priceNum;
      } else {
        failed.push({ match, error: cartJson.message || 'Cart add failed' });
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

export async function addToBeatportCart(
  accountId: string,
  matches: StoreMatch[],
  onProgress?: (p: StoreCartProgress) => void
): Promise<StoreCartResult> {
  // Direct-API path using the Bearer token extracted from the user's
  // persisted Beatport session. No BrowserWindow, no Playwright, no DOM
  // scraping. Requires the user to have completed a real login in the
  // `persist:beatport` partition at least once so `/api/auth/session`
  // returns a token carrying their identity.
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

  const baseHeaders: Record<string, string> = {
    'User-Agent': USER_AGENT,
    'Accept': 'application/json',
    'Authorization': `Bearer ${token}`,
    'Origin': 'https://www.beatport.com',
    'Referer': 'https://www.beatport.com/',
  };

  // Resolve cart id.
  onProgress?.({
    current: 0, total: matches.length, currentTrack: '',
    phase: 'adding', message: 'Finding your Beatport cart…'
  });
  let cartId: string | null = null;
  let cartDiag = '';
  try {
    const res = await fetch('https://api.beatport.com/v4/my/carts/', { headers: baseHeaders });
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

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    onProgress?.({
      current: i + 1, total: matches.length,
      currentTrack: `${match.artist} - ${match.title}`,
      phase: 'adding', message: `Adding: ${match.title}`
    });

    let ok = false;
    let lastErr = '';
    let alreadyOwned = false;
    for (const a of attempts) {
      try {
        const res = await fetch(`https://api.beatport.com/v4/my/carts/${cartId}/items/`, {
          method: 'POST',
          headers: { ...baseHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            item_id: Number(match.trackId),
            item_type_id: a.item_type_id,
            audio_format_id: a.audio_format_id,
            purchase_type_id: 1,
            source_type_id: 6,
          }),
        });
        if (res.ok) {
          ok = true;
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
          added.push(match); // Treat as "in cart" — the end state matches.
          break;
        }
        if (res.status === 400 && /AlreadyPurchased/.test(text)) {
          alreadyOwned = true;
          break;
        }
        lastErr = `${res.status} (type=${a.item_type_id}/fmt=${a.audio_format_id}): ${text.slice(0, 140)}`;
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

export function matchesOwnedTrack(
  track: StoreTrackInput,
  owned: OwnedTrack[]
): OwnedTrack | null {
  const trackArtist = normalizeForComparison(track.artist);
  const trackTitle = normalizeForComparison(track.title);

  for (const o of owned) {
    const oArtist = normalizeForComparison(o.artist);
    const oTitle = normalizeForComparison(o.title);

    const titleScore = Math.max(
      fuzzball.ratio(trackTitle, oTitle),
      fuzzball.token_set_ratio(trackTitle, oTitle)
    ) / 100;

    const artistScore = Math.max(
      fuzzball.ratio(trackArtist, oArtist),
      fuzzball.token_set_ratio(trackArtist, oArtist)
    ) / 100;

    const combined = titleScore * 0.6 + artistScore * 0.4;
    if (combined >= 0.80) return o;
  }
  return null;
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
  destDir: string;
};

async function downloadFile(partition: string, url: string, destPath: string): Promise<void> {
  const res = await fetchWithSession(partition, url, {
    headers: { 'Accept': '*/*' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await import('fs/promises').then(fsp => fsp.writeFile(destPath, buffer));
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim();
}

/**
 * Ensure a downloaded file is AIFF. If it's not already AIFF, convert it and delete the original.
 * Returns the final AIFF path.
 */
async function ensureAiff(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.aiff' || ext === '.aif') return filePath;

  log.info(`Converting ${path.basename(filePath)} to AIFF...`);
  const result = await convertToAiff(filePath);
  if (!result.success || !result.outputPath) {
    throw new Error(`AIFF conversion failed: ${result.errorMessage || 'Unknown error'}`);
  }
  await deleteOriginalAfterConversion(filePath, result.outputPath);
  return result.outputPath;
}

/**
 * Download a track from a URL, then convert to AIFF if needed.
 * Returns the final AIFF file path.
 */
async function downloadAndConvertTrack(
  partition: string,
  url: string,
  destDir: string,
  artist: string,
  title: string,
  sourceExt: string,
  onProgress?: (p: DownloadProgress) => void,
  progressIndex?: { current: number; total: number }
): Promise<string> {
  const label = `${artist} - ${title}`;

  // Download the raw file
  const rawFileName = sanitizeFilename(`${artist} - ${title}.${sourceExt}`);
  const rawPath = path.join(destDir, rawFileName);
  await downloadFile(partition, url, rawPath);

  // Convert to AIFF if needed
  if (onProgress && progressIndex) {
    onProgress({ ...progressIndex, currentTrack: label, phase: 'converting', message: `Converting to AIFF: ${label}` });
  }
  const finalPath = await ensureAiff(rawPath);
  return finalPath;
}

export async function downloadQobuzPurchases(
  defaultAccountId: string,
  tracks: StoreMatch[],
  destDir: string,
  onProgress?: (p: DownloadProgress) => void,
  concurrency: number = 1
): Promise<DownloadResult> {
  // Ensure each unique account has sniffed creds. Tracks can come from different accounts
  // (an OwnedTrack retains its sourceAccountId through buildStoreMatch).
  const neededAccounts = new Set<string>([defaultAccountId]);
  for (const t of tracks) {
    const aid = (t as StoreMatch & { sourceAccountId?: string }).sourceAccountId;
    if (aid) neededAccounts.add(aid);
  }
  for (const aid of neededAccounts) {
    if (!qobuzCreds.has(aid)) {
      const creds = await sniffQobuzCredentials(aid);
      if (!creds) {
        log.warn(`Qobuz[${aid}]: could not sniff credentials for download`);
      }
    }
  }

  const downloaded: string[] = [];
  const failed: Array<{ trackId: string; artist: string; title: string; error: string }> = [];
  const fsp = await import('fs/promises');
  await fsp.mkdir(destDir, { recursive: true });

  let completed = 0;
  async function handleTrack(track: StoreMatch): Promise<void> {
    const label = `${track.artist} - ${track.title}`;
    const trackAccountId = (track as StoreMatch & { sourceAccountId?: string }).sourceAccountId || defaultAccountId;
    completed++;
    const progress = { current: completed, total: tracks.length };

    if (track.trackId && isTrackDownloaded('qobuz', track.trackId)) {
      // Reuse the prior download iff the file still exists. Otherwise forget
      // the stale record and fall through to a fresh download — previously
      // this silently "skipped" and surfaced as "unknown failure" in restore
      // reports because the downstream caller never saw it in downloaded[] or
      // failed[].
      const priorPath = getDownloadedTrackPath('qobuz', track.trackId);
      if (priorPath && fsSync.existsSync(priorPath)) {
        log.info(`Already downloaded: ${label} (${priorPath})`);
        downloaded.push(priorPath);
        onProgress?.({ ...progress, currentTrack: label, phase: 'downloading', message: `Already downloaded: ${label}` });
        return;
      }
      log.warn(`DB says downloaded but file is gone (${priorPath ?? 'no path'}) — re-downloading: ${label}`);
      forgetDownloadedTrack('qobuz', track.trackId);
    }
    onProgress?.({ ...progress, currentTrack: label, phase: 'downloading', message: `Downloading: ${label}` });

    try {
      if (!track.trackId) {
        failed.push({ trackId: track.trackId ?? '', artist: track.artist, title: track.title, error: 'No track ID' });
        return;
      }
      if (!qobuzCreds.has(trackAccountId)) {
        failed.push({ trackId: track.trackId ?? '', artist: track.artist, title: track.title, error: `No Qobuz credentials for account ${trackAccountId}` });
        return;
      }

      // Request the highest-quality format (27 = hi-res FLAC, fallback 7 = 24-bit FLAC, 6 = 16-bit FLAC)
      let dlUrl: string | null = null;
      let sourceExt = 'flac';
      for (const fmt of [27, 7, 6]) {
        const res = await qobuzApi<{ url?: string; mime_type?: string; sample?: boolean }>(
          trackAccountId, 'track/getFileUrl', { format_id: fmt, track_id: track.trackId, intent: 'import' }, { sign: true }
        );
        if (res.ok && res.data?.url && !res.data.sample) {
          dlUrl = res.data.url;
          if (res.data.mime_type?.includes('mpeg')) sourceExt = 'mp3';
          break;
        }
      }

      if (!dlUrl) {
        failed.push({ trackId: track.trackId ?? '', artist: track.artist, title: track.title, error: 'No download URL from track/getFileUrl' });
        return;
      }

      const finalPath = await downloadAndConvertTrack(
        qobuzPartition(trackAccountId), dlUrl, destDir,
        track.artist, track.title, sourceExt,
        onProgress, progress
      );
      downloaded.push(finalPath);
      recordDownload('qobuz', track.trackId, track.artist, track.title, finalPath);
    } catch (err) {
      log.error('Qobuz download failed for', label, err);
      failed.push({ trackId: track.trackId ?? '', artist: track.artist, title: track.title, error: err instanceof Error ? err.message : 'Download failed' });
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

  onProgress?.({ current: tracks.length, total: tracks.length, currentTrack: '', phase: 'complete', message: `Done: ${downloaded.length} downloaded, ${failed.length} failed` });
  return { downloaded, failed, destDir };
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
  const fsp = await import('fs/promises');
  await fsp.mkdir(destDir, { recursive: true });

  let completed = 0;
  async function handleTrack(track: StoreMatch, idx: number): Promise<void> {
    const label = `${track.artist} - ${track.title}`;
    const trackAccountId = (track as StoreMatch & { sourceAccountId?: string }).sourceAccountId || defaultAccountId;
    completed++;
    const progress = { current: completed, total: tracks.length };

    // Reuse the prior download iff the file still exists; otherwise forget
    // the stale record and re-download. (Mirror of the Qobuz fix: previously a
    // skipped-but-missing file surfaced as "unknown failure" in restore.)
    if (track.trackId && isTrackDownloaded('beatport', track.trackId)) {
      const priorPath = getDownloadedTrackPath('beatport', track.trackId);
      if (priorPath && fsSync.existsSync(priorPath)) {
        log.info(`Already downloaded: ${label} (${priorPath})`);
        downloaded.push(priorPath);
        onProgress?.({ ...progress, currentTrack: label, phase: 'downloading', message: `Already downloaded: ${label}` });
        return;
      }
      log.warn(`DB says downloaded but file is gone (${priorPath ?? 'no path'}) — re-downloading: ${label}`);
      forgetDownloadedTrack('beatport', track.trackId);
    }

    onProgress?.({ ...progress, currentTrack: label, phase: 'downloading', message: `Downloading: ${label}` });

    try {
      if (!track.trackId) {
        failed.push({ trackId: track.trackId ?? '', artist: track.artist, title: track.title, error: 'No track ID' });
        return;
      }

      let dlUrl: string | null = null;
      const token = getBeatportAccessToken(trackAccountId);
      const oidd = (track as StoreMatch & { orderItemDownloadId?: string }).orderItemDownloadId;

      // Primary: the real purchase-download endpoint Beatport's UI uses
      if (token && oidd) {
        const res = await fetch(
          `https://api.beatport.com/v4/catalog/tracks/purchase-download/?order_item_download_id=${encodeURIComponent(oidd)}`,
          {
            headers: {
              'User-Agent': USER_AGENT,
              'Accept': 'application/json, text/plain, */*',
              'Authorization': `Bearer ${token}`,
              'Origin': 'https://www.beatport.com',
            },
          }
        );
        if (res.ok) {
          const data = await res.json() as { download_url?: string; url?: string; signed_url?: string };
          dlUrl = data.download_url || data.url || data.signed_url || null;
        } else {
          log.warn(`Beatport purchase-download ${oidd}: HTTP ${res.status} — ${(await res.text()).slice(0, 120)}`);
        }
      } else if (!oidd) {
        log.warn(`Beatport: no orderItemDownloadId for track ${track.trackId}, skipping`);
      }

      if (!dlUrl) {
        failed.push({ trackId: track.trackId ?? '', artist: track.artist, title: track.title, error: 'No download URL found' });
        return;
      }

      // Beatport serves AIFF directly when requested — detect format from URL or default to aiff
      const sourceExt = dlUrl.match(/\.(wav|aiff|aif|mp3|flac)$/i)?.[1] || 'aiff';
      const finalPath = await downloadAndConvertTrack(
        beatportPartition(trackAccountId), dlUrl, destDir,
        track.artist, track.title, sourceExt,
        onProgress, progress
      );
      downloaded.push(finalPath);
      recordDownload('beatport', track.trackId, track.artist, track.title, finalPath);
    } catch (err) {
      log.error('Beatport download failed for', label, err);
      failed.push({ trackId: track.trackId ?? '', artist: track.artist, title: track.title, error: err instanceof Error ? err.message : 'Download failed' });
    }
  }

  // Worker pool
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < tracks.length) {
      const myIdx = next++;
      await handleTrack(tracks[myIdx], myIdx);
      if (next < tracks.length) await sleep(300);
    }
  });
  await Promise.allSettled(workers);

  onProgress?.({ current: tracks.length, total: tracks.length, currentTrack: '', phase: 'complete', message: `Done: ${downloaded.length} downloaded, ${failed.length} failed` });
  return { downloaded, failed, destDir };
}

// ========== Helpers ==========

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type BeatportTrackData = {
  track_id: number;
  track_name: string;
  mix_name?: string;
  artists?: Array<{ artist_name: string }>;
  release?: { release_name: string };
  label?: { label_name: string };
  price?: { display?: string; value?: number };
};

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

export type QobuzProbeResult = {
  url: string;
  method: 'html' | 'api';
  status: number;
  ok: boolean;
  bodySnippet: string;
  bodyLength: number;
  hasListItems?: boolean;
  jsonTopLevelKeys?: string[];
};

/**
 * Diagnostic: probe Qobuz purchase-history endpoints (HTML scrape + JSON API).
 */
export async function probeQobuzPurchases(accountId: string): Promise<QobuzProbeResult[]> {
  const partition = qobuzPartition(accountId);
  // Try to extract app_id from the logged-in homepage for proper API access
  let appId: string | null = null;
  let userAuthToken: string | null = null;
  try {
    const homeRes = await fetchWithSession(partition, 'https://play.qobuz.com/login', {
      headers: { 'Accept': 'text/html' },
    });
    const homeHtml = await homeRes.text();
    // Common patterns seen in Qobuz app bundles
    const appIdMatch = homeHtml.match(/app_id["':=\s]+([0-9]{6,})/) || homeHtml.match(/"?appId"?\s*[:=]\s*["']?([0-9]{6,})/);
    if (appIdMatch) appId = appIdMatch[1];
    // Try /resources/<hash>/bundle.js
    const bundleMatch = homeHtml.match(/\/resources\/[^\/]+\/bundle\.([a-f0-9]+)\.js/);
    if (bundleMatch) {
      const bundleUrl = 'https://play.qobuz.com' + (homeHtml.match(/\/resources\/[^"']+bundle\.[a-f0-9]+\.js/) || [''])[0];
      const bRes = await fetchWithSession(partition, bundleUrl);
      const bJs = await bRes.text();
      const appIdB = bJs.match(/APP_ID:"([0-9]+)"/) || bJs.match(/app_id:"([0-9]+)"/);
      if (appIdB) appId = appIdB[1];
    }
  } catch { /* ignore */ }

  // Try to get user auth token from the authenticated session (Qobuz stores it in a cookie or localStorage)
  try {
    const ses = session.fromPartition(partition);
    const cookies = await ses.cookies.get({ url: 'https://www.qobuz.com' });
    const authCookie = cookies.find(c => c.name.toLowerCase().includes('token') || c.name === 'userCookie');
    if (authCookie) userAuthToken = authCookie.value;
  } catch { /* ignore */ }

  const apiHeaders: Record<string, string> = {
    'Accept': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (appId) apiHeaders['X-App-Id'] = appId;
  if (userAuthToken) apiHeaders['X-User-Auth-Token'] = userAuthToken;

  const endpoints: Array<{ url: string; method: 'html' | 'api'; extraHeaders?: Record<string, string> }> = [
    // HTML pages under various localized paths
    { url: 'https://www.qobuz.com/us-en/account/purchases/tracks', method: 'html' },
    { url: 'https://www.qobuz.com/us-en/account/purchases', method: 'html' },
    { url: 'https://www.qobuz.com/us-en/account/downloads', method: 'html' },
    { url: 'https://www.qobuz.com/us-en/library/purchases', method: 'html' },
    { url: 'https://www.qobuz.com/us-en/library', method: 'html' },
    { url: 'https://play.qobuz.com/user/purchases', method: 'html' },
    // JSON API with app_id/token
    { url: `https://www.qobuz.com/api.json/0.2/purchase/getUserPurchases?limit=10&offset=0${appId ? '&app_id=' + appId : ''}`, method: 'api', extraHeaders: apiHeaders },
    { url: `https://www.qobuz.com/api.json/0.2/user/login?app_id=${appId || ''}`, method: 'api', extraHeaders: apiHeaders },
  ];

  const results: QobuzProbeResult[] = [];
  // Prepend a pseudo-result with the discovered credentials so we can see them
  results.push({
    url: `__discovery__ app_id=${appId || '(none)'} token=${userAuthToken ? userAuthToken.slice(0, 20) + '...' : '(none)'}`,
    method: 'html',
    status: 0,
    ok: false,
    bodyLength: 0,
    bodySnippet: '',
  });
  for (const ep of endpoints) {
    try {
      const res = await fetchWithSession(partition, ep.url, {
        headers: ep.method === 'api'
          ? (ep.extraHeaders || { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' })
          : { 'Accept': 'text/html' },
      });
      const text = await res.text();
      const probe: QobuzProbeResult = {
        url: ep.url,
        method: ep.method,
        status: res.status,
        ok: res.ok,
        bodyLength: text.length,
        bodySnippet: text.slice(0, 400),
      };
      if (ep.method === 'html' && res.ok) {
        probe.hasListItems = /ListItem|track-item|purchase-item|my-purchases/i.test(text);
      }
      if (ep.method === 'api' && res.ok) {
        try { probe.jsonTopLevelKeys = Object.keys(JSON.parse(text) || {}); } catch {}
      }
      results.push(probe);
    } catch (err) {
      results.push({
        url: ep.url,
        method: ep.method,
        status: -1,
        ok: false,
        bodyLength: 0,
        bodySnippet: err instanceof Error ? err.message : String(err),
      });
    }
    await sleep(400);
  }
  return results;
}

// Cached Qobuz API credentials (app_id + user_auth_token) sniffed from the SPA,
// keyed by account id.
const qobuzCreds = new Map<string, { appId: string; userAuthToken: string }>();

export function getQobuzCredentials(accountId: string): { appId: string | null; userAuthToken: string | null } {
  const entry = qobuzCreds.get(accountId);
  return { appId: entry?.appId ?? null, userAuthToken: entry?.userAuthToken ?? null };
}

export function setQobuzCredentials(accountId: string, appId: string, userAuthToken: string): void {
  qobuzCreds.set(accountId, { appId, userAuthToken });
  log.info(`Qobuz[${accountId}]: credentials cached`);
}

/**
 * Sniff Qobuz `X-App-Id` / `X-User-Auth-Token` by loading `play.qobuz.com` in
 * a BrowserWindow and intercepting the SPA's own API calls.
 *
 * The window starts hidden — if the account is already logged in on
 * `play.qobuz.com` (cookies shared from the main sign-in) the SPA will issue
 * authenticated API calls within seconds and we'll grab the headers silently.
 *
 * If no creds land in the short fast-path window, we show the BrowserWindow
 * so the user can sign into `play.qobuz.com` interactively. We wait up to
 * five minutes, then give up. Keeping the window *visible* during the slow
 * path also mitigates the renderer crashes we reproduced when the SPA loaded
 * cold in a hidden window during restore.
 */
export async function sniffQobuzCredentials(accountId: string, displayName?: string): Promise<{ appId: string; userAuthToken: string } | null> {
  // In-process Electron BrowserWindow sniff.
  //
  // We earlier tried an out-of-process Playwright Chromium worker to avoid a
  // renderer-crash we attributed to play.qobuz.com loading. That attribution
  // was wrong — the crashes were from an unrelated background process killing
  // our Electron. The real new blocker for the out-of-process path is
  // Cloudflare returning 403 on the www.qobuz.com OAuth endpoint when the
  // request comes from Playwright's bundled Chromium (detected as automation).
  // An Electron BrowserWindow is regular Chromium, which Cloudflare treats the
  // same as any browser — so the OAuth flow completes and we can intercept
  // the authenticated API headers.
  //
  // Strategy: show the window from the start. If the play.qobuz.com session
  // is already valid, the SPA fires authenticated calls within seconds and
  // we close immediately. Otherwise the user signs in directly in the window.
  // Qobuz's SPA has a hard 1024px minimum viewport — below that it shows a
  // "please use a bigger screen" message instead of the login form. Must be
  // wider than 1024 or the sniff will time out on a useless page.
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    title: displayName
      ? `Sign in to play.qobuz.com — ${displayName}`
      : `Sign in to play.qobuz.com — account ${accountId.slice(0, 8)}`,
    alwaysOnTop: true,
    webPreferences: { partition: qobuzPartition(accountId), nodeIntegration: false, contextIsolation: true },
  });
  try { win.moveTop(); win.focus(); } catch { /* ignore */ }
  setTimeout(() => { try { if (!win.isDestroyed()) win.setAlwaysOnTop(false); } catch { /* ignore */ } }, 3000);

  const REAL_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  win.webContents.setUserAgent(REAL_UA);

  // OAuth pop-ups (rare on Qobuz but possible) should inherit the same partition.
  const partitionName = qobuzPartition(accountId);
  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      webPreferences: { partition: partitionName, nodeIntegration: false, contextIsolation: true },
    },
  }));

  let foundAppId: string | null = null;
  let foundToken: string | null = null;
  let closedByUser = false;

  const listener = (details: Electron.OnBeforeSendHeadersListenerDetails, cb: (r: Electron.BeforeSendResponse) => void) => {
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
  };
  win.webContents.session.webRequest.onBeforeSendHeaders(listener);
  win.on('closed', () => { closedByUser = true; });

  // Surface navigation + page state so we can diagnose from logs exactly what
  // the embedded browser is doing (especially useful when the user can't see
  // the window or when play.qobuz.com redirects through OAuth).
  win.webContents.on('did-navigate', (_e, url) => {
    log.info(`Qobuz[${accountId}] sniff nav: ${url}`);
  });
  win.webContents.on('did-navigate-in-page', (_e, url) => {
    log.info(`Qobuz[${accountId}] sniff nav-in-page: ${url}`);
  });
  win.webContents.on('did-fail-load', (_e, errorCode, errorDesc, validatedURL) => {
    log.warn(`Qobuz[${accountId}] sniff fail-load code=${errorCode} desc=${errorDesc} url=${validatedURL}`);
  });

  const INTERACTIVE_MS = 5 * 60 * 1000;
  try {
    await win.loadURL('https://play.qobuz.com/');
    log.info(`Qobuz[${accountId}] sniff: initial URL ${win.webContents.getURL()}`);
    const deadline = Date.now() + INTERACTIVE_MS;
    let lastReportAt = 0;
    while (Date.now() < deadline && !foundAppId && !closedByUser) {
      await sleep(500);
      if (Date.now() - lastReportAt > 10_000) {
        lastReportAt = Date.now();
        try {
          const bounds = win.getBounds();
          const visible = win.isVisible();
          const minimized = win.isMinimized();
          const focused = win.isFocused();
          const snapshot = await win.webContents.executeJavaScript(`
            (() => ({
              url: window.location.href,
              title: document.title.slice(0, 80),
              hasBody: !!document.body,
              bodyLen: document.body ? document.body.innerText.length : 0,
              bodyPreview: document.body ? document.body.innerText.slice(0, 160) : '',
              hasUserAuthToken: !!window.localStorage && !!window.localStorage.getItem('user_auth_token'),
              hasZUser: !!window.localStorage && !!window.localStorage.getItem('z:user'),
              forms: document.forms.length,
              buttons: document.querySelectorAll('button').length,
              links: document.querySelectorAll('a[href*="signin"], a[href*="login"]').length,
            }))()
          `, true);
          log.info(`Qobuz[${accountId}] sniff state: visible=${visible} minimized=${minimized} focused=${focused} bounds=${JSON.stringify(bounds)} page=${JSON.stringify(snapshot)}`);
          // (Removed debug screenshot of the logged-in session — it wrote a PNG of
          // an authenticated Qobuz page to world-readable /tmp.)
        } catch (err) {
          log.warn(`Qobuz[${accountId}] sniff state probe failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } finally {
    try { if (!win.isDestroyed()) win.close(); } catch { /* already destroyed */ }
  }

  if (foundAppId && foundToken) {
    qobuzCreds.set(accountId, { appId: foundAppId, userAuthToken: foundToken });
    log.info(`Qobuz[${accountId}]: sniffed credentials (appId=${foundAppId})`);
    return { appId: foundAppId, userAuthToken: foundToken };
  }
  return null;
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
    const crypto = await import('crypto');
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
  });
  const text = await res.text();
  let data: T | null = null;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, data, text };
}

/**
 * Probe Qobuz track download endpoint with various strategies.
 */
export async function probeQobuzDownload(accountId: string, trackId: string): Promise<Array<{ url: string; method: string; status: number; ok: boolean; body: string; parsed?: unknown }>> {
  if (!qobuzCreds.has(accountId)) {
    const creds = await sniffQobuzCredentials(accountId);
    if (!creds) throw new Error('No Qobuz credentials');
  }

  const results: Array<{ url: string; method: string; status: number; ok: boolean; body: string; parsed?: unknown }> = [];

  // Try different format_ids and intents WITH signing
  const signedTry = async (path: string, params: Record<string, string | number>) => {
    try {
      const res = await qobuzApi(accountId, path, params, { sign: true });
      const r: { url: string; method: string; status: number; ok: boolean; body: string; parsed?: unknown } = {
        url: `${path} signed`,
        method: 'GET',
        status: res.status,
        ok: res.ok,
        body: res.text.slice(0, 600),
      };
      if (res.ok) r.parsed = res.data;
      results.push(r);
    } catch (e) {
      results.push({ url: path, method: 'GET', status: -1, ok: false, body: e instanceof Error ? e.message : String(e) });
    }
  };
  await signedTry('track/getFileUrl', { format_id: 27, track_id: trackId, intent: 'import' });
  await signedTry('track/getFileUrl', { format_id: 7, track_id: trackId, intent: 'import' });
  await signedTry('track/getFileUrl', { format_id: 6, track_id: trackId, intent: 'import' });
  await signedTry('track/getFileUrl', { format_id: 5, track_id: trackId, intent: 'import' });
  await signedTry('track/getFileUrl', { format_id: 27, track_id: trackId, intent: 'stream' });
  return results;
}

export async function fetchQobuzPurchases(accountId: string, displayName?: string): Promise<OwnedTrack[]> {
  if (!qobuzCreds.has(accountId)) {
    log.info(`Qobuz[${accountId}]: no cached credentials; sniffing from session`);
    const creds = await sniffQobuzCredentials(accountId, displayName);
    if (!creds) {
      log.warn(`Qobuz[${accountId}]: could not sniff credentials; user must be logged in via play.qobuz.com`);
      return [];
    }
  }

  const owned: OwnedTrack[] = [];
  const seen = new Set<string>();

  // Fetch purchased tracks (paginated)
  const limit = 500;
  let offset = 0;
  let total: number | null = null;
  while (true) {
    const res = await qobuzApi<{
      tracks?: { total?: number; items?: Array<{ id?: number; title?: string; performer?: { name?: string }; album?: { artist?: { name?: string } } }> };
      albums?: { total?: number; items?: Array<{ id?: string; title?: string; artist?: { name?: string }; tracks?: { items?: Array<{ id?: number; title?: string; performer?: { name?: string } }> } }> };
    }>(accountId, 'purchase/getUserPurchases', { limit, offset });
    if (!res.ok || !res.data) {
      log.error(`Qobuz[${accountId}] purchase/getUserPurchases @offset=${offset}: HTTP ${res.status} — ${res.text.slice(0, 150)}`);
      break;
    }
    const trackItems = res.data.tracks?.items || [];
    const albumItems = res.data.albums?.items || [];
    if (offset === 0) {
      const trackTotal = res.data.tracks?.total ?? trackItems.length;
      const albumTotal = res.data.albums?.total ?? albumItems.length;
      total = Math.max(trackTotal, albumTotal);
      log.info(`Qobuz[${accountId}]: fetching ${trackTotal} purchased tracks + ${albumTotal} albums`);
    }
    for (const t of trackItems) {
      if (!t.id || !t.title) continue;
      const trackId = String(t.id);
      if (seen.has(trackId)) continue;
      seen.add(trackId);
      const artist = t.performer?.name || t.album?.artist?.name || '';
      owned.push({ source: 'qobuz', trackId, artist, title: t.title, sourceAccountId: accountId });
    }
    for (const album of albumItems) {
      const albumArtist = album.artist?.name || '';
      if (!album.id) continue;
      const ar = await qobuzApi<{ tracks?: { items?: Array<{ id?: number; title?: string; performer?: { name?: string } }> } }>(accountId, 'album/get', { album_id: album.id, extra: 'tracks' });
      const albumTracks = ar.data?.tracks?.items || [];
      for (const t of albumTracks) {
        if (!t.id || !t.title) continue;
        const trackId = String(t.id);
        if (seen.has(trackId)) continue;
        seen.add(trackId);
        const artist = t.performer?.name || albumArtist;
        owned.push({ source: 'qobuz', trackId, artist, title: t.title, sourceAccountId: accountId });
      }
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
 * First occurrence wins (so order accounts by preferred source account).
 */
export async function fetchAllQobuzPurchases(accounts: StoreAccount[]): Promise<OwnedTrack[]> {
  const merged: OwnedTrack[] = [];
  const seen = new Set<string>();
  for (const account of accounts) {
    try {
      await loginQobuz(account.id);
      // Prefer label, fall back to email, so the sniff window title tells the
      // user which Qobuz account to sign into when multiple prompts pop up.
      const displayName = account.label || account.email || undefined;
      const tracks = await fetchQobuzPurchases(account.id, displayName);
      for (const t of tracks) {
        if (seen.has(t.trackId)) continue;
        seen.add(t.trackId);
        merged.push(t);
      }
    } catch (err) {
      log.error(`Qobuz[${account.id}] fetch failed:`, err);
    }
  }
  log.info(`Qobuz: aggregated ${merged.length} unique tracks across ${accounts.length} account(s)`);
  return merged;
}

export type BeatportProbeResult = {
  url: string;
  auth: 'bearer' | 'cookie';
  status: number;
  ok: boolean;
  bodySnippet: string;
  topLevelKeys?: string[];
  count?: number;
  firstResultKeys?: string[];
  firstResultSample?: unknown;
};

/**
 * Diagnostic: try multiple endpoint + auth combinations for Beatport purchase history
 * and return the raw response shape for each, so we can identify the right one.
 */
export async function probeBeatportDownloadLink(accountId: string, trackId: string, orderItemDownloadId?: string): Promise<BeatportProbeResult[]> {
  const token = getBeatportAccessToken(accountId);
  const ses = session.fromPartition(beatportPartition(accountId));
  const cookies = await ses.cookies.get({ url: 'https://www.beatport.com' });
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  const endpoints: Array<{ url: string; auth: 'bearer' | 'cookie'; method?: 'GET' | 'POST' }> = [];
  if (orderItemDownloadId) {
    // POST variants (common for signed-URL generators)
    endpoints.push(
      { url: `https://api.beatport.com/v4/my/downloads/${orderItemDownloadId}/?audio_format_id=3`, auth: 'bearer', method: 'POST' },
      { url: `https://api.beatport.com/v4/my/downloads/${orderItemDownloadId}/`, auth: 'bearer', method: 'POST' },
      { url: `https://api.beatport.com/v4/my/downloads/order-items/${orderItemDownloadId}/?audio_format_id=3`, auth: 'bearer', method: 'POST' },
      { url: `https://api.beatport.com/v4/my/downloads/order-items/${orderItemDownloadId}/download/?audio_format_id=3`, auth: 'bearer', method: 'POST' },
      // GET with alternate paths
      { url: `https://api.beatport.com/v4/my/downloads/${orderItemDownloadId}/?audio_format_id=3`, auth: 'bearer', method: 'GET' },
      { url: `https://api.beatport.com/v4/my/downloads/?order_item_download_id=${orderItemDownloadId}&audio_format_id=3`, auth: 'bearer', method: 'GET' },
      { url: `https://api.beatport.com/v4/my/downloads/${orderItemDownloadId}/download/?audio_format_id=3`, auth: 'bearer', method: 'GET' },
    );
  }
  const results: BeatportProbeResult[] = [];
  for (const ep of endpoints) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      };
      if (ep.auth === 'bearer' && token) headers['Authorization'] = `Bearer ${token}`;
      if (ep.auth === 'cookie') headers['Cookie'] = cookieHeader;
      const res = await fetch(ep.url, { headers, method: ep.method || 'GET' });
      const text = await res.text();
      const probe: BeatportProbeResult = {
        url: ep.url,
        auth: ep.auth,
        status: res.status,
        ok: res.ok,
        bodySnippet: text.slice(0, 600),
      };
      if (res.ok) {
        try {
          const data = JSON.parse(text);
          probe.topLevelKeys = Object.keys(data || {});
          probe.firstResultSample = data;
        } catch {}
      }
      results.push(probe);
    } catch (err) {
      results.push({
        url: ep.url,
        auth: ep.auth,
        status: -1,
        ok: false,
        bodySnippet: err instanceof Error ? err.message : String(err),
      });
    }
    await sleep(300);
  }
  return results;
}

export async function probeBeatportPurchases(accountId: string): Promise<BeatportProbeResult[]> {
  const token = getBeatportAccessToken(accountId);
  const ses = session.fromPartition(beatportPartition(accountId));
  const cookies = await ses.cookies.get({ url: 'https://www.beatport.com' });
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  const endpoints: Array<{ url: string; auth: 'bearer' | 'cookie' }> = [
    // api.beatport.com family (JWT/Bearer)
    { url: 'https://api.beatport.com/v4/my/downloads/?per_page=10&page=1', auth: 'bearer' },
    { url: 'https://api.beatport.com/v4/my/orders/?per_page=10&page=1', auth: 'bearer' },
    { url: 'https://api.beatport.com/v4/my/purchases/?per_page=10&page=1', auth: 'bearer' },
    { url: 'https://api.beatport.com/v4/my/library/?per_page=10&page=1', auth: 'bearer' },
    // www.beatport.com/api family (cookie-based, same domain as session)
    { url: 'https://www.beatport.com/api/v4/my/downloads/?per_page=10&page=1', auth: 'cookie' },
    { url: 'https://www.beatport.com/api/v4/my/orders/?per_page=10&page=1', auth: 'cookie' },
    { url: 'https://www.beatport.com/api/v4/my/purchases/?per_page=10&page=1', auth: 'cookie' },
  ];

  const results: BeatportProbeResult[] = [];
  for (const ep of endpoints) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      };
      if (ep.auth === 'bearer' && token) headers['Authorization'] = `Bearer ${token}`;
      if (ep.auth === 'cookie') headers['Cookie'] = cookieHeader;

      const res = await fetch(ep.url, { headers });
      const text = await res.text();
      const probe: BeatportProbeResult = {
        url: ep.url,
        auth: ep.auth,
        status: res.status,
        ok: res.ok,
        bodySnippet: text.slice(0, 400),
      };

      if (res.ok) {
        try {
          const data = JSON.parse(text);
          probe.topLevelKeys = Object.keys(data || {});
          if (typeof data?.count === 'number') probe.count = data.count;
          const resultsArr = data?.results || data?.data || data?.items;
          if (Array.isArray(resultsArr) && resultsArr.length > 0) {
            probe.firstResultKeys = Object.keys(resultsArr[0] || {});
            probe.firstResultSample = resultsArr[0];
          }
        } catch { /* not JSON */ }
      }
      results.push(probe);
    } catch (err) {
      results.push({
        url: ep.url,
        auth: ep.auth,
        status: -1,
        ok: false,
        bodySnippet: err instanceof Error ? err.message : String(err),
      });
    }
    await sleep(200);
  }
  return results;
}

export async function fetchBeatportPurchases(accountId: string): Promise<OwnedTrack[]> {
  const token = getBeatportAccessToken(accountId);
  if (!token) {
    log.warn(`Beatport[${accountId}]: not logged in; cannot fetch purchases`);
    return [];
  }

  const owned: OwnedTrack[] = [];
  const seen = new Set<string>();
  const perPage = 100;
  let page = 1;
  let totalPages: number | null = null;

  while (true) {
    const url = `https://api.beatport.com/v4/my/downloads/?per_page=${perPage}&page=${page}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      log.error(`Beatport purchases page ${page}: HTTP ${res.status} — ${body.slice(0, 200)}`);
      break;
    }

    const rawText = await res.text();
    const data = JSON.parse(rawText) as {
      count?: number;
      next?: string | null;
      results?: Array<{
        id?: number;
        name?: string;
        mix_name?: string;
        artists?: Array<{ name?: string }>;
        release?: { name?: string };
        label?: { name?: string };
        order_item_download_id?: number;
      }>;
    };

    const results = data.results || [];
    if (page === 1) {
      const total = data.count ?? results.length;
      totalPages = Math.ceil(total / perPage);
      log.info(`Beatport: fetching ${total} purchases across ${totalPages} page(s)`);
      if (results.length > 0) {
        log.info(`Beatport DEBUG first result keys: ${Object.keys(results[0] || {}).join(',')}`);
      }
    }

    for (const t of results) {
      if (!t?.id || !t.name) { if (page === 1) log.warn(`Beatport skip: id=${t?.id} name=${t?.name}`); continue; }
      const trackId = String(t.id);
      if (seen.has(trackId)) continue;
      seen.add(trackId);
      const artist = (t.artists || []).map(a => a.name).filter(Boolean).join(', ');
      const titleWithMix = t.mix_name && t.mix_name !== 'Original Mix'
        ? `${t.name} (${t.mix_name})`
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
 * orderItemDownloadId — downloads must use that account's token.
 */
export async function fetchAllBeatportPurchases(accounts: StoreAccount[]): Promise<OwnedTrack[]> {
  const merged: OwnedTrack[] = [];
  const seen = new Set<string>();
  for (const account of accounts) {
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
    }
  }
  log.info(`Beatport: aggregated ${merged.length} unique tracks across ${accounts.length} account(s)`);
  return merged;
}
