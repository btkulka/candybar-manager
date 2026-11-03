import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { checkTrackHealth, canonicalContainer } from '../trackHealthCheck';

// checkTrackHealth against real files (made with ffmpeg-static), so the
// container/codec strings music-metadata actually reports are exercised.

let tmp: string;

function ffmpeg(args: string[]): void {
  const r = spawnSync(ffmpegPath as unknown as string, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr?.toString()}`);
}

function make(name: string, codecArgs: string[], extra: string[] = []): string {
  const out = path.join(tmp, name);
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-ac', '2', ...codecArgs,
    '-metadata', 'title=T', '-metadata', 'artist=A', ...extra, out]);
  return out;
}

const codes = (issues: { code: string }[]) => issues.map(i => i.code);

describe('checkTrackHealth on real files', () => {
  beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'health-files-')); });
  afterAll(async () => { if (tmp) await fs.rm(tmp, { recursive: true, force: true }); });

  it('treats uncompressed AIFF-C (sowt) as lossless AIFF: no lossy, bitrate or unsupported flags', async () => {
    const f = make('sowt.aif', ['-c:a', 'pcm_s16le']); // ffmpeg writes little-endian PCM as AIFC/sowt
    const h = await checkTrackHealth(f);
    expect(h.format.container).toBe('AIFF-C');
    expect(h.format.lossless).toBe(true);
    const c = codes(h.issues);
    expect(c).not.toContain('UNSUPPORTED_FORMAT');
    expect(c).not.toContain('LOSSY_FORMAT');
    expect(c).not.toContain('HIGH_BITRATE');
    expect(c).not.toContain('NON_PCM_CODEC');
    expect(h.issues.some(i => i.suggestedAction === 'reencode_mp3')).toBe(false);
  });

  it('recognises an AAC .m4a (ftyp brand list) as a supported MP4 container', async () => {
    const f = make('aac.m4a', ['-c:a', 'aac', '-b:a', '256k']);
    const h = await checkTrackHealth(f);
    expect(canonicalContainer(h.format.container ?? undefined)).toBe('MP4');
    expect(codes(h.issues)).not.toContain('UNSUPPORTED_FORMAT');
    expect(codes(h.issues)).toContain('LOSSY_FORMAT'); // still lossy, just not "unsupported"
  });

  it('never suggests an MP3 re-encode for a lossless file with a bad sample rate', async () => {
    const f = make('hi-res.aiff', ['-c:a', 'pcm_s24be', '-ar', '96000']);
    const h = await checkTrackHealth(f);
    const rate = h.issues.find(i => i.code === 'INVALID_SAMPLE_RATE');
    expect(rate?.suggestedAction).toBe('convert_aiff');
    expect(h.issues.some(i => i.suggestedAction === 'reencode_mp3')).toBe(false);
  });

  it('reads BPM from tags', async () => {
    const f = make('bpm.mp3', ['-c:a', 'libmp3lame', '-b:a', '320k', '-id3v2_version', '3'], ['-metadata', 'TBPM=124']);
    const h = await checkTrackHealth(f);
    expect(h.bpm).toBe(124);
  });

  it('leaves bpm null when the file has none', async () => {
    const f = make('nobpm.wav', ['-c:a', 'pcm_s16le']);
    expect((await checkTrackHealth(f)).bpm).toBeNull();
  });

  it('reports FILE_NOT_FOUND for a missing path', async () => {
    const h = await checkTrackHealth(path.join(tmp, 'nope.aif'));
    expect(codes(h.issues)).toEqual(['FILE_NOT_FOUND']);
    expect(h.isHealthy).toBe(false);
  });
});

describe('canonicalContainer', () => {
  it('maps MP4 ftyp brand lists to MP4 and leaves others alone', () => {
    expect(canonicalContainer('M4A/isom/iso2')).toBe('MP4');
    expect(canonicalContainer('mp42/isom')).toBe('MP4');
    expect(canonicalContainer('isom/iso2/mp41')).toBe('MP4');
    expect(canonicalContainer('AIFF')).toBe('AIFF');
    expect(canonicalContainer('MPEG')).toBe('MPEG');
    expect(canonicalContainer(undefined)).toBeUndefined();
  });
});
