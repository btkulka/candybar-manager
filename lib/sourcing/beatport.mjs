// Beatport — real Chrome required.
//
// Verified live: www.beatport.com returns 403 to plain fetch AND to headless
// Chrome (Cloudflare fingerprints both). Headed real Chrome via
// launchSiteBrowser gets 200 with the full __NEXT_DATA__ payload. So search
// runs inside the browser.
//
// api.beatport.com, by contrast, answers 401 — not 403 — so it is NOT
// Cloudflare-gated: once we harvest the session's Bearer token from the
// browser, cart operations can run over plain HTTP from node. Browser for
// auth, HTTP for work.

import { launchSiteBrowser } from '../launchBrowser.mjs';
import { storeScoreParts } from './matching.mjs';

const BASE = 'https://www.beatport.com';
const API = 'https://api.beatport.com/v4';

/** Open the persistent Beatport profile. Headed by default — see above. */
export async function openBeatport({ headless = false } = {}) {
  const ctx = await launchSiteBrowser({ profile: 'beatport', headless });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  return {
    ctx,
    page,
    close: async () => { try { await ctx.close(); } catch { /* already gone */ } },
  };
}

/** Bearer token for the logged-in session, or null when signed out. */
export async function getAccessToken(page) {
  try {
    const sess = await page.evaluate(async () => {
      const r = await fetch('/api/auth/session', { credentials: 'include' });
      if (!r.ok) return null;
      return r.json().catch(() => null);
    });
    // Beatport (NextAuth) nests the live token under `token.accessToken`.
    // The flat spellings are kept as fallbacks in case the shape moves again —
    // reading only those reported a signed-in account as signed out.
    return sess?.token?.accessToken
      || sess?.access_token
      || sess?.accessToken
      || null;
  } catch {
    return null;
  }
}

/** Block until the user completes an interactive login (or times out). */
export async function waitForLogin(page, { timeoutMs = 300000 } = {}) {
  await page.goto(`${BASE}/account/login`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const token = await getAccessToken(page);
    if (token) return token;
    await page.waitForTimeout(2000);
  }
  return null;
}

function normalizeApiTrack(t) {
  // Beatport sometimes bakes the mix name into track_name already
  // ("Delilah (pull me out of this)" + mix_name "pull me out of this"),
  // so only append when it isn't there yet.
  const name = t.track_name || t.name || '';
  const mix = t.mix_name && t.mix_name !== 'Original Mix'
    && !name.toLowerCase().includes(t.mix_name.toLowerCase())
    ? ` (${t.mix_name})` : '';
  const artists = (t.artists || []).map(a => a.artist_name || a.name).filter(Boolean);
  const slug = t.slug || String(t.track_name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const id = String(t.track_id ?? t.id ?? '');
  return {
    id,
    title: `${name}${mix}`,
    artists,
    mix: t.mix_name || null,
    label: t.label?.label_name || t.release?.label?.label_name || null,
    price: t.price?.display || null,
    length: t.length || null,
    image: t.release?.image?.uri || t.image?.uri || null,
    url: `${BASE}/track/${slug}/${id}`,
    store: 'beatport',
    // Beatport sells WAV/AIFF/FLAC on every purchasable track.
    lossless: true,
  };
}

/** Pull the tracks array out of the Next.js payload, wherever it's nested. */
function tracksFromNextData(data) {
  const queries = data?.props?.pageProps?.dehydratedState?.queries || [];
  for (const q of queries) {
    const d = q?.state?.data;
    const rows = Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : null;
    if (rows && rows.some(r => r && (r.track_name || r.mix_name))) return rows;
  }
  return [];
}

/** Search inside the browser page (works signed out). */
export async function searchViaPage(page, query) {
  const url = `${BASE}/search/tracks?q=${encodeURIComponent(query)}`;
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (resp && resp.status() !== 200) throw new Error(`Beatport search ${resp.status()}`);
  const raw = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    return el ? el.textContent : null;
  });
  if (!raw) throw new Error('Beatport page had no __NEXT_DATA__ (blocked or markup changed)');
  return tracksFromNextData(JSON.parse(raw)).map(normalizeApiTrack);
}

/** Search over the API with a harvested token — much faster, no page loads. */
export async function searchViaApi(token, query) {
  const res = await fetch(`${API}/catalog/search/?q=${encodeURIComponent(query)}&type=tracks&per_page=20`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Beatport API search ${res.status}`);
  const data = await res.json();
  const rows = data.tracks || data.results || data.data || [];
  return rows.map(normalizeApiTrack);
}

/** One searcher that prefers the fast path and degrades to the browser. */
export function makeSearcher({ page, token }) {
  let useApi = Boolean(token);
  return async function search(query) {
    if (useApi) {
      try {
        return await searchViaApi(token, query);
      } catch (err) {
        // A dead/expired token shouldn't kill the run — fall back for good.
        useApi = false;
      }
    }
    return searchViaPage(page, query);
  };
}

export async function bestBeatportMatch(search, want) {
  const tracks = await search(`${want.artist} ${want.title}`);
  let best = null;
  for (const t of tracks) {
    const parts = storeScoreParts(want, t.artists, t.title);
    if (!best || parts.score > best.score) best = { ...t, score: parts.score, scoreParts: parts };
  }
  return best;
}

// ---------- cart ----------

/** Resolve the user's default cart id. */
export async function getCartId(token) {
  const res = await fetch(`${API}/my/carts/`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Beatport cart lookup ${res.status}`);
  const raw = await res.json();
  const list = Array.isArray(raw) ? raw : raw.results || raw.carts || [];
  const cart = list.find(c => c.default) || list.find(c => c.name === 'cart') || list[0];
  const id = cart?.id ?? cart?.cart_id;
  if (id == null) throw new Error('Beatport returned no usable cart id');
  return String(id);
}

// (item_type_id, audio_format_id) permutations, best format first. Only track
// adds — item_type_id 2 needs a RELEASE id, and reusing a track id there adds
// an unrelated release to the cart.
// purchase_type_id and source_type_id are REQUIRED — the API 400s without them
// ("This field is required"). Values captured from Beatport's own add-to-cart
// button on a track page, which posts:
//   {item_id, item_type_id:1, audio_format_id:14, purchase_type_id:1, source_type_id:6}
const ADD_ATTEMPTS = [
  { item_type_id: 1, audio_format_id: 14, purchase_type_id: 1, source_type_id: 6 }, // WAV
  { item_type_id: 1, audio_format_id: 5, purchase_type_id: 1, source_type_id: 6 },  // AIFF
  { item_type_id: 1, audio_format_id: 4, purchase_type_id: 1, source_type_id: 6 },  // FLAC
];

/** Track ids already sitting in the cart, so a re-run never double-adds. */
export async function getCartTrackIds(token, cartId) {
  const res = await fetch(`${API}/my/carts/${cartId}/`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Beatport cart read ${res.status}`);
  const cart = await res.json();
  return new Set((cart.tracks || []).map(t => String(t.item_id ?? t.item?.id)));
}

/**
 * Add one track. Returns { ok, format } or { ok:false, error, alreadyPurchased?, authExpired? }.
 *
 * Verified live (2026-09-21): a track the account already owns answers 400
 * {"AlreadyPurchased":{"id":…,"audio_format":…}} for every format, so it is
 * reported rather than retried — it's owned on Beatport but may never have
 * been downloaded into Rekordbox. `audio_format` echoes the format that was
 * requested, not the one that was bought, so it says nothing about the purchase.
 *
 * Only "this format isn't sold" moves on to the next format. AlreadyInCart is
 * the state asked for; a 401 is a dead token and a 429/5xx a busy store, and
 * trying the next format on those would at best waste calls and at worst put
 * the same track in the cart twice in two formats.
 */
export async function addToCart(token, cartId, trackId) {
  let lastError = 'no attempt succeeded';
  for (const attempt of ADD_ATTEMPTS) {
    let res;
    for (let tries = 0; ; tries++) {
      res = await fetch(`${API}/my/carts/${cartId}/items/`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ ...attempt, item_id: Number(trackId) }),
      });
      if (res.status !== 429 || tries >= 2) break;
      const wait = Math.min(Number(res.headers.get('retry-after')) || 2, 30);
      await new Promise(r => setTimeout(r, wait * 1000));
    }
    if (res.ok) return { ok: true, format: attempt.audio_format_id };
    const body = await res.text();
    lastError = `${res.status}: ${body.slice(0, 160)}`;
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* not JSON */ }
    if (parsed?.AlreadyPurchased) return { ok: false, error: lastError, alreadyPurchased: true };
    if (parsed?.AlreadyInCart || /AlreadyInCart/.test(body)) return { ok: true, format: attempt.audio_format_id, alreadyInCart: true };
    if (res.status === 401) return { ok: false, error: lastError, authExpired: true };
    if (res.status !== 400 || !/Item does not exist/i.test(body)) return { ok: false, error: lastError };
  }
  return { ok: false, error: lastError };
}
