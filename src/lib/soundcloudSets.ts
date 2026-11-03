/**
 * SoundCloud sets (playlists) as a Sources input.
 *
 * The reading itself lives in lib/sourcing/soundcloud.mjs, shared with the
 * playlist-sourcing CLI: it resolves the link, hydrates the stub tracks 50 at
 * a time, restores the set's order, and splits "Artist - Title *FREE DL*"
 * titles into a clean artist/title pair. Loading it here (rather than porting
 * it) keeps the app and the skill reading a set the same way.
 *
 * Only public and secret-link sets are read: a private set needs the signed-in
 * SoundCloud session, which the app doesn't drive.
 */

import { app } from 'electron';
import path from 'path';
import { pathToFileURL } from 'url';
import type { TrackRecord } from './musicLibraryCheck';
import { normalizeBasic } from './stringUtils';

type SetRow = {
  scId: number;
  artist: string;
  title: string;
  duration: number | null;
  url: string | null;
};

type SetSource = {
  set: string;
  user: string | null;
  url: string;
  trackCount: number;
  fetchedCount: number;
  unavailable: Array<{ scId: number }>;
  image: string | null;
};

type SoundCloudSourcingModule = {
  fetchSetPublic: (
    setUrl: string,
    opts?: { onProgress?: (loaded: number, total: number) => void }
  ) => Promise<{ source: SetSource; tracks: SetRow[] }>;
};

let mod: SoundCloudSourcingModule | null = null;

async function getModule(): Promise<SoundCloudSourcingModule> {
  if (!mod) {
    const url = pathToFileURL(path.join(app.getAppPath(), 'lib', 'sourcing', 'soundcloud.mjs')).href;
    mod = await import(url) as SoundCloudSourcingModule;
  }
  return mod;
}

export type SoundCloudSet = {
  name: string;
  owner: string;
  imageUrl: string | null;
  trackCount: number;
  tracks: TrackRecord[];
};

/** Read a public or secret-link set. A private set answers 401/403/404 to an
 *  anonymous read; that's reported as something the user can fix. */
export async function fetchSoundCloudSet(
  setUrl: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<SoundCloudSet> {
  const { fetchSetPublic } = await getModule();
  // A pasted "soundcloud.com/…" without the scheme is still a set link.
  const url = /^https?:\/\//i.test(setUrl.trim()) ? setUrl.trim() : `https://${setUrl.trim()}`;
  let result: Awaited<ReturnType<SoundCloudSourcingModule['fetchSetPublic']>>;
  try {
    result = await fetchSetPublic(url, { onProgress });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403 || status === 404) {
      throw new Error('SoundCloud set not found or private. For a private set, copy its secret link (Share → Copy link) and paste that instead.');
    }
    throw err;
  }

  const { source, tracks } = result;
  return {
    name: source.set,
    owner: source.user ?? '',
    imageUrl: source.image,
    trackCount: source.trackCount,
    tracks: tracks.map(t => ({
      key: normalizeBasic(`${t.artist} - ${t.title}`),
      artist: t.artist || 'Unknown Artist',
      title: t.title || 'Unknown Title',
      duration: t.duration ?? undefined,
    })),
  };
}
