// Free and cheap copies of a track, looked for in Ben's order (2026-11-03): a
// SoundCloud free download first, then Bandcamp (a free download, a $0
// name-your-price, or a cheap minimum), and only then the paid stores.
//
// Read-only and signed out: SoundCloud's public search, Bandcamp's public
// search and track pages. Nothing is downloaded here. Each hit carries the row
// bin/source-soundcloud-likes.mjs --tracks fetches, gates and all.
//
// Format: Bandcamp serves the lossless master the artist uploaded, so its hits
// are lossless. A SoundCloud file's format is only known once it arrives
// (api-v2 has no original_format), so a SoundCloud hit keeps a fallback and a
// lossy file is quarantined on arrival like any other free download.
//
// Bandcamp's data-tralbum, as read live on 2026-11-03:
//   current.minimum_price   0 = name your price; > 0 = the minimum ("£2 or more")
//   freeDownloadPage        set when the free file needs no email
//   current.require_email   1 = signed out, the free link is mailed
//   trackinfo[0].duration   seconds
// and the band's currency on the page as data-band-currency="GBP".

import { createRequire } from 'module';
import { storeScoreParts, normalizeLoose } from './matching.mjs';
import { normalizeLikedTrack, parseSoundCloudTitle, searchTracksPublic, resolveTrackPublic, knownGateHost, hostOf } from './soundcloud.mjs';
import { inspectGate } from './gates/inspect.mjs';

const fuzzball = createRequire(import.meta.url)('fuzzball');

/** Free sources are full of bootlegs and edits sharing a title, so the bar
 *  sits well above the stores' 0.50. */
export const FREE_MATCH_FLOOR = 0.80;
/** The swap keeps the Rekordbox cues, so the file has to be the same cut. A
 *  copy more than this many seconds longer or shorter is another version. */
export const DURATION_TOLERANCE_SEC = 10;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const BANDCAMP_SEARCH = 'https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic';
/** Track pages read per wanted track: the best-scoring search results only. */
const BANDCAMP_PAGES = 3;
const BANDCAMP_PAUSE_MS = 300;
/** An upload this close to the wanted track, passed over (no download,
 *  another cut, an MP3), is reported as a near miss so a "not found" row can
 *  say why: "Shizz Lo's upload matches, but it offers no download". */
export const NEAR_MISS_FLOOR = 0.80;
/** Near misses kept per track. */
const NEAR_MISSES = 3;
/** Free SoundCloud uploads whose gate is read before it's offered. */
const INSPECT_PICKS = 3;
/** An upload whose title says it's an MP3 ("- 192kbps", "- 192kps", "[MP3]") is never an upgrade. */
const LOSSY_TITLE_RE = /\b(\d{2,3}\s*kb?ps|mp3)\b/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- scoring ----------

// ---------- rework credits ----------

const REWORK_WORD_RE = /\b(remix|flip|edit|bootleg|rework|refix|re-?edit|rerub|vip|mashup)\b/i;
/** Words uploaders use for the same kind of rework: a "Shizz Lo Flip" and a
 *  "Shizz Lo Remix" of the same length are one track. A VIP or a mashup is
 *  its own thing. */
const SAME_REWORK_RE = /^(remix|flip|edit|bootleg|rework|refix|reedit|rerub)$/;
const CREDIT_NOISE_RE = /\b(extended|original|club|radio|mix|version|free|download|dl|official|unofficial)\b/gi;

/** A name as a rework credit compares: lower case, letters, digits, spaces. */
function creditKey(s) {
  return (s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(CREDIT_NOISE_RE, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The rework a title names, from its bracketed or dashed tags: "Go Back
 * (Shizz Lo Flip)" → { tag: 'Shizz Lo Flip', word: 'flip', credit: 'shizz lo' }.
 * Null for an original.
 */
export function reworkTag(title) {
  const t = title || '';
  const tags = [...t.matchAll(/[\(\[]([^\)\]]*)[\)\]]/g)].map(m => m[1]);
  tags.push(...t.split(/\s+[-–—]\s+/).slice(1));
  for (const tag of tags) {
    const m = REWORK_WORD_RE.exec(tag);
    if (!m) continue;
    return { tag: tag.trim(), word: m[1].toLowerCase().replace('-', ''), credit: creditKey(tag.slice(0, m.index)) };
  }
  return null;
}

const sameCredit = (a, b) => !!a && !!b && fuzzball.token_set_ratio(a, b) >= 90;

// ---------- scoring ----------

/**
 * How well a candidate fits the wanted track: the store scorer, held under
 * the floor when it's another version or another length. The stores only
 * dock a different version 0.12, which leaves "That Acid (ANDUJ Edit)" at
 * 0.88 for "That Acid"; for a swap that keeps the cues, any other cut is wrong.
 * One exception: the same reworker under another word ("Flip" / "Remix") at
 * the same length is the same track, uploaders being loose with the word.
 * `rawScore` is the score before the hold, for explaining a near miss.
 */
export function scoreFreeCandidate(want, cand) {
  const parts = storeScoreParts(want, cand.artist, cand.title);
  const durationGap = want.duration && cand.duration ? Math.abs(want.duration - cand.duration) : null;
  let versionMismatch = parts.penalty > 0;
  let rawScore = parts.score;
  if (versionMismatch && durationGap != null && durationGap <= DURATION_TOLERANCE_SEC) {
    const a = reworkTag(want.title);
    const b = reworkTag(cand.title);
    if (a && b && sameCredit(a.credit, b.credit) && SAME_REWORK_RE.test(a.word) && SAME_REWORK_RE.test(b.word)) {
      versionMismatch = false;
      rawScore = Math.min(1, parts.score + parts.penalty);
    }
  }
  const durationMismatch = durationGap != null && durationGap > DURATION_TOLERANCE_SEC;
  const score = versionMismatch || durationMismatch ? Math.min(rawScore, FREE_MATCH_FLOOR - 0.01) : rawScore;
  return { ...parts, rawScore, score, durationGap, versionMismatch, durationMismatch };
}

/**
 * Ways to read the wanted track: as tagged; and, when the title carries a
 * whole SoundCloud listing with the uploader as the artist ("Shizz Lo" /
 * "John Summit & Sub Focus – Go Back (Shizz Lo Flip)"), split the way
 * SoundCloud titles are.
 */
export function wantReadings(want) {
  const out = [want];
  if (/\s[-–—]\s/.test(want.title || '')) {
    const p = parseSoundCloudTitle(want.title, { uploader: want.artist || '' });
    if (p.artist && p.title && (p.artist !== want.artist || p.title !== want.title)) out.push({ ...want, artist: p.artist, title: p.title });
  }
  return out;
}

/** Ways to read an upload: the artist from its title, and the uploader as the
 *  artist (a reworker's own upload, tagged that way when it was downloaded). */
function uploadReadings(row) {
  const out = [{ artist: row.artist, title: row.title }];
  if (row.uploader && normalizeLoose(row.uploader) !== normalizeLoose(row.artist)) out.push({ artist: row.uploader, title: row.title });
  return out;
}

/**
 * The best score over every reading of both sides. One more reading of the
 * wanted track: credited to the reworker with a bare title ("Shizz Lo" / "Go
 * Back"), it's read as that reworker's version when the upload names them.
 */
export function bestFreeScore(want, row) {
  let best = null;
  for (const w of wantReadings(want)) {
    for (const c of uploadReadings(row)) {
      const tries = [w];
      const tag = reworkTag(c.title);
      if (tag && !reworkTag(w.title) && sameCredit(tag.credit, creditKey(w.artist))) tries.push({ ...w, title: `${w.title} (${tag.tag})` });
      for (const t of tries) {
        const s = scoreFreeCandidate(t, { ...c, duration: row.duration });
        if (!best || s.score > best.score || (s.score === best.score && s.rawScore > best.rawScore)) best = { ...s, reading: c };
      }
    }
  }
  return best;
}

/** The best of several readings of one candidate (Bandcamp bootlegs put
 *  "Artist - Title (X Remix)" in the track name and the remixer in band_name). */
function bestReading(want, readings, duration) {
  let best = null;
  for (const r of readings) {
    const s = scoreFreeCandidate(want, { ...r, duration });
    if (!best || s.score > best.parts.score) best = { reading: r, parts: s };
  }
  return best;
}

const round2 = n => Math.round(n * 100) / 100;

// ---------- SoundCloud ----------

const GATE_NAMES = { 'ipln.io': 'Influence Planner', 'influenceplanner.com': 'Influence Planner', 'hypeddit.com': 'Hypeddit', 'toneden.io': 'ToneDen', 'droploud.com': 'Droploud' };
const NEED_WORDS = {
  email: 'your email', 'soundcloud-connect': 'a SoundCloud connect', comment: 'a comment',
  'spotify-connect': 'a Spotify connect', spotify: 'a Spotify follow', 'soundcloud-support': 'SoundCloud support',
  instagram: 'an Instagram follow', tiktok: 'a TikTok follow', youtube: 'a YouTube follow', facebook: 'a Facebook follow',
  x: 'an X follow', beatport: 'a Beatport follow', mixcloud: 'a Mixcloud follow', 'droploud-follow': 'a Droploud follow',
  disclaimer: 'a rights checkbox', 'apple-music': 'an Apple Music connect', deezer: 'a Deezer follow',
};
const listWords = xs => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Why an upload this close was passed over, as a code and a phrase. */
function missWhy(want, row, s, lossyTitle) {
  if (s.versionMismatch) return { code: 'other-version', text: `it's another version ("${row.title}")` };
  if (s.durationMismatch) {
    return { code: 'other-length', text: `it's ${s.durationGap}s ${row.duration > want.duration ? 'longer' : 'shorter'} than yours, so another cut` };
  }
  if (lossyTitle) return { code: 'lossy-title', text: 'its title says it\'s an MP3' };
  if (row.free.reason === 'SoundCloud download limit reached') return { code: 'download-limit', text: 'its download limit is used up' };
  if (row.free.kind === 'none') return { code: 'no-download', text: row.purchaseUrl ? `it offers no free download (its link is "${row.purchaseTitle || row.purchaseUrl}")` : 'it offers no free download' };
  return { code: 'low-match', text: 'the match was too weak' };
}

/** Which near misses say most: the track itself, out of reach, before another
 *  cut of it, before another version. */
const MISS_ORDER = { 'no-download': 0, 'download-limit': 0, 'lossy-title': 0, 'gate-off': 0, 'gate-lossy': 0, 'other-length': 1, 'low-match': 2, 'other-version': 3 };
const byUsefulness = (a, b) => (MISS_ORDER[a.why.code] ?? 2) - (MISS_ORDER[b.why.code] ?? 2) || b.confidence - a.confidence;

function missFrom(row, s, why) {
  return { url: row.url, listedAs: row.scTitle, uploader: row.uploader, confidence: round2(s.rawScore + (s.versionMismatch ? s.penalty : 0)), why };
}

/**
 * Free uploads of the wanted track, best first, and the near misses: uploads
 * close enough to be the track that were passed over, with why. Uploads whose
 * title says MP3 are skipped. Ties go to the native button: no gate to walk.
 */
export function rankSoundCloudFree(want, rawTracks) {
  const picks = [];
  const misses = [];
  for (const raw of rawTracks) {
    const row = normalizeLikedTrack(raw);
    const s = bestFreeScore(want, row);
    const lossyTitle = LOSSY_TITLE_RE.test(row.scTitle);
    if (row.free.kind !== 'none' && !lossyTitle && s.score >= FREE_MATCH_FLOOR) {
      picks.push({ row, parts: s });
      continue;
    }
    const closeness = s.rawScore + (s.versionMismatch ? s.penalty : 0);
    if (!s.artistFloored && closeness >= NEAR_MISS_FLOOR) misses.push(missFrom(row, s, missWhy(want, row, s, lossyTitle)));
  }
  picks.sort((a, b) => b.parts.score - a.parts.score
    || (a.row.free.kind === 'native' ? 0 : 1) - (b.row.free.kind === 'native' ? 0 : 1));
  misses.sort(byUsefulness);
  return { picks, misses };
}

function hitFrom({ row, parts }) {
  const host = row.free.gate?.host || null;
  return {
    source: 'soundcloud',
    kind: row.free.kind,
    url: row.url,
    artist: row.artist,
    title: row.title,
    listedAs: row.scTitle,
    uploader: row.uploader,
    duration: row.duration,
    confidence: round2(parts.score),
    durationGap: parts.durationGap,
    gate: row.free.gate ? { host, url: row.free.gate.url } : null,
    gateInfo: null,
    lossless: 'on-arrival',
    reason: row.free.kind === 'native' ? 'SoundCloud download button'
      : host ? `Free download via ${GATE_NAMES[host] || host}` : `Free download link (${row.free.reason})`,
    fetchRow: row,
  };
}

/** The best free upload of the wanted track, before any gate is read. */
export function pickSoundCloudFree(want, rawTracks) {
  const { picks } = rankSoundCloudFree(want, rawTracks);
  return picks.length ? hitFrom(picks[0]) : null;
}

/** What to ask SoundCloud's search: artist and title as tagged, then the
 *  SoundCloud-style split of the title, else the title on its own. */
export function soundCloudQueries(want) {
  const qs = [`${want.artist || ''} ${want.title || ''}`];
  const split = wantReadings(want)[1];
  qs.push(split ? `${split.artist} ${split.title}` : want.title || '');
  return [...new Set(qs.map(q => q.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

/**
 * The best free SoundCloud upload, with its gate read where the host allows
 * (a gate that's switched off, or gives an MP3, is passed over), and the near
 * misses. `inspect` and `search` are for tests.
 */
export async function searchSoundCloudFree(want, { inspect = inspectGate, search = searchTracksPublic } = {}) {
  const seen = new Set();
  const picks = [];
  const misses = [];
  for (const q of soundCloudQueries(want)) {
    const raw = (await search(q, { limit: 20 })).filter(r => !seen.has(r.id) && seen.add(r.id));
    const r = rankSoundCloudFree(want, raw);
    picks.push(...r.picks);
    misses.push(...r.misses);
    if (picks.length) break;
  }
  picks.sort((a, b) => b.parts.score - a.parts.score);
  let hit = null;
  for (const p of picks.slice(0, INSPECT_PICKS)) {
    const h = hitFrom(p);
    if (h.kind === 'gate' && h.gate?.host) {
      let info = null;
      try { info = await inspect(h.gate); } catch (err) { h.gateNote = `Couldn't read the download page (${err.message})`; }
      if (info) {
        h.gateInfo = { format: info.format, lossless: info.lossless, needs: info.needs, optional: info.optional || [], active: info.active };
        if (!info.active) { misses.push(missFrom(p.row, p.parts, { code: 'gate-off', text: 'its download page is switched off' })); continue; }
        if (info.lossless === false) { misses.push(missFrom(p.row, p.parts, { code: 'gate-lossy', text: `its download is an ${info.format}` })); continue; }
        if (info.lossless) h.lossless = 'source';
        const name = GATE_NAMES[h.gate.host] || h.gate.host;
        const what = info.format ? `Free ${info.format} via ${name}` : `Free download via ${name}`;
        h.reason = info.needs.length ? `${what} (asks for ${listWords(info.needs.map(n => NEED_WORDS[n] || n))})` : what;
      }
    }
    hit = h;
    break;
  }
  const byUrl = new Map();
  for (const m of misses.sort(byUsefulness)) if (!byUrl.has(m.url) && m.url !== hit?.url) byUrl.set(m.url, m);
  return { hit, misses: [...byUrl.values()].slice(0, NEAR_MISSES) };
}

// ---------- a link the user found ----------

/** Where a link ends up after its redirects (ipln.io → gate.influenceplanner.com). */
async function finalUrl(url) {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    res.body?.cancel?.().catch?.(() => {});
    return res.url || url;
  } catch {
    return url;
  }
}

/**
 * A free copy from a link the user found by hand: a SoundCloud track page, or
 * the download page itself (Influence Planner, Hypeddit, a short link…). It
 * is checked against the wanted track where it can be — the SoundCloud
 * upload's title and length, or what an Influence Planner gate says it holds —
 * and kept either way, since the user chose it; `warning` says when it may
 * not be the same version, or when nothing could be checked.
 * Returns { hit, warning }; throws when the link is no use at all.
 */
export async function freeHitFromLink(want, link, { inspect = inspectGate, resolve = resolveTrackPublic, follow = finalUrl } = {}) {
  let url;
  try { url = new URL(String(link).trim()).href; } catch { throw new Error("That isn't a link. Paste the whole address, starting with https://"); }
  const host = hostOf(url) || '';
  let row = null;
  let gate = null;
  let info = null;

  if (/(^|\.)soundcloud\.com$/.test(host)) {
    row = normalizeLikedTrack(await resolve(url));
    if (row.free.kind === 'none') {
      throw new Error(`That SoundCloud upload doesn't offer a free download Track Lab can see (${row.free.reason}). Paste the download page's link instead.`);
    }
    gate = row.free.gate || null;
  } else {
    const landed = await follow(url);
    const gateHost = knownGateHost(landed) || knownGateHost(url);
    gate = { host: gateHost, url, title: 'link you pasted' };
  }

  if (gate?.host) {
    try { info = await inspect(gate); } catch { info = null; }
  }
  // An Influence Planner gate names its SoundCloud track: read that for the check.
  if (!row && info?.scTrackId) {
    try { row = normalizeLikedTrack(await resolve(info.scTrackId)); } catch { row = null; }
  }
  if (info && !info.active) throw new Error('That download page is switched off.');
  if (info && info.lossless === false) throw new Error(`That download page gives an ${info.format}, so it wouldn't be an upgrade.`);

  const fetchRow = row
    ? { ...row, free: gate && gate !== row.free.gate ? { kind: 'gate', gate, reason: 'link you pasted' } : row.free }
    : {
        scId: `link:${url}`, source: 'soundcloud', scTitle: info?.title ? `${info.artists ? `${info.artists} - ` : ''}${info.title}` : url,
        artist: info?.artists || want.artist, title: info?.title || want.title, uploader: '', uploaderId: null, url, duration: null,
        free: { kind: 'gate', gate, reason: 'link you pasted' },
      };
  const s = row ? bestFreeScore(want, row) : null;
  const name = gate?.host ? (GATE_NAMES[gate.host] || gate.host) : null;
  const what = info?.format ? `Free ${info.format}${name ? ` via ${name}` : ''}` : fetchRow.free.kind === 'native' ? 'SoundCloud download button' : name ? `Free download via ${name}` : 'Free download link';
  const hit = {
    source: 'soundcloud',
    kind: fetchRow.free.kind,
    url: row?.url || url,
    artist: fetchRow.artist,
    title: fetchRow.title,
    listedAs: fetchRow.scTitle,
    uploader: fetchRow.uploader,
    duration: fetchRow.duration,
    confidence: s ? round2(s.score) : 0,
    durationGap: s?.durationGap ?? null,
    gate: fetchRow.free.gate ? { host: fetchRow.free.gate.host, url: fetchRow.free.gate.url } : null,
    gateInfo: info ? { format: info.format, lossless: info.lossless, needs: info.needs, optional: info.optional || [], active: info.active } : null,
    lossless: info?.lossless ? 'source' : 'on-arrival',
    reason: info?.needs?.length ? `${what} (asks for ${listWords(info.needs.map(n => NEED_WORDS[n] || n))})` : what,
    pasted: true,
    fetchRow,
  };
  let warning = null;
  if (!s) warning = "Track Lab can't see what's behind this link, so it can't check it's the same version. A compressed file is deleted when it arrives.";
  else if (s.versionMismatch) warning = `This looks like another version ("${row.title}"). The swap keeps your cues, so check it before you swap it in.`;
  else if (s.durationMismatch) warning = `This is ${s.durationGap}s ${row.duration > want.duration ? 'longer' : 'shorter'} than yours, so it may be another cut. Check it before you swap it in.`;
  else if (s.score < FREE_MATCH_FLOOR) warning = `Track Lab is only ${Math.round(s.score * 100)}% sure this is the same track.`;
  return { hit, warning };
}

// ---------- Bandcamp ----------

/** Readings of one Bandcamp search result, best-scoring first. */
export function rankBandcampResults(want, results) {
  return results
    .filter(r => r.type === 't' && r.item_url_path)
    .map(r => {
      const parsed = parseSoundCloudTitle(r.name, { uploader: r.band_name || '' });
      const best = bestReading(want, [{ artist: r.band_name || '', title: r.name || '' }, parsed], null);
      return { result: r, score: best.parts.score };
    })
    .filter(x => x.score >= FREE_MATCH_FLOOR)
    .sort((a, b) => b.score - a.score);
}

/** data-tralbum and the band's currency, from a Bandcamp track page. */
export function parseTralbumHtml(html) {
  const m = /data-tralbum="([^"]*)"/.exec(html);
  if (!m) return null;
  let tralbum;
  try { tralbum = JSON.parse(decodeEntities(m[1])); } catch { return null; }
  const currency = /data-band-currency="([A-Z]{3})"/.exec(html)?.[1] || null;
  return { tralbum, currency };
}

function decodeEntities(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** What Bandcamp asks for this track: free, or a minimum price. Null when
 *  the track can't be bought on its own (album-only, unreleased). */
export function bandcampOffer({ tralbum, currency }) {
  const track = tralbum.trackinfo?.[0] || {};
  if (tralbum.item_type !== 'track' || track.is_downloadable === false || track.unreleased_track) return null;
  if (tralbum.freeDownloadPage) return { kind: 'free', needsEmail: false, price: null };
  const min = tralbum.current?.minimum_price;
  if (typeof min !== 'number') return null;
  if (min === 0) return { kind: 'free', needsEmail: !!tralbum.current?.require_email, price: null };
  return { kind: 'paid', needsEmail: false, price: { amount: min, currency: currency || 'USD', label: formatPrice(min, currency || 'USD') } };
}

function formatPrice(amount, currency) {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount); } catch { return `${amount.toFixed(2)} ${currency}`; }
}

/** One Bandcamp track page as a hit for `want`, or null when it isn't one. */
export function bandcampHit(want, url, page, searchResult = {}) {
  const offer = bandcampOffer(page);
  if (!offer) return null;
  const t = page.tralbum;
  const name = t.current?.title || searchResult.name || '';
  const band = t.artist || searchResult.band_name || '';
  const duration = t.trackinfo?.[0]?.duration ? Math.round(t.trackinfo[0].duration) : null;
  const best = bestReading(want, [{ artist: band, title: name }, parseSoundCloudTitle(name, { uploader: band })], duration);
  if (best.parts.score < FREE_MATCH_FLOOR) return null;
  const free = offer.kind === 'free';
  return {
    source: 'bandcamp',
    kind: offer.kind,
    url,
    artist: best.reading.artist,
    title: best.reading.title,
    listedAs: name,
    uploader: searchResult.band_name || band,
    duration,
    confidence: round2(best.parts.score),
    durationGap: best.parts.durationGap,
    price: offer.price,
    needsEmail: offer.needsEmail,
    lossless: 'source',
    reason: free
      ? (offer.needsEmail ? 'Free on Bandcamp, but Bandcamp sends it by email' : 'Free on Bandcamp')
      : `${offer.price.label} or more on Bandcamp`,
    // Only a free copy goes to the downloader; a priced one is Ben's to buy.
    fetchRow: free ? {
      scId: `bandcamp:${t.id ?? searchResult.id ?? url}`,
      source: 'bandcamp',
      scTitle: name,
      artist: best.reading.artist,
      title: best.reading.title,
      uploader: searchResult.band_name || band,
      uploaderId: null,
      url,
      duration,
      free: { kind: 'gate', gate: { host: 'bandcamp.com', url, title: 'name your price' }, reason: 'Bandcamp name your price' },
    } : null,
  };
}

/** Bandcamp's search wants every word to match, so a version tag or a "The"
 *  the uploader left off ("PRODIGY - VOODOO PEOPLE - DWAINE WHYTE BOOTLEG")
 *  returns nothing. Ask for the bare title with and without the artist; the
 *  version is checked when the results are scored. */
export function bandcampQueries(want) {
  const base = normalizeLoose(want.title);
  const artist = normalizeLoose(want.artist).replace(/^the\s+/, '');
  return [...new Set([`${artist} ${base}`.trim(), base].filter(Boolean))];
}

async function searchBandcamp(query) {
  const res = await fetch(BANDCAMP_SEARCH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ search_text: query, search_filter: 't', full_page: false, fan_id: null }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Bandcamp search failed: HTTP ${res.status}`);
  return (await res.json()).auto?.results || [];
}

async function fetchTrackPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Bandcamp page ${url}: HTTP ${res.status}`);
  return parseTralbumHtml(await res.text());
}

/** The best Bandcamp copy: a free one beats a priced one, then the higher score. */
export async function searchBandcampCopy(want) {
  const results = new Map();
  for (const q of bandcampQueries(want)) {
    for (const r of await searchBandcamp(q)) if (!results.has(r.id)) results.set(r.id, r);
  }
  const ranked = rankBandcampResults(want, [...results.values()]).slice(0, BANDCAMP_PAGES);
  let best = null;
  for (const { result } of ranked) {
    await sleep(BANDCAMP_PAUSE_MS);
    const page = await fetchTrackPage(result.item_url_path).catch(() => null);
    const hit = page && bandcampHit(want, result.item_url_path, page, result);
    if (!hit) continue;
    if (!best || (hit.kind === 'free' && best.kind !== 'free') || (hit.kind === best.kind && hit.confidence > best.confidence)) best = hit;
  }
  return best;
}

// ---------- both, in order ----------

/** The copy to go for first: SoundCloud free, then Bandcamp free, then Bandcamp priced. */
export function primaryFree(found) {
  return found.soundcloud || found.bandcamp || null;
}

/** True unless Bandcamp gives it away with no email: only then is a free
 *  lossless copy certain, and the paid stores need not be searched. A
 *  SoundCloud file may still turn out to be an MP3. */
export function needsStoreSearch(found) {
  return !(found.bandcamp?.kind === 'free' && !found.bandcamp.needsEmail);
}

/**
 * SoundCloud and Bandcamp for one track. A failed search is reported in
 * `errors`, never as "not there". `soundcloudMisses` are the uploads close
 * enough to be the track that were passed over, with why.
 * `want` is { artist, title, duration? (seconds) }.
 */
export async function findFreeSources(want) {
  const found = { soundcloud: null, bandcamp: null, soundcloudMisses: [], errors: [] };
  try {
    const sc = await searchSoundCloudFree(want);
    found.soundcloud = sc.hit;
    found.soundcloudMisses = sc.misses;
  } catch (err) { found.errors.push(`SoundCloud: ${err.message}`); }
  try { found.bandcamp = await searchBandcampCopy(want); } catch (err) { found.errors.push(`Bandcamp: ${err.message}`); }
  return found;
}

/**
 * What a --tracks session did for each upgradeKey: the lossless file it
 * landed (this run, or an earlier run per the ledger), and every source tried
 * on the way, so a miss can say why ("MP3 only, deleted", "needs an email").
 */
export function upgradeOutcomes(session) {
  const out = {};
  const entry = key => (out[key] ||= { filePath: null, source: null, attempts: [] });
  const lossless = files => (files || []).filter(f => f.lossless === true);
  // A gate zip can be a stem pack, filed one stem per file. Which one is the
  // full track is a person's call; swapping a stem in would lose the mix.
  const onlyFile = files => (lossless(files).length === 1 ? lossless(files)[0].path : null);
  for (const r of session.alreadyDownloaded || []) {
    const file = r.upgradeKey && onlyFile(r.ledger?.files);
    if (file) Object.assign(entry(r.upgradeKey), { filePath: file, source: r.source || 'soundcloud', earlier: true });
  }
  const tried = ['downloaded', 'flagged', 'dropped', 'byHand', 'queue', 'notFree'].flatMap(b => session[b] || []);
  for (const r of tried) {
    if (!r.upgradeKey) continue;
    const e = entry(r.upgradeKey);
    const o = r.outcome || { status: 'pending' };
    const got = o.status === 'downloaded' ? lossless(o.files).length : 0;
    const file = got === 1 ? onlyFile(o.files) : null;
    if (file && !e.filePath) Object.assign(e, { filePath: file, source: r.source || 'soundcloud' });
    const status = got > 1 ? 'several-files'
      : o.status === 'downloaded' && !file ? 'lossy'
      : r.free?.kind === 'none' && o.status !== 'not-free' ? 'not-free' : o.status;
    const reason = got > 1 ? `${got} lossless files arrived (a stem pack?); pick the full track in the intake folder`
      : status === 'lossy' ? 'only a lossy file arrived (kept under lossy/)'
      : o.reason || r.free?.reason || '';
    e.attempts.push({ source: r.source || 'soundcloud', url: r.url, status, reason });
  }
  return out;
}

/** Rows for bin/source-soundcloud-likes.mjs --tracks, in the order they are
 *  tried: for each wanted track, SoundCloud first, then a free Bandcamp copy.
 *  `upgradeKey` ties a row back to what it upgrades; once one row for a key
 *  lands a lossless file, the rest for that key are skipped. */
export function toFetchRows(entries) {
  const rows = [];
  for (const { key, found } of entries) {
    for (const hit of [found.soundcloud, found.bandcamp]) {
      if (hit?.fetchRow) rows.push({ ...hit.fetchRow, upgradeKey: key });
    }
  }
  return rows;
}
