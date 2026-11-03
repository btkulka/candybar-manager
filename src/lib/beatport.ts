/**
 * Beatport catalog search.
 *
 * www.beatport.com answers 403 to a plain fetch and to headless Chrome
 * (Cloudflare — verified live for the CLI, see lib/sourcing/beatport.mjs), so
 * nothing here scrapes it from Node. With a signed-in session's Bearer token,
 * search goes to api.beatport.com, which isn't behind Cloudflare and takes no
 * cookies — the CLI's fast path. Without one, the search page is read from a
 * hidden page on the Beatport session partition (storeBrowser.ts), a real
 * Chromium the store treats like any visitor. Failures throw; they are never
 * an empty result.
 */

import { sessionFetch } from './storeBrowser';
import { getAnyBeatportAccessToken, beatportSearchPartition, invalidateBeatportToken } from './storePurchase';

export type BeatportTrack = {
  id: string;
  name: string;
  artists: string[];
  remixers: string[];
  label: string;
  genre: string;
  bpm: number | null;
  key: string | null;
  release_date: string | null;
  price: string | null;
  url: string;
};

export type BeatportArtist = {
  id: string;
  name: string;
  url: string;
};

export type BeatportSearchResult = {
  tracks: BeatportTrack[];
  artists: BeatportArtist[];
};

const BASE_URL = 'https://www.beatport.com';
const API = 'https://api.beatport.com/v4';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function slugify(s: string): string {
  return s.toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80) || '-';
}

/** One track row from either the API (`name`, `artists[].name`, `id`) or the
 *  search page (`track_name`, `artists[].artist_name`, `track_id`). Beatport
 *  sometimes bakes the mix name into the name already, so it's only appended
 *  when it isn't there. */
export function normalizeBeatportTrack(t: BeatportApiTrack): BeatportTrack {
  const name = t.track_name ?? t.name ?? '';
  const mix = t.mix_name && t.mix_name !== 'Original Mix' && !name.toLowerCase().includes(t.mix_name.toLowerCase())
    ? ` (${t.mix_name})` : '';
  const id = String(t.track_id ?? t.id ?? '');
  return {
    id,
    name: `${name}${mix}`,
    artists: (t.artists ?? []).map(a => a.artist_name ?? a.name ?? '').filter(Boolean),
    remixers: (t.remixers ?? []).map(a => a.artist_name ?? a.name ?? '').filter(Boolean),
    label: t.label?.label_name ?? t.label?.name ?? '',
    genre: (Array.isArray(t.genre) ? t.genre[0]?.genre_name : t.genre?.name) ?? '',
    bpm: t.bpm ?? null,
    key: t.key_name ?? t.key?.name ?? null,
    release_date: t.release_date ?? t.publish_date ?? t.new_release_date ?? null,
    price: t.price?.display ?? null,
    url: `${BASE_URL}/track/${t.slug || slugify(name || 'track')}/${id}`,
  };
}

/** The tracks (or artists) array out of the search page's Next.js payload,
 *  wherever its query lands it. */
export function rowsFromNextData(html: string, kind: 'tracks' | 'artists'): unknown[] {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s);
  if (!m) throw new Error('Beatport page had no search data (blocked, or the markup changed)');
  let data: NextData;
  try { data = JSON.parse(m[1]) as NextData; } catch (err) {
    throw new Error(`Beatport page data JSON parse failed: ${(err as Error).message}`);
  }
  for (const q of data.props?.pageProps?.dehydratedState?.queries ?? []) {
    const d = q?.state?.data as { data?: unknown; artists?: unknown } | unknown[] | undefined;
    const rows = kind === 'artists'
      ? (Array.isArray((d as { artists?: unknown })?.artists) ? (d as { artists: unknown[] }).artists : null)
      : (Array.isArray((d as { data?: unknown })?.data) ? (d as { data: unknown[] }).data : Array.isArray(d) ? d : null);
    if (!rows) continue;
    if (kind === 'artists' || rows.some(r => r && typeof r === 'object' && ('track_name' in r || 'mix_name' in r))) return rows;
  }
  return [];
}

/** The search API with the signed-in session's token, or null when there's
 *  no token (or it just stopped working). */
async function searchViaApi(type: 'tracks' | 'artists', query: string): Promise<unknown[] | null> {
  const auth = getAnyBeatportAccessToken();
  if (!auth) return null;
  const res = await fetch(`${API}/catalog/search/?q=${encodeURIComponent(query)}&type=${type}&per_page=20`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', Authorization: `Bearer ${auth.token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401) {
    invalidateBeatportToken(auth.accountId);
    return null;
  }
  if (!res.ok) throw new Error(`Beatport API search ${res.status}`);
  const data = await res.json() as Record<string, unknown>;
  const rows = data[type] ?? data.results ?? data.data ?? [];
  return Array.isArray(rows) ? rows : [];
}

/** The search page, read from inside the Beatport session. */
async function searchViaPage(type: 'tracks' | 'artists', query: string, page: number): Promise<unknown[]> {
  const res = await sessionFetch(beatportSearchPartition(), BASE_URL, `/search/${type}?q=${encodeURIComponent(query)}&page=${page}`, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  if (res.status !== 200) throw new Error(`Beatport search ${res.status || 'unreachable'}${res.status ? '' : `: ${res.text}`}`);
  return rowsFromNextData(res.text, type);
}

export async function searchBeatportTracks(query: string, page = 1): Promise<BeatportTrack[]> {
  const rows = (page === 1 ? await searchViaApi('tracks', query) : null) ?? await searchViaPage('tracks', query, page);
  return (rows as BeatportApiTrack[]).filter(t => t && (t.track_id ?? t.id) != null).map(normalizeBeatportTrack);
}

export async function searchBeatportArtists(query: string, page = 1): Promise<BeatportArtist[]> {
  const rows = (page === 1 ? await searchViaApi('artists', query) : null) ?? await searchViaPage('artists', query, page);
  return (rows as Array<{ id?: number; artist_id?: number; name?: string; artist_name?: string; slug?: string }>)
    .filter(a => a && (a.id ?? a.artist_id) != null)
    .map(a => {
      const id = String(a.id ?? a.artist_id);
      const name = a.name ?? a.artist_name ?? '';
      return { id, name, url: `${BASE_URL}/artist/${a.slug || slugify(name)}/${id}` };
    });
}

export async function searchBeatport(query: string): Promise<BeatportSearchResult> {
  const [tracks, artists] = await Promise.all([
    searchBeatportTracks(query),
    searchBeatportArtists(query)
  ]);

  return { tracks, artists };
}

// Beatport payload shapes (partial). The search page's Next.js data (2026):
// queries[n].state.data.data[] with track_id/track_name/mix_name; the API:
// tracks[] with id/name/mix_name. normalizeBeatportTrack reads both.
type BeatportApiTrack = {
  id?: number;
  track_id?: number;
  name?: string;
  track_name?: string;
  mix_name?: string;
  slug?: string;
  artists?: Array<{ name?: string; artist_name?: string }>;
  remixers?: Array<{ name?: string; artist_name?: string }>;
  label?: { name?: string; label_name?: string };
  genre?: Array<{ genre_name?: string }> | { name?: string };
  bpm?: number;
  key_name?: string;
  key?: { name?: string };
  release_date?: string;
  publish_date?: string;
  new_release_date?: string;
  price?: { display?: string };
};

type NextData = {
  props?: {
    pageProps?: {
      dehydratedState?: {
        queries?: Array<{ state?: { data?: unknown } }>;
      };
    };
  };
};
