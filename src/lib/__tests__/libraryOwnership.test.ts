import { describe, it, expect } from 'vitest';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  toOwnershipInput, bucketsToCheckResult, rekordboxReadError, csvRecordsToTrackRecords,
  collectionPathKey, type OwnershipBuckets, type OwnershipUncertainMatch,
} from '../libraryOwnership';
import type { TrackRecord } from '../musicLibraryCheck';

// The real engine, so the adapter is tested against what bucketTracks emits.
const engineUrl = pathToFileURL(path.resolve(__dirname, '..', '..', '..', 'lib', 'sourcing', 'matching.mjs')).href;
const libraryUrl = pathToFileURL(path.resolve(__dirname, '..', '..', '..', 'lib', 'sourcing', 'library.mjs')).href;

const rec = (artist: string, title: string): TrackRecord => ({ key: `${artist} - ${title}`.toLowerCase(), artist, title });

async function bucket(wanted: TrackRecord[], collection: Array<Record<string, unknown>>): Promise<OwnershipBuckets> {
  const { buildLibraryIndex } = await import(engineUrl);
  const { bucketTracks } = await import(libraryUrl);
  const index = buildLibraryIndex(collection);
  return bucketTracks(toOwnershipInput(wanted), { index, ignored: new Set() });
}

describe('bucketsToCheckResult', () => {
  it('owns only what Rekordbox holds; a disk-only file is probable, not owned', async () => {
    const wanted = [
      rec('Fred again..', 'Delilah (pull me out of this)'),
      rec('Four Tet', 'Baby'),
      rec('Nobody Knows', 'This Song'),
    ];
    const buckets = await bucket(wanted, [
      { artist: 'Fred again..', title: 'Delilah (pull me out of this)', file_path: '/Volumes/Candy Bar/Music/F/delilah.aiff', in_rekordbox: true },
      { artist: 'Four Tet', title: 'Baby', file_path: '/Volumes/Candy Bar/tracks_to_organize/baby.wav', in_rekordbox: false },
    ]);
    const result = bucketsToCheckResult(wanted, buckets, 2);

    expect(result.matchedTracks.map(t => t.title)).toEqual(['Delilah (pull me out of this)']);
    expect(result.matchedTracks[0].matchedLibraryTrack?.filePath).toBe('/Volumes/Candy Bar/Music/F/delilah.aiff');
    // The original record (and its app-style key, which the ignore list uses) survives.
    expect(result.matchedTracks[0].key).toBe(wanted[0].key);

    expect(result.uncertainMatches).toHaveLength(1);
    const probable = result.uncertainMatches[0] as OwnershipUncertainMatch;
    expect(probable.csvTrack.title).toBe('Baby');
    expect(probable.reason).toBe('file on disk, not in Rekordbox');
    expect(probable.libraryTrack.filePath).toBe('/Volumes/Candy Bar/tracks_to_organize/baby.wav');

    expect(result.missingTracks.map(t => t.title)).toEqual(['This Song']);
    expect(result.csvTotal).toBe(3);
    expect(result.matchedCount + result.uncertainCount + result.missingCount).toBe(3);
    expect(result.libraryTracks).toEqual([]);
  });

  it('accounts for every input row', async () => {
    const wanted = Array.from({ length: 12 }, (_, i) => rec(`Artist ${i}`, `Title ${i}`));
    const buckets = await bucket(wanted, [{ artist: 'Artist 3', title: 'Title 3', file_path: '/a.aiff', in_rekordbox: true }]);
    const result = bucketsToCheckResult(wanted, buckets, 1);
    expect(result.matchedCount + result.uncertainCount + result.missingCount).toBe(wanted.length);
  });
});

describe('rekordboxReadError', () => {
  it('flags a failed or empty Rekordbox read', () => {
    expect(rekordboxReadError({ rekordbox: 0, candybar: 10, disk_only: 10, errors: ['rekordbox: No module named pyrekordbox'] }))
      .toBe('No module named pyrekordbox');
    expect(rekordboxReadError({ rekordbox: 0, candybar: 10, disk_only: 10, errors: [] })).toMatch(/empty/);
    expect(rekordboxReadError(undefined)).not.toBeNull();
  });

  it('passes a healthy read even when candybar.db had trouble', () => {
    expect(rekordboxReadError({ rekordbox: 5000, candybar: 0, disk_only: 0, errors: ['candybar: locked'] })).toBeNull();
  });
});

describe('csvRecordsToTrackRecords', () => {
  it('reads the same columns checkLibrary did and keys like the rest of the app', () => {
    const tracks = csvRecordsToTrackRecords([
      { 'Track Name': 'x', Artist: 'Daft Punk', Title: 'One More Time', Album: 'Discovery' },
      { artists: 'Bicep', name: 'Glue' },
      { Artist: '', Title: '' },
    ]);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({ artist: 'Daft Punk', title: 'One More Time', album: 'Discovery', key: 'daft punk one more time' });
    expect(tracks[1]).toMatchObject({ artist: 'Bicep', title: 'Glue' });
  });
});

describe('collectionPathKey', () => {
  it('ignores case and accent composition', () => {
    const composed = '/Volumes/Candy Bar/Music/Rosé.aiff';
    const decomposed = '/Volumes/Candy Bar/music/Rosé.AIFF';
    expect(collectionPathKey(composed)).toBe(collectionPathKey(decomposed));
  });
});
