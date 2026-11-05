// Read-only looks at download gates, for the free search and the walkers:
// what a gate gives (its file's format, when it says) and what it asks for
// (email, a SoundCloud connect, a comment, a Spotify connect, follows),
// read signed out before anything is clicked. Only hosts that ship that in
// the page have an inspector; the rest are judged when walked.
//
//   Influence Planner (ipln.io → gate.influenceplanner.com): the whole gate
//     config in the Next.js payload — see influenceplanner.mjs.
//   Droploud (droploud.com/track/<id>; /gate/<id> redirects there): the
//     Next.js payload carries "gateData" with the ordered steps, e.g.
//     instagram_follow, soundcloud_follow/like/repost/comment, spotify_follow,
//     droploud_follow, email (read from 31 live gates, 2026-11-04).
//   Hypeddit: <input id="steps_select" value='dw,sc,sp,ig'>, one entry per
//     step group (alternatives joined by "|"); sp is a Spotify OAuth connect
//     with no skip button, the one step that can't be got round.
//
// A summary is { host, active, format, lossless, needs, optional, ... }:
// `needs` are the steps the gate insists on, in order; `optional` the ones it
// lets you skip.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const LOSSLESS_EXT = new Set(['wav', 'aif', 'aiff', 'flac', 'alac']);
const LOSSY_EXT = new Set(['mp3', 'm4a', 'aac', 'ogg', 'opus']);

/** The JSON object that starts at `start` (a "{"), read with strings in mind. */
function objectAt(text, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * The gate's config from its page, or null when the page carries none (a
 * dead link, a changed site). The payload sits inside script strings, so its
 * quotes arrive escaped once.
 */
export function parseInfluencePlannerGate(html) {
  if (!html) return null;
  for (const text of [html, html.replace(/\\"/g, '"')]) {
    const at = text.search(/"gate":\{"id":/);
    if (at < 0) continue;
    const raw = objectAt(text, text.indexOf('{', at));
    if (!raw) continue;
    try { return JSON.parse(raw); } catch { /* try the unescaped copy */ }
  }
  return null;
}

/** What a gate asks for and gives, in the shape the free search reports. */
export function summarizeInfluencePlannerGate(gate) {
  if (!gate) return null;
  const ext = (/\.([a-z0-9]+)$/i.exec(gate.trackFilename || '')?.[1] || '').toLowerCase();
  const needs = [];
  if (gate.emailRequired) needs.push('email');
  if (gate.superfanRequired) needs.push('soundcloud-connect');
  if (gate.commentRequired) needs.push('comment');
  return {
    host: 'influenceplanner.com',
    active: gate.active !== false && !gate.deletedAt,
    format: ext ? ext.toUpperCase() : null,
    lossless: LOSSLESS_EXT.has(ext) ? true : LOSSY_EXT.has(ext) ? false : null,
    needs,
    optional: [],
    scTrackId: /soundcloud:tracks:(\d+)/.exec(gate.trackUrn || '')?.[1] || null,
    artists: gate.trackArtists || null,
    title: gate.trackTitle || null,
  };
}

/** Read a gate signed out, following ipln.io's redirect. Never clicks. */
export async function inspectInfluencePlanner(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Influence Planner gate: HTTP ${res.status}`);
  return summarizeInfluencePlannerGate(parseInfluencePlannerGate(await res.text()));
}

// ---------- Droploud ----------

/** Droploud step types → the walker's and the UI's words for them. */
const DROPLOUD_NEEDS = {
  email: 'email',
  soundcloud_follow: 'soundcloud-connect', soundcloud_like: 'soundcloud-connect', soundcloud_repost: 'soundcloud-connect',
  soundcloud_comment: 'comment',
  instagram_follow: 'instagram', tiktok_follow: 'tiktok', youtube_follow: 'youtube', facebook_follow: 'facebook',
  twitter_follow: 'x', beatport_follow: 'beatport', mixcloud_follow: 'mixcloud',
  spotify_follow: 'spotify', spotify_save: 'spotify',
  droploud_follow: 'droploud-follow',
  disclaimer: 'disclaimer',
};
/** Steps Droploud lets you skip: Spotify ("Optional: connect Spotify to follow
 *  + save, or skip. Your download isn't blocked either way.") and following
 *  the artist on Droploud. */
const DROPLOUD_OPTIONAL = new Set(['spotify_follow', 'spotify_save', 'droploud_follow']);

/** "gateData" from a Droploud track page, or null. */
export function parseDroploudGate(html) {
  if (!html) return null;
  for (const text of [html, html.replace(/\\"/g, '"')]) {
    const at = text.indexOf('"gateData":{');
    if (at < 0) continue;
    const raw = objectAt(text, text.indexOf('{', at));
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      if (Array.isArray(data.steps)) return data;
    } catch { /* try the unescaped copy */ }
  }
  return null;
}

const uniq = xs => [...new Set(xs)];

export function summarizeDroploudGate(data) {
  if (!data) return null;
  const types = data.steps.map(s => s.type);
  const required = types.filter(t => !DROPLOUD_OPTIONAL.has(t) && !(data.sc_optional && /^soundcloud_/.test(t)));
  return {
    host: 'droploud.com',
    active: true,
    format: null,
    lossless: null,
    needs: uniq(required.map(t => DROPLOUD_NEEDS[t] || t)),
    optional: uniq(types.filter(t => DROPLOUD_OPTIONAL.has(t)).map(t => DROPLOUD_NEEDS[t] || t)),
    steps: types,
    scTrackUrl: data.track?.soundcloud_url || null,
    artists: data.artist?.display_name || null,
    title: data.track?.title || null,
  };
}

export async function inspectDroploud(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Droploud gate: HTTP ${res.status}`);
  return summarizeDroploudGate(parseDroploudGate(await res.text()));
}

// ---------- Hypeddit ----------

const HYPEDDIT_NEEDS = {
  sc: 'soundcloud-support', sp: 'spotify-connect', ig: 'instagram', email: 'email', yt: 'youtube',
  fb: 'facebook', tw: 'x', tt: 'tiktok', am: 'apple-music', dz: 'deezer', bc: 'bandcamp', mc: 'mixcloud',
};

/** The step groups from a Hypeddit gate page: [['sc'], ['sp'], ['ig']], with
 *  "dw" (the download itself) left out; null when the page has none (a smart
 *  link, a dead gate). */
export function parseHypedditSteps(html) {
  const m = /id="steps_select"[^>]*value=['"]([^'"]*)['"]/.exec(html || '') || /value=['"]([^'"]*)['"][^>]*id="steps_select"/.exec(html || '');
  if (!m) return null;
  return m[1].split(',').map(g => g.split('|').map(x => x.trim()).filter(Boolean)).filter(g => g.length && !(g.length === 1 && g[0] === 'dw'));
}

/** A group with alternatives needs none of them in particular: the gate
 *  offers a choice ("sc|sp"), so those go to `optional`. */
export function summarizeHypedditSteps(groups) {
  if (!groups) return null;
  const word = c => HYPEDDIT_NEEDS[c] || c;
  return {
    host: 'hypeddit.com',
    active: true,
    format: null,
    lossless: null,
    needs: uniq(groups.filter(g => g.length === 1).map(g => word(g[0]))),
    optional: uniq(groups.filter(g => g.length > 1).flat().map(word)),
    steps: groups.map(g => g.join('|')),
  };
}

export async function inspectHypeddit(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Hypeddit gate: HTTP ${res.status}`);
  return summarizeHypedditSteps(parseHypedditSteps(await res.text()));
}

/** Inspectors by gate host (as knownGateHost names it). */
export const GATE_INSPECTORS = {
  'ipln.io': inspectInfluencePlanner,
  'influenceplanner.com': inspectInfluencePlanner,
  'droploud.com': inspectDroploud,
  'hypeddit.com': inspectHypeddit,
};

/** What a gate gives and asks for, or null when its host has no inspector.
 *  A failed read throws: the caller reports it rather than guessing. */
export async function inspectGate(gate, opts = {}) {
  const inspect = gate?.host ? GATE_INSPECTORS[gate.host] : null;
  return inspect ? inspect(gate.url, opts) : null;
}
