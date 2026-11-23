// yt-dlp wrapper: search YouTube and extract audio to mp3, on
// @btkulka/media-kit (binary lookup, the spawn, the JSON search, the download
// and its trustworthy final path).
//
// yt-dlp is a standalone binary, not an npm dependency. media-kit finds it: a
// `YT_DLP_PATH` override, the system PATH, the cached copy under
// ~/.cache/candybar-manager/bin, then the usual install folders. When none of
// those has it, Track Lab downloads the standalone release binary into that
// cache on first use. ffmpeg (needed for the mp3 transcode) is the bundled
// `ffmpeg-static`, falling back to whatever media-kit finds.
//
// Its one caller is yt-vocal-split.mjs, run from a checkout: media-kit is a
// devDependency, so nothing the packaged app runs may import this file.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { resolveFfmpeg, resolveYtDlp as findYtDlp, ytDlpDownload, ytDlpJson } from '@btkulka/media-kit';

const require = createRequire(import.meta.url);
const BIN_DIR = path.join(os.homedir(), '.cache', 'candybar-manager', 'bin');

// Release asset name differs per platform.
function ytDlpAssetName() {
  switch (process.platform) {
    case 'win32': return 'yt-dlp.exe';
    case 'darwin': return 'yt-dlp_macos';
    default: return 'yt-dlp';
  }
}

// --- binary resolution ----------------------------------------------------

async function downloadYtDlp(dest) {
  const asset = ytDlpAssetName();
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  process.stderr.write(`[yt-dlp] not found — downloading standalone binary…\n  ${url}\n`);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download yt-dlp: ${res.status} ${res.statusText}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  await fs.promises.rename(tmp, dest);
  if (process.platform !== 'win32') await fs.promises.chmod(dest, 0o755);
  process.stderr.write(`[yt-dlp] saved to ${dest}\n`);
}

let cachedYtDlp = null;
export async function resolveYtDlp() {
  if (cachedYtDlp) return cachedYtDlp;
  const found = findYtDlp({ extraDirs: [BIN_DIR] });
  if (found) return (cachedYtDlp = found);
  // The macOS asset keeps its release name (yt-dlp_macos), which a lookup for
  // "yt-dlp" doesn't match.
  const cached = path.join(BIN_DIR, ytDlpAssetName());
  if (fs.existsSync(cached)) return (cachedYtDlp = cached);
  await downloadYtDlp(cached);
  return (cachedYtDlp = cached);
}

/** The bundled ffmpeg-static, else one media-kit finds; null lets yt-dlp use PATH. */
function resolveFfmpegBin() {
  let bundled = null;
  try { bundled = require('ffmpeg-static'); } catch { /* not installed */ }
  return resolveFfmpeg({ bundled });
}

// --- public API -----------------------------------------------------------

/**
 * Search YouTube and return up to `limit` results, most-relevant first.
 *
 * Uses `ytsearchN:` with `--flat-playlist` so we get one lightweight JSON
 * line per hit without yt-dlp resolving each video's full page — fast enough
 * to paginate interactively. `--ignore-errors` keeps the good entries when
 * some fail; a non-zero exit only fails the search when nothing printed.
 *
 * @returns {Promise<Array<{id:string,title:string,url:string,duration:number|null,channel:string,views:number|null}>>}
 */
export async function searchYouTube(query, { limit = 40, ytDlp = null } = {}) {
  const bin = ytDlp || await resolveYtDlp();
  const hits = await ytDlpJson(bin, [
    `ytsearch${limit}:${query}`,
    '--flat-playlist',
    '--dump-json',
    '--no-warnings',
    '--ignore-errors',
  ], { timeoutMs: 120_000 });

  const items = [];
  for (const o of hits) {
    if (!o.id && !o.url) continue;
    items.push({
      id: o.id || '',
      title: o.title || o.id || '(untitled)',
      url: (o.url && /^https?:\/\//.test(o.url)) ? o.url : `https://www.youtube.com/watch?v=${o.id}`,
      duration: typeof o.duration === 'number' ? o.duration : null,
      channel: o.channel || o.uploader || '',
      views: typeof o.view_count === 'number' ? o.view_count : null,
    });
  }
  return items;
}

/**
 * Download the audio of a single YouTube URL and transcode it to mp3.
 *
 * Downloads into a throwaway subdir of `outDir` (so a failed run leaves no
 * partial files behind), then moves the finished file up into `outDir`.
 * `onProgress` gets yt-dlp's download progress ({ percent, downloadedBytes,
 * totalBytes }).
 *
 * @returns {Promise<string>} absolute path to the written .mp3
 */
export async function downloadAudioMp3(url, outDir, { ytDlp = null, quality = '0', onProgress } = {}) {
  const bin = ytDlp || await resolveYtDlp();
  await fs.promises.mkdir(outDir, { recursive: true });

  // mkdtemp inside outDir keeps the temp dir on the same filesystem so the
  // final rename is atomic rather than a cross-device copy.
  const workDir = await fs.promises.mkdtemp(path.join(outDir, '.dl-'));
  try {
    const src = await ytDlpDownload(bin, {
      url,
      output: path.join(workDir, '%(title)s [%(id)s].%(ext)s'),
      args: [
        '-x', '--audio-format', 'mp3', '--audio-quality', String(quality),
        // ASCII-only filenames: keeps the name safe for the lalal.ai upload
        // Content-Disposition header and for cross-platform paths.
        '--restrict-filenames',
        '--no-warnings',
      ],
      ffmpegPath: resolveFfmpegBin(),
      // A personal yt-dlp config may still apply, as it always has.
      ignoreConfig: false,
      timeoutMs: 900_000,
      onProgress,
    });
    const dest = path.join(outDir, path.basename(src));
    await fs.promises.rename(src, dest);
    return dest;
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
