// Free-download files: fetch, identify, and file them.
//
// Lossless-only is the same invariant the buy list has, applied to files that
// cost nothing: a lossy file is never dropped into the intake folder as if it
// were a keeper. It is kept — under <dest>/lossy — and reported as flagged, so
// the decision stays with a human and nothing is thrown away.
//
// SoundCloud's API says nothing about the file format (no original_format in
// api-v2), and a gate says even less, so the format is read from the file
// itself: ffprobe's codec when it is available, magic bytes when it is not.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { loadConfig, sessionDir } from './config.mjs';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export const LOSSLESS_CODECS = new Set(['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_s16be', 'pcm_s24be', 'pcm_s32be', 'pcm_f32le', 'pcm_f32be', 'flac', 'alac', 'wavpack', 'ape', 'tta']);
export const LOSSLESS_EXT = new Set(['wav', 'aif', 'aiff', 'aifc', 'flac', 'alac']);
export const LOSSY_EXT = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma']);
const AUDIO_EXT = new Set([...LOSSLESS_EXT, ...LOSSY_EXT]);

let ffprobePath = null;
try { ffprobePath = require('ffprobe-static').path; } catch { /* magic bytes only */ }

/** Format from the first bytes of a file. `lossless` is null when the
 *  container alone cannot say (an .m4a may be AAC or ALAC). */
export function sniffFormat(buf) {
  const s4 = buf.subarray(0, 4).toString('latin1');
  const s8 = buf.subarray(8, 12).toString('latin1');
  if (s4 === 'RIFF' && s8 === 'WAVE') return { ext: 'wav', lossless: true };
  if (s4 === 'FORM' && (s8 === 'AIFF' || s8 === 'AIFC')) return { ext: s8 === 'AIFC' ? 'aifc' : 'aiff', lossless: true };
  if (s4 === 'fLaC') return { ext: 'flac', lossless: true };
  if (s4 === 'OggS') return { ext: 'ogg', lossless: false };
  if (s4.startsWith('ID3')) return { ext: 'mp3', lossless: false };
  if (buf[0] === 0xff && (buf[1] & 0xe6) === 0xe2) return { ext: 'mp3', lossless: false };
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return { ext: 'm4a', lossless: null };
  if (s4.startsWith('PK')) return { ext: 'zip', lossless: null };
  if (s4 === 'Rar!') return { ext: 'rar', lossless: null };
  return { ext: null, lossless: null };
}

/** Identify one file on disk: container, codec, and whether it is lossless. */
export async function classifyFile(p) {
  const fd = fs.openSync(p, 'r');
  const head = Buffer.alloc(16);
  try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
  const sniffed = sniffFormat(head);
  const extFromName = path.extname(p).slice(1).toLowerCase() || null;
  const out = { ext: sniffed.ext || extFromName, codec: null, lossless: sniffed.lossless, archive: sniffed.ext === 'zip' || sniffed.ext === 'rar' };
  if (out.archive) return out;
  if (ffprobePath) {
    try {
      const { stdout } = await execFileAsync(ffprobePath, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', p], { timeout: 20000 });
      const codec = stdout.trim().split('\n')[0]?.trim() || null;
      if (codec) { out.codec = codec; out.lossless = LOSSLESS_CODECS.has(codec); }
    } catch { /* fall back to the sniff */ }
  }
  if (out.lossless === null && out.ext) {
    if (LOSSLESS_EXT.has(out.ext)) out.lossless = true;
    else if (LOSSY_EXT.has(out.ext) && out.ext !== 'm4a') out.lossless = false;
  }
  return out;
}

export function safeFilename(s) {
  return String(s || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 180) || 'untitled';
}

/** "<Artist> - <Title>.<ext>", never colliding with an existing file. */
export function targetPath(dir, row, ext, name = null) {
  const base = safeFilename(name || `${row.artist || row.uploader || 'Unknown'} - ${row.title || row.scTitle || row.scId}`);
  let candidate = path.join(dir, `${base}.${ext}`);
  let n = 2;
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${base} (${n++}).${ext}`);
  return candidate;
}

function filenameFromHeaders(res, url) {
  const cd = res.headers.get('content-disposition') || '';
  const star = cd.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) { try { return decodeURIComponent(star[1].trim()); } catch { /* fall through */ } }
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/);
  if (plain) return plain[1].trim();
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return last;
  } catch { /* not a URL */ }
  return 'download.bin';
}

/** Stream a URL to a temp file. Returns { tmpPath, filename, bytes, contentType }. */
export async function downloadUrlToFile(url, tmpDir, { headers = {}, timeoutMs = 600000 } = {}) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} fetching the file`);
  const filename = filenameFromHeaders(res, res.url || url);
  const tmpPath = path.join(tmpDir, `${Date.now()}-${safeFilename(filename)}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmpPath));
  return { tmpPath, filename, bytes: fs.statSync(tmpPath).size, contentType: res.headers.get('content-type') || null };
}

/** Audio files inside an archive a gate delivered, extracted next to it. */
export async function unpackArchive(tmpPath) {
  const outDir = tmpPath + '.unpacked';
  fs.mkdirSync(outDir, { recursive: true });
  await execFileAsync('unzip', ['-o', '-j', '-q', tmpPath, '-d', outDir], { timeout: 120000 });
  return fs.readdirSync(outDir)
    .filter(f => AUDIO_EXT.has(path.extname(f).slice(1).toLowerCase()) && !f.startsWith('.'))
    .map(f => path.join(outDir, f));
}

/**
 * File a delivered download: identify it, then move it under `destDir`
 * (lossless) or `destDir/lossy` (lossy / unknown). Archives are unpacked and
 * each audio file inside is filed on its own.
 * Returns an array of { path, ext, codec, lossless, original } — one per file.
 */
export async function fileDownload(tmpPath, row, destDir, { originalName = null, keepName = false } = {}) {
  const cls = await classifyFile(tmpPath);
  if (cls.archive) {
    let inner = [];
    try { inner = await unpackArchive(tmpPath); } catch (err) { throw new Error(`archive could not be unpacked: ${err.message}`); }
    if (!inner.length) throw new Error('archive held no audio files');
    const out = [];
    // A pack (several tracks, or a track with its DJ edit and instrumental)
    // keeps the names inside it; the row's name would make them all "Title (n)".
    const keepName = inner.length > 1;
    for (const p of inner) out.push(...await fileDownload(p, row, destDir, { originalName: path.basename(p), keepName }));
    try { fs.unlinkSync(tmpPath); } catch { /* keep going */ }
    return out;
  }
  const ext = cls.ext || 'bin';
  const lossless = cls.lossless === true;
  const dir = lossless ? destDir : path.join(destDir, 'lossy');
  fs.mkdirSync(dir, { recursive: true });
  const dest = targetPath(dir, row, ext, keepName && originalName ? path.parse(originalName).name : null);
  try {
    fs.renameSync(tmpPath, dest);
  } catch {
    fs.copyFileSync(tmpPath, dest);
    fs.unlinkSync(tmpPath);
  }
  return [{ path: dest, ext, codec: cls.codec, lossless: cls.lossless, original: originalName || path.basename(tmpPath).replace(/^\d+-/, '') }];
}

/** Where free downloads land: the app's intake folder when its volume is
 *  mounted, otherwise ~/Downloads — never silently a path on a missing drive. */
export function defaultDestDir(sub = 'soundcloud-likes') {
  const { organizeSourceDir } = loadConfig();
  // The intake folder itself: everything ready to add lives at its top level.
  if (organizeSourceDir && fs.existsSync(organizeSourceDir)) return organizeSourceDir;
  return path.join(os.homedir(), 'Downloads', sub);
}

export function tmpDir() {
  const d = path.join(os.tmpdir(), 'candybar-soundcloud');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * What has already been fetched, keyed by SoundCloud track id. An entry is
 * permanent, even after its file is gone: a file leaves because Ben deleted it
 * or because it was organized into the library, and neither should bring the
 * track back. To fetch one again, remove its entry by hand.
 */
export class DownloadLedger {
  /** A missing ledger starts empty. An unreadable one does NOT: starting empty
   *  and saving over it would forget every track Ben deleted, and the next run
   *  would fetch them all again. It's copied aside and the run stops, so a
   *  human decides what it should say. */
  constructor(file = path.join(sessionDir(), 'soundcloud-downloads.json')) {
    this.file = file;
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Could not read the download ledger ${file}: ${err.message}`);
    }
    if (text === null) { this.entries = {}; return; }
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const backup = `${file}.unreadable-${Date.now()}`;
      try { fs.copyFileSync(file, backup); } catch { /* the error below still stops the run */ }
      throw new Error(`The download ledger ${file} is unreadable (copied to ${backup}). Fix or restore it before downloading again — starting fresh would re-fetch everything you deleted.`);
    }
    this.entries = parsed;
  }
  get(scId) {
    return this.entries[String(scId)] || null;
  }
  record(scId, entry) {
    this.entries[String(scId)] = { ...entry, at: new Date().toISOString() };
    this.save();
  }
  /** Written to a temp file and renamed over the ledger, so a crash mid-write
   *  leaves the previous ledger whole rather than a truncated one. */
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.entries, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
