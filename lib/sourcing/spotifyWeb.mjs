// Spotify through the signed-in web player: the account, not an API key.
//
// The sign-in lives in the active Track Lab profile's gate browser (the
// 'soundcloud' Chrome profile under its cache folder, the same one whose
// Spotify login the Spotify-connect download gates use), so one login covers
// both. Nothing stores a token: each read opens that profile, lets
// open.spotify.com load, and reads what the web player itself fetched.
//
// Why not the token against api.spotify.com: the web player's token answers
// 429 "API rate limit exceeded" on the public Web API (live 2026-11-05). The
// player's own GraphQL calls (api-partner.spotify.com/pathfinder) carry
// everything, so reads listen to those responses:
//   profileAttributes      data.me.profile { name, username, uri }
//   fetchPlaylist          data.playlistV2 { name, ownerV2, content { totalCount, items } }
//   fetchPlaylistContents  data.playlistV2.content { totalCount, items } (50 a page, as the list scrolls)
// A private playlist the account can see reads the same way, which neither the
// API key nor the embed page could do.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { launchSiteBrowser, profileRoot, profileHolder } from '../launchBrowser.mjs';
import { cacheDir } from '../profilePaths.mjs';
import { makeTrackKey } from './matching.mjs';

/** The gate browser profile this sign-in lives in. */
export const SPOTIFY_BROWSER_PROFILE = 'soundcloud';
const PATHFINDER_RE = /api-partner\.spotify\.com\/pathfinder/;

/** CANDYBAR_SPOTIFY_STATUS overrides the path (tests). Account name only, never a token. */
function statusFile() {
  return process.env.CANDYBAR_SPOTIFY_STATUS || path.join(cacheDir(), 'spotify-session.json');
}

export function recordSpotifyStatus(status, file = statusFile()) {
  const s = { signedIn: !!status.signedIn, name: status.name ?? null, username: status.username ?? null, checkedAt: new Date().toISOString(), ...(status.reason ? { reason: status.reason } : {}) };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, file);
  } catch { /* a convenience */ }
  return s;
}

/** Who the saved sign-in belonged to at the last check, or null when nothing has looked yet. */
export function readSpotifyStatus(file = statusFile()) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof s?.signedIn === 'boolean' ? s : null;
  } catch {
    return null;
  }
}

export function parseSpotifyPlaylistId(input) {
  const s = String(input || '').trim();
  return s.match(/playlist[/:]([A-Za-z0-9]{22})/)?.[1] || (/^[A-Za-z0-9]{22}$/.test(s) ? s : null);
}

/** The pathfinder operation a response answers. */
function operationOf(response) {
  try {
    const u = new URL(response.url());
    return u.searchParams.get('operationName') || JSON.parse(response.request().postData() || '{}').operationName || '';
  } catch {
    return '';
  }
}

export async function openSpotifyWeb({ headless = true } = {}) {
  const ctx = await launchSiteBrowser({ profile: SPOTIFY_BROWSER_PROFILE, headless, attach: false });
  const page = ctx.pages()[0] || (await ctx.newPage());
  return { ctx, page, close: async () => { try { await ctx.close(); } catch { /* gone */ } } };
}

/** One track row from a fetchPlaylist / fetchPlaylistContents item, or null
 *  (a podcast episode, a local file, an unavailable track). */
export function trackFromItem(item) {
  const d = item?.itemV2?.data ?? item?.item?.data;
  if (!d || (d.__typename && d.__typename !== 'Track') || !d.name) return null;
  const artists = (d.artists?.items || []).map(a => a?.profile?.name).filter(Boolean);
  const id = (d.uri || '').split(':').pop() || null;
  const ms = d.trackDuration?.totalMilliseconds ?? d.duration?.totalMilliseconds ?? null;
  return {
    uid: item.uid || d.uri,
    artist: artists.join(', '),
    artists,
    title: d.name,
    album: d.albumOfTrack?.name || '',
    durationMs: ms,
    duration: ms ? Math.round(ms / 1000) : null,
    image: d.albumOfTrack?.coverArt?.sources?.[0]?.url || null,
    spotifyUrl: id ? `https://open.spotify.com/track/${id}` : null,
    id,
  };
}

/** The account the web player is signed in as, from its own profile call. */
export async function readSpotifyAccount(page, { timeoutMs = 20000 } = {}) {
  let profile = null;
  const onResponse = async (r) => {
    if (!PATHFINDER_RE.test(r.url()) || operationOf(r) !== 'profileAttributes') return;
    try { profile = (await r.json())?.data?.me?.profile ?? profile; } catch { /* not JSON */ }
  };
  page.on('response', onResponse);
  try {
    await page.goto('https://open.spotify.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !profile) {
      if (await page.locator('[data-testid="login-button"]').first().isVisible().catch(() => false)) break;
      await page.waitForTimeout(500);
    }
    const widget = await page.locator('[data-testid="user-widget-link"]').first().getAttribute('aria-label').catch(() => null);
    const name = profile?.name || widget || null;
    const username = profile?.username || (profile?.uri || '').split(':').pop() || null;
    return { signedIn: !!(profile || widget), name, username };
  } finally {
    page.off('response', onResponse);
  }
}

/**
 * Every track of a playlist the signed-in account can see, public or private,
 * read from the web player's own responses while its track list is scrolled.
 * Returns { playlist: { name, owner, trackCount, fetchedCount, imageUrl, url }, tracks }.
 */
export async function fetchPlaylistViaWeb(page, input, { onProgress, timeoutMs = 180000 } = {}) {
  const id = parseSpotifyPlaylistId(input);
  if (!id) throw new Error(`Not a Spotify playlist link: ${input}`);
  const rows = new Map();
  let meta = null, total = null;
  const take = (items) => { for (const it of items || []) { const t = trackFromItem(it); if (t && !rows.has(t.uid)) rows.set(t.uid, t); } };
  const onResponse = async (r) => {
    if (!PATHFINDER_RE.test(r.url())) return;
    const op = operationOf(r);
    if (op !== 'fetchPlaylist' && op !== 'fetchPlaylistContents' && op !== 'fetchPlaylistMetadata') return;
    try {
      const pl = (await r.json())?.data?.playlistV2;
      if (!pl) return;
      if (pl.name && (pl.uri || '').endsWith(id)) meta = pl;
      if (pl.content) { total = pl.content.totalCount ?? total; take(pl.content.items); }
    } catch { /* not JSON */ }
  };
  page.on('response', onResponse);
  try {
    await page.goto(`https://open.spotify.com/playlist/${id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && total === null) {
      if (await page.locator('[data-testid="login-button"]').first().isVisible().catch(() => false) && !rows.size) break;
      await page.waitForTimeout(500);
    }
    if (total === null) throw new Error('Spotify didn\'t load that playlist (signed out, or the account can\'t see it)');
    // The list is virtual: bring its last row into view to load the next page.
    let still = 0, last = -1;
    while (Date.now() < deadline && rows.size < total && still < 8) {
      await page.locator('[data-testid="tracklist-row"]').last().scrollIntoViewIfNeeded().catch(() => {});
      await page.mouse.wheel(0, 4000).catch(() => {});
      await page.waitForTimeout(1200);
      onProgress?.(rows.size, total);
      if (rows.size === last) still++; else { still = 0; last = rows.size; }
    }
  } finally {
    page.off('response', onResponse);
  }
  const tracks = [...rows.values()].map(({ uid, ...t }) => ({ ...t, key: makeTrackKey(t.artist, t.title) }));
  return {
    playlist: {
      name: meta?.name || '',
      owner: meta?.ownerV2?.data?.name || '',
      imageUrl: meta?.images?.items?.[0]?.sources?.[0]?.url || null,
      trackCount: total ?? tracks.length,
      fetchedCount: tracks.length,
      url: `https://open.spotify.com/playlist/${id}`,
    },
    tracks,
  };
}

/** Check the saved sign-in, headless, and note who it is. */
export async function checkSpotifySignIn() {
  const holder = profileHolder(path.join(profileRoot(), SPOTIFY_BROWSER_PROFILE));
  if (holder) return readSpotifyStatus() ?? { signedIn: false, name: null, username: null, reason: 'the gate browser is open' };
  const web = await openSpotifyWeb({ headless: true });
  try {
    return recordSpotifyStatus(await readSpotifyAccount(web.page));
  } finally {
    await web.close();
  }
}

/** Read a playlist with the saved sign-in (headless). */
export async function readPlaylistSignedIn(input, onProgress) {
  const web = await openSpotifyWeb({ headless: true });
  try {
    return await fetchPlaylistViaWeb(web.page, input, { onProgress });
  } finally {
    await web.close();
  }
}

function chromeBinary() {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
    : process.platform === 'win32'
      ? [path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe')]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
  return candidates.find(p => fs.existsSync(p)) || null;
}

/**
 * Sign in: plain Google Chrome on the gate browser profile, at Spotify's login
 * page, with nothing automated attached (an automated window is refused by
 * Spotify's Facebook/Google logins, and once closed a login pop-up mid-run).
 * Waits for the person to close the window (up to `timeoutMs`), then checks.
 */
export async function signInToSpotifyWeb({ timeoutMs = 10 * 60_000, onOpened } = {}) {
  const dir = path.join(profileRoot(), SPOTIFY_BROWSER_PROFILE);
  const holder = profileHolder(dir);
  if (holder) throw new Error(`The gate browser is already open (Chrome pid ${holder}), probably a download run. Let it finish, then sign in.`);
  const bin = chromeBinary();
  if (!bin) throw new Error('Google Chrome isn\'t installed; Track Lab signs in to Spotify in Chrome.');
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(bin, [`--user-data-dir=${dir}`, '--use-mock-keychain', '--no-first-run', '--no-default-browser-check', '--new-window',
    'https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F'], { stdio: 'ignore' });
  onOpened?.();
  await new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } resolve(); }, timeoutMs);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
    child.on('error', () => { clearTimeout(timer); resolve(); });
  });
  // Chrome may take a moment to let go of the profile.
  for (let i = 0; i < 20 && profileHolder(dir); i++) await new Promise(r => setTimeout(r, 500));
  return checkSpotifySignIn();
}
