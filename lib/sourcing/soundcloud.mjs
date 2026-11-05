// SoundCloud likes as a sourcing input.
//
// Two ways to read a likes list:
//   - public   — /users/<id>/track_likes is open for a public profile, so a
//                permalink is enough and no browser is needed.
//   - browser  — the signed-in Chrome profile ('soundcloud'), reading the same
//                API the web app calls for itself, with its own OAuth header.
//                Required for anything account-shaped: the native download
//                endpoint answers 401 without it (verified 2026-09-23).
//
// api-v2 has NO original_format field (verified against the live track
// object), so whether a free download is lossless can only be judged from the
// file that actually arrives — see downloads.mjs. What the track object does
// carry is the free-download signal:
//   downloadable + has_downloads_left   -> SoundCloud's own download button
//   purchase_url + purchase_title       -> the "Free Download" link, which is
//                                          almost always a gate (Hypeddit &c)

import fs from 'fs';
import path from 'path';
import { launchSiteBrowser } from '../launchBrowser.mjs';
import { makeTrackKey } from './matching.mjs';
import { cacheDir } from '../profilePaths.mjs';

export const SC = 'https://soundcloud.com';
export const API = 'https://api-v2.soundcloud.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Accept: 'application/json' };
const PAGE_SIZE = 100;
const PAGE_PAUSE_MS = 250;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- public client_id ----------

let clientIdCache = null;

/** The web app's public client_id, scraped from its bundles. Rotates every
 *  few weeks; cached for the process. */
export async function getPublicClientId() {
  if (clientIdCache) return clientIdCache;
  const home = await (await fetch(`${SC}/`, { headers: { 'User-Agent': UA } })).text();
  const urls = [...home.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^\s"']+\.js/g)].map(m => m[0]);
  for (const u of urls.reverse()) {
    try {
      const js = await (await fetch(u, { headers: { 'User-Agent': UA } })).text();
      const m = js.match(/client_id:\s*"([a-zA-Z0-9]{20,})"/) || js.match(/client_id=([a-zA-Z0-9]{20,})/);
      if (m) { clientIdCache = m[1]; return clientIdCache; }
    } catch { /* try the next bundle */ }
  }
  throw new Error('Could not extract a SoundCloud client_id from soundcloud.com');
}

function withClientId(u, clientId) {
  const url = new URL(u);
  if (!url.searchParams.get('client_id')) url.searchParams.set('client_id', clientId);
  return url.toString();
}

// ---------- title parsing ----------
//
// SoundCloud titles carry the artist, the free-download marker and often a
// genre tag all in one string. The library scorer wants a clean artist/title
// pair, so strip what is decoration and split on the first dash.

const MARKER_WORDS = /\b(free\s*(download|dl)|download|dl|out\s*now|premiere|supported\s*by|exclusive|buy\s*now|click\s*buy|full\s*version|preview)\b/i;
const KEEP_WORDS = /\b(remix|edit|mix|bootleg|flip|rework|version|vip|dub|mashup|refix|extended|radio|instrumental|acapella|club)\b/i;
const GENRE_PREFIX = /^\s*[A-Za-z&' /]{2,32}\s*\|\s*/;
const PREMIERE_PREFIX = /^\s*(premiere|first\s*play|out\s*now)\s*[:|\-–—]\s*/i;
const DASHES = /\s+[-–—]\s+/;

/** Remove "*FREE DOWNLOAD*", "[FREE DL]", "(Out Now)" and similar tags. A
 *  bracketed segment survives when it names a version ("(X Remix)"), because
 *  that is part of what the track is. */
export function stripMarkers(title) {
  let t = (title || '');
  t = t.replace(/[\[\(\{]([^\]\)\}]*)[\]\)\}]/g, (whole, inner) =>
    MARKER_WORDS.test(inner) && !KEEP_WORDS.test(inner) ? ' ' : whole);
  t = t.replace(/\*+\s*[^*]*?(free\s*(download|dl)|download|out\s*now)[^*]*?\*+/gi, ' ');
  t = t.replace(/\b(free\s*(download|dl)|free\s*dl)\b[!.]*/gi, ' ');
  t = t.replace(/\s*[|]\s*$/, '');
  return t.replace(/\s{2,}/g, ' ').replace(/^[\s\-–—:|]+|[\s\-–—:|]+$/g, '').trim();
}

/** Split a SoundCloud title into { artist, title }.
 *  Precedence for the artist: the "Artist - Title" convention in the title,
 *  then publisher_metadata.artist (labels fill this in), then the uploader. */
export function parseSoundCloudTitle(rawTitle, { uploader = '', publisherArtist = '' } = {}) {
  let t = stripMarkers((rawTitle || '').replace(PREMIERE_PREFIX, ''));
  t = t.replace(GENRE_PREFIX, '');
  const parts = t.split(DASHES);
  if (parts.length >= 2) {
    const artist = parts[0].trim();
    const title = parts.slice(1).join(' - ').trim();
    if (artist && title) return { artist, title, source: 'title' };
  }
  const pub = (publisherArtist || '').trim();
  if (pub) return { artist: pub, title: t, source: 'publisher' };
  return { artist: (uploader || '').trim(), title: t, source: 'uploader' };
}

// ---------- free-download classification ----------

/** Hosts that gate a free file behind follow/like/email steps. Order matters
 *  only for reporting. Anything else is reported as an unknown host and left
 *  to the assisted (human) path. */
export const GATE_HOSTS = [
  'hypeddit.com', 'toneden.io', 'hitsdistrict.com', 'sicktaste.com', 'payhip.com',
  'fanlink.to', 'fanlink.tv', 'lnk.to', 'smarturl.it', 'ffm.to', 'linktr.ee',
  'bandcamp.com', 'dropbox.com', 'drive.google.com', 'mediafire.com', 'mega.nz',
  'wetransfer.com', 'gumroad.com', 'artist.link', 'thmatc.co', 'unlockyoursound.com',
  'gaterush.me', // seen in Ben's likes 2026-10-29 ("FREE DL"); no walker yet
  'droploud.com', 'sublair.com',
  // Influence Planner: ipln.io short links land on gate.influenceplanner.com.
  // Seen 2026-11-04 as "FREE DOWNLOAD - https://ipln.io/…" in a description,
  // with no buy link at all (Shizz Lo's Go Back flip).
  'ipln.io', 'influenceplanner.com',
  // Fan-gate platforms seen on "FREE DOWNLOAD" lines in a 514-upload sample
  // (2026-11-04); no walker of their own yet, so the generic one tries them.
  'pumpyoursound.com', 'valorizd.app',
];

/** Hosts that only ever gate a download: a link to one is free whatever its
 *  label says. The rest (store pickers, link pages, file hosts) also carry
 *  stream and buy links, so they need the label or the line to say free. */
const DEDICATED_GATE_RE = /^(hypeddit\.com|toneden\.io|hitsdistrict\.com|sicktaste\.com|unlockyoursound\.com|thmatc\.co|gaterush\.me|droploud\.com|sublair\.com|ipln\.io|influenceplanner\.com|pumpyoursound\.com|valorizd\.app)$/;
/** Gate hosts with a walker of their own in gates/index.mjs (kept in step by
 *  a test there). Between two links on a free line, one of these goes first. */
export const WALKED_GATE_HOSTS = ['hypeddit.com', 'bandcamp.com', 'droploud.com', 'sublair.com', 'ipln.io', 'influenceplanner.com'];

/** Hosts whose link is the file itself (or Bandcamp's name-your-price page):
 *  worth a try from anywhere in a description unless their line streams or sells. */
const FILE_HOST_RE = /^(drive\.google\.com|dropbox\.com|mediafire\.com|mega\.nz|wetransfer\.com|bandcamp\.com)$/;

/** Never the free file: socials, players and stores, linked in every bio. */
const NEVER_GATE_RE = /(^|\.)(soundcloud\.com|on\.soundcloud\.com|snd\.sc|instagram\.com|facebook\.com|fb\.me|twitter\.com|x\.com|tiktok\.com|youtube\.com|youtu\.be|spotify\.com|spotify\.link|apple\.com|music\.apple\.com|deezer\.com|tidal\.com|beatport\.com|traxsource\.com|junodownload\.com|amazon\.com|discord\.gg|discord\.com|twitch\.tv|patreon\.com)$/i;

const FREE_TITLE_RE = /\b(free|download|dl|grab|get\s*it|unlock)\b/i;
const NOT_FREE_TITLE_RE = /\b(buy|purchase|stream|listen|pre-?order|pre-?save|video|merch|tickets?|spotify|apple|beatport|traxsource|juno)\b/i;
/** A description line offering the file. "FREE DOWNLOAD - https://…" and
 *  "Free DL: …" say so outright; "download here ↓" or "DL link:" only count
 *  when the line doesn't also stream or sell ("Stream/DL: bssrush.co/…" is a
 *  label's store picker). */
const FREE_LINE_STRONG_RE = /\bfree\s*(download|dl)\b/i;
const FREE_LINE_WEAK_RE = /\b(download|dl)\s*(here|link|now)\b|\b(download|dl)\s*[:\-–—→↓⬇]/i;
/** On a "free download" line, only these say it isn't (stream/listen ride
 *  along with free downloads too often: "FREE DOWNLOAD + STREAM"). */
const NOT_FREE_LINE_RE = /\b(buy|purchase|pre-?order|pre-?save|tickets?|merch)\b/i;

function isFreeLine(line) {
  if (NOT_FREE_LINE_RE.test(line)) return false;
  if (FREE_LINE_STRONG_RE.test(line)) return true;
  return FREE_LINE_WEAK_RE.test(line) && !NOT_FREE_TITLE_RE.test(line);
}

/** "MP3 - https://…" is never an upgrade; "WAV - https://…" is the one to get. */
const LOSSY_LINE_RE = /\b(mp3|aac|m4a|\d{3}\s*kb?ps)\b/i;
const LOSSLESS_LINE_RE = /\b(wav|aiff?|flac|alac|lossless)\b/i;
/** The upload's own title offers a download: "[FREE DL]", "DL LINK IN DESC". */
const TITLE_SAYS_FREE_RE = /\bfree\s*(download|dl)\b|\b(dl|download)\s*link\b|[\[(]\s*free\s*[\])]/i;
/** Links SoundCloud auto-links in descriptions, with or without the scheme. */
const LINK_RE = /\bhttps?:\/\/[^\s<>"')\]]+|\b(?:[a-z0-9-]+\.)+(?:com|io|to|me|co|net|org|fm|link|ly|app|gg|cc|tv|bio|page|site|xyz|ee|nz|it|de|uk)\/[^\s<>"')\]]*/gi;

export function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

export function knownGateHost(u) {
  const h = hostOf(u);
  if (!h) return null;
  return GATE_HOSTS.find(g => h === g || h.endsWith('.' + g)) || null;
}

/** Every link in a block of text, with a scheme, trailing punctuation off. */
function linksIn(text) {
  const out = [];
  for (const m of (text || '').matchAll(LINK_RE)) {
    let u = m[0].replace(/[.,;:!?)\]]+$/, '');
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

/** Links to known gate hosts inside a track description. */
export function findGateLinks(text) {
  if (!text) return [];
  const out = [];
  for (const u of linksIn(text).filter(x => /^https?:\/\//i.test(x))) {
    const host = knownGateHost(u);
    if (host && !out.some(x => x.url === u)) out.push({ host, url: u });
  }
  return out;
}

/**
 * Links a description offers as the free file: on a line that says so
 * ("FREE DOWNLOAD - https://ipln.io/…"), or listed under a header line
 * ("Download Link" / "MP3 - …" / "WAV - …"). A link labelled lossy is
 * dropped; one labelled WAV/AIFF/FLAC goes first, then known gate hosts
 * (those with a walker before those without), then unknown ones — still worth a try in Chrome, and
 * worth showing as "needs you" rather than "no download offered". Socials,
 * players and stores never count. Each entry: { host, url, line, lossless }.
 */
export function findFreeLines(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const out = [];
  const add = (url, line) => {
    const h = hostOf(url);
    if (!h || NEVER_GATE_RE.test(h) || out.some(x => x.url === url)) return;
    if (LOSSY_LINE_RE.test(line) && !LOSSLESS_LINE_RE.test(line)) return;
    out.push({ host: knownGateHost(url), url, line: line.slice(0, 120), lossless: LOSSLESS_LINE_RE.test(line) });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isFreeLine(line)) continue;
    const own = linksIn(line);
    if (own.length) {
      for (const u of own) add(u, line);
      continue;
    }
    // A header: the links on the lines under it, up to a blank line.
    for (let j = i + 1, n = 0; j < lines.length && lines[j] && n < 4; j++) {
      if (isFreeLine(lines[j]) || NOT_FREE_TITLE_RE.test(lines[j])) break;
      const ls = linksIn(lines[j]);
      if (ls.length) { n++; for (const u of ls) add(u, lines[j]); }
    }
  }
  const rank = x => (x.lossless ? 0 : 4) + (x.host ? (WALKED_GATE_HOSTS.includes(x.host) ? 0 : 1) : 2);
  return out.map((x, k) => ({ x, k })).sort((a, b) => rank(a.x) - rank(b.x) || a.k - b.k).map(({ x }) => x);
}

/** Every link a description labels lossy ("MP3 - https://…"). */
function lossyLabelledLinks(text) {
  return (text || '').split(/\r?\n/).filter(l => LOSSY_LINE_RE.test(l) && !LOSSLESS_LINE_RE.test(l)).flatMap(l => linksIn(l));
}

/**
 * Every free offer on an upload, best first: a description link labelled
 * lossless; the buy-link slot (unless the description labels it MP3); a
 * "free download" line to a known gate; a known gate elsewhere in the
 * description (a download-only host anywhere, a file host or Bandcamp unless
 * its line streams or sells, a link page only when the title says free); and
 * last a "free download" line to a host nobody knows yet.
 */
export function freeOffers(t) {
  const pt = t.purchaseTitle || '';
  const pu = t.purchaseUrl || '';
  const offers = [];
  const add = (gate, reason, lossless = false) => {
    if (!offers.some(o => o.gate.url === gate.url)) offers.push({ gate, reason, lossless });
  };
  const freeLines = findFreeLines(t.description);
  const fromLine = l => add({ host: l.host, url: l.url, title: 'description: free download' },
    `description says free download${l.lossless ? ' (lossless)' : ''} → ${l.host || `unknown host ${hostOf(l.url)}`}`, l.lossless);
  freeLines.filter(l => l.lossless).forEach(fromLine);
  const lossyLinks = lossyLabelledLinks(t.description);
  if (pu && !lossyLinks.includes(pu)) {
    const host = knownGateHost(pu);
    const saysFree = FREE_TITLE_RE.test(pt) && !NOT_FREE_TITLE_RE.test(pt);
    if (host && (saysFree || !pt || DEDICATED_GATE_RE.test(host))) add({ host, url: pu, title: pt }, `"${pt || 'link'}" → ${host}`);
    else if (saysFree) add({ host: null, url: pu, title: pt }, `"${pt}" → unknown host ${hostOf(pu) || pu}`);
  }
  freeLines.filter(l => !l.lossless && l.host).forEach(fromLine);
  const titleSaysFree = TITLE_SAYS_FREE_RE.test(t.scTitle || '');
  const descLines = (t.description || '').split(/\r?\n/);
  const lineOf = url => descLines.find(l => l.includes(url.replace(/^https?:\/\//, ''))) || '';
  for (const l of findGateLinks(t.description)) {
    if (lossyLinks.includes(l.url)) continue;
    const ok = DEDICATED_GATE_RE.test(l.host) || (!NOT_FREE_TITLE_RE.test(lineOf(l.url)) && (FILE_HOST_RE.test(l.host) || titleSaysFree));
    if (ok) add({ host: l.host, url: l.url, title: 'description link' }, `description links to ${l.host}`);
  }
  freeLines.filter(l => !l.lossless && !l.host).forEach(fromLine);
  return offers;
}

/**
 * Where a liked track's free file is, if anywhere:
 *   native  — SoundCloud's own download (needs the signed-in session)
 *   gate    — a third-party gate; `gate.host` is null for an unknown host
 *   none    — nothing free: paid link, or no link at all
 * After SoundCloud's own button, the pick among freeOffers(): one labelled
 * lossless, else the first with a walker, else the first.
 */
export function classifyFreeDownload(t) {
  if (t.downloadable && t.hasDownloadsLeft) {
    return { kind: 'native', gate: null, reason: 'SoundCloud download button' };
  }
  if (t.downloadable && !t.hasDownloadsLeft) {
    return { kind: 'none', gate: null, reason: 'SoundCloud download limit reached' };
  }
  const pt = t.purchaseTitle || '';
  const pu = t.purchaseUrl || '';
  const offers = freeOffers(t);
  // A link labelled WAV/AIFF/FLAC first; then the first offer Track Lab has a
  // walker for; then the first offer at all.
  const pick = offers.find(o => o.lossless) || offers.find(o => WALKED_GATE_HOSTS.includes(o.gate.host)) || offers[0];
  if (pick) return { kind: 'gate', gate: pick.gate, reason: pick.reason };
  if (pu) return { kind: 'none', gate: null, reason: `link is "${pt || hostOf(pu)}" — not a free download` };
  return { kind: 'none', gate: null, reason: 'no download offered' };
}

// ---------- track normalization ----------

/** One api-v2 track (or a like wrapper) → the row shape the pipeline uses. */
export function normalizeLikedTrack(item) {
  const t = item.track || item;
  const uploader = t.user?.username || '';
  const publisherArtist = t.publisher_metadata?.artist || '';
  const parsed = parseSoundCloudTitle(t.title, { uploader, publisherArtist });
  const row = {
    scId: t.id,
    scTitle: t.title || '',
    artist: parsed.artist,
    title: parsed.title,
    artistSource: parsed.source,
    uploader,
    uploaderUrl: t.user?.permalink_url || null,
    uploaderId: t.user?.id ?? t.user_id ?? null,
    url: t.permalink_url || null,
    duration: t.duration ? Math.round(t.duration / 1000) : null,
    image: (t.artwork_url || t.user?.avatar_url || null)?.replace('-large.', '-t200x200.') || null,
    genre: t.genre || null,
    likedAt: item.created_at && item.kind === 'like' ? item.created_at : null,
    createdAt: t.created_at || null,
    downloadable: !!t.downloadable,
    hasDownloadsLeft: !!t.has_downloads_left,
    downloadCount: t.download_count ?? null,
    purchaseUrl: t.purchase_url || null,
    purchaseTitle: t.purchase_title || null,
    description: t.description || null,
    policy: t.policy || null,
  };
  row.key = makeTrackKey(row.artist, row.title);
  row.free = classifyFreeDownload(row);
  return row;
}

// ---------- public likes ----------

/** A public api-v2 GET with the cached client_id. A rotated id answers
 *  401/403, so on either the id is re-scraped once before the call fails. */
async function publicFetch(urlWithoutClientId) {
  const attempt = async () => fetch(withClientId(urlWithoutClientId, await getPublicClientId()), { headers: H });
  const res = await attempt();
  if (res.status !== 401 && res.status !== 403) return res;
  clientIdCache = null;
  return attempt();
}

export async function resolvePublicUser(userOrUrl) {
  const target = /^https?:/i.test(userOrUrl) ? userOrUrl : `${SC}/${String(userOrUrl).replace(/^@/, '')}`;
  const res = await publicFetch(`${API}/resolve?url=${encodeURIComponent(target)}`);
  if (!res.ok) throw new Error(`SoundCloud could not resolve ${target}: HTTP ${res.status}`);
  const u = await res.json();
  if (u.kind !== 'user') throw new Error(`${target} is a ${u.kind}, not a user`);
  return { id: u.id, username: u.username, permalink: u.permalink, url: u.permalink_url, likesCount: u.likes_count ?? null, avatar: u.avatar_url || null };
}

/** Every liked track on a public profile, newest first. */
/** One public track by its page link or id, as api-v2 returns it. */
export async function resolveTrackPublic(urlOrId) {
  const res = /^\d+$/.test(String(urlOrId))
    ? await publicFetch(`${API}/tracks/${urlOrId}`)
    : await publicFetch(`${API}/resolve?url=${encodeURIComponent(await expandShortLink(String(urlOrId)))}`);
  if (!res.ok) throw new Error(`SoundCloud could not find ${urlOrId}: HTTP ${res.status}`);
  const t = await res.json();
  if (t.kind && t.kind !== 'track') throw new Error(`that link is a SoundCloud ${t.kind}, not a track`);
  return t;
}

export async function fetchLikesPublic(userOrUrl, { limit = 0, onProgress } = {}) {
  const user = await resolvePublicUser(userOrUrl);
  let next = `${API}/users/${user.id}/track_likes?limit=${PAGE_SIZE}&offset=0&linked_partitioning=1`;
  const tracks = [];
  while (next) {
    // next_href carries the client_id it was issued with; strip it so a re-scraped one applies.
    const u = new URL(next); u.searchParams.delete('client_id');
    const res = await publicFetch(u.toString());
    if (!res.ok) throw new Error(`SoundCloud likes page failed: HTTP ${res.status}`);
    const page = await res.json();
    for (const item of page.collection || []) {
      if (!item.track) continue;
      tracks.push(normalizeLikedTrack(item));
      if (limit && tracks.length >= limit) break;
    }
    onProgress?.(tracks.length, user.likesCount);
    if (limit && tracks.length >= limit) break;
    next = page.next_href || null;
    if (next) await sleep(PAGE_PAUSE_MS);
  }
  return { source: { user: user.username, userId: user.id, url: `${user.url}/likes`, likesCount: user.likesCount, fetchedCount: tracks.length, via: 'public', image: user.avatar }, tracks };
}

/** Raw api-v2 track objects for a public search, best match first. */
export async function searchTracksPublic(query, { limit = 10 } = {}) {
  const res = await publicFetch(`${API}/search/tracks?q=${encodeURIComponent(query)}&limit=${limit}`);
  if (!res.ok) throw new Error(`SoundCloud search failed: HTTP ${res.status}`);
  return (await res.json()).collection || [];
}

// ---------- browser session ----------
//
// The 'soundcloud' Chrome profile is the one place a SoundCloud sign-in
// lives: this CLI, the MCP tools and the app all open it, so signing in from
// any of them signs in all of them. Nothing stores the token. Each capture
// notes who it found (account only) in a status file beside the profiles, so
// the app can say "signed in as …" without opening Chrome. Both belong to the
// active Track Lab profile (lib/profilePaths.mjs): each person signs in once.

/** CANDYBAR_SC_STATUS overrides the path (tests). */
function statusFile() {
  return process.env.CANDYBAR_SC_STATUS || path.join(cacheDir(), 'soundcloud-session.json');
}

/** Note who a captured session belongs to. Best effort: a status that can't
 *  be written never fails the run. */
export function recordSessionStatus(sess, file = statusFile()) {
  const status = sess.signedIn
    ? { signedIn: true, username: sess.me?.username ?? null, permalink: sess.me?.permalink ?? null, url: sess.me?.url ?? null, checkedAt: new Date().toISOString() }
    : { signedIn: false, username: null, permalink: null, url: null, checkedAt: new Date().toISOString(), reason: sess.diagnostic || null };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(status, null, 2));
    fs.renameSync(tmp, file);
  } catch { /* status is a convenience */ }
  return status;
}

/** Who the saved session belonged to at the last capture, or null when
 *  nothing has looked yet. */
export function readSessionStatus(file = statusFile()) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof s?.signedIn === 'boolean' ? s : null;
  } catch {
    return null;
  }
}

export async function openSoundCloud({ headless = false } = {}) {
  const ctx = await launchSiteBrowser({ profile: 'soundcloud', headless });
  const page = ctx.pages()[0] || (await ctx.newPage());
  return { ctx, page, close: async () => { try { await ctx.close(); } catch { /* already gone */ } } };
}

/** Run a fetch inside the page (same origin as the web app, so api-v2's CORS
 *  policy admits it) with the session's own OAuth header. */
export async function pageFetch(page, url, { token = null, method = 'GET', json = undefined } = {}) {
  return page.evaluate(async ({ url, token, method, json }) => {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = token;
    const init = { method, headers };
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(json); }
    const r = await fetch(url, init);
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
    return { status: r.status, body };
  }, { url, token, method, json });
}

/** What the page itself knows about the session: the web app keeps its token
 *  in a cookie its own scripts read, and shows the user menu once signed in.
 *  Read from inside the page, never from the profile on disk. */
async function sessionFromPage(page) {
  try {
    return await page.evaluate(() => {
      const m = document.cookie.match(/(?:^|;\s*)oauth_token=([^;]+)/);
      const token = m ? decodeURIComponent(m[1]) : null;
      const signedInUi = !!document.querySelector('.header__userNav, .header__userNavButton, [class*="userNavUsername"]');
      return { token: token ? `OAuth ${token}` : null, signedInUi };
    });
  } catch {
    return { token: null, signedInUi: false };
  }
}

/**
 * Attach to the web app's own API traffic and read what it uses: the
 * client_id, the OAuth header, and the signed-in user's id. Navigates to the
 * likes page so those requests fire; when no request carrying the header is
 * seen, the same token is read from the app's cookie. `signedIn` is only true
 * once /me answers with the header — a real answer, not an empty list.
 */
export async function captureSession(page, { timeoutMs = 25000 } = {}) {
  const sess = { clientId: null, token: null, meId: null, likesUrl: null };
  const onRequest = req => {
    const u = req.url();
    if (!u.startsWith(API)) return;
    try {
      const cid = new URL(u).searchParams.get('client_id');
      if (cid) sess.clientId = cid;
    } catch { /* not a URL we can parse */ }
    const auth = req.headers()['authorization'];
    if (auth && /^OAuth\s+\S+/i.test(auth)) sess.token = auth;
    const m = u.match(/\/users\/(\d+)\/track_likes/);
    if (m) { sess.meId = m[1]; sess.likesUrl = sess.likesUrl || u; }
    const me = u.match(/\/me(\?|$)/);
    if (me && auth) sess.hasMe = true;
  };
  page.on('request', onRequest);
  try {
    await page.goto(`${SC}/you/likes`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (sess.token && sess.clientId && sess.likesUrl) break;
      await page.waitForTimeout(500);
    }
  } finally {
    page.off('request', onRequest);
  }
  if (!sess.clientId) sess.clientId = await getPublicClientId().catch(() => null);
  if (!sess.token) {
    const fromPage = await sessionFromPage(page);
    if (fromPage.token) { sess.token = fromPage.token; sess.tokenSource = 'cookie'; }
    sess.signedInUi = fromPage.signedInUi;
  } else {
    sess.tokenSource = 'request';
  }
  sess.signedIn = false;
  if (sess.token) {
    const me = await pageFetch(page, `${API}/me?client_id=${sess.clientId}`, { token: sess.token }).catch(() => null);
    if (me?.status === 200 && me.body?.id) {
      sess.signedIn = true;
      sess.meId = String(me.body.id);
      sess.me = { id: me.body.id, username: me.body.username, permalink: me.body.permalink, url: me.body.permalink_url, likesCount: me.body.likes_count ?? null, avatar: me.body.avatar_url || null };
    } else {
      sess.diagnostic = `token seen (${sess.tokenSource}) but /me answered ${me?.status ?? 'nothing'}`;
    }
  } else {
    sess.diagnostic = sess.signedInUi ? 'signed-in UI visible but no token readable' : 'no OAuth header and no session cookie';
  }
  recordSessionStatus(sess);
  return sess;
}

/** Wait, without navigating again, for an interactive sign-in in the visible
 *  window: either a request carrying the OAuth header, or the app's session
 *  cookie appearing. Returns false when the window is closed. */
export async function waitForSoundCloudLogin(page, { timeoutMs = 300000, onTick = null } = {}) {
  let token = null;
  const onRequest = req => {
    if (token) return;
    const auth = req.headers()['authorization'];
    if (req.url().startsWith(API) && auth && /^OAuth\s+\S+/i.test(auth)) token = auth;
  };
  page.on('request', onRequest);
  try {
    await page.goto(`${SC}/signin`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    let ticks = 0;
    while (Date.now() < deadline) {
      if (token) return true;
      if (page.isClosed()) return false;
      if (ticks++ % 3 === 0) {
        const fromPage = await sessionFromPage(page);
        if (fromPage.token) return true;
      }
      if (onTick && ticks % 60 === 0) onTick(Math.round((deadline - Date.now()) / 1000));
      try { await page.waitForTimeout(1000); } catch { return false; }
    }
    return false;
  } finally {
    try { page.off('request', onRequest); } catch { /* page gone */ }
  }
}

/** The signed-in user's likes, read through the session. */
export async function fetchLikesViaSession(page, sess, { limit = 0, onProgress } = {}) {
  if (!sess.signedIn || !sess.meId) throw new Error('SoundCloud session is signed out');
  let next = `${API}/users/${sess.meId}/track_likes?client_id=${sess.clientId}&limit=${PAGE_SIZE}&offset=0&linked_partitioning=1`;
  const tracks = [];
  while (next) {
    const { status, body } = await pageFetch(page, withClientId(next, sess.clientId), { token: sess.token });
    if (status !== 200 || !body?.collection) throw new Error(`SoundCloud likes page failed: HTTP ${status}`);
    for (const item of body.collection) {
      if (!item.track) continue;
      tracks.push(normalizeLikedTrack(item));
      if (limit && tracks.length >= limit) break;
    }
    onProgress?.(tracks.length, sess.me?.likesCount ?? null);
    if (limit && tracks.length >= limit) break;
    next = body.next_href || null;
    if (next) await sleep(PAGE_PAUSE_MS);
  }
  const me = sess.me || {};
  return {
    source: { user: me.username || 'you', userId: sess.meId, url: `${me.url || SC + '/you'}/likes`, likesCount: me.likesCount ?? null, fetchedCount: tracks.length, via: 'browser', image: me.avatar || null },
    tracks,
  };
}

/** Uploaded by the account itself. Decided by uploader id, because a title
 *  like "[NHI Flip]" also appears on other people's edits of the same name. */
export function isOwnTrack(row, meId) {
  return !!meId && row.uploaderId != null && String(row.uploaderId) === String(meId);
}

/** Signed URL for a track's native download, or null with the reason. */
export async function resolveNativeDownload(page, sess, row) {
  if (!sess?.signedIn) return { url: null, reason: 'signed out — native downloads need the SoundCloud session' };
  const { status, body } = await pageFetch(page, `${API}/tracks/${row.scId}/download?client_id=${sess.clientId}`, { token: sess.token });
  if (status === 200 && (body?.redirectUri || body?.url)) return { url: body.redirectUri || body.url, reason: null };
  if (status === 401 || status === 403) return { url: null, reason: `HTTP ${status} — SoundCloud refused the download (limit reached or followers-only)` };
  if (status === 404) return { url: null, reason: 'HTTP 404 — download withdrawn' };
  return { url: null, reason: `HTTP ${status}` };
}

// ---------- account actions (what a gate asks for) ----------
//
// The same calls the web app makes when you press its own buttons. A non-2xx
// answer is reported, not thrown: a gate only counts the click, so a failed
// follow must not abort the download.

export async function resolveInSession(page, sess, url) {
  const { status, body } = await pageFetch(page, `${API}/resolve?url=${encodeURIComponent(url)}&client_id=${sess.clientId}`, { token: sess.token });
  return status === 200 && body && typeof body === 'object' ? body : null;
}

export async function followUser(page, sess, userId) {
  // PUT answers 404 here (live 2026-10-30); the web app POSTs.
  const r = await pageFetch(page, `${API}/me/followings/${userId}?client_id=${sess.clientId}`, { token: sess.token, method: 'POST' });
  return { ok: r.status >= 200 && r.status < 300, status: r.status };
}

export async function likeTrack(page, sess, trackId) {
  const r = await pageFetch(page, `${API}/users/${sess.meId}/track_likes/${trackId}?client_id=${sess.clientId}`, { token: sess.token, method: 'PUT' });
  return { ok: r.status >= 200 && r.status < 300, status: r.status };
}

export async function repostTrack(page, sess, trackId) {
  const r = await pageFetch(page, `${API}/me/track_reposts/${trackId}?client_id=${sess.clientId}`, { token: sess.token, method: 'PUT' });
  return { ok: r.status >= 200 && r.status < 300, status: r.status };
}

/** Leave a comment on a track, the way the web app's comment box does. Its
 *  endpoint map (read from the app's bundle 2026-11-05) has
 *  commentCreate: POST tracks/:track_id/comments, query {body, timestamp}: the
 *  text and position go in the query string. A JSON body is refused with 400
 *  "multiple missing params", which is what every comment got before. */
export async function commentTrack(page, sess, trackId, body, { timestampMs = 0 } = {}) {
  const q = new URLSearchParams({ body: String(body), timestamp: String(Math.max(0, Math.round(timestampMs))), client_id: sess.clientId });
  const r = await pageFetch(page, `${API}/tracks/${trackId}/comments?${q}`, {
    token: sess.token, method: 'POST',
  });
  return { ok: r.status >= 200 && r.status < 300, status: r.status };
}

// ---------- sets (playlists) ----------
//
// A set resolves to a playlist object whose `tracks` array is the full track
// list in order, but only the first five are real track objects — the rest
// are {id, kind, monetization_model, policy} stubs (verified live 2026-10-29
// on a 407-track public set). The web app fills them in 50 ids at a time via
// /tracks?ids=…, and that call answers in arbitrary order, so the set's own
// order is restored afterwards. A secret set (…/sets/name/s-TOKEN) resolves
// from its link; hydrating its tracks needs the playlist id + secret token.

const HYDRATE_BATCH = 50;

/** A pasted set link, cleaned for /resolve: query junk (?si=…&utm_…) dropped,
 *  the mobile host folded into the main one, trailing slash removed. The
 *  secret token lives in the path, so it survives. */
export function normalizeSetUrl(u) {
  let url;
  try { url = new URL(String(u).trim()); } catch { throw new Error(`not a SoundCloud set link: ${u}`); }
  if (url.hostname === 'm.soundcloud.com') url.hostname = 'soundcloud.com';
  if (!/(^|\.)soundcloud\.com$/.test(url.hostname)) throw new Error(`not a SoundCloud link: ${u}`);
  url.search = ''; url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

/** Short share links (on.soundcloud.com/…) redirect to the real permalink. */
export async function expandShortLink(u) {
  const url = new URL(u);
  if (url.hostname !== 'on.soundcloud.com') return u;
  const res = await fetch(u, { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': UA } });
  const loc = res.headers.get('location');
  if (!loc) throw new Error(`short link did not redirect: ${u}`);
  return loc;
}

/** Does this look like a set rather than a track or profile? Cheap check for
 *  argument handling; /resolve has the final say. */
export function isSetUrl(u) {
  return /soundcloud\.com\/[^/?#]+\/sets\/[^/?#]+/i.test(String(u)) || /on\.soundcloud\.com\//i.test(String(u));
}

/**
 * Put hydrated tracks back in the set's order. `stubs` is the playlist's
 * `tracks` array (hydrated or not), `hydrated` maps id → full track. A stub
 * that never hydrated (deleted, blocked in this region, private to the owner)
 * is reported as unavailable rather than silently dropped.
 */
export function orderSetTracks(stubs, hydrated) {
  const tracks = [], unavailable = [];
  for (const s of stubs) {
    const t = hydrated.get(s.id);
    if (t && t.title !== undefined) tracks.push(t);
    else unavailable.push({ scId: s.id, policy: s.policy || null });
  }
  return { tracks, unavailable };
}

/** Read one set through `get(url) → {status, body}` — the public fetch or the
 *  in-page session fetch — so both paths share the same hydration logic. */
async function readSet(get, clientId, setUrl, { limit = 0, onProgress } = {}) {
  const target = normalizeSetUrl(await expandShortLink(normalizeSetUrl(setUrl)));
  const r = await get(`${API}/resolve?url=${encodeURIComponent(target)}&client_id=${clientId}`);
  if (r.status !== 200 || !r.body || typeof r.body !== 'object') {
    const err = new Error(`SoundCloud could not resolve ${target}: HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  const pl = r.body;
  if (pl.kind !== 'playlist') throw new Error(`${target} is a ${pl.kind}, not a set`);
  let stubs = pl.tracks || [];
  if (limit) stubs = stubs.slice(0, limit);
  const hydrated = new Map(stubs.filter(t => t.title !== undefined).map(t => [t.id, t]));
  const missing = stubs.filter(t => t.title === undefined).map(t => t.id);
  onProgress?.(hydrated.size, stubs.length);
  for (let i = 0; i < missing.length; i += HYDRATE_BATCH) {
    const ids = missing.slice(i, i + HYDRATE_BATCH);
    let u = `${API}/tracks?ids=${ids.join(',')}&client_id=${clientId}`;
    if (pl.secret_token) u += `&playlistId=${pl.id}&playlistSecretToken=${encodeURIComponent(pl.secret_token)}`;
    const h = await get(u);
    if (h.status !== 200 || !Array.isArray(h.body)) throw new Error(`SoundCloud track hydration failed: HTTP ${h.status}`);
    for (const t of h.body) hydrated.set(t.id, t);
    onProgress?.(hydrated.size, stubs.length);
    if (i + HYDRATE_BATCH < missing.length) await sleep(PAGE_PAUSE_MS);
  }
  const ordered = orderSetTracks(stubs, hydrated);
  const tracks = ordered.tracks.map((t, i) => ({ ...normalizeLikedTrack(t), position: i + 1 }));
  return {
    source: {
      kind: 'set',
      set: pl.title || pl.permalink || 'Untitled set',
      setId: pl.id,
      user: pl.user?.username || null,
      userId: pl.user?.id ?? pl.user_id ?? null,
      url: pl.permalink_url || target,
      trackCount: pl.track_count ?? (pl.tracks || []).length,
      fetchedCount: tracks.length,
      unavailable: ordered.unavailable,
      sharing: pl.sharing || null,
      image: (pl.artwork_url || pl.user?.avatar_url || null)?.replace('-large.', '-t200x200.') || null,
    },
    tracks,
  };
}

async function publicGet(url) {
  const res = await fetch(url, { headers: H });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

/** A public (or secret-link) set, no browser needed. Throws with `.status`
 *  401/403/404 when the set is private to the signed-in user.
 *
 *  A rotated client_id also answers 401, and the cached one lives as long as
 *  the process — for the app, that's until it quits. So a 401/403 re-scrapes
 *  the id once before calling the set private. */
export async function fetchSetPublic(setUrl, opts = {}) {
  let r;
  try {
    r = await readSet(publicGet, await getPublicClientId(), setUrl, opts);
  } catch (err) {
    if (err.status !== 401 && err.status !== 403) throw err;
    clientIdCache = null;
    r = await readSet(publicGet, await getPublicClientId(), setUrl, opts);
  }
  r.source.via = 'public';
  return r;
}

/** The same set read through the signed-in session — the only way to see the
 *  user's own private sets. */
export async function fetchSetViaSession(page, sess, setUrl, opts = {}) {
  if (!sess.signedIn) throw new Error('SoundCloud session is signed out');
  const get = url => pageFetch(page, url, { token: sess.token });
  const r = await readSet(get, sess.clientId, setUrl, opts);
  r.source.via = 'browser';
  return r;
}
