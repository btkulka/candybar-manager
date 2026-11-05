// Locks the lossy/lossless calls behind the Upgrades tab. The entry field
// combinations (FileType, BitRate, the encrypted streaming titles) are the
// ones the live Rekordbox collection returned on 2026-11-02.

import { describe, it, expect } from 'vitest';
import {
  classifyEntry, toUpgradeRow, streamingUri, spotifyIdToResolve, applySpotifyTrack,
  copyKey, buildLosslessIndex, findLosslessCopy, needsStoreSearch, withPastedRow, type RekordboxEntry,
} from '../losslessUpgrade';

function entry(over: Partial<RekordboxEntry>): RekordboxEntry {
  return {
    rbId: '1', artist: 'Claude VonStroke', title: 'Jolean (Extended Mix)', album: '',
    filePath: '/Volumes/Candy Bar/Music/Claude VonStroke/Jolean.aiff',
    fileType: 12, bitRate: 1411, sampleRate: 44100, bitDepth: 16, length: 407,
    ...over,
  };
}

const SPOTIFY_ENTRY = entry({
  rbId: '187420498',
  title: '$A7:v1:GT0cJcopQ0fc5hQKMtp11Q==:C1wrNnqmOLlLHoufdqoNgQ==',
  artist: '$A7:v1:KXGOFBKMpS96SdaQLbUlhg==:KfoH49wThfYUpRbbA0eOcGPo/+YXLA7OD81V9rfcrOI=',
  filePath: 'spotify:track:0juHDDLp734YR1Rd9W4Tx4',
  fileType: 25, bitRate: 0, length: 203,
});

describe('classifyEntry', () => {
  it('calls AIFF/WAV/FLAC lossless with their resolution', () => {
    expect(classifyEntry(entry({}))).toEqual({ format: 'lossless', label: 'AIFF 16/44.1' });
    expect(classifyEntry(entry({ filePath: '/x/t.aif' }))).toEqual({ format: 'lossless', label: 'AIFF 16/44.1' });
    expect(classifyEntry(entry({ filePath: '/x/t.wav', fileType: 11, bitDepth: 24, sampleRate: 96000 })))
      .toEqual({ format: 'lossless', label: 'WAV 24/96' });
    expect(classifyEntry(entry({ filePath: '/x/t.flac', fileType: 5, bitDepth: 0 }))).toEqual({ format: 'lossless', label: 'FLAC' });
  });

  it('calls MP3 lossy with its bit rate', () => {
    expect(classifyEntry(entry({ filePath: '/x/t.mp3', fileType: 1, bitRate: 320 }))).toEqual({ format: 'lossy', label: 'MP3 320' });
  });

  it('tells AAC from ALAC inside an M4A by bit rate', () => {
    expect(classifyEntry(entry({ filePath: '/x/02 Track.m4a', fileType: 4, bitRate: 256 }))).toEqual({ format: 'lossy', label: 'AAC 256' });
    expect(classifyEntry(entry({ filePath: '/x/t.m4a', fileType: 4, bitRate: 912 }))).toEqual({ format: 'lossless', label: 'ALAC 16/44.1' });
    expect(classifyEntry(entry({ filePath: '/x/t.m4a', fileType: 4, bitRate: 0 }))).toEqual({ format: 'unknown', label: 'M4A' });
  });

  it('calls a streaming entry streaming, by URI or by FileType 25', () => {
    expect(classifyEntry(SPOTIFY_ENTRY)).toEqual({ format: 'streaming', label: 'Spotify stream' });
    expect(classifyEntry(entry({ filePath: 'soundcloud:tracks:12345', fileType: 25 }))).toEqual({ format: 'streaming', label: 'SoundCloud stream' });
  });
});

describe('streamingUri', () => {
  it('reads service and id, and ignores file paths', () => {
    expect(streamingUri('spotify:track:0juHDDLp734YR1Rd9W4Tx4')).toEqual({ service: 'spotify', id: '0juHDDLp734YR1Rd9W4Tx4' });
    expect(streamingUri('soundcloud:tracks:12345')).toEqual({ service: 'soundcloud', id: '12345' });
    expect(streamingUri('/Volumes/Candy Bar/Music/a.mp3')).toBeNull();
    expect(streamingUri('file:///Volumes/a.mp3')).toBeNull();
  });
});

describe('streaming rows', () => {
  it('blanks encrypted titles and asks Spotify for them', () => {
    const row = toUpgradeRow(SPOTIFY_ENTRY);
    expect(row.artist).toBe('');
    expect(row.title).toBe('');
    expect(row.note).toBeUndefined();
    expect(spotifyIdToResolve(row)).toBe('0juHDDLp734YR1Rd9W4Tx4');
    expect(needsStoreSearch(row)).toBe(false);

    applySpotifyTrack(row, {
      id: '0juHDDLp734YR1Rd9W4Tx4', name: 'Losing It', artists: ['FISHER'], album: 'Losing It',
      album_image_url: null, release_year: '2018', duration_ms: 247000, preview_url: null, external_url: '', popularity: 0,
    });
    expect(row).toMatchObject({ artist: 'FISHER', title: 'Losing It', album: 'Losing It', duration: 203 });
    expect(spotifyIdToResolve(row)).toBeNull();
    expect(needsStoreSearch(row)).toBe(true);
  });

  it('notes an encrypted non-Spotify entry as unsearchable', () => {
    const row = toUpgradeRow({ ...SPOTIFY_ENTRY, filePath: 'tidal:tracks:999' });
    expect(row.note).toMatch(/encrypted/);
    expect(spotifyIdToResolve(row)).toBeNull();
  });
});

describe('lossless copies elsewhere in the collection', () => {
  const collection = [
    entry({ rbId: '10', title: 'Jolean - Extended Mix' }),
    entry({ rbId: '11', title: 'Jolean (Radio Edit)', filePath: '/x/Jolean radio.mp3', fileType: 1, bitRate: 320 }),
    SPOTIFY_ENTRY,
  ];
  const index = buildLosslessIndex(collection);

  it('finds the same version, punctuation aside', () => {
    const lossy = toUpgradeRow(entry({ rbId: '20', title: 'Jolean (Extended Mix)', filePath: '/x/Jolean.mp3', fileType: 1, bitRate: 320 }));
    expect(findLosslessCopy(lossy, index)).toEqual({ rbId: '10', filePath: collection[0].filePath, formatLabel: 'AIFF 16/44.1' });
  });

  it('never offers a different version or a lossy file', () => {
    const radio = toUpgradeRow(entry({ rbId: '11', title: 'Jolean (Radio Edit)', filePath: '/x/Jolean radio.mp3', fileType: 1, bitRate: 320 }));
    expect(findLosslessCopy(radio, index)).toBeUndefined();
    expect(needsStoreSearch(radio)).toBe(true);
  });

  it('keeps non-Latin titles apart instead of folding them to nothing', () => {
    expect(copyKey('YOASOBI', '夜に駆ける')).not.toBe(copyKey('YOASOBI', '群青'));
    expect(copyKey('Кино', 'Группа крови')).toBe('кино|группакрови');
    expect(copyKey('Tiësto', 'Adagio For Strings')).toBe(copyKey('Tiesto', 'adagio for strings!'));
    expect(copyKey('', 'Title')).toBeNull();

    const jp = buildLosslessIndex([entry({ rbId: '30', artist: 'YOASOBI', title: '群青', filePath: '/x/gunjou.aiff' })]);
    const other = toUpgradeRow(entry({ rbId: '31', artist: 'YOASOBI', title: '夜に駆ける', filePath: '/x/yoru.mp3', fileType: 1, bitRate: 320 }));
    expect(findLosslessCopy(other, jp)).toBeUndefined();
  });

  it('finds a copy whose tags spell the version or the credits differently', () => {
    const lib = buildLosslessIndex([
      entry({ rbId: '40', artist: 'Chris Lake, FISHER', title: 'Turn Off The Lights (Original Mix)', filePath: '/x/totl.aiff' }),
      entry({ rbId: '41', artist: 'Disclosure, Sam Smith', title: 'Latch', filePath: '/x/latch.wav', fileType: 11 }),
    ]);
    const lossy = (artist: string, title: string) =>
      toUpgradeRow(entry({ rbId: '50', artist, title, filePath: '/x/t.mp3', fileType: 1, bitRate: 320 }));
    expect(findLosslessCopy(lossy('Chris Lake & Fisher', 'Turn Off The Lights'), lib)?.rbId).toBe('40');
    expect(findLosslessCopy(lossy('Chris Lake and FISHER', 'Turn Off The Lights - Original Mix'), lib)?.rbId).toBe('40');
    expect(findLosslessCopy(lossy('Disclosure', 'Latch (feat. Sam Smith)'), lib)?.rbId).toBe('41');
  });

  it('never offers a remix, a live take or another song as the copy', () => {
    const lib = buildLosslessIndex([
      entry({ rbId: '60', artist: 'Bicep', title: 'Glue (Hammer Remix)', filePath: '/x/glue-hammer.aiff' }),
      entry({ rbId: '61', artist: 'Bicep', title: 'Glue (Live)', filePath: '/x/glue-live.aiff' }),
      entry({ rbId: '62', artist: 'Rüfüs Du Sol', title: 'Innerbloom (What So Not Remix)', filePath: '/x/ib.aiff' }),
      entry({ rbId: '63', artist: 'Flume', title: 'Glue', filePath: '/x/flume-glue.aiff' }),
    ]);
    const glue = toUpgradeRow(entry({ rbId: '70', artist: 'Bicep', title: 'Glue', filePath: '/x/glue.mp3', fileType: 1, bitRate: 320 }));
    expect(findLosslessCopy(glue, lib)).toBeUndefined();
  });

  it('skips a copy that is the entry itself', () => {
    const self = toUpgradeRow(entry({ rbId: '10', title: 'Jolean - Extended Mix' }));
    expect(findLosslessCopy(self, index)).toBeUndefined();
  });

  it('does not search a lossy row that already has a lossless copy', () => {
    const row = toUpgradeRow(entry({ rbId: '20', filePath: '/x/Jolean.mp3', fileType: 1, bitRate: 320 }));
    row.losslessCopy = findLosslessCopy(row, index);
    expect(needsStoreSearch(row)).toBe(false);
  });
});

describe('flips and the lossless copies elsewhere in the collection', () => {
  const original = entry({ rbId: '30', artist: 'Sub Focus, Julia Church, John Summit', title: 'Go Back (Original Mix)', filePath: '/x/Go_Back.aiff' });
  const flipAiff = entry({ rbId: '31', artist: 'John Summit, Sub Focus', title: 'Go Back - Shizz Lo Flip', filePath: '/x/Go Back Shizz Lo.wav', fileType: 11 });

  it('never relinks a flip to the original', () => {
    const lossy = toUpgradeRow(entry({ rbId: '40', artist: 'John Summit & Sub Focus', title: 'Go Back (Shizz Lo Flip)', filePath: '/x/flip.mp3', fileType: 1, bitRate: 320 }));
    expect(findLosslessCopy(lossy, buildLosslessIndex([original]))).toBeUndefined();
  });

  it('finds the same flip written the other way', () => {
    const lossy = toUpgradeRow(entry({ rbId: '40', artist: 'John Summit & Sub Focus', title: 'Go Back (Shizz Lo Flip)', filePath: '/x/flip.mp3', fileType: 1, bitRate: 320 }));
    expect(findLosslessCopy(lossy, buildLosslessIndex([original, flipAiff]))?.rbId).toBe('31');
  });
});

describe('a pasted free download link in the downloader rows', () => {
  const row = (key: string, scId: string, source?: string) => ({ upgradeKey: key, scId, ...(source ? { source } : {}) });
  const rows = [row('rb:1', 'a'), row('rb:2', 'b'), row('rb:2', 'bandcamp:9', 'bandcamp'), row('rb:3', 'c')];

  it("takes the place of the row's SoundCloud copy, ahead of its Bandcamp fallback", () => {
    expect(withPastedRow(rows, 'rb:2', row('rb:2', 'pasted')).map(r => r.scId)).toEqual(['a', 'pasted', 'bandcamp:9', 'c']);
  });

  it('goes at the end for a row the search found nothing for, and drops out when forgotten', () => {
    expect(withPastedRow(rows, 'rb:4', row('rb:4', 'pasted')).map(r => r.scId)).toEqual(['a', 'b', 'bandcamp:9', 'c', 'pasted']);
    expect(withPastedRow(rows, 'rb:2', null).map(r => r.scId)).toEqual(['a', 'bandcamp:9', 'c']);
  });
});
