// Qobuz — anonymous HTTP. No login, no browser, no Electron session.
//
// Verified live: the albums search page still ships its results inline in
// `data-live-props-value`, and the per-track add-to-cart popin is readable
// logged-out. The popin's `data-cart-link` (/v4/ajax/add-cart?articleId=...)
// is a GET, but one that answers ONLY to an XHR — a plain navigation 404s
// (checked 2026-09-07, signed in and out). So the link is the article id
// carrier, not something a page can click; see cart.mjs for the real add.

import { storeScoreParts, withVersion, STORE_MATCH_FLOOR } from './matching.mjs';

const BASE = 'https://www.qobuz.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Retry only what retrying can fix: rate limits, gateway hiccups, and dropped
 *  connections. A 404 is an answer, not a hiccup — one wrong URL must not cost
 *  three round trips per track across a whole playlist. */
function isTransient(status) {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

async function fetchPage(url, { xhr = false, attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          // The add-to-cart popin 404s unless it's asked for as an XHR — it's
          // an AJAX fragment endpoint, not a page.
          ...(xhr ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
        },
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return res.text();
      if (!isTransient(res.status) || attempt === attempts) {
        throw new Error(`Qobuz ${res.status} for ${url}`);
      }
      lastError = new Error(`Qobuz ${res.status} for ${url}`);
    } catch (err) {
      // A thrown non-transient HTTP error must not be retried as if it were a
      // network fault.
      if (/Qobuz \d+ for/.test(err.message) && !isTransient(Number(err.message.match(/Qobuz (\d+)/)?.[1]))) throw err;
      if (attempt === attempts) throw err;
      lastError = err;
    }
    await sleep(400 * 2 ** (attempt - 1)); // 400ms, 800ms
  }
  throw lastError;
}

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Cover art lives at /images/covers/{id[-2:]}/{id[-4:-2]}/{id}_600.jpg */
function coverUrl(id) {
  if (!id || id.length < 4) return null;
  return `https://static.qobuz.com/images/covers/${id.slice(-2)}/${id.slice(-4, -2)}/${id}_600.jpg`;
}

/** Parse "24-Bit 44.1 kHz" into a comparable number, for picking the best of
 *  several lossless editions of the same record. */
function qualityScore(bitDepth, samplingRate) {
  const b = parseFloat(String(bitDepth || '').replace(/[^\d.]/g, '')) || 0;
  const s = parseFloat(String(samplingRate || '').replace(/[^\d.]/g, '')) || 0;
  return b * s;
}

export async function searchQobuz(query) {
  const html = await fetchPage(`${BASE}/us-en/search/albums/${encodeURIComponent(query)}`);
  for (const m of html.matchAll(/data-live-props-value="([^"]+)"/g)) {
    const decoded = decodeEntities(m[1]);
    if (!decoded.includes('"albums"') || !decoded.includes('"paginationData"')) continue;
    try {
      const outer = JSON.parse(decoded);
      if (!outer.albums) continue;
      const inner = JSON.parse(outer.albums);
      return Object.values(inner).map(a => ({
        id: a.id,
        slug: a.slug,
        // Qobuz keeps "HNTR Remix" in `version`, apart from the title.
        title: withVersion(a.title, a.version),
        artists: (a.artists || []).map(x => x.name),
        bitDepth: a.bitDepth || null,
        samplingRate: a.samplingRate || null,
        price: a.price ?? null,
        url: `${BASE}/us-en/album/${a.slug}/${a.id}`,
        image: coverUrl(a.id),
      }));
    } catch {
      /* payload shape changed — try the next candidate blob */
    }
  }
  return [];
}

/** Best Qobuz candidate for a wanted track, or null. */
export async function bestQobuzMatch(want) {
  const albums = await searchQobuz(`${want.artist} ${want.title}`);
  let best = null;
  for (const a of albums) {
    const parts = storeScoreParts(want, a.artists, a.title);
    const q = qualityScore(a.bitDepth, a.samplingRate);
    if (!best || parts.score > best.score || (parts.score === best.score && q > best.qualityScore)) {
      best = { ...a, score: parts.score, scoreParts: parts, qualityScore: q, store: 'qobuz' };
    }
  }
  if (!best) return null;
  // Qobuz publishes bitDepth/samplingRate only for lossless editions.
  best.lossless = Boolean(best.bitDepth && best.samplingRate);
  best.quality = best.bitDepth && best.samplingRate ? `${best.bitDepth} ${best.samplingRate}` : null;
  return best;
}

/** Public web-player app id (not a secret; shipped in Qobuz's own bundle). */
const QOBUZ_APP_ID = '798273057';

/** Every track on a release: the catalog API first (structured, carries each
 *  track's own version), the album page second. A page row whose title can't
 *  be read is left out — a track we can't name is a track we can't check. */
export async function releaseTracks(albumId, albumUrl) {
  if (albumId) {
    try {
      const res = await fetch(`${BASE}/api.json/0.2/album/get?album_id=${encodeURIComponent(albumId)}&app_id=${QOBUZ_APP_ID}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json', 'X-App-Id': QOBUZ_APP_ID },
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) {
        const data = await res.json();
        const albumArtist = data?.artist?.name || '';
        const tracks = (data?.tracks?.items || [])
          .filter(t => t.id && t.title)
          .map(t => ({ id: String(t.id), title: withVersion(t.title, t.version), artist: t.performer?.name || albumArtist }));
        if (tracks.length) return tracks;
      }
    } catch { /* fall back to the page */ }
  }
  if (!albumUrl) return [];
  return parseAlbumPageTracks(await fetchPage(albumUrl));
}

/** Track rows from an album page. Each add-to-cart marker's title is read from
 *  the markup between it and the previous marker — its own row — never from a
 *  window that reaches into the neighbours. */
export function parseAlbumPageTracks(html) {
  const marks = [...html.matchAll(/popin-add-cart\/track\/(\d+)/g)];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < marks.length; i++) {
    const id = marks[i][1];
    if (seen.has(id)) continue;
    const from = i > 0 ? marks[i - 1].index + marks[i - 1][0].length : Math.max(0, marks[i].index - 4000);
    const row = html.slice(from, marks[i].index);
    const pick = cls => {
      const m = row.match(new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</`, 'i'));
      return m ? decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
    };
    const title = pick('track__title') || pick('track__name');
    if (!title) continue;
    seen.add(id);
    out.push({ id, title, artist: pick('track__artist') || pick('track__artists') });
  }
  return out;
}

/** The track on a release that is the record asked for, or null. Scored
 *  against the request — never the release title — and never defaulted to the
 *  first track when nothing clears the floor. Mirrors storeMatching.ts
 *  pickReleaseTrack. */
export async function resolveTrackId(albumUrl, want, albumId = null, albumArtists = []) {
  const tracks = await releaseTracks(albumId, albumUrl);
  let best = null;
  for (const t of tracks) {
    const parts = storeScoreParts(want, t.artist ? [t.artist] : albumArtists, t.title);
    if (!best || parts.score > best.parts.score || (parts.score === best.parts.score && parts.boost > best.parts.boost)) {
      best = { track: t, parts };
    }
  }
  // Every track on a release shares the artist, so the title must clear its
  // own bar (storeMatching.ts RELEASE_TITLE_FLOOR) or a different song passes.
  return best && best.parts.score >= STORE_MATCH_FLOOR && best.parts.titleScore >= 0.75 ? best.track.id : null;
}

/** "mp3" / "cd" / "hires" / "unknown" for one quality option. Only a positive
 *  hi-res or CD/FLAC reading is lossless. Mirrors storeMatching.ts. */
export function classifyTier(text) {
  const t = (text || '').toLowerCase();
  const mp3 = /\bmp3\b|\baac\b|\b(320|256|192|128)\s*k(bps)?\b|lossy/.test(t);
  if (/hi[\s-]?res|hires|hi-resolution|24[\s-]?bit|studio master/.test(t)) return mp3 ? 'unknown' : 'hires';
  if (/cd[\s-]?quality|\bcd\b|16[\s-]?bit|lossless|\bflac\b/.test(t)) return mp3 ? 'unknown' : 'cd';
  return mp3 ? 'lossy' : 'unknown';
}

/**
 * Every purchasable quality tier for a track, best first.
 * Each entry: { label, price, cartUrl, lossless }.
 *
 * Each tier is read from its own element only — the tag carrying the cart link
 * and its content up to the next option — so an MP3 button can never borrow
 * the "Hi-Res" text of the button after it.
 */
export async function cartOptions(trackId) {
  return parseCartOptions(await fetchPage(`${BASE}/v4/ajax/popin-add-cart/track/${trackId}`, { xhr: true }));
}

export function parseCartOptions(html) {
  const marks = [...html.matchAll(/data-cart-link="([^"]*articleId=[^"]*)"/g)];
  const options = [];
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    const link = decodeEntities(m[1]);
    const tagStart = html.lastIndexOf('<', m.index);
    const tagEnd = html.indexOf('>', m.index);
    const tag = html.slice(tagStart, tagEnd + 1);
    const nextTag = i + 1 < marks.length ? html.lastIndexOf('<', marks[i + 1].index) : html.length;
    const body = decodeEntities(html.slice(tagEnd + 1, nextTag).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const attr = name => decodeEntities((tag.match(new RegExp(`${name}="([^"]*)"`)) || [])[1] || '');
    const label = attr('data-label') || body.replace(/[$€£].*$/, '').trim().slice(0, 40);
    const priceMatch = body.match(/[$€£]\s?\d+[.,]\d{2}/);
    const attrPrice = Number(attr('data-price'));
    const kind = classifyTier([label, body, attr('data-format'), attr('data-quality'), attr('aria-label')].join(' '));

    options.push({
      label: label.trim(),
      price: priceMatch ? priceMatch[0] : (attrPrice > 0 ? `$${attrPrice.toFixed(2)}` : null),
      cartUrl: link.startsWith('http') ? link : `${BASE}${link}`,
      lossless: kind === 'hires' || kind === 'cd',
      rank: kind === 'hires' ? 3 : kind === 'cd' ? 2 : 1,
    });
  }

  options.sort((a, b) => b.rank - a.rank);
  return options;
}

/** Full resolution for one winning match: track id + purchasable tiers.
 *  `prefer` picks which lossless tier becomes the primary buy link. */
export async function resolveCart(match, want, { prefer = 'hires' } = {}) {
  const trackId = await resolveTrackId(match.url, want, match.id, match.artists || []);
  if (!trackId) return { ...match, cartError: `couldn't find "${want.title}" on the release` };

  const options = (await cartOptions(trackId)).filter(o => o.lossless);
  if (options.length === 0) {
    return { ...match, trackId, cartError: 'no lossless tier offered' };
  }
  const chosen = prefer === 'cd' ? options[options.length - 1] : options[0];
  return {
    ...match,
    trackId,
    trackUrl: `${BASE}/us-en/album/${match.slug}/${match.id}`,
    cartUrl: chosen.cartUrl,
    cartLabel: chosen.label,
    price: chosen.price || match.price,
    cartOptions: options,
  };
}
