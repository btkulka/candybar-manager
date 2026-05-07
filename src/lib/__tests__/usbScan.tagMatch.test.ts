import { describe, it, expect } from 'vitest';
import { matchAgainstUsbIndex, type UsbIndex } from '../usbScan';
import { makeTagKey } from '../stringUtils';
import type { RekordboxTrack } from '../rekordboxXml';

function makeTrack(partial: Partial<RekordboxTrack> = {}): RekordboxTrack {
  return {
    trackId: '1', artist: '', title: '', album: '', label: '', genre: '',
    year: '', bpm: '', key: '', origPath: '', ...partial,
  };
}

function makeIndex(partial: Partial<UsbIndex> = {}): UsbIndex {
  return {
    volume: { name: 'vol', mountPath: '/Volumes/vol', scanRoot: '/Volumes/vol' },
    files: [],
    byArtistFolder: new Map(),
    ...partial,
  };
}

describe('matchAgainstUsbIndex tag_exact strategy', () => {
  it('matches on normalized artist+title tag key when unique', () => {
    const file = '/Volumes/vol/Some Weird Path/file.aiff';
    const byTagKey = new Map<string, string[]>([
      [makeTagKey('RÜFÜS DU SOL', 'Innerbloom (Original Mix)'), [file]],
    ]);
    const index = makeIndex({ byTagKey, files: [file] });
    const track = makeTrack({
      artist: 'Rufus Du Sol',
      title: 'Innerbloom (Original Mix)',
    });
    const m = matchAgainstUsbIndex(track, index);
    expect(m?.method).toBe('tag_exact');
    expect(m?.sourcePath).toBe(file);
  });

  it('does NOT match when "Original Mix" and "Remix" differ (version-preserving)', () => {
    const file = '/Volumes/vol/remix-file.aiff';
    const byTagKey = new Map<string, string[]>([
      [makeTagKey('Rufus Du Sol', 'Innerbloom (Ship Wrek Remix)'), [file]],
    ]);
    const index = makeIndex({ byTagKey, files: [file] });
    const track = makeTrack({
      artist: 'Rufus Du Sol',
      title: 'Innerbloom (Original Mix)',
    });
    const m = matchAgainstUsbIndex(track, index);
    expect(m).toBeNull();
  });

  it('returns null on ambiguous tag match (multiple files share the same key)', () => {
    const a = '/Volumes/vol/a.aiff';
    const b = '/Volumes/vol/b.aiff';
    const byTagKey = new Map<string, string[]>([
      [makeTagKey('Artist', 'Title'), [a, b]],
    ]);
    const index = makeIndex({ byTagKey, files: [a, b] });
    const track = makeTrack({ artist: 'Artist', title: 'Title' });
    const m = matchAgainstUsbIndex(track, index);
    // No exact path, ambiguous tag match, no fuzzy-index data → no match.
    expect(m).toBeNull();
  });

  it('skips tag strategy when index has no byTagKey (readTags was off)', () => {
    const index = makeIndex({ byTagKey: undefined });
    const track = makeTrack({ artist: 'Artist', title: 'Title' });
    // No files to fuzzy-match against either — null expected.
    expect(matchAgainstUsbIndex(track, index)).toBeNull();
  });

  it('skips tag strategy when track has empty artist or title', () => {
    const file = '/Volumes/vol/file.aiff';
    const byTagKey = new Map<string, string[]>([
      [makeTagKey('', 'Solo Title'), [file]],
    ]);
    const index = makeIndex({ byTagKey, files: [file] });
    const track = makeTrack({ artist: '', title: 'Solo Title' });
    expect(matchAgainstUsbIndex(track, index)).toBeNull();
  });
});
