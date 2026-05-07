/**
 * Spotify API client for basic track/artist search
 * Uses Client Credentials flow (no user auth needed for search)
 */

import { createScopedLogger } from './logger';

const log = createScopedLogger('Spotify');

export type SpotifyCredentials = {
  clientId: string;
  clientSecret: string;
};

export type SpotifyTrack = {
  id: string;
  name: string;
  artists: string[];
  album: string;
  album_image_url: string | null;
  release_year: string | null;
  duration_ms: number;
  preview_url: string | null;
  external_url: string;
  popularity: number;
};

export type SpotifyArtist = {
  id: string;
  name: string;
  genres: string[];
  popularity: number;
  external_url: string;
  image_url: string | null;
};

export type SpotifySearchResult = {
  tracks: SpotifyTrack[];
  artists: SpotifyArtist[];
};

type TokenCache = {
  token: string;
  expiresAt: number;
};

let tokenCache: TokenCache | null = null;

const DEFAULT_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Spotify request timed out after ${timeoutMs}ms: ${input}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken(credentials: SpotifyCredentials): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60000) {
    return tokenCache.token;
  }

  const { clientId, clientSecret } = credentials;
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetchWithTimeout('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!response.ok) {
    const error = await response.text();
    log.error('Spotify auth failed:', error);
    throw new Error(`Spotify auth failed: ${error}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };

  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000
  };

  return tokenCache.token;
}

export async function searchSpotify(
  query: string,
  credentials: SpotifyCredentials,
  options: { type?: ('track' | 'artist')[]; limit?: number } = {}
): Promise<SpotifySearchResult> {
  const { type = ['track', 'artist'], limit = 20 } = options;
  const token = await getAccessToken(credentials);

  const params = new URLSearchParams({
    q: query,
    type: type.join(','),
    limit: limit.toString()
  });

  const response = await fetchWithTimeout(`https://api.spotify.com/v1/search?${params}`, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  if (!response.ok) {
    const error = await response.text();
    log.error('Spotify search failed:', error);
    throw new Error(`Spotify search failed: ${error}`);
  }

  const data = await response.json() as {
    tracks?: { items: SpotifyApiTrack[] };
    artists?: { items: SpotifyApiArtist[] };
  };

  return {
    tracks: (data.tracks?.items ?? []).map(mapTrack),
    artists: (data.artists?.items ?? []).map(mapArtist)
  };
}

// Internal Spotify API types
type SpotifyApiTrack = {
  id: string;
  name: string;
  artists: { name: string }[];
  album: { name: string; images: { url: string }[]; release_date?: string };
  duration_ms: number;
  preview_url: string | null;
  external_urls: { spotify: string };
  popularity: number;
};

type SpotifyApiArtist = {
  id: string;
  name: string;
  genres: string[];
  popularity: number;
  external_urls: { spotify: string };
  images: { url: string }[];
};

function mapTrack(t: SpotifyApiTrack): SpotifyTrack {
  return {
    id: t.id,
    name: t.name,
    artists: t.artists.map(a => a.name),
    album: t.album.name,
    album_image_url: t.album.images[0]?.url ?? null,
    release_year: t.album.release_date?.substring(0, 4) ?? null,
    duration_ms: t.duration_ms,
    preview_url: t.preview_url,
    external_url: t.external_urls.spotify,
    popularity: t.popularity
  };
}

function mapArtist(a: SpotifyApiArtist): SpotifyArtist {
  return {
    id: a.id,
    name: a.name,
    genres: a.genres,
    popularity: a.popularity,
    external_url: a.external_urls.spotify,
    image_url: a.images[0]?.url ?? null
  };
}

// ========== Playlist Support ==========

/**
 * Parse a Spotify playlist URL/URI into a playlist ID.
 * Supports:
 *  - https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
 *  - https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=...
 *  - spotify:playlist:37i9dQZF1DXcBWIGoYBM5M
 *  - 37i9dQZF1DXcBWIGoYBM5M (bare ID, 22 chars alphanumeric)
 */
export function parseSpotifyPlaylistUrl(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();

  // URL format
  const urlMatch = trimmed.match(/open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/);
  if (urlMatch) return urlMatch[1];

  // URI format
  const uriMatch = trimmed.match(/^spotify:playlist:([a-zA-Z0-9]+)$/);
  if (uriMatch) return uriMatch[1];

  // Bare ID (Spotify IDs are 22 chars, base62)
  if (/^[a-zA-Z0-9]{22}$/.test(trimmed)) return trimmed;

  return null;
}

export type SpotifyPlaylistInfo = {
  id: string;
  name: string;
  description: string;
  trackCount: number;
  imageUrl: string | null;
  externalUrl: string;
  owner: string;
};

type SpotifyApiPlaylistTrackItem = {
  track: SpotifyApiTrack | null; // null for local files
};

/**
 * Fetch all tracks from a public Spotify playlist.
 * Uses Client Credentials flow — only works for public playlists.
 */
export async function getPlaylistTracks(
  playlistInput: string,
  credentials: SpotifyCredentials,
  onProgress?: (loaded: number, total: number) => void
): Promise<{ playlist: SpotifyPlaylistInfo; tracks: SpotifyTrack[] }> {
  const playlistId = parseSpotifyPlaylistUrl(playlistInput);
  if (!playlistId) {
    throw new Error('Invalid Spotify playlist URL. Please use a link like: https://open.spotify.com/playlist/...');
  }

  const token = await getAccessToken(credentials);

  // Fetch playlist metadata
  const metaResponse = await fetchWithTimeout(
    `https://api.spotify.com/v1/playlists/${playlistId}?fields=id,name,description,external_urls,images,owner(display_name),tracks(total)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!metaResponse.ok) {
    if (metaResponse.status === 404) {
      throw new Error('Playlist not found. Make sure the playlist exists and is public.');
    }
    if (metaResponse.status === 403) {
      throw new Error('This playlist is private. Only public playlists are supported.');
    }
    const errText = await metaResponse.text();
    throw new Error(`Spotify API error: ${errText}`);
  }

  const meta = await metaResponse.json() as {
    id: string;
    name: string;
    description: string;
    external_urls: { spotify: string };
    images: { url: string }[];
    owner: { display_name: string };
    tracks: { total: number };
  };

  const playlist: SpotifyPlaylistInfo = {
    id: meta.id,
    name: meta.name,
    description: meta.description || '',
    trackCount: meta.tracks.total,
    imageUrl: meta.images[0]?.url ?? null,
    externalUrl: meta.external_urls.spotify,
    owner: meta.owner.display_name
  };

  // Paginate through all tracks (50 per page)
  const tracks: SpotifyTrack[] = [];
  const total = meta.tracks.total;
  let offset = 0;
  const limit = 50;
  const MAX_RETRIES_PER_PAGE = 5;
  const MAX_RETRY_SECONDS = 60;
  let retriesThisPage = 0;

  while (offset < total) {
    const pageToken = await getAccessToken(credentials); // refresh if needed
    const pageResponse = await fetchWithTimeout(
      `https://api.spotify.com/v1/playlists/${playlistId}/tracks?offset=${offset}&limit=${limit}&fields=items(track(id,name,artists,album,duration_ms,preview_url,external_urls,popularity)),total`,
      { headers: { Authorization: `Bearer ${pageToken}` } }
    );

    if (!pageResponse.ok) {
      if (pageResponse.status === 401) {
        tokenCache = null; // force refresh on next call
      }
      if (pageResponse.status === 429 && retriesThisPage < MAX_RETRIES_PER_PAGE) {
        const retryAfter = Math.min(
          parseInt(pageResponse.headers.get('retry-after') || '2', 10),
          MAX_RETRY_SECONDS
        );
        retriesThisPage += 1;
        log.warn(`Spotify rate limited (retry ${retriesThisPage}/${MAX_RETRIES_PER_PAGE}), waiting ${retryAfter}s`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue; // retry same offset
      }
      const errText = await pageResponse.text();
      throw new Error(`Spotify API error fetching tracks: ${errText}`);
    }

    retriesThisPage = 0;

    const page = await pageResponse.json() as { items: SpotifyApiPlaylistTrackItem[] };

    for (const item of page.items) {
      if (item.track) {
        tracks.push(mapTrack(item.track));
      }
    }

    offset += limit;
    onProgress?.(Math.min(offset, total), total);

    // Small delay to avoid rate limiting on large playlists
    if (offset < total) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  log.info(`Fetched ${tracks.length} tracks from playlist "${playlist.name}" (${playlist.trackCount} total, ${playlist.trackCount - tracks.length} local/unavailable skipped)`);

  return { playlist, tracks };
}

export async function testSpotifyConnection(credentials: SpotifyCredentials): Promise<boolean> {
  try {
    await getAccessToken(credentials);
    return true;
  } catch (error) {
    log.warn('Spotify connection test failed:', error);
    return false;
  }
}
