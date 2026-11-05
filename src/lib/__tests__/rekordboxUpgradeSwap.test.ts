import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  classifyAlignment, cueShiftProblem, swapFileName, swapTargetBase, numberedVariants, archivePathFor,
  losslessBitRate, conversionFor, isLosslessCodec, mergeTags, id3MetadataArgs, buildApplyItem, formatDuration,
  tagsFromMetadata, ALIGNED_MS, type AlignMeasurement, type SwapCue, type SwapRow,
} from '../rekordboxUpgradeSwap';
import type { IAudioMetadata } from 'music-metadata';
import type { UpgradeSwapPlanItem } from '../../types';

function measurement(lags: number[], over: Partial<AlignMeasurement> = {}, ncc = 0.9): AlignMeasurement {
  return {
    originalDurationSec: 300, newDurationSec: 300, globalLagMs: lags[0] ?? 0, globalPeak: 0.9,
    windows: lags.map((lagMs, i) => ({ atSec: 20 + i * 100, lagMs, ncc, inverted: false, atEdge: false })),
    originalTimeline: 'untrimmed', gaplessTrimMs: 25.057,
    ...over,
  };
}

function cue(InMsec: number, OutMsec = -1, extra: Partial<SwapCue> = {}): SwapCue {
  return {
    ID: String(InMsec), Kind: 1, InMsec, InFrame: Math.floor(InMsec * 0.15), InMpegFrame: 0, InMpegAbs: 0,
    OutMsec, OutFrame: OutMsec >= 0 ? Math.floor(OutMsec * 0.15) : 0, OutMpegFrame: 0, OutMpegAbs: 0, CueMicrosec: 0, ...extra,
  };
}

describe('classifyAlignment', () => {
  it('calls a sub-5 ms offset aligned: cues stay put', () => {
    const a = classifyAlignment(measurement([0.4, 0.3, 0.5], { gaplessTrimMs: 0, originalTimeline: 'as-decoded' }));
    expect(a.status).toBe('aligned');
    expect(Math.abs(a.offsetMs)).toBeLessThanOrEqual(ALIGNED_MS);
    expect(a.confidence).toBeCloseTo(0.9);
  });

  it('explains the MP3 encoder delay when the lossless file matches the gapless decode', () => {
    const a = classifyAlignment(measurement([-25.06, -25.06, -25.05]));
    expect(a.status).toBe('shifted');
    expect(a.offsetMs).toBeCloseTo(-25.06, 1);
    expect(a.note).toMatch(/encoder delay/);
    expect(a.note).toMatch(/25 ms earlier/);
  });

  it('shifts for a consistent offset that is not the encoder delay (extra lead-in)', () => {
    const a = classifyAlignment(measurement([37.5, 37.4, 37.5], { gaplessTrimMs: 0 }));
    expect(a.status).toBe('shifted');
    expect(a.note).toMatch(/later in the new file/);
  });

  it('refuses a length difference over 2 s as a different version', () => {
    const a = classifyAlignment(measurement([0, 0, 0], { newDurationSec: 161, originalDurationSec: 303 }));
    expect(a.status).toBe('mismatch');
    expect(a.note).toContain('2:41 vs 5:03');
  });

  it('refuses weak correlation as a different recording', () => {
    const a = classifyAlignment(measurement([-509, -508.7, -508.9], {}, 0.05));
    expect(a.status).toBe('mismatch');
    expect(a.note).toMatch(/same recording/);
  });

  it('refuses windows that disagree (a different edit)', () => {
    const m = measurement([-25, -25, -25]);
    m.windows[1].ncc = 0.01;
    m.windows[2].atEdge = true;
    expect(classifyAlignment(m)).toMatchObject({ status: 'mismatch', note: expect.stringMatching(/different edit/) });
    expect(classifyAlignment(measurement([-25, -25, -12])).status).toBe('mismatch');
  });

  it('cannot check a track with no usable window', () => {
    expect(classifyAlignment(measurement([])).status).toBe('unchecked');
  });
});

describe('cueShiftProblem', () => {
  it('lets a first-beat cue be pinned to 0:00', () => {
    expect(cueShiftProblem([cue(7), cue(60084)], -25, 300_000)).toBeNull();
  });
  it('refuses a cue that would land well before the start, and any loop crossing 0', () => {
    expect(cueShiftProblem([cue(1000)], -1100, 300_000)).toMatch(/before the start/);
    expect(cueShiftProblem([cue(10, 1885)], -25, 300_000)).toMatch(/loop/);
  });
  it('refuses a cue past the end of the new file', () => {
    expect(cueShiftProblem([cue(299_990)], 25, 300_000)).toMatch(/past the end/);
  });
});

describe('paths', () => {
  it('keeps the original basename with .aif and drops a legacy hash prefix', () => {
    expect(swapFileName('/m/Dom Dolla/16686306_Miracle Maker_(Extended Mix).mp3')).toBe('Miracle Maker_(Extended Mix).aif');
    expect(swapFileName('/m/A/01 - A1_cab30b1b-2805.mp3')).toBe('01 - A1_cab30b1b-2805.aif');
    expect(swapFileName('/m/A/Track.m4a')).toBe('Track.aif');
  });

  it('puts the new file beside the one it replaces', () => {
    expect(swapTargetBase('/lib', 'Dom Dolla', '/V/Music/Old Rips/16686306_Miracle Maker.mp3', new Map(), true))
      .toBe(path.join('/V/Music/Old Rips', 'Miracle Maker.aif'));
    // A streaming entry has no folder of its own.
    expect(path.dirname(swapTargetBase('/lib', 'Dom Dolla', 'spotify:track:0juH', new Map(), true))).toBe(path.join('/lib', 'Dom Dolla'));
  });

  it("falls back to <library>/<Artist> when the original's folder isn't there, joining an existing folder whatever its case", () => {
    const existing = new Map([['dj koze', 'DJ Koze']]);
    expect(swapTargetBase('/lib', 'Dj Koze', '/old/x.mp3', existing)).toBe(path.join('/lib', 'DJ Koze', 'x.aif'));
    expect(swapTargetBase('/lib', 'AC/DC', '/old/y.mp3', new Map())).toBe(path.join('/lib', 'AC-DC', 'y.aif'));
    expect(swapTargetBase('/lib', '', '/old/z.mp3', new Map())).toBe(path.join('/lib', 'Unknown Artist', 'z.aif'));
  });

  it('numbers alternatives without touching the first', () => {
    expect(numberedVariants('/lib/A/x.aif', 3)).toEqual(['/lib/A/x.aif', '/lib/A/x (2).aif', '/lib/A/x (3).aif']);
  });

  it('archives the old file in the same layout under upgraded-originals', () => {
    expect(archivePathFor('/V/Music/Dom Dolla/Album/t.mp3', '/V/Music', '/T/_archived'))
      .toBe(path.join('/T/_archived', 'upgraded-originals', 'Dom Dolla', 'Album', 't.mp3'));
    expect(archivePathFor('/V/tracks_to_organize/t.mp3', '/V/Music', '/T/_archived'))
      .toBe(path.join('/T/_archived', 'upgraded-originals', 'tracks_to_organize', 't.mp3'));
    expect(archivePathFor('/Elsewhere/t.mp3', '/V/Music', '/T/_archived'))
      .toBe(path.join('/T/_archived', 'upgraded-originals', 't.mp3'));
  });
});

describe('formats', () => {
  it("matches Rekordbox's BitRate for PCM", () => {
    expect(losslessBitRate(44100, 16, 2)).toBe(1411);
    expect(losslessBitRate(44100, 24, 2)).toBe(2116);
    expect(losslessBitRate(96000, 24, 2)).toBe(4608);
    expect(losslessBitRate(176400, 24, 2)).toBe(8467);
  });

  it('only takes lossless codecs', () => {
    for (const c of ['pcm_s16be', 'pcm_s24be', 'pcm_s16le', 'pcm_f32le', 'flac', 'alac']) expect(isLosslessCodec(c)).toBe(true);
    for (const c of ['mp3', 'aac', 'vorbis', 'opus', 'pcm_mulaw', 'pcm_alaw', '']) expect(isLosslessCodec(c)).toBe(false);
  });

  it('copies an AIFF as it is and converts the rest within CDJ limits', () => {
    expect(conversionFor({ codec: 'pcm_s24be', container: 'aiff', sampleRate: 44100, bitDepth: 24, channels: 2, durationSec: 1 }))
      .toEqual({ copyAudio: true, codec: 'copy', sampleRate: 44100, bitDepth: 24 });
    expect(conversionFor({ codec: 'flac', container: 'flac', sampleRate: 44100, bitDepth: 16, channels: 2, durationSec: 1 }))
      .toEqual({ copyAudio: false, codec: 'pcm_s16be', sampleRate: 44100, bitDepth: 16 });
    expect(conversionFor({ codec: 'flac', container: 'flac', sampleRate: 192000, bitDepth: 24, channels: 2, durationSec: 1 }))
      .toEqual({ copyAudio: false, codec: 'pcm_s24be', sampleRate: 96000, bitDepth: 24 });
    expect(conversionFor({ codec: 'pcm_f32le', container: 'wav', sampleRate: 48000, bitDepth: 32, channels: 2, durationSec: 1 }).codec).toBe('pcm_s24be');
  });

  it('formats durations', () => {
    expect(formatDuration(161)).toBe('2:41');
    expect(formatDuration(303.4)).toBe('5:03');
  });
});

describe('tags', () => {
  it("prefers the original's tags field by field, the store's where it has none", () => {
    const merged = mergeTags({ title: 'Mine', artist: 'A', comment: 'my note', bpm: '' }, { title: 'Store', artist: 'B', bpm: '124', label: 'Lbl' });
    expect(merged).toEqual({ title: 'Mine', artist: 'A', comment: 'my note', bpm: '124', label: 'Lbl' });
  });

  it("reads a comment ffmpeg wrote as TXXX:comment (the app's own tag editor does)", () => {
    const meta = {
      common: { title: 'T', track: { no: null, of: null }, disk: { no: null, of: null } },
      native: { 'ID3v2.3': [{ id: 'TIT2', value: 'T' }, { id: 'TXXX:comment', value: 'typed in Track Lab' }] },
      format: {},
    } as unknown as IAudioMetadata;
    expect(tagsFromMetadata(meta)).toMatchObject({ title: 'T', comment: 'typed in Track Lab' });
  });

  it('writes DJ fields as their ID3 frames', () => {
    const args = id3MetadataArgs({ title: 'T', bpm: '124', key: '8A', remixer: 'R', isrc: 'X', label: 'L' });
    expect(args).toEqual(['-metadata', 'title=T', '-metadata', 'publisher=L', '-metadata', 'TBPM=124', '-metadata', 'TKEY=8A', '-metadata', 'TPE4=R', '-metadata', 'TSRC=X']);
  });
});

describe('buildApplyItem', () => {
  const row = {
    rbId: '113409292', artist: 'Darkside', album: 'X',
    FolderPath: '/V/Music/Darkside/a.mp3', FileNameL: 'a.mp3', FileSize: 5840753, FileType: 1,
    BitRate: 320, SampleRate: 44100, BitDepth: 16, Length: 184, OrgFolderPath: '',
    ID: '113409292', UUID: 'u', StockDate: '2023-03-01', DJPlayCount: 17, Rating: 5, ColorID: '0', Commnt: '', Title: 'Promethium',
    cues: [cue(14039)], counts: { hotCues: 1, memoryCues: 0, loops: 0, playlists: 1, myTags: 2 },
    contentCueCount: 1, contentCue: '[]',
  } as SwapRow;
  const item = { cueShiftMs: -25 } as UpgradeSwapPlanItem;

  it('guards every field it sets, plus the history, and clears MPEG fields off an MP3', () => {
    const a = buildApplyItem({ row, item }, { path: '/V/Music/Darkside/a.aif', size: 32_000_000, sampleRate: 44100, bitDepth: 16, channels: 2, durationSec: 184.3 });
    expect(a.set).toEqual({ FolderPath: '/V/Music/Darkside/a.aif', FileNameL: 'a.aif', FileSize: 32_000_000, FileType: 12, BitRate: 1411, SampleRate: 44100, BitDepth: 16 });
    for (const k of Object.keys(a.set)) expect(a.expectBefore).toHaveProperty(k, (row as unknown as Record<string, unknown>)[k]);
    expect(a.expectBefore).toMatchObject({ StockDate: '2023-03-01', DJPlayCount: 17, Rating: 5, ColorID: '0', UUID: 'u' });
    expect(a).toMatchObject({ cueShiftMs: -25, zeroMpeg: true, newLengthMs: 184_300, contentCueBefore: '[]' });
  });

  it('rewrites Length only when the new file differs by more than a second', () => {
    const a = buildApplyItem({ row, item }, { path: '/x.aif', size: 1, sampleRate: 44100, bitDepth: 24, channels: 2, durationSec: 187.9 });
    expect(a.set).toMatchObject({ Length: 187, BitRate: 2116 });
    expect(a.expectBefore).toHaveProperty('Length', 184);
  });
});
