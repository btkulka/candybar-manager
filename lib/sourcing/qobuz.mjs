// Qobuz — anonymous HTTP. No login, no browser, no Electron session.
//
// Verified live: the albums search page still ships its results inline in
// `data-live-props-value`, and the per-track add-to-cart popin is readable
// logged-out. The popin's `data-cart-link` (/v4/ajax/add-cart?articleId=...)
// is a GET, but one that answers ONLY to an XHR — a plain navigation 404s
// (checked 2026-09-07, signed in and out). So the link is the article id
// carrier, not something a page can click; see cart.mjs for the real add.

import { storeScore, storeScoreParts } from './matching.mjs';

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
        title: a.title,
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

/** Resolve the individual track inside an album page whose title best matches
 *  what we want. Search returns ALBUM ids; carts need TRACK ids. */
export async function resolveTrackId(albumUrl, want) {
  const html = await fetchPage(albumUrl);
  const ids = [...new Set([...html.matchAll(/popin-add-cart\/track\/(\d+)/g)].map(m => m[1]))];
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0];

  // Multi-track release: score each track's title from the surrounding markup.
  let bestId = ids[0], bestScore = -1;
  for (const id of ids) {
    const at = html.indexOf(`popin-add-cart/track/${id}`);
    const context = html.slice(Math.max(0, at - 1200), at + 400).replace(/<[^>]+>/g, ' ');
    const score = storeScore(want, [want.artist], decodeEntities(context).replace(/\s+/g, ' '));
    if (score > bestScore) { bestScore = score; bestId = id; }
  }
  return bestId;
}

/**
 * Every purchasable quality tier for a track, best first.
 * Each entry: { label, price, cartUrl, lossless }.
 */
export async function cartOptions(trackId) {
  const html = await fetchPage(`${BASE}/v4/ajax/popin-add-cart/track/${trackId}`, { xhr: true });
  const options = [];

  for (const m of html.matchAll(/data-cart-link="([^"]*articleId=[^"]*)"/g)) {
    const link = decodeEntities(m[1]);
    // The tier label and price sit AFTER the attribute in the markup, so read
    // forward from the end of the match — not from the attribute itself.
    const at = m.index + m[0].length;
    const text = decodeEntities(html.slice(at, at + 600).replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ').trim();

    // Each quality button carries its own attributes — read those rather than
    // scraping visible text, which varies by locale.
    const window = html.slice(at, at + 600);
    const label = (window.match(/data-label="([^"]+)"/) || [])[1]
      || (text.match(/^[^$€£]*/) || [''])[0].trim().slice(0, 40);
    const priceMatch = text.match(/[$€£]\s?\d+[.,]\d{2}/);

    const hiRes = /hi[\s-]?res|24[\s-]?bit|studio master/i.test(label + ' ' + text);
    const cd = /cd quality|16[\s-]?bit|lossless|flac/i.test(label + ' ' + text);
    const mp3 = /\bmp3\b|\b320\b|lossy/i.test(label + ' ' + text);

    options.push({
      label: label.trim(),
      price: priceMatch ? priceMatch[0] : null,
      cartUrl: link.startsWith('http') ? link : `${BASE}${link}`,
      lossless: hiRes || (cd && !mp3),
      rank: hiRes ? 3 : cd && !mp3 ? 2 : 1,
    });
  }

  options.sort((a, b) => b.rank - a.rank);
  return options;
}

/** Full resolution for one winning match: track id + purchasable tiers.
 *  `prefer` picks which lossless tier becomes the primary buy link. */
export async function resolveCart(match, want, { prefer = 'hires' } = {}) {
  const trackId = await resolveTrackId(match.url, want);
  if (!trackId) return { ...match, cartError: 'no track id on album page' };

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
