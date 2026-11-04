// Beatport — real Chrome required.
//
// Verified live: www.beatport.com returns 403 to plain fetch AND to headless
// Chrome (Cloudflare fingerprints both). Headed real Chrome via
// launchSiteBrowser gets 200 with the full __NEXT_DATA__ payload. So search
// runs inside the browser.
//
// api.beatport.com, by contrast, answers 401 — not 403 — so it is NOT
// Cloudflare-gated: when this profile happens to be signed in, its Bearer
// token lets search run over plain HTTP (faster); signed out, search reads the
// page. Sign-in and cart adds belong to Track Lab's Beatport accounts and go
// through its store bridge (lib/storeBridge.mjs), not this profile.

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
