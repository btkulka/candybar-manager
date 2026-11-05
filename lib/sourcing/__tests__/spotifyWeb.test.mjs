// The Spotify web-player reader's parsing (live shapes from 2026-11-05).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { trackFromItem, parseSpotifyPlaylistId, recordSpotifyStatus, readSpotifyStatus } from '../spotifyWeb.mjs';

describe('Spotify web player reader', () => {
  it('reads a track row from a fetchPlaylistContents item, and skips episodes and empty rows', () => {
    const item = { uid: 'u1', itemV2: { data: { __typename: 'Track', name: 'Disc Jockey', uri: 'spotify:track:abc123',
      artists: { items: [{ profile: { name: 'LYNY' } }, { profile: { name: 'Guest' } }] },
      albumOfTrack: { name: 'Disc Jockey', coverArt: { sources: [{ url: 'https://i.scdn.co/x' }] } },
      trackDuration: { totalMilliseconds: 165521 } } } };
    expect(trackFromItem(item)).toEqual({ uid: 'u1', artist: 'LYNY, Guest', artists: ['LYNY', 'Guest'], title: 'Disc Jockey', album: 'Disc Jockey',
      durationMs: 165521, duration: 166, image: 'https://i.scdn.co/x', spotifyUrl: 'https://open.spotify.com/track/abc123', id: 'abc123' });
    expect(trackFromItem({ itemV2: { data: { __typename: 'Episode', name: 'Pod' } } })).toBeNull();
    expect(trackFromItem({ itemV2: { data: { __typename: 'NotFound' } } })).toBeNull();
    expect(trackFromItem({ item: { data: { __typename: 'Track', name: 'Newer shape', artists: { items: [] } } } })?.title).toBe('Newer shape');
  });

  it('finds the playlist id in links, URIs and bare ids', () => {
    expect(parseSpotifyPlaylistId('https://open.spotify.com/playlist/37i9dQZF1DX5Q27plkaOQ3?si=abc')).toBe('37i9dQZF1DX5Q27plkaOQ3');
    expect(parseSpotifyPlaylistId('spotify:playlist:37i9dQZF1DX5Q27plkaOQ3')).toBe('37i9dQZF1DX5Q27plkaOQ3');
    expect(parseSpotifyPlaylistId('37i9dQZF1DX5Q27plkaOQ3')).toBe('37i9dQZF1DX5Q27plkaOQ3');
    expect(parseSpotifyPlaylistId('https://open.spotify.com/album/x')).toBeNull();
  });

  it('keeps who is signed in, never a token', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-sp-')), 'spotify-session.json');
    recordSpotifyStatus({ signedIn: true, name: 'Enchvnted', username: 'u1', token: 'secret' }, f);
    const s = readSpotifyStatus(f);
    expect(s).toMatchObject({ signedIn: true, name: 'Enchvnted', username: 'u1' });
    expect(JSON.stringify(s)).not.toContain('secret');
  });
});
