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

import { storeScoreParts, normalizeLoose } from './matching.mjs';
import { normalizeLikedTrack, parseSoundCloudTitle, searchTracksPublic } from './soundcloud.mjs';

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
/** An upload whose title says it's an MP3 ("- 192kbps", "- 192kps", "[MP3]") is never an upgrade. */
const LOSSY_TITLE_RE = /\b(\d{2,3}\s*kb?ps|mp3)\b/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- scoring ----------

/**
 * How well a candidate fits the wanted track: the store scorer, held under
 * the floor when it's another version or another length. The stores only
 * dock a different version 0.12, which leaves "That Acid (ANDUJ Edit)" at
 * 0.88 for "That Acid"; for a swap that keeps the cues, any other cut is wrong.
 */
export function scoreFreeCandidate(want, cand) {
  const parts = storeScoreParts(want, cand.artist, cand.title);
  const durationGap = want.duration && cand.duration ? Math.abs(want.duration - cand.duration) : null;
  const versionMismatch = parts.penalty > 0;
  const durationMismatch = durationGap != null && durationGap > DURATION_TOLERANCE_SEC;
  const score = versionMismatch || durationMismatch ? Math.min(parts.score, FREE_MATCH_FLOOR - 0.01) : parts.score;
  return { ...parts, score, durationGap, versionMismatch, durationMismatch };
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

/**
 * The best SoundCloud upload of the wanted track that has a free download
 * (the native button or a gate), from raw api-v2 search results. Uploads
 * whose title says MP3 are skipped. Ties go to the native button: no gate to walk.
 */
export function pickSoundCloudFree(want, rawTracks) {
  let best = null;
  for (const raw of rawTracks) {
    const row = normalizeLikedTrack(raw);
    if (row.free.kind === 'none' || LOSSY_TITLE_RE.test(row.scTitle)) continue;
    const parts = scoreFreeCandidate(want, row);
    if (parts.score < FREE_MATCH_FLOOR) continue;
    const better = !best || parts.score > best.parts.score
      || (parts.score === best.parts.score && row.free.kind === 'native' && best.row.free.kind !== 'native');
    if (better) best = { row, parts };
  }
  if (!best) return null;
  const { row, parts } = best;
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
    gate: row.free.gate ? { host: row.free.gate.host, url: row.free.gate.url } : null,
    lossless: 'on-arrival',
    reason: row.free.kind === 'native' ? 'SoundCloud download button'
      : row.free.gate?.host ? `Free download via ${row.free.gate.host}` : `Free download link (${row.free.reason})`,
    fetchRow: row,
  };
}

export async function searchSoundCloudFree(want) {
  return pickSoundCloudFree(want, await searchTracksPublic(`${want.artist} ${want.title}`, { limit: 20 }));
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
 * `errors`, never as "not there".
 * `want` is { artist, title, duration? (seconds) }.
 */
export async function findFreeSources(want) {
  const found = { soundcloud: null, bandcamp: null, errors: [] };
  try { found.soundcloud = await searchSoundCloudFree(want); } catch (err) { found.errors.push(`SoundCloud: ${err.message}`); }
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
