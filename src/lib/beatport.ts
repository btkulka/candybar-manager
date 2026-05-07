/**
 * Beatport scraper for track/artist search
 * Scrapes public search pages - no API key required
 */

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
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchPage(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5'
    }
  });

  if (!response.ok) {
    throw new Error(`Beatport fetch failed: ${response.status}`);
  }

  return response.text();
}

// Parse Next.js __NEXT_DATA__ JSON embedded in page
function extractNextData(html: string): unknown {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s);
  if (!match) {
    throw new Error('Could not find Beatport page data');
  }
  try {
    return JSON.parse(match[1]);
  } catch (err) {
    throw new Error(`Beatport page data JSON parse failed: ${(err as Error).message}`);
  }
}

function slugify(s: string): string {
  return s.toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80) || '-';
}

export async function searchBeatportTracks(query: string, page = 1): Promise<BeatportTrack[]> {
  const url = `${BASE_URL}/search/tracks?q=${encodeURIComponent(query)}&page=${page}`;
  const html = await fetchPage(url);

  try {
    const data = extractNextData(html) as NextDataTracks;
    const tracks = data?.props?.pageProps?.dehydratedState?.queries?.[0]?.state?.data?.data;

    if (!tracks || !Array.isArray(tracks)) {
      return [];
    }

    return tracks.map((t): BeatportTrack => {
      const title = t.mix_name && t.mix_name !== 'Original Mix'
        ? `${t.track_name} (${t.mix_name})`
        : t.track_name ?? '';
      return {
        id: String(t.track_id),
        name: title,
        artists: (t.artists ?? []).map((a) => a.artist_name),
        remixers: [],
        label: t.label?.label_name ?? '',
        genre: t.genre?.[0]?.genre_name ?? '',
        bpm: t.bpm ?? null,
        key: t.key_name ?? null,
        release_date: t.release_date ?? t.publish_date ?? null,
        price: t.price?.display ?? null,
        url: `${BASE_URL}/track/${slugify(t.track_name ?? 'track')}/${t.track_id}`
      };
    });
  } catch {
    // Fallback: try regex parsing if JSON structure changed
    return parseTracksFromHtml(html);
  }
}

export async function searchBeatportArtists(query: string, page = 1): Promise<BeatportArtist[]> {
  const url = `${BASE_URL}/search/artists?q=${encodeURIComponent(query)}&page=${page}`;
  const html = await fetchPage(url);

  try {
    const data = extractNextData(html) as NextDataArtists;
    const artists = data?.props?.pageProps?.dehydratedState?.queries?.[0]?.state?.data?.artists;

    if (!artists || !Array.isArray(artists)) {
      return [];
    }

    return artists.map((a): BeatportArtist => ({
      id: String(a.id),
      name: a.name ?? '',
      url: `${BASE_URL}/artist/${a.slug}/${a.id}`
    }));
  } catch {
    return parseArtistsFromHtml(html);
  }
}

export async function searchBeatport(query: string): Promise<BeatportSearchResult> {
  const [tracks, artists] = await Promise.all([
    searchBeatportTracks(query),
    searchBeatportArtists(query)
  ]);

  return { tracks, artists };
}

// Fallback HTML parsers (regex-based, less reliable)
function parseTracksFromHtml(html: string): BeatportTrack[] {
  const tracks: BeatportTrack[] = [];
  const trackPattern = /href="\/track\/([^/]+)\/(\d+)"[^>]*>([^<]+)/g;
  let match;

  while ((match = trackPattern.exec(html)) !== null) {
    const [, slug, id, name] = match;
    if (!tracks.some(t => t.id === id)) {
      tracks.push({
        id,
        name: decodeHtmlEntities(name.trim()),
        artists: [],
        remixers: [],
        label: '',
        genre: '',
        bpm: null,
        key: null,
        release_date: null,
        price: null,
        url: `${BASE_URL}/track/${slug}/${id}`
      });
    }
  }

  return tracks.slice(0, 20);
}

function parseArtistsFromHtml(html: string): BeatportArtist[] {
  const artists: BeatportArtist[] = [];
  const artistPattern = /href="\/artist\/([^/]+)\/(\d+)"[^>]*>([^<]+)/g;
  let match;

  while ((match = artistPattern.exec(html)) !== null) {
    const [, slug, id, name] = match;
    if (!artists.some(a => a.id === id)) {
      artists.push({
        id,
        name: decodeHtmlEntities(name.trim()),
        url: `${BASE_URL}/artist/${slug}/${id}`
      });
    }
  }

  return artists.slice(0, 20);
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Next.js data types (partial, for extraction)
// Beatport's search API shape (as of 2026): queries[0].state.data.data[]
// with track_id/track_name/mix_name/etc. — NOT the older tracks[].id/name shape.
type NextDataTracks = {
  props?: {
    pageProps?: {
      dehydratedState?: {
        queries?: Array<{
          state?: {
            data?: {
              data?: Array<{
                track_id: number;
                track_name: string;
                mix_name?: string;
                artists?: Array<{ artist_id: number; artist_name: string }>;
                label?: { label_id: number; label_name: string };
                genre?: Array<{ genre_id: number; genre_name: string }>;
                bpm?: number;
                key_name?: string;
                release_date?: string;
                publish_date?: string;
                price?: { display: string };
                release?: { release_id: number; release_name: string };
              }>;
            };
          };
        }>;
      };
    };
  };
};

type NextDataArtists = {
  props?: {
    pageProps?: {
      dehydratedState?: {
        queries?: Array<{
          state?: {
            data?: {
              artists?: Array<{
                id: number;
                name: string;
                slug: string;
              }>;
            };
          };
        }>;
      };
    };
  };
};
