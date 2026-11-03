import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { parseFile } from 'music-metadata';
import { convertToAiff, reencodeToMp3 } from '../trackConverter';
import { setManualTrashDir } from '../safeDelete';
import { initWriteJournal, flushWriteJournal, getWriteJournalDir } from '../writeJournal';

let tmp: string;
let trashDir: string;

function ffmpeg(args: string[]): void {
  const r = spawnSync(ffmpegPath as unknown as string, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr?.toString()}`);
}

/** A 2s sine with full tags and a cover picture, as MP3 or FLAC. */
function makeTaggedSource(out: string, codecArgs: string[], tags: Record<string, string>): void {
  ffmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-f', 'lavfi', '-i', 'color=c=red:s=32x32:d=1', '-frames:v', '1',
    '-map', '0:a', '-map', '1:v', ...codecArgs, '-c:v', 'mjpeg', '-disposition:v', 'attached_pic',
    ...Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]),
    out,
  ]);
}

async function tagsOf(p: string) {
  const m = await parseFile(p);
  return {
    artist: m.common.artist, title: m.common.title, album: m.common.album,
    bpm: m.common.bpm, key: m.common.key, pictures: m.common.picture?.length ?? 0,
    sampleRate: m.format.sampleRate, bits: m.format.bitsPerSample, container: m.format.container,
  };
}

async function journal(): Promise<Record<string, unknown>[]> {
  await flushWriteJournal();
  const dir = getWriteJournalDir()!;
  const files = await fs.readdir(dir).catch(() => []);
  const lines: Record<string, unknown>[] = [];
  for (const f of files) {
    const raw = await fs.readFile(path.join(dir, f), 'utf8');
    for (const l of raw.trim().split('\n').filter(Boolean)) lines.push(JSON.parse(l));
  }
  return lines;
}

describe('trackConverter', () => {
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'converter-test-'));
    trashDir = path.join(tmp, 'Trash');
    setManualTrashDir(trashDir); // never touch the real Trash
    initWriteJournal(path.join(tmp, 'userData'));
  });
  afterAll(async () => {
    setManualTrashDir(null);
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it('MP3 → AIFF keeps artist/title/album, BPM and the cover picture', async () => {
    const src = path.join(tmp, 'tagged.mp3');
    makeTaggedSource(src, ['-c:a', 'libmp3lame', '-b:a', '192k', '-id3v2_version', '3'],
      { artist: 'Test Artist', title: 'Test Title', album: 'Alb', TBPM: '128' });
    const r = await convertToAiff(src);
    expect(r.success).toBe(true);
    expect(r.outputPath).toBe(path.join(tmp, 'tagged.aif'));
    expect(await tagsOf(r.outputPath!)).toMatchObject({
      artist: 'Test Artist', title: 'Test Title', album: 'Alb', bpm: 128, pictures: 1,
      sampleRate: 44100, bits: 24, container: 'AIFF',
    });
    // The converter itself never deletes a differently-named original.
    await expect(fs.access(src)).resolves.toBeUndefined();
  });

  it('FLAC → AIFF writes BPM and key as TBPM/TKEY that readers recognise', async () => {
    const src = path.join(tmp, 'dj.flac');
    makeTaggedSource(src, ['-c:a', 'flac'], { artist: 'Flac Artist', title: 'Flac Title', BPM: '126', INITIALKEY: '8A' });
    const r = await convertToAiff(src);
    expect(r.success).toBe(true);
    expect(await tagsOf(r.outputPath!)).toMatchObject({ artist: 'Flac Artist', bpm: 126, key: '8A', pictures: 1 });
  });

  it('in-place AIFF reconversion moves the original to the Trash before replacing it', async () => {
    const src = path.join(tmp, 'inplace.aiff');
    makeTaggedSource(src, ['-c:a', 'pcm_s16be', '-ar', '48000', '-write_id3v2', '1'], { artist: 'In Place', title: 'Song' });
    const r = await convertToAiff(src);
    expect(r.success).toBe(true);
    expect(r.replacedInPlace).toBe(true);
    expect(r.outputPath).toBe(src);
    expect(await tagsOf(src)).toMatchObject({ artist: 'In Place', sampleRate: 44100, bits: 24, pictures: 1 });
    // The original (48 kHz, 16-bit) is recoverable from the Trash.
    expect(r.originalTrashPath).toBe(path.join(trashDir, 'inplace.aiff'));
    expect(await tagsOf(r.originalTrashPath!)).toMatchObject({ artist: 'In Place', sampleRate: 48000, bits: 16 });
  });

  it('keepOriginal refuses an in-place conversion and journals the refusal', async () => {
    const src = path.join(tmp, 'keep.aif');
    ffmpeg(['-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'pcm_s16be', src]);
    const before = await fs.readFile(src);
    const r = await convertToAiff(src, undefined, { keepOriginal: true });
    expect(r.success).toBe(false);
    expect(Buffer.compare(await fs.readFile(src), before)).toBe(0);
    const entries = await journal();
    expect(entries.find(e => e.src === src)).toMatchObject({ op: 'convert', outcome: 'error', detail: { refused: 'keep-original' } });
  });

  it('journals an ffmpeg failure and leaves no temp file behind', async () => {
    const src = path.join(tmp, 'garbage.mp3');
    await fs.writeFile(src, 'not audio at all');
    const r = await convertToAiff(src);
    expect(r.success).toBe(false);
    const entries = await journal();
    expect(entries.find(e => e.src === src)).toMatchObject({ op: 'convert', outcome: 'error' });
    expect((await fs.readdir(tmp)).some(n => n.includes('.converting-'))).toBe(false);
  });

  it('refuses to overwrite a different file at the derived destination (and journals it)', async () => {
    const src = path.join(tmp, 'clash.mp3');
    makeTaggedSource(src, ['-c:a', 'libmp3lame'], { artist: 'A', title: 'B' });
    await fs.writeFile(path.join(tmp, 'clash.aif'), 'someone else');
    const r = await convertToAiff(src);
    expect(r.success).toBe(false);
    expect(await fs.readFile(path.join(tmp, 'clash.aif'), 'utf8')).toBe('someone else');
    const entries = await journal();
    expect(entries.find(e => e.src === src && e.outcome === 'error')).toMatchObject({ detail: { refused: 'destination-exists' } });
  });

  it('MP3 re-encode keeps tags and art, and trashes the replaced original', async () => {
    const src = path.join(tmp, 'reencode.mp3');
    makeTaggedSource(src, ['-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '3'], { artist: 'Re', title: 'Encode', TBPM: '124' });
    const r = await reencodeToMp3(src);
    expect(r.success).toBe(true);
    expect(r.replacedInPlace).toBe(true);
    expect(await tagsOf(src)).toMatchObject({ artist: 'Re', title: 'Encode', bpm: 124, pictures: 1 });
    expect(r.originalTrashPath).toBeTruthy();
    await expect(fs.access(r.originalTrashPath!)).resolves.toBeUndefined();
  });
});
