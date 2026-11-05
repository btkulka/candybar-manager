// Read-only looks at download gates, for the free search: what a gate gives
// (its file's format) and what it asks for (email, a SoundCloud connect, a
// comment), read signed out before anything is clicked. Only hosts that ship
// that in the page have an inspector; the rest are judged when walked.
//
// Influence Planner (ipln.io → gate.influenceplanner.com) ships its whole
// gate config in the Next.js server payload — see influenceplanner.mjs for
// the markup the walker uses.

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

/** Inspectors by gate host (as knownGateHost names it). */
export const GATE_INSPECTORS = {
  'ipln.io': inspectInfluencePlanner,
  'influenceplanner.com': inspectInfluencePlanner,
};

/** What a gate gives and asks for, or null when its host has no inspector.
 *  A failed read throws: the caller reports it rather than guessing. */
export async function inspectGate(gate, opts = {}) {
  const inspect = gate?.host ? GATE_INSPECTORS[gate.host] : null;
  return inspect ? inspect(gate.url, opts) : null;
}
