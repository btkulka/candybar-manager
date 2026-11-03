import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { parseFile } from 'music-metadata';
import { createScopedLogger } from './logger';
import { repairAiffHeader } from './aiffRepair';
import { recordWrite, statBytes } from './writeJournal';
import { safeDelete } from './safeDelete';
import { readDjTags } from './djTags';
import { updateDownloadedTrackPath } from './db';
import { invalidateLibraryFileLists } from './jobQueue/sharedResultStore';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string = require('ffmpeg-static');
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const ffprobePath: string = require('ffprobe-static').path;

const log = createScopedLogger('Converter');

export type ConversionResult = {
  success: boolean;
  originalPath: string;
  outputPath?: string;
  errorMessage?: string;
  /** True when the output replaced the original under the same name. */
  replacedInPlace?: boolean;
  /** Where the replaced original went, when it was moved into a Trash folder we know. */
  originalTrashPath?: string;
};

export type ConvertOptions = {
  /**
   * Never move or replace the original. A conversion to a new extension leaves
   * the original beside the output (it already does); an in-place conversion
   * (same filename) is refused instead of replacing the file.
   */
  keepOriginal?: boolean;
};

export type ConversionProgress = {
  filePath: string;
  percent: number;
};

type ProgressCallback = (progress: ConversionProgress) => void;

// Cache ffmpeg availability check for the process lifetime
let ffmpegAvailableCache: boolean | null = null;

async function checkFfmpegAvailable(): Promise<boolean> {
  if (ffmpegAvailableCache !== null) return ffmpegAvailableCache;
  try {
    await fs.access(ffmpegPath);
    ffmpegAvailableCache = true;
  } catch {
    ffmpegAvailableCache = false;
  }
  return ffmpegAvailableCache;
}

function parseDuration(text: string): number {
  const m = text.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  if (!m) return 0;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
}

function parseTime(text: string): number {
  const m = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
  if (!m) return 0;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
}

// Pull the most informative line(s) out of ffmpeg stderr so the UI layer can
// show something actionable instead of "exited with code 1".
function summarizeFfmpegError(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const signal = lines.filter((l) =>
    /^\[[^\]]+\]\s+(error|could not|invalid|unsupported|unknown or unsupported)/i.test(l) ||
    /^(error|invalid data|no such file|permission denied|unable|failed|unsupported)/i.test(l)
  );
  const picked = signal.pop() || lines.pop() || 'unknown error';
  // Strip the [aiff @ 0x...] style prefix — noise for users.
  return picked.replace(/^\[[^\]]+\]\s*/, '').slice(0, 240);
}

// AIFC files with a junk compressionType FourCC fail ffmpeg reads with this
// exact message. Matches the contract trackScanner.ts uses for the renderer's
// repair-and-retry flow (see shared.ts updateTrackTagsWithRepair).
const AIFC_CORRUPT_HEADER_PATTERN = /could not find COMM tag or invalid block_align value/i;

/**
 * Guard against ffmpeg's '-y' silently overwriting an unrelated pre-existing file
 * at the derived destination (callers then delete the source → permanent loss of
 * the clobbered file). Returns an error string when the destination holds a
 * DIFFERENT existing file, or null when it's safe (destination free, or resolves
 * to the input itself — the in-place case, which we handle via a temp + rename).
 */
async function conversionTargetError(filePath: string, outputPath: string): Promise<string | null> {
  if (path.resolve(filePath) === path.resolve(outputPath)) return null; // in-place; temp+rename below
  try {
    const outStat = await fs.stat(outputPath);
    const inStat = await fs.stat(filePath).catch(() => null);
    // Same underlying file (e.g. case-insensitive FS treating .AIF/.aif as one).
    if (inStat && inStat.ino === outStat.ino && inStat.dev === outStat.dev) return null;
    return `a different file already exists at the destination (${path.basename(outputPath)}); refusing to overwrite`;
  } catch {
    return null; // destination does not exist — safe
  }
}

/** Unique sibling temp path preserving the output extension (so ffmpeg infers the format). */
function tempConversionPath(outputPath: string): string {
  const ext = path.extname(outputPath);
  const stem = outputPath.slice(0, outputPath.length - ext.length);
  return `${stem}.converting-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
}

type ConversionJob = {
  filePath: string;
  outputPath: string;
  /** Codec/format args placed between the stream maps and the output path. */
  codecArgs: string[];
  /** Write ID3v2 (AIFF needs it switched on; MP3 has it by default). */
  writeId3: boolean;
  context: 'convert-aiff' | 'reencode-mp3';
  onProgress?: ProgressCallback;
  options?: ConvertOptions;
};

/**
 * Tag args that carry DJ tags across. -map_metadata 0 copies most fields, but a
 * FLAC/WAV source names BPM/key 'BPM'/'INITIALKEY', which the ID3 writer would
 * emit as TXXX frames that Rekordbox ignores, so set TBPM/TKEY explicitly.
 */
async function djTagArgs(filePath: string): Promise<string[]> {
  try {
    const meta = await parseFile(filePath, { duration: false, skipCovers: true });
    const tags = readDjTags(meta);
    const bpm = tags.bpm;
    let key = tags.key;
    if (!key) {
      // Vorbis/FLAC keeps the key as INITIALKEY, which music-metadata doesn't map to common.key.
      for (const native of Object.values(meta.native)) {
        const hit = native.find(t => /^(INITIALKEY|INITIAL KEY|KEY)$/i.test(t.id) && t.value != null && String(t.value).trim());
        if (hit) { key = String(hit.value).trim(); break; }
      }
    }
    const args: string[] = [];
    if (bpm) args.push('-metadata', `TBPM=${bpm}`, '-metadata', 'BPM=');
    if (key) args.push('-metadata', `TKEY=${key}`, '-metadata', 'INITIALKEY=');
    return args;
  } catch {
    return [];
  }
}

function runFfmpeg(args: string[], onStderr?: (text: string) => void): Promise<{ code: number | null; stderr: string; spawnError?: Error }> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      onStderr?.(text);
    });
    proc.on('close', (code) => resolve({ code, stderr }));
    proc.on('error', (err) => resolve({ code: null, stderr, spawnError: err }));
  });
}

/**
 * Shared conversion runner: ffmpeg into a sibling temp, then finalize. Tags and
 * cover art are carried over. An in-place conversion moves the original into the
 * Trash before the converted file takes its name, so it stays recoverable. Every
 * outcome — refusals and failures included — is journaled.
 */
async function runConversion(job: ConversionJob): Promise<ConversionResult> {
  const { filePath, outputPath, codecArgs, writeId3, context, onProgress, options } = job;
  const inPlace = path.resolve(filePath) === path.resolve(outputPath);
  const bytes = await statBytes(filePath);
  const fail = (errorMessage: string, detail: Record<string, unknown> = {}): ConversionResult => {
    recordWrite({ op: 'convert', src: filePath, dest: outputPath, bytes, context, outcome: 'error', error: errorMessage, detail: { inPlace, ...detail } });
    return { success: false, originalPath: filePath, errorMessage };
  };

  if (!(await checkFfmpegAvailable())) return fail('ffmpeg not available');

  const conflict = await conversionTargetError(filePath, outputPath);
  if (conflict) {
    log.warn(`${context} refusing to overwrite: ${conflict}`);
    return fail(conflict, { refused: 'destination-exists' });
  }
  if (inPlace && options?.keepOriginal) {
    return fail('in-place conversion would replace the original, and keepOriginal is set', { refused: 'keep-original' });
  }

  const tmpPath = tempConversionPath(outputPath);
  const args = [
    '-i', filePath,
    // Audio plus the first picture stream (cover art), copied untouched.
    '-map', '0:a:0', '-map', '0:v:0?', '-c:v', 'copy', '-disposition:v:0', 'attached_pic',
    '-map_metadata', '0',
    ...codecArgs,
    ...(writeId3 ? ['-write_id3v2', '1'] : []),
    '-id3v2_version', '3',
    ...(await djTagArgs(filePath)),
    '-y', tmpPath,
  ];

  let duration = 0;
  const { code, stderr, spawnError } = await runFfmpeg(args, (text) => {
    if (!onProgress) return;
    if (!duration) duration = parseDuration(text);
    if (duration > 0) {
      const elapsed = parseTime(text);
      if (elapsed > 0) onProgress({ filePath, percent: Math.min(99, Math.round((elapsed / duration) * 100)) });
    }
  });

  if (spawnError || code !== 0) {
    await fs.unlink(tmpPath).catch(() => {});
    if (spawnError) return fail(spawnError.message);
    log.error(`ffmpeg ${context} failed:`, stderr.slice(-500));
    if (AIFC_CORRUPT_HEADER_PATTERN.test(stderr)) return fail(`AIFC_CORRUPT_HEADER: ${filePath}`);
    return fail(`ffmpeg exited with code ${code}: ${summarizeFfmpegError(stderr)}`);
  }

  // In place: park the original in the Trash first, so replacing it is recoverable.
  let originalTrashPath: string | undefined;
  if (inPlace) {
    try {
      const res = await safeDelete(filePath, { context: `${context}:replace-original`, detail: { replacedBy: 'converted output' } });
      originalTrashPath = res.trashPath;
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => {});
      return fail(`could not move the original to the Trash before replacing it: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    await fs.rename(tmpPath, outputPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (inPlace) {
      // The original is already in the Trash; keep the converted temp rather
      // than lose both. Its name is ignored by every scan.
      return fail(`failed to finalize output: ${msg}. The original is in the Trash${originalTrashPath ? ` (${originalTrashPath})` : ''}; the converted file is at ${tmpPath}`, { tmpPath, originalTrashPath });
    }
    await fs.unlink(tmpPath).catch(() => {});
    return fail(`failed to finalize output: ${msg}`);
  }

  onProgress?.({ filePath, percent: 100 });
  recordWrite({ op: 'convert', src: filePath, dest: outputPath, bytes, context, outcome: 'ok', detail: inPlace ? { inPlace: true, originalTrashPath } : undefined });
  // The output is the file going forward (callers trash the original), so a
  // download record should follow it — unless the caller is keeping the original.
  if (!inPlace && !options?.keepOriginal) updateDownloadedTrackPath(filePath, outputPath);
  invalidateLibraryFileLists();
  return { success: true, originalPath: filePath, outputPath, replacedInPlace: inPlace, originalTrashPath };
}

/**
 * Convert to 24-bit/44.1kHz AIFF, keeping tags and cover art. An AIFF-family
 * input keeps its filename (so Rekordbox path references survive); its original
 * goes to the Trash. Other inputs get a new `.aif` beside the original, which
 * this function never deletes (see deleteOriginalAfterConversion).
 */
export async function convertToAiff(
  filePath: string,
  onProgress?: ProgressCallback,
  options?: ConvertOptions,
): Promise<ConversionResult> {
  const ext = path.extname(filePath);
  // For an AIFF-family input, keep the SAME filename (convert in place via temp)
  // so existing Rekordbox path references aren't orphaned by a .aiff -> .aif rename.
  const isAiffInput = /\.aiff?$/i.test(ext);
  const outputPath = isAiffInput ? filePath : filePath.slice(0, -ext.length) + '.aif';
  return runConversion({
    filePath, outputPath, context: 'convert-aiff', onProgress, options, writeId3: true,
    codecArgs: ['-c:a', 'pcm_s24be', '-ar', '44100'],
  });
}

/** Re-encode to 320kbps/44.1kHz MP3, keeping tags and cover art. MP3 input is replaced in place (original to the Trash). */
export async function reencodeToMp3(filePath: string, options?: ConvertOptions): Promise<ConversionResult> {
  const ext = path.extname(filePath);
  // .mp3 input → re-encode in place (same filename via temp); other formats → .mp3.
  const isMp3Input = ext.toLowerCase() === '.mp3';
  const outputPath = isMp3Input ? filePath : filePath.slice(0, -ext.length) + '.mp3';
  return runConversion({
    filePath, outputPath, context: 'reencode-mp3', options, writeId3: false,
    codecArgs: ['-c:a', 'libmp3lame', '-b:a', '320k', '-ar', '44100'],
  });
}

// ============================================================
// MP3 preview transcoding for the media:// protocol handler.
// Chromium's bundled FFmpeg can't demux 24-bit AIFF, so problem
// files get transcoded to MP3 once, cached in memory, and served
// with full Range support so the <audio> element can seek and
// show duration like any other MP3.
// ============================================================

const PREVIEW_CACHE_MAX_ENTRIES = 12;
const PREVIEW_CACHE_MAX_BYTES = 150 * 1024 * 1024;
// Keyed by path+mtime so edits (e.g. an aiffRepair write) invalidate the
// old entry automatically. Map insertion order gives us LRU.
const previewCache = new Map<string, Buffer>();

async function previewCacheKey(filePath: string): Promise<string> {
  try {
    const stat = await fs.stat(filePath);
    return `${filePath}:${stat.mtimeMs}`;
  } catch {
    return filePath;
  }
}

function getPreviewFromCache(key: string): Buffer | undefined {
  const buf = previewCache.get(key);
  if (buf) {
    previewCache.delete(key);
    previewCache.set(key, buf);
  }
  return buf;
}

function addPreviewToCache(key: string, buf: Buffer): void {
  previewCache.set(key, buf);
  let totalBytes = 0;
  for (const b of previewCache.values()) totalBytes += b.length;
  while (previewCache.size > PREVIEW_CACHE_MAX_ENTRIES || totalBytes > PREVIEW_CACHE_MAX_BYTES) {
    const oldest = previewCache.keys().next().value;
    if (oldest === undefined) break;
    const oldBuf = previewCache.get(oldest);
    if (oldBuf) totalBytes -= oldBuf.length;
    previewCache.delete(oldest);
  }
}

function transcodeToMp3Buffer(filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', filePath,
      '-vn',
      '-c:a', 'libmp3lame',
      '-b:a', '192k',
      '-f', 'mp3',
      'pipe:1',
    ];
    const proc = spawn(ffmpegPath, args);
    const chunks: Buffer[] = [];
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
      }
    });
  });
}

async function getOrBuildMp3Preview(filePath: string): Promise<Buffer> {
  const key = await previewCacheKey(filePath);
  const cached = getPreviewFromCache(key);
  if (cached) return cached;

  let buf: Buffer;
  try {
    buf = await transcodeToMp3Buffer(filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The 4-byte header repair is safe (no audio data changes) and necessary
    // for any use of the file, so do it inline rather than fail playback.
    if (AIFC_CORRUPT_HEADER_PATTERN.test(msg)) {
      log.warn(`Auto-repairing corrupt AIFC header for preview: ${filePath}`);
      await repairAiffHeader(filePath);
      buf = await transcodeToMp3Buffer(filePath);
    } else {
      throw err;
    }
  }
  // Re-stat in case the repair bumped mtime.
  const finalKey = await previewCacheKey(filePath);
  addPreviewToCache(finalKey, buf);
  return buf;
}

export async function createMp3PreviewResponse(
  filePath: string,
  rangeHeader: string | null,
): Promise<Response> {
  const buf = await getOrBuildMp3Preview(filePath);

  if (rangeHeader) {
    const m = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? Math.min(parseInt(m[2], 10), buf.length - 1) : buf.length - 1;
      if (Number.isFinite(start) && start <= end && start < buf.length) {
        const slice = new Uint8Array(buf.subarray(start, end + 1));
        return new Response(slice, {
          status: 206,
          headers: {
            'Content-Type': 'audio/mpeg',
            'Content-Length': String(slice.length),
            'Content-Range': `bytes ${start}-${end}/${buf.length}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
          },
        });
      }
    }
  }

  const body = new Uint8Array(buf);
  return new Response(body, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(body.length),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    },
  });
}

export async function deleteOriginalAfterConversion(originalPath: string, outputPath: string | undefined): Promise<void> {
  if (!outputPath) return;
  // In-place conversion (e.g. .aiff fixed under the same name) → the "original"
  // IS the output; deleting it would destroy the just-converted file.
  if (path.resolve(originalPath) === path.resolve(outputPath)) return;
  try {
    await safeDelete(originalPath, { context: 'convert-cleanup', detail: { convertedTo: outputPath } });
    log.info('Deleted original after conversion:', originalPath);
  } catch (err) {
    log.warn('Failed to delete original after conversion:', originalPath, err);
  }
}

// Suppress unused import warning — ffprobePath available for future use
void ffprobePath;
