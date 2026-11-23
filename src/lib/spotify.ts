/**
 * Spotify through the API key (client-credentials flow; public data only), on
 * @btkulka/spotify-client: the token, 401 refresh, 429 waits, search, playlist
 * paging and the flattened track/artist shapes live there. What stays here is
 * Track Lab's: one client per credential pair, its log lines, and the
 * by-id lookup that drops malformed Rekordbox ids.
 */

import {
  createSpotifyClient,
  toTrack,
  SpotifyApiError,
  type SpotifyClient,
  type SpotifyCredentials,
  type SpotifyPlaylistInfo,
  type SpotifySearchResult,
  type SpotifyTrack,
  type SpotifyTrackObject,
} from '@btkulka/spotify-client';
import { createScopedLogger } from './logger';

export type { SpotifyArtist, SpotifyCredentials, SpotifyPlaylistInfo, SpotifySearchResult, SpotifyTrack } from '@btkulka/spotify-client';

const log = createScopedLogger('Spotify');

let current: { key: string; client: SpotifyClient } | null = null;

/** The client for these credentials, kept while they stay the same so its token is reused. */
function spotifyFor(credentials: SpotifyCredentials): SpotifyClient {
  const key = `${credentials.clientId}\n${credentials.clientSecret}`;
  if (current?.key !== key) current = { key, client: createSpotifyClient(credentials) };
  return current.client;
}

export async function searchSpotify(
  query: string,
  credentials: SpotifyCredentials,
  options: { type?: ('track' | 'artist')[]; limit?: number } = {}
): Promise<SpotifySearchResult> {
  try {
    return await spotifyFor(credentials).search(query, options);
  } catch (err) {
    log.error('Spotify search failed:', err instanceof Error ? err.message : err);
    throw err;
  }
}

/** Every track of a public playlist (the API key can't read private ones). */
export async function getPlaylistTracks(
  playlistInput: string,
  credentials: SpotifyCredentials,
  onProgress?: (loaded: number, total: number) => void
): Promise<{ playlist: SpotifyPlaylistInfo; tracks: SpotifyTrack[] }> {
  const result = await spotifyFor(credentials).getPlaylistTracks(playlistInput, onProgress);
  const { playlist, tracks } = result;
  log.info(`Fetched ${tracks.length} tracks from playlist "${playlist.name}" (${playlist.trackCount} total, ${playlist.trackCount - tracks.length} local/unavailable skipped)`);
  return result;
}

/**
 * Look up tracks by Spotify ID, 50 per request (the API's cap). IDs Spotify
 * no longer knows come back as null and are left out of the map.
 *
 * The client waits out 429s and refreshes the token on a 401. A 400 means one
 * id in the batch is malformed (a truncated Rekordbox URI), and Spotify rejects
 * the whole batch for it, so the batch is halved until the bad id stands alone
 * and is dropped — one bad entry can't fail a whole playlist.
 */
export async function getSpotifyTracksByIds(
  ids: string[],
  credentials: SpotifyCredentials
): Promise<Map<string, SpotifyTrack>> {
  const client = spotifyFor(credentials);
  const found = new Map<string, SpotifyTrack>();

  async function lookup(batch: string[]): Promise<void> {
    try {
      const data = await client.get<{ tracks?: Array<SpotifyTrackObject | null> }>(`/tracks?ids=${batch.map(encodeURIComponent).join(',')}`);
      for (const t of data?.tracks ?? []) {
        if (t) found.set(t.id, toTrack(t));
      }
    } catch (err) {
      if (!(err instanceof SpotifyApiError) || err.status !== 400) throw err;
      if (batch.length === 1) {
        log.warn(`Spotify rejected track id ${batch[0]} as invalid — skipped`);
        return;
      }
      const mid = Math.ceil(batch.length / 2);
      await lookup(batch.slice(0, mid));
      await lookup(batch.slice(mid));
    }
  }

  for (let i = 0; i < ids.length; i += 50) {
    await lookup(ids.slice(i, i + 50));
  }
  return found;
}

export async function testSpotifyConnection(credentials: SpotifyCredentials): Promise<boolean> {
  try {
    await spotifyFor(credentials).getToken();
    return true;
  } catch (error) {
    log.warn('Spotify connection test failed:', error);
    return false;
  }
}
