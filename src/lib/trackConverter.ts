import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { createScopedLogger } from './logger';
import { repairAiffHeader } from './aiffRepair';
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

export async function convertToAiff(
  filePath: string,
  onProgress?: ProgressCallback
): Promise<ConversionResult> {
  const available = await checkFfmpegAvailable();
  if (!available) {
    return { success: false, originalPath: filePath, errorMessage: 'ffmpeg not available' };
  }

  const ext = path.extname(filePath);
  const outputPath = filePath.slice(0, -ext.length) + '.aif';

  return new Promise((resolve) => {
    const args = ['-i', filePath, '-c:a', 'pcm_s24be', '-ar', '44100', '-y', outputPath];
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    let duration = 0;

    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      if (!duration) duration = parseDuration(text);
      if (duration > 0) {
        const elapsed = parseTime(text);
        if (elapsed > 0) onProgress?.({ filePath, percent: Math.min(99, Math.round((elapsed / duration) * 100)) });
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        onProgress?.({ filePath, percent: 100 });
        resolve({ success: true, originalPath: filePath, outputPath });
      } else {
        log.error('ffmpeg convertToAiff failed:', stderr.slice(-500));
        if (AIFC_CORRUPT_HEADER_PATTERN.test(stderr)) {
          resolve({ success: false, originalPath: filePath, errorMessage: `AIFC_CORRUPT_HEADER: ${filePath}` });
          return;
        }
        resolve({
          success: false,
          originalPath: filePath,
          errorMessage: `ffmpeg exited with code ${code}: ${summarizeFfmpegError(stderr)}`,
        });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, originalPath: filePath, errorMessage: err.message });
    });
  });
}

export async function reencodeToMp3(filePath: string): Promise<ConversionResult> {
  const available = await checkFfmpegAvailable();
  if (!available) {
    return { success: false, originalPath: filePath, errorMessage: 'ffmpeg not available' };
  }

  const ext = path.extname(filePath);
  const outputPath = filePath.slice(0, -ext.length) + '.mp3';

  return new Promise((resolve) => {
    const args = ['-i', filePath, '-c:a', 'libmp3lame', '-b:a', '320k', '-ar', '44100', '-y', outputPath];
    const proc = spawn(ffmpegPath, args);
    let stderr = '';

    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, originalPath: filePath, outputPath });
      } else {
        log.error('ffmpeg reencodeToMp3 failed:', stderr.slice(-500));
        if (AIFC_CORRUPT_HEADER_PATTERN.test(stderr)) {
          resolve({ success: false, originalPath: filePath, errorMessage: `AIFC_CORRUPT_HEADER: ${filePath}` });
          return;
        }
        resolve({
          success: false,
          originalPath: filePath,
          errorMessage: `ffmpeg exited with code ${code}: ${summarizeFfmpegError(stderr)}`,
        });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, originalPath: filePath, errorMessage: err.message });
    });
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
  try {
    await fs.unlink(originalPath);
    log.info('Deleted original after conversion:', originalPath);
  } catch (err) {
    log.warn('Failed to delete original after conversion:', originalPath, err);
  }
}

// Suppress unused import warning — ffprobePath available for future use
void ffprobePath;
