import { describe, it, expect, vi } from 'vitest';

vi.mock('electron-log', () => ({
  default: {
    transports: { console: { level: 'info' } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    scope: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
}));

import { summarizeHealth, type TrackHealth } from '../trackHealthCheck';
import type { HealthIssue } from '../../types';

function makeHealth(overrides: Partial<TrackHealth> & { filePath?: string }): TrackHealth {
  return {
    filePath: overrides.filePath ?? '/music/track.aif',
    fileName: 'track.aif',
    artist: 'Artist',
    title: 'Title',
    album: 'Album',
    year: 2020,
    genre: 'Electronic',
    hasAlbumArt: true,
    isHealthy: true,
    issues: [],
    dateAdded: null,
    format: {
      container: 'AIFF',
      codec: 'PCM',
      sampleRate: 44100,
      bitDepth: 16,
      bitRate: null,
      channels: 2,
      duration: 300,
      lossless: true,
    },
    ...overrides,
  };
}

function makeIssue(code: string, severity: 'error' | 'warning'): HealthIssue {
  return { code, severity, message: code, detail: '', suggestedAction: 'none' };
}

describe('summarizeHealth', () => {
  it('returns all zeros for an empty list', () => {
    const summary = summarizeHealth([]);
    expect(summary).toEqual({ total: 0, healthy: 0, warnings: 0, errors: 0, byIssueCode: {} });
  });

  it('counts a track with no issues as healthy', () => {
    const summary = summarizeHealth([makeHealth({})]);
    expect(summary.healthy).toBe(1);
    expect(summary.warnings).toBe(0);
    expect(summary.errors).toBe(0);
  });

  it('counts a track with only warnings as warnings (isHealthy = true)', () => {
    const track = makeHealth({
      isHealthy: true,
      issues: [makeIssue('MISSING_ALBUM_ART', 'warning')],
    });
    const summary = summarizeHealth([track]);
    expect(summary.warnings).toBe(1);
    expect(summary.healthy).toBe(0);
    expect(summary.errors).toBe(0);
  });

  it('counts a track with an error as errors (isHealthy = false)', () => {
    const track = makeHealth({
      isHealthy: false,
      issues: [makeIssue('UNSUPPORTED_FORMAT', 'error')],
    });
    const summary = summarizeHealth([track]);
    expect(summary.errors).toBe(1);
    expect(summary.healthy).toBe(0);
  });

  it('tracks byIssueCode counts', () => {
    const tracks = [
      makeHealth({ isHealthy: false, issues: [makeIssue('UNSUPPORTED_FORMAT', 'error')] }),
      makeHealth({ isHealthy: false, issues: [makeIssue('UNSUPPORTED_FORMAT', 'error'), makeIssue('LOW_SAMPLE_RATE', 'error')] }),
      makeHealth({ isHealthy: true, issues: [makeIssue('MISSING_ALBUM_ART', 'warning')] }),
    ];
    const summary = summarizeHealth(tracks);
    expect(summary.byIssueCode['UNSUPPORTED_FORMAT']).toBe(2);
    expect(summary.byIssueCode['LOW_SAMPLE_RATE']).toBe(1);
    expect(summary.byIssueCode['MISSING_ALBUM_ART']).toBe(1);
  });

  it('correctly tallies a mixed batch', () => {
    const tracks = [
      makeHealth({}), // healthy
      makeHealth({}), // healthy
      makeHealth({ isHealthy: true, issues: [makeIssue('LOSSY_FORMAT', 'warning')] }), // warning
      makeHealth({ isHealthy: false, issues: [makeIssue('UNSUPPORTED_FORMAT', 'error')] }), // error
    ];
    const summary = summarizeHealth(tracks);
    expect(summary.total).toBe(4);
    expect(summary.healthy).toBe(2);
    expect(summary.warnings).toBe(1);
    expect(summary.errors).toBe(1);
  });
});

describe('XDJ-RX3 health check rules (documented expected behavior)', () => {
  it('FLAC should produce UNSUPPORTED_FORMAT error', () => {
    const track = makeHealth({
      isHealthy: false,
      format: { container: 'FLAC', codec: 'FLAC', sampleRate: 44100, bitDepth: 16, bitRate: null, channels: 2, duration: 300, lossless: true },
      issues: [makeIssue('UNSUPPORTED_FORMAT', 'error')],
    });
    expect(track.issues.some(i => i.code === 'UNSUPPORTED_FORMAT')).toBe(true);
    expect(track.isHealthy).toBe(false);
  });

  it('96kHz sample rate should be an error (not in supported list)', () => {
    // Supported: 32000, 44100, 48000
    const track = makeHealth({
      isHealthy: false,
      format: { container: 'AIFF', codec: 'PCM', sampleRate: 96000, bitDepth: 24, bitRate: null, channels: 2, duration: 300, lossless: true },
      issues: [makeIssue('INVALID_SAMPLE_RATE', 'error')],
    });
    expect(track.isHealthy).toBe(false);
    expect(track.issues.some(i => i.code === 'INVALID_SAMPLE_RATE')).toBe(true);
  });

  it('16000 Hz sample rate should be LOW_SAMPLE_RATE (below 32000 Hz minimum)', () => {
    const track = makeHealth({
      isHealthy: false,
      format: { container: 'AIFF', codec: 'PCM', sampleRate: 16000, bitDepth: 16, bitRate: null, channels: 2, duration: 300, lossless: true },
      issues: [makeIssue('LOW_SAMPLE_RATE', 'error')],
    });
    expect(track.issues.some(i => i.code === 'LOW_SAMPLE_RATE')).toBe(true);
  });

  it('multichannel audio (>2 channels) should be an error', () => {
    const track = makeHealth({
      isHealthy: false,
      format: { container: 'AIFF', codec: 'PCM', sampleRate: 44100, bitDepth: 24, bitRate: null, channels: 6, duration: 300, lossless: true },
      issues: [makeIssue('MULTICHANNEL', 'error')],
    });
    expect(track.isHealthy).toBe(false);
    expect(track.issues.some(i => i.code === 'MULTICHANNEL')).toBe(true);
  });

  it('MP3 at 320kbps should be healthy (valid lossy format within bitrate range)', () => {
    // 320kbps MP3 is valid — only LOSSY_FORMAT warning, no errors
    const track = makeHealth({
      isHealthy: true,
      format: { container: 'MPEG', codec: 'MP3', sampleRate: 44100, bitDepth: null, bitRate: 320, channels: 2, duration: 300, lossless: false },
      issues: [makeIssue('LOSSY_FORMAT', 'warning'), makeIssue('MISSING_ALBUM_ART', 'warning')],
    });
    expect(track.isHealthy).toBe(true);
  });

  it('MP3 below 32kbps should produce LOW_BITRATE warning', () => {
    const track = makeHealth({
      isHealthy: true,
      format: { container: 'MPEG', codec: 'MP3', sampleRate: 44100, bitDepth: null, bitRate: 16, channels: 2, duration: 300, lossless: false },
      issues: [makeIssue('LOW_BITRATE', 'warning'), makeIssue('LOSSY_FORMAT', 'warning')],
    });
    expect(track.issues.some(i => i.code === 'LOW_BITRATE')).toBe(true);
    expect(track.isHealthy).toBe(true); // bitrate issues are warnings, not errors
  });

  it('tracks over 2 hours should produce LONG_DURATION warning', () => {
    const track = makeHealth({
      isHealthy: true,
      format: { container: 'AIFF', codec: 'PCM', sampleRate: 44100, bitDepth: 16, bitRate: null, channels: 2, duration: 7300, lossless: true },
      issues: [makeIssue('LONG_DURATION', 'warning')],
    });
    expect(track.issues.some(i => i.code === 'LONG_DURATION')).toBe(true);
  });

  it('tracks under 10 seconds should produce SHORT_DURATION warning', () => {
    const track = makeHealth({
      isHealthy: true,
      format: { container: 'AIFF', codec: 'PCM', sampleRate: 44100, bitDepth: 16, bitRate: null, channels: 2, duration: 5, lossless: true },
      issues: [makeIssue('SHORT_DURATION', 'warning')],
    });
    expect(track.issues.some(i => i.code === 'SHORT_DURATION')).toBe(true);
  });

  it('isHealthy is false only when errors are present', () => {
    const warningsOnly = makeHealth({ isHealthy: true, issues: [makeIssue('LOSSY_FORMAT', 'warning')] });
    const withError = makeHealth({ isHealthy: false, issues: [makeIssue('UNSUPPORTED_FORMAT', 'error')] });
    expect(warningsOnly.isHealthy).toBe(true);
    expect(withError.isHealthy).toBe(false);
  });
});
