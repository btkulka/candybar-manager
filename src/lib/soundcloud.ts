/**
 * SoundCloud API client for basic track/artist search
 * Uses OAuth2 Client Credentials flow
 */

import { createScopedLogger } from './logger';

const log = createScopedLogger('SoundCloud');

export type SoundCloudCredentials = {
  clientId: string;
  clientSecret: string;
};

export type SoundCloudTrack = {
  id: number;
  title: string;
  user: string;
  duration_ms: number;
  permalink_url: string;
  artwork_url: string | null;
  genre: string | null;
  playback_count: number;
};

export type SoundCloudUser = {
  id: number;
  username: string;
  permalink_url: string;
  avatar_url: string | null;
  track_count: number;
  followers_count: number;
};

export type SoundCloudSearchResult = {
  tracks: SoundCloudTrack[];
  users: SoundCloudUser[];
};

type TokenCache = {
  token: string;
  expiresAt: number;
};

let tokenCache: TokenCache | null = null;

async function getAccessToken(credentials: SoundCloudCredentials): Promise<string> {
  log.debug('[SoundCloud:getAccessToken] Called');
  log.debug('[SoundCloud:getAccessToken] Has cached token:', !!tokenCache);

  // Return cached token if still valid (with 60s buffer)
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60000) {
    log.debug(
      '[SoundCloud:getAccessToken] Using cached token, expires in',
      Math.round((tokenCache.expiresAt - Date.now()) / 1000),
      'seconds'
    );
    return tokenCache.token;
  }

  log.debug('[SoundCloud:getAccessToken] Need to fetch new token');
  const { clientId, clientSecret } = credentials;
  log.debug('[SoundCloud:getAccessToken] clientId length:', clientId?.length ?? 0);
  log.debug('[SoundCloud:getAccessToken] clientSecret length:', clientSecret?.length ?? 0);

  log.debug('[SoundCloud:getAccessToken] Making token request to SoundCloud...');

  const fetchStart = Date.now();
  const response = await fetch('https://api.soundcloud.com/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    }).toString()
  });
  log.debug('[SoundCloud:getAccessToken] Fetch completed in', Date.now() - fetchStart, 'ms');
  log.debug('[SoundCloud:getAccessToken] Response status:', response.status, response.statusText);

  if (!response.ok) {
    const error = await response.text();
    log.error('[SoundCloud:getAccessToken] Auth failed:', error);
    throw new Error(`SoundCloud auth failed: ${error}`);
  }

  log.debug('[SoundCloud:getAccessToken] Parsing response JSON...');
  const data = (await response.json()) as { access_token: string; expires_in: number };
  log.debug('[SoundCloud:getAccessToken] Token received, expires_in:', data.expires_in, 'seconds');

  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000
  };

  log.debug('[SoundCloud:getAccessToken] Token cached successfully');
  return tokenCache.token;
}

export async function searchSoundCloud(
  query: string,
  credentials: SoundCloudCredentials,
  options: { type?: ('track' | 'user')[]; limit?: number } = {}
): Promise<SoundCloudSearchResult> {
  const { type = ['track', 'user'], limit = 20 } = options;
  const token = await getAccessToken(credentials);

  const result: SoundCloudSearchResult = {
    tracks: [],
    users: []
  };

  // SoundCloud requires separate API calls for tracks and users
  const tasks: Promise<void>[] = [];

  if (type.includes('track')) {
    tasks.push(
      (async () => {
        const params = new URLSearchParams({
          q: query,
          limit: limit.toString()
        });

        const response = await fetch(`https://api.soundcloud.com/tracks?${params}`, {
          headers: {
            Authorization: `OAuth ${token}`
          }
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`SoundCloud track search failed: ${error}`);
        }

        const data = (await response.json()) as SoundCloudApiTrack[];
        result.tracks = data.map(mapTrack);
      })()
    );
  }

  if (type.includes('user')) {
    tasks.push(
      (async () => {
        const params = new URLSearchParams({
          q: query,
          limit: limit.toString()
        });

        const response = await fetch(`https://api.soundcloud.com/users?${params}`, {
          headers: {
            Authorization: `OAuth ${token}`
          }
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`SoundCloud user search failed: ${error}`);
        }

        const data = (await response.json()) as SoundCloudApiUser[];
        result.users = data.map(mapUser);
      })()
    );
  }

  await Promise.all(tasks);
  return result;
}

// Internal SoundCloud API types
type SoundCloudApiTrack = {
  id: number;
  title: string;
  user: { username: string };
  duration: number; // in milliseconds
  permalink_url: string;
  artwork_url: string | null;
  genre: string | null;
  playback_count: number;
};

type SoundCloudApiUser = {
  id: number;
  username: string;
  permalink_url: string;
  avatar_url: string | null;
  track_count: number;
  followers_count: number;
};

function mapTrack(t: SoundCloudApiTrack): SoundCloudTrack {
  return {
    id: t.id,
    title: t.title,
    user: t.user.username,
    duration_ms: t.duration,
    permalink_url: t.permalink_url,
    artwork_url: t.artwork_url,
    genre: t.genre,
    playback_count: t.playback_count
  };
}

function mapUser(u: SoundCloudApiUser): SoundCloudUser {
  return {
    id: u.id,
    username: u.username,
    permalink_url: u.permalink_url,
    avatar_url: u.avatar_url,
    track_count: u.track_count,
    followers_count: u.followers_count
  };
}

/**
 * Public reachability check — used when no API credentials are configured.
 * Confirms SoundCloud's API is responding (any HTTP status counts; only network
 * errors mean unreachable). Doesn't prove auth works, but matches the user's
 * "is the service up?" notion of connected.
 */
export async function pingSoundCloudPublic(): Promise<boolean> {
  log.debug('[SoundCloud:pingSoundCloudPublic] Called');
  const startTime = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('https://api.soundcloud.com/', {
      method: 'HEAD',
      signal: controller.signal
    });
    log.debug(
      '[SoundCloud:pingSoundCloudPublic] Reachable, status',
      response.status,
      'in',
      Date.now() - startTime,
      'ms'
    );
    return true;
  } catch (err) {
    log.error('[SoundCloud:pingSoundCloudPublic] Unreachable after', Date.now() - startTime, 'ms', err);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// ====== Public client_id scraping + V2 API ======

// Extracted from https://soundcloud.com on page load; valid for days-to-weeks
let publicClientIdCache: { id: string; fetchedAt: number } | null = null;

/** Fetch soundcloud.com, follow asset refs, extract a working client_id. */
export async function getPublicSoundCloudClientId(): Promise<string> {
  if (publicClientIdCache && Date.now() - publicClientIdCache.fetchedAt < 6 * 3600 * 1000) {
    return publicClientIdCache.id;
  }
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const homeRes = await fetch('https://soundcloud.com/', { headers: { 'User-Agent': UA } });
  const home = await homeRes.text();
  // Asset URLs look like https://a-v2.sndcdn.com/assets/0-XXXX-X.js
  const scriptUrls = Array.from(home.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^\s"']+\.js/g)).map(m => m[0]);
  for (const url of scriptUrls.reverse()) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      const js = await r.text();
      const m = js.match(/client_id:\s*"([a-zA-Z0-9]{20,})"/) || js.match(/client_id=([a-zA-Z0-9]{20,})/);
      if (m) {
        publicClientIdCache = { id: m[1], fetchedAt: Date.now() };
        return m[1];
      }
    } catch { /* try next */ }
  }
  throw new Error('Could not extract SoundCloud public client_id');
}

export type SoundCloudPublicTrack = {
  id: number;
  title: string;
  artist: string;
  permalink_url: string;
  duration_ms: number;
  downloadable: boolean;
  has_downloads_left: boolean;
  original_format: string | null; // 'wav', 'aiff', 'flac', 'mp3', ...
  description: string | null;
  publisher_metadata: { artist?: string } | null;
  created_at: string;
  genre: string | null;
};

type V2Track = {
  id: number;
  title: string;
  permalink_url: string;
  duration: number;
  downloadable: boolean;
  has_downloads_left: boolean;
  download_count: number;
  original_format?: string | null;
  description?: string | null;
  user?: { username?: string };
  publisher_metadata?: { artist?: string } | null;
  created_at: string;
  genre?: string | null;
};

function mapV2Track(t: V2Track): SoundCloudPublicTrack {
  return {
    id: t.id,
    title: t.title,
    artist: t.publisher_metadata?.artist || t.user?.username || '',
    permalink_url: t.permalink_url,
    duration_ms: t.duration,
    downloadable: !!t.downloadable,
    has_downloads_left: !!t.has_downloads_left,
    original_format: t.original_format || null,
    description: t.description || null,
    publisher_metadata: t.publisher_metadata || null,
    created_at: t.created_at,
    genre: t.genre || null,
  };
}

/** Public V2 search — no OAuth required, uses rotating client_id. */
export async function searchSoundCloudPublic(query: string, limit = 10): Promise<SoundCloudPublicTrack[]> {
  const clientId = await getPublicSoundCloudClientId();
  const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=${limit}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`SoundCloud v2 search failed: HTTP ${res.status}`);
  const data = await res.json() as { collection?: V2Track[] };
  return (data.collection || []).map(mapV2Track);
}

/**
 * Public V2 search returning the same shape as the OAuth `searchSoundCloud`.
 * Lets callers (autopopulate, album-art suggestions) treat the two paths
 * interchangeably when OAuth creds aren't configured.
 */
export async function searchSoundCloudPublicTracks(
  query: string,
  limit = 10,
): Promise<SoundCloudSearchResult> {
  const clientId = await getPublicSoundCloudClientId();
  const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=${limit}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`SoundCloud v2 search failed: HTTP ${res.status}`);
  const data = await res.json() as { collection?: V2PublicSearchTrack[] };
  const tracks: SoundCloudTrack[] = (data.collection || []).map((t) => ({
    id: t.id,
    title: t.title,
    user: t.user?.username || '',
    duration_ms: t.duration,
    permalink_url: t.permalink_url,
    artwork_url: t.artwork_url ?? null,
    genre: t.genre ?? null,
    playback_count: t.playback_count ?? 0,
  }));
  return { tracks, users: [] };
}

type V2PublicSearchTrack = V2Track & {
  artwork_url?: string | null;
  playback_count?: number;
};

/** Fetch a single track's full metadata by ID (needed for description etc.). */
export async function getSoundCloudTrack(trackId: number): Promise<SoundCloudPublicTrack> {
  const clientId = await getPublicSoundCloudClientId();
  const res = await fetch(`https://api-v2.soundcloud.com/tracks/${trackId}?client_id=${clientId}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as V2Track;
  return mapV2Track(data);
}

/** Get a direct download URL for a downloadable track. Returns null if not downloadable. */
export async function getSoundCloudDownloadUrl(trackId: number): Promise<string | null> {
  const clientId = await getPublicSoundCloudClientId();
  const res = await fetch(`https://api-v2.soundcloud.com/tracks/${trackId}/download?client_id=${clientId}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
  });
  if (!res.ok) return null;
  const data = await res.json() as { redirectUri?: string; url?: string };
  return data.redirectUri || data.url || null;
}

export async function testSoundCloudConnection(credentials: SoundCloudCredentials): Promise<boolean> {
  log.debug('[SoundCloud:testSoundCloudConnection] Called');
  const startTime = Date.now();

  try {
    log.debug('[SoundCloud:testSoundCloudConnection] Calling getAccessToken...');
    await getAccessToken(credentials);
    log.debug('[SoundCloud:testSoundCloudConnection] Success! Total time:', Date.now() - startTime, 'ms');
    return true;
  } catch (err) {
    log.error('[SoundCloud:testSoundCloudConnection] Failed after', Date.now() - startTime, 'ms');
    log.error('[SoundCloud:testSoundCloudConnection] Error:', err);
    return false;
  }
}
