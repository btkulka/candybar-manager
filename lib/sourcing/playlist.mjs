// Playlist input — Spotify playlist URL or a CSV export.

import fs from 'fs/promises';
import { loadConfig } from './config.mjs';
import { makeTrackKey } from './matching.mjs';

const SPOTIFY_PLAYLIST_RE = /(?:playlist[/:])([A-Za-z0-9]+)/;

export function parsePlaylistId(input) {
  const m = (input || '').match(SPOTIFY_PLAYLIST_RE);
  return m ? m[1] : null;
}

async function getToken({ spotifyClientId, spotifyClientSecret }) {
  if (!spotifyClientId || !spotifyClientSecret) {
    throw new Error('Spotify credentials missing — add spotifyClientId/Secret to secrets.json');
  }
  const auth = Buffer.from(`${spotifyClientId}:${spotifyClientSecret}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Spotify auth failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

/** Fetch every track in a Spotify playlist. Returns { playlist, tracks }. */
export async function fetchSpotifyPlaylist(url, onProgress) {
  const id = parsePlaylistId(url);
  if (!id) throw new Error(`Not a Spotify playlist URL: ${url}`);
  const token = await getToken(loadConfig());
  const headers = { Authorization: `Bearer ${token}` };

  const metaRes = await fetch(
    `https://api.spotify.com/v1/playlists/${id}?fields=name,images,owner(display_name),tracks(total)`,
    { headers }
  );
  if (!metaRes.ok) {
    throw new Error(`Spotify playlist fetch failed: ${metaRes.status} ${await metaRes.text()}`);
  }
  const meta = await metaRes.json();

  const tracks = [];
  let next = `https://api.spotify.com/v1/playlists/${id}/tracks?limit=100&fields=next,items(track(name,artists(name),album(name,release_date,images),duration_ms,external_urls))`;
  while (next) {
    const res = await fetch(next, { headers });
    if (!res.ok) throw new Error(`Spotify tracks page failed: ${res.status}`);
    const page = await res.json();
    for (const item of page.items || []) {
      const t = item.track;
      if (!t || !t.name) continue; // local files / unavailable entries
      const artist = (t.artists || []).map(a => a.name).join(', ');
      tracks.push({
        artist,
        title: t.name,
        album: t.album?.name || '',
        year: (t.album?.release_date || '').slice(0, 4),
        duration: t.duration_ms ? Math.round(t.duration_ms / 1000) : null,
        image: t.album?.images?.[0]?.url || null,
        spotifyUrl: t.external_urls?.spotify || null,
        key: makeTrackKey(artist, t.name),
      });
    }
    onProgress?.(tracks.length, meta.tracks?.total ?? tracks.length);
    next = page.next;
  }

  return {
    playlist: {
      name: meta.name,
      owner: meta.owner?.display_name || '',
      imageUrl: meta.images?.[0]?.url || null,
      trackCount: meta.tracks?.total ?? tracks.length,
      fetchedCount: tracks.length,
      url,
    },
    tracks,
  };
}

/** Parse a CSV export. Accepts any header spelling of artist/title. */
export async function readCsvPlaylist(csvPath) {
  const { parse } = await import('csv-parse/sync');
  const raw = await fs.readFile(csvPath, 'utf8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });

  const pick = (row, names) => {
    for (const n of names) {
      const hit = Object.keys(row).find(k => k.toLowerCase().replace(/[^a-z]/g, '') === n);
      if (hit && row[hit]) return row[hit];
    }
    return '';
  };

  const tracks = [];
  for (const row of rows) {
    const artist = pick(row, ['artist', 'artistname', 'artistnames', 'artists', 'albumartist']);
    const title = pick(row, ['title', 'trackname', 'track', 'name', 'song']);
    if (!artist && !title) continue;
    // Exports differ in what else they carry. Exportify writes "Duration (ms)",
    // "Album Image URL" and "Track URI"; the skill's Spotify-desktop walk writes
    // duration_s, artwork_url and spotify_url. Take whichever is there so the
    // review page gets cover art and a track link instead of blank tiles.
    const durationMs = Number(pick(row, ['durationms']));
    const durationS = Number(pick(row, ['durations', 'duration', 'length']));
    const link = pick(row, ['spotifyurl', 'trackurl', 'trackuri', 'spotifyuri', 'url', 'uri']);
    tracks.push({
      artist,
      title,
      album: pick(row, ['album', 'albumname']),
      year: pick(row, ['year', 'releasedate']).slice(0, 4),
      duration: durationMs > 0 ? Math.round(durationMs / 1000) : durationS > 0 ? Math.round(durationS) : null,
      image: pick(row, ['artworkurl', 'albumimageurl', 'imageurl', 'image', 'coverurl', 'cover']) || null,
      spotifyUrl: link ? link.replace(/^spotify:track:([A-Za-z0-9]+)$/, 'https://open.spotify.com/track/$1') : null,
      key: makeTrackKey(artist, title),
    });
  }

  return {
    playlist: { name: csvPath.split('/').pop(), owner: '', imageUrl: null, trackCount: tracks.length, fetchedCount: tracks.length, url: csvPath },
    tracks,
  };
}

export async function loadPlaylist({ playlistUrl, csvPath }, onProgress) {
  if (playlistUrl) return fetchSpotifyPlaylist(playlistUrl, onProgress);
  if (csvPath) return readCsvPlaylist(csvPath);
  throw new Error('Provide either a Spotify playlist URL or a CSV path');
}
