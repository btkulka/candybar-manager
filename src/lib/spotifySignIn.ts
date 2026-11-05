/**
 * The app's side of the Spotify sign-in: the account, not an API key.
 *
 * The sign-in lives in the profile's gate browser (lib/sourcing/spotifyWeb.mjs),
 * the same Chrome profile the Spotify-connect download gates use, so one login
 * covers playlists and gates. Nothing stores a token: reads open the profile
 * headless and take what Spotify's web player itself loaded. With no sign-in,
 * playlists still come through the API key (public playlists only).
 */

import { app } from 'electron';
import path from 'path';
import { pathToFileURL } from 'url';
import type { SpotifySignIn } from '../types';
import { getPlaylistTracks, type SpotifyCredentials, type SpotifyPlaylistInfo, type SpotifyTrack } from './spotify';

type WebTrack = { artist: string; artists: string[]; title: string; album: string; durationMs: number | null; image: string | null; spotifyUrl: string | null; id: string | null };
type WebPlaylist = { playlist: { name: string; owner: string; imageUrl: string | null; trackCount: number; fetchedCount: number; url: string }; tracks: WebTrack[] };

type SpotifyWebModule = {
  readSpotifyStatus: () => SpotifySignIn | null;
  checkSpotifySignIn: () => Promise<SpotifySignIn>;
  signInToSpotifyWeb: (opts?: { timeoutMs?: number; onOpened?: () => void }) => Promise<SpotifySignIn>;
  readPlaylistSignedIn: (input: string, onProgress?: (loaded: number, total: number) => void) => Promise<WebPlaylist>;
  parseSpotifyPlaylistId: (input: string) => string | null;
};

let mod: Promise<SpotifyWebModule> | null = null;
function spotifyWeb(): Promise<SpotifyWebModule> {
  mod ??= import(pathToFileURL(path.join(app.getAppPath(), 'lib', 'sourcing', 'spotifyWeb.mjs')).href) as Promise<SpotifyWebModule>;
  return mod;
}

/** Who the saved sign-in belonged to at its last check, or null. Never opens Chrome. */
export async function readSpotifySignIn(): Promise<SpotifySignIn | null> {
  return (await spotifyWeb()).readSpotifyStatus();
}

/** Check the saved sign-in (headless). */
export async function checkSpotifySignIn(): Promise<SpotifySignIn> {
  return (await spotifyWeb()).checkSpotifySignIn();
}

/** Open plain Chrome on the gate browser at Spotify's login; resolves with the
 *  sign-in once the person closes that window. */
export async function signInToSpotify(onOpened?: () => void): Promise<SpotifySignIn> {
  return (await spotifyWeb()).signInToSpotifyWeb({ onOpened });
}

function toApiShape(r: WebPlaylist): { playlist: SpotifyPlaylistInfo; tracks: SpotifyTrack[]; via: 'spotify-sign-in' } {
  return {
    via: 'spotify-sign-in',
    playlist: {
      id: r.playlist.url.split('/').pop() ?? '',
      name: r.playlist.name,
      description: '',
      trackCount: r.playlist.trackCount,
      imageUrl: r.playlist.imageUrl,
      externalUrl: r.playlist.url,
      owner: r.playlist.owner,
    },
    tracks: r.tracks.map((t) => ({
      id: t.id ?? '',
      name: t.title,
      artists: t.artists.length ? t.artists : [t.artist],
      album: t.album,
      album_image_url: t.image,
      release_year: null,
      duration_ms: t.durationMs ?? 0,
      preview_url: null,
      external_url: t.spotifyUrl ?? '',
      popularity: 0,
    })),
  };
}

/**
 * A playlist's tracks: through the Spotify sign-in when the profile has one
 * (private playlists too), else through the API key. If the key can't see it
 * (private), the sign-in is tried.
 */
export async function getPlaylistTracksAny(
  playlistInput: string,
  credentials: SpotifyCredentials,
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ playlist: SpotifyPlaylistInfo; tracks: SpotifyTrack[]; via: 'spotify-sign-in' | 'api-key' }> {
  const web = await spotifyWeb();
  const signedIn = web.readSpotifyStatus()?.signedIn === true;
  let webError: unknown = null;
  if (signedIn) {
    try {
      return toApiShape(await web.readPlaylistSignedIn(playlistInput, onProgress));
    } catch (err) {
      webError = err;
    }
  }
  try {
    return { ...(await getPlaylistTracks(playlistInput, credentials, onProgress)), via: 'api-key' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (webError) throw new Error(`${msg} (and through the Spotify sign-in: ${webError instanceof Error ? webError.message : String(webError)})`);
    if (/private|not found/i.test(msg)) throw new Error(`${msg} Sign in to Spotify (Settings → Spotify) to read private playlists.`);
    throw err;
  }
}
