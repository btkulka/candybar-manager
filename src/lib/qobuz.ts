/**
 * Qobuz scraper for track/artist search
 * Scrapes public search pages - no API key required
 */

import { createScopedLogger } from './logger';

const log = createScopedLogger('Qobuz');

export type QobuzTrack = {
  id: string;
  name: string;
  artists: string[];
  album: string;
  duration_seconds: number | null;
  quality: string | null;
  price: string | null;
  url: string;
  /** URL of the cover art (600px by convention). null if unavailable. */
  image: string | null;
};

export type QobuzArtist = {
  id: string;
  name: string;
  url: string;
};

export type QobuzAlbum = {
  id: string;
  name: string;
  artist: string;
  year: number | null;
  quality: string | null;
  price: string | null;
  url: string;
};

export type QobuzSearchResult = {
  tracks: QobuzTrack[];
  artists: QobuzArtist[];
  albums: QobuzAlbum[];
};

const BASE_URL = 'https://www.qobuz.com';
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
    throw new Error(`Qobuz fetch failed: ${response.status}`);
  }

  return response.text();
}

// Extract JSON-LD or embedded data from page
function extractPageData(html: string): unknown {
  // Try Next.js data first
  const nextMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s);
  if (nextMatch) {
    try {
      return JSON.parse(nextMatch[1]);
    } catch (err) {
      log.warn('Qobuz __NEXT_DATA__ JSON parse failed, falling back to ld+json', err);
    }
  }

  // Try JSON-LD
  const ldMatch = html.match(/<script type="application\/ld\+json">(.+?)<\/script>/s);
  if (ldMatch) {
    try {
      return JSON.parse(ldMatch[1]);
    } catch (err) {
      log.warn('Qobuz ld+json parse failed', err);
    }
  }

  return null;
}

// Qobuz no longer server-renders the /search/tracks page — only /search/albums
// ships inline data. We search albums and treat each result as a single-track
// candidate (using album title + artist for fuzzy matching). For compilation
// albums this is imperfect, but for singles (the common case) it works well.
export async function searchQobuzTracks(query: string): Promise<QobuzTrack[]> {
  const url = `${BASE_URL}/us-en/search/albums/${encodeURIComponent(query)}`;
  const html = await fetchPage(url);

  const albums = extractLiveAlbums(html);
  if (albums.length === 0) {
    log.debug('Qobuz search returned 0 albums for query:', query);
  }

  return albums.map((a): QobuzTrack => ({
    id: a.id,
    name: a.title,
    artists: a.artists,
    album: a.title,
    duration_seconds: null,
    quality: a.bitDepth && a.samplingRate ? `${a.bitDepth}/${a.samplingRate}` : null,
    price: a.priceDisplay,
    url: `${BASE_URL}/us-en/album/${a.slug}/${a.id}`,
    image: qobuzCoverUrl(a.id),
  }));
}

/** Construct the CDN cover-art URL from a Qobuz album id. Qobuz lays covers
 *  out at `/images/covers/{id.slice(-2)}/{id.slice(-4,-2)}/{id}_600.jpg`. */
function qobuzCoverUrl(id: string): string | null {
  if (!id || id.length < 4) return null;
  const last2 = id.slice(-2);
  const prev2 = id.slice(-4, -2);
  return `https://static.qobuz.com/images/covers/${last2}/${prev2}/${id}_600.jpg`;
}

type LiveAlbum = {
  id: string;
  slug: string;
  title: string;
  artists: string[];
  bitDepth: string | null;
  samplingRate: string | null;
  priceDisplay: string | null;
};

// Extract the inline JSON payload Qobuz stashes in `data-live-props-value` on
// the albums search page. It's HTML-escaped JSON-inside-JSON, so we decode
// entities, parse once, then parse the stringified `albums` value.
function extractLiveAlbums(html: string): LiveAlbum[] {
  const propRe = /data-live-props-value="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = propRe.exec(html)) !== null) {
    const decoded = decodeHtmlEntities(m[1]);
    if (!decoded.includes('"albums"') || !decoded.includes('"paginationData"')) continue;
    try {
      const outer = JSON.parse(decoded) as { albums?: string };
      if (!outer.albums) continue;
      const inner = JSON.parse(outer.albums) as Record<string, {
        id: string;
        slug: string;
        title: string;
        artists?: Array<{ name: string }>;
        bitDepth?: string;
        samplingRate?: string;
        price?: number;
      }>;
      const out: LiveAlbum[] = [];
      for (const a of Object.values(inner)) {
        out.push({
          id: a.id,
          slug: a.slug,
          title: a.title,
          artists: (a.artists ?? []).map(x => x.name),
          bitDepth: a.bitDepth ?? null,
          samplingRate: a.samplingRate ?? null,
          priceDisplay: typeof a.price === 'number' ? `$${a.price.toFixed(2)}` : null,
        });
      }
      return out;
    } catch (err) {
      log.warn('Failed to parse Qobuz data-live-props-value:', err);
    }
  }
  return [];
}


export async function searchQobuzArtists(query: string): Promise<QobuzArtist[]> {
  const url = `${BASE_URL}/us-en/search?q=${encodeURIComponent(query)}&type=artists`;
  const html = await fetchPage(url);

  try {
    const data = extractPageData(html) as QobuzNextData;
    const results = data?.props?.pageProps?.results?.artists?.items;

    if (results && Array.isArray(results)) {
      return results.map((a): QobuzArtist => ({
        id: String(a.id),
        name: a.name ?? '',
        url: a.url ? `${BASE_URL}${a.url}` : `${BASE_URL}/us-en/interpreter/${a.slug}/${a.id}`
      }));
    }
  } catch {
    // Fall through to regex parsing
  }

  return parseArtistsFromHtml(html);
}

export async function searchQobuzAlbums(query: string): Promise<QobuzAlbum[]> {
  const url = `${BASE_URL}/us-en/search?q=${encodeURIComponent(query)}&type=albums`;
  const html = await fetchPage(url);

  try {
    const data = extractPageData(html) as QobuzNextData;
    const results = data?.props?.pageProps?.results?.albums?.items;

    if (results && Array.isArray(results)) {
      return results.map((a): QobuzAlbum => ({
        id: String(a.id),
        name: a.title ?? '',
        artist: a.artist?.name ?? '',
        year: a.release_date_original ? new Date(a.release_date_original).getFullYear() : null,
        quality: a.maximum_bit_depth ? `${a.maximum_bit_depth}bit/${a.maximum_sampling_rate}kHz` : null,
        price: null,
        url: a.url ? `${BASE_URL}${a.url}` : `${BASE_URL}/us-en/album/${a.id}`
      }));
    }
  } catch {
    // Fall through to regex parsing
  }

  return parseAlbumsFromHtml(html);
}

export async function searchQobuz(query: string): Promise<QobuzSearchResult> {
  const [tracks, artists, albums] = await Promise.all([
    searchQobuzTracks(query),
    searchQobuzArtists(query),
    searchQobuzAlbums(query)
  ]);

  return { tracks, artists, albums };
}

// Fallback HTML parsers
function parseTracksFromHtml(html: string): QobuzTrack[] {
  const tracks: QobuzTrack[] = [];
  // Match track links with various patterns
  const patterns = [
    /href="([^"]*\/track\/[^"]+)"[^>]*>([^<]+)/g,
    /data-track-id="(\d+)"[^>]*>.*?<[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)/gs
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const [, urlOrId, name] = match;
      const id = urlOrId.match(/\d+/)?.[0] ?? urlOrId;
      if (!tracks.some(t => t.id === id)) {
        tracks.push({
          id,
          name: decodeHtmlEntities(name.trim()),
          artists: [],
          album: '',
          duration_seconds: null,
          quality: null,
          price: null,
          url: urlOrId.startsWith('/') ? `${BASE_URL}${urlOrId}` : urlOrId,
          image: null,
        });
      }
    }
  }

  return tracks.slice(0, 20);
}

function parseArtistsFromHtml(html: string): QobuzArtist[] {
  const artists: QobuzArtist[] = [];
  const pattern = /href="([^"]*\/interpreter\/[^"]+)"[^>]*>([^<]+)/g;
  let match;

  while ((match = pattern.exec(html)) !== null) {
    const [, url, name] = match;
    const id = url.match(/\d+/)?.[0] ?? url;
    if (!artists.some(a => a.id === id)) {
      artists.push({
        id,
        name: decodeHtmlEntities(name.trim()),
        url: url.startsWith('/') ? `${BASE_URL}${url}` : url
      });
    }
  }

  return artists.slice(0, 20);
}

function parseAlbumsFromHtml(html: string): QobuzAlbum[] {
  const albums: QobuzAlbum[] = [];
  const pattern = /href="([^"]*\/album\/[^"]+)"[^>]*>([^<]+)/g;
  let match;

  while ((match = pattern.exec(html)) !== null) {
    const [, url, name] = match;
    const id = url.match(/\d+/)?.[0] ?? url;
    if (!albums.some(a => a.id === id)) {
      albums.push({
        id,
        name: decodeHtmlEntities(name.trim()),
        artist: '',
        year: null,
        quality: null,
        price: null,
        url: url.startsWith('/') ? `${BASE_URL}${url}` : url
      });
    }
  }

  return albums.slice(0, 20);
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Qobuz Next.js data types (partial)
type QobuzNextData = {
  props?: {
    pageProps?: {
      results?: {
        tracks?: { items?: QobuzTrackData[] };
        artists?: { items?: QobuzArtistData[] };
        albums?: { items?: QobuzAlbumData[] };
      };
    };
  };
};

type QobuzTrackData = {
  id: number;
  title?: string;
  name?: string;
  duration?: number;
  performer?: { name: string };
  artists?: Array<{ name: string }>;
  album?: { id: string; title: string };
  maximum_bit_depth?: number;
  maximum_sampling_rate?: number;
  url?: string;
};

type QobuzArtistData = {
  id: number;
  name?: string;
  slug?: string;
  url?: string;
};

type QobuzAlbumData = {
  id: string;
  title?: string;
  artist?: { name: string };
  release_date_original?: string;
  maximum_bit_depth?: number;
  maximum_sampling_rate?: number;
  url?: string;
};
