/**
 * SoundCloud sets (playlists) as a Sources input.
 *
 * The reading itself lives in lib/sourcing/soundcloud.mjs, shared with the
 * playlist-sourcing CLI: it resolves the link, hydrates the stub tracks 50 at
 * a time, restores the set's order, and splits "Artist - Title *FREE DL*"
 * titles into a clean artist/title pair. Loading it here (rather than porting
 * it) keeps the app and the skill reading a set the same way.
 *
 * Public and secret-link sets are read anonymously. A private set is read
 * through the saved SoundCloud sign-in (soundcloudSession.ts), the same one
 * the downloader uses.
 */

import type { TrackRecord } from './musicLibraryCheck';
import type { SetFreeDownload } from '../types';
import { normalizeBasic } from './stringUtils';
import { loadSoundCloudModule, withSoundCloudSession, type SetRow, type SetSource } from './soundcloudSession';

/** A set track that the set itself gives away: what to show, and the row
 *  bin/source-soundcloud-likes.mjs --tracks fetches it from. */
export type SetFreeTrack = { free: SetFreeDownload; fetchRow: SetRow };

export type SoundCloudSet = {
  name: string;
  owner: string;
  imageUrl: string | null;
  trackCount: number;
  tracks: TrackRecord[];
  /** By track key: the tracks with SoundCloud's download button or a free gate. */
  freeByKey: Map<string, SetFreeTrack>;
};

/** The free download a set row offers, or null. Exported for tests. */
export function setFreeDownload(row: SetRow): SetFreeDownload | null {
  const f = row.free;
  if (!f || f.kind === 'none' || !row.url) return null;
  const host = f.gate?.host ?? null;
  return {
    kind: f.kind,
    url: row.url,
    listedAs: row.scTitle || `${row.artist} - ${row.title}`,
    uploader: row.uploader ?? '',
    gateHost: host,
    reason: f.kind === 'native' ? 'SoundCloud download button'
      : host ? `Free download via ${host}` : `Free download link (${f.reason})`,
  };
}

/** Read a set. One that answers 401/403/404 anonymously is private (or
 *  gone), so it's read again through the saved sign-in, as the downloader
 *  does; `onSignIn` fires if that has to wait for the user to sign in. */
export async function fetchSoundCloudSet(
  setUrl: string,
  onProgress?: (loaded: number, total: number) => void,
  onSignIn?: () => void
): Promise<SoundCloudSet> {
  const { fetchSetPublic } = await loadSoundCloudModule();
  // A pasted "soundcloud.com/…" without the scheme is still a set link.
  const url = /^https?:\/\//i.test(setUrl.trim()) ? setUrl.trim() : `https://${setUrl.trim()}`;
  let result: { source: SetSource; tracks: SetRow[] };
  try {
    result = await fetchSetPublic(url, { onProgress });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 401 && status !== 403 && status !== 404) throw err;
    try {
      result = await withSoundCloudSession(
        (page, sess, sc) => sc.fetchSetViaSession(page, sess, url, { onProgress }),
        { onWaiting: onSignIn }
      );
    } catch (sessionErr) {
      const why = sessionErr instanceof Error ? sessionErr.message : String(sessionErr);
      throw new Error(`That SoundCloud set isn't public, and reading it through your SoundCloud sign-in didn't work (${why}). If it's someone else's private set, ask for its secret link (Share → Copy link).`);
    }
  }

  const { source, tracks } = result;
  const keyOf = (t: SetRow) => normalizeBasic(`${t.artist} - ${t.title}`);
  const freeByKey = new Map<string, SetFreeTrack>();
  for (const t of tracks) {
    const free = setFreeDownload(t);
    // A track listed twice keeps its first free copy.
    if (free && !freeByKey.has(keyOf(t))) freeByKey.set(keyOf(t), { free, fetchRow: t });
  }
  return {
    name: source.set,
    owner: source.user ?? '',
    imageUrl: source.image,
    trackCount: source.trackCount,
    tracks: tracks.map(t => ({
      key: keyOf(t),
      artist: t.artist || 'Unknown Artist',
      title: t.title || 'Unknown Title',
      duration: t.duration ?? undefined,
    })),
    freeByKey,
  };
}
