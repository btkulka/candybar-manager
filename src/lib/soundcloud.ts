/**
 * SoundCloud search through @btkulka/soundcloud-client: the OAuth token
 * (client-credentials), 401 refresh, 429 waits, the public api-v2 search with
 * a scraped client_id, and the flattened track/user shapes live there. Track
 * Lab keeps one client per credential pair, plus one without credentials, so
 * the token and the scraped client_id survive between searches (SoundCloud
 * rate-limits its token endpoint hard).
 */

import {
  createSoundCloudClient,
  type SoundCloudClient,
  type SoundCloudCredentials,
  type SoundCloudSearchResult,
} from '@btkulka/soundcloud-client';

export type { SoundCloudCredentials, SoundCloudSearchResult, SoundCloudTrack, SoundCloudUser } from '@btkulka/soundcloud-client';

let oauth: { key: string; client: SoundCloudClient } | null = null;
let publicClient: SoundCloudClient | null = null;

function soundcloudFor(credentials: SoundCloudCredentials): SoundCloudClient {
  const key = `${credentials.clientId}\n${credentials.clientSecret}`;
  if (oauth?.key !== key) oauth = { key, client: createSoundCloudClient(credentials) };
  return oauth.client;
}

export function searchSoundCloud(
  query: string,
  credentials: SoundCloudCredentials,
  options: { type?: ('track' | 'user')[]; limit?: number } = {}
): Promise<SoundCloudSearchResult> {
  return soundcloudFor(credentials).search(query, options);
}

/**
 * Public api-v2 track search, same shape as `searchSoundCloud` (no users), so
 * callers (autopopulate, album-art suggestions) can use it when no OAuth
 * credentials are configured.
 */
export function searchSoundCloudPublicTracks(query: string, limit = 10): Promise<SoundCloudSearchResult> {
  publicClient ??= createSoundCloudClient({ timeoutMs: 20_000 });
  return publicClient.searchPublicTracks(query, limit);
}
