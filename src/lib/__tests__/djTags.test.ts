import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { parseFile, type IAudioMetadata } from 'music-metadata';
import { readDjTags } from '../djTags';
import { updateTags } from '../trackScanner';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string = require('ffmpeg-static');

function meta(common: Record<string, unknown>, id3: Array<{ id: string; value: unknown }> = []): IAudioMetadata {
  return { common, native: id3.length ? { 'ID3v2.3': id3 } : {}, format: {}, quality: { warnings: [] } } as unknown as IAudioMetadata;
}

describe('readDjTags', () => {
  it('reads the standard fields music-metadata maps from TKEY / TBPM / TPE4', () => {
    expect(readDjTags(meta({ key: '8A', bpm: 128, remixer: ['Kyle Watson'] })))
      .toEqual({ key: '8A', bpm: '128', remixer: 'Kyle Watson' });
  });

  it('never reads the field the app used to look for', () => {
    // `remixedBy` does not exist in music-metadata; a value there means nothing.
    expect(readDjTags(meta({ remixedBy: 'ghost' })).remixer).toBe('');
  });

  it('falls back to the TXXX frames the old ffmpeg write produced', () => {
    const m = meta({}, [
      { id: 'TXXX:initialkey', value: '11B' },                              // shape music-metadata 10 reports
      { id: 'TXXX:bpm', value: '140' },
      { id: 'TXXX', value: { description: 'remixer', text: 'Otira' } },    // older object shape
      { id: 'TXXX:comment', value: 'unrelated' },
    ]);
    expect(readDjTags(m)).toEqual({ key: '11B', bpm: '140', remixer: 'Otira' });
  });

  it('prefers the standard frame when both are present', () => {
    const m = meta({ remixer: ['New'] }, [{ id: 'TXXX', value: { description: 'remixer', text: 'Old' } }]);
    expect(readDjTags(m).remixer).toBe('New');
  });

  it('returns empty strings when nothing is tagged', () => {
    expect(readDjTags(meta({}))).toEqual({ key: '', bpm: '', remixer: '' });
  });
});

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let err = '';
    p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
}

describe('updateTags on AIFF (ffmpeg path)', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'djtags-')); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('writes key, BPM and remixer to frames that read back, replacing legacy TXXX copies', async () => {
    const file = path.join(tmp, 'track.aiff');
    // A one-second AIFF tagged the way the app used to tag it: TXXX frames.
    await run(['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '1',
      '-c:a', 'pcm_s16be', '-metadata', 'initialkey=1A', '-metadata', 'bpm=100', '-metadata', 'remixer=Old Remixer',
      '-write_id3v2', '1', '-id3v2_version', '3', '-y', file]);
    const before = readDjTags(await parseFile(file, { duration: false }));
    expect(before).toEqual({ key: '1A', bpm: '100', remixer: 'Old Remixer' }); // via the fallback only

    const result = await updateTags({ filePath: file, title: 'T', artist: 'A', key: '8A', bpm: '128', remixer: 'Kyle Watson' });
    expect(result).toMatchObject({ key: '8A', bpm: '128', remixer: 'Kyle Watson' });

    const after = await parseFile(file, { duration: false });
    expect(after.common.key).toBe('8A');
    expect(after.common.bpm).toBe(128);
    expect(after.common.remixer).toEqual(['Kyle Watson']);
    const txxx = (after.native['ID3v2.3'] || []).filter(t => t.id.startsWith('TXXX'))
      .map(t => (t.id.startsWith('TXXX:') ? t.id.slice(5) : String((t.value as { description?: string })?.description || '')).toLowerCase());
    expect(txxx).not.toContain('remixer');
    expect(txxx).not.toContain('initialkey');
    expect(txxx).not.toContain('bpm');
  }, 30000);
});
