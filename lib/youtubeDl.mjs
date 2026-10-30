// yt-dlp wrapper: search YouTube and extract audio to mp3.
//
// yt-dlp is a standalone binary, not an npm dependency, so this module
// resolves it in four steps: an explicit `YT_DLP_PATH` override, the system
// PATH, a cached copy under ~/.cache/candybar-manager/bin, then — if none of
// those hit — auto-downloading the standalone release binary into that cache
// on first use. ffmpeg (needed for the mp3 transcode) comes from the bundled
// `ffmpeg-static` dependency, falling back to whatever is on PATH.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const BIN_DIR = path.join(os.homedir(), '.cache', 'candybar-manager', 'bin');

// Release asset name differs per platform. On win32 spawn() ignores PATHEXT,
// so we always resolve/download a name with the real extension.
function ytDlpAssetName() {
  switch (process.platform) {
    case 'win32': return 'yt-dlp.exe';
    case 'darwin': return 'yt-dlp_macos';
    default: return 'yt-dlp';
  }
}

// --- process helper -------------------------------------------------------

// Spawn a child with no shell (args passed as an array, so a search query
// with spaces/&/: needs no quoting). `inherit` wires the child straight to
// the terminal — used for the download so the user sees yt-dlp's own
// progress. `captureStdout` buffers stdout for parsing (search/where).
function run(cmd, args, { inherit = false, captureStdout = false, timeout = 0, check = true } = {}) {
  return new Promise((resolve, reject) => {
    const stdio = inherit ? 'inherit' : ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe'];
    const child = spawn(cmd, args, { stdio, windowsHide: true });
    let out = '';
    let err = '';
    if (child.stdout) child.stdout.on('data', (d) => { out += d; });
    if (child.stderr) child.stderr.on('data', (d) => { err += d; });
    let timer = null;
    if (timeout) {
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error(`${path.basename(String(cmd))} timed out after ${timeout}ms`));
      }, timeout);
    }
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (!check || code === 0) resolve({ code, stdout: out, stderr: err });
      else reject(new Error(`${path.basename(String(cmd))} exited with code ${code}${err ? `:\n${err.slice(-800)}` : ''}`));
    });
  });
}

// --- binary resolution ----------------------------------------------------

// Return the absolute path of `name` if it's on PATH, else null. We resolve
// the full path (rather than trusting spawn to find it later) because on
// Windows spawn() without a shell won't apply PATHEXT — an absolute path
// sidesteps that entirely. where.exe / which is invoked by absolute path so
// PATHEXT doesn't bite us here either.
async function findOnPath(name) {
  try {
    if (process.platform === 'win32') {
      const whereExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
      const { stdout } = await run(whereExe, [name], { captureStdout: true, check: false });
      const hit = stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s));
      return hit || null;
    }
    const { stdout } = await run('which', [name], { captureStdout: true, check: false });
    const hit = stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s));
    return hit || null;
  } catch {
    return null;
  }
}

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
  const override = process.env.YT_DLP_PATH;
  if (override && fs.existsSync(override)) return (cachedYtDlp = override);
  const onPath = await findOnPath(process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (onPath) return (cachedYtDlp = onPath);
  const cached = path.join(BIN_DIR, ytDlpAssetName());
  if (fs.existsSync(cached)) return (cachedYtDlp = cached);
  await downloadYtDlp(cached);
  return (cachedYtDlp = cached);
}

// Directory containing an ffmpeg binary, or null to let yt-dlp use PATH.
// `ffmpeg-static` ships the exact binary as its default export path.
async function resolveFfmpegDir() {
  try {
    const mod = await import('ffmpeg-static');
    const p = mod.default || mod;
    if (typeof p === 'string' && fs.existsSync(p)) return path.dirname(p);
  } catch {}
  return null;
}

// --- public API -----------------------------------------------------------

/**
 * Search YouTube and return up to `limit` results, most-relevant first.
 *
 * Uses `ytsearchN:` with `--flat-playlist` so we get one lightweight JSON
 * line per hit without yt-dlp resolving each video's full page — fast enough
 * to paginate interactively.
 *
 * @returns {Promise<Array<{id:string,title:string,url:string,duration:number|null,channel:string,views:number|null}>>}
 */
export async function searchYouTube(query, { limit = 40, ytDlp = null } = {}) {
  const bin = ytDlp || await resolveYtDlp();
  // --flat-playlist can make some entries fail; --ignore-errors keeps the
  // good ones. We tolerate a non-zero exit and just parse whatever printed.
  const { stdout, stderr, code } = await run(bin, [
    `ytsearch${limit}:${query}`,
    '--flat-playlist',
    '--dump-json',
    '--no-warnings',
    '--ignore-errors',
  ], { captureStdout: true, check: false, timeout: 120_000 });

  const items = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
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
  if (!items.length && code !== 0) {
    throw new Error(`yt-dlp search failed (exit ${code})${stderr ? `:\n${stderr.slice(-800)}` : ''}`);
  }
  return items;
}

/**
 * Download the audio of a single YouTube URL and transcode it to mp3.
 *
 * Downloads into a throwaway subdir of `outDir` (isolated so "the one mp3 in
 * there" is unambiguous), then moves the finished file up into `outDir`.
 * yt-dlp's stdio is inherited so the user sees its native progress bar.
 *
 * @returns {Promise<string>} absolute path to the written .mp3
 */
export async function downloadAudioMp3(url, outDir, { ytDlp = null, quality = '0' } = {}) {
  const bin = ytDlp || await resolveYtDlp();
  await fs.promises.mkdir(outDir, { recursive: true });
  const ffmpegDir = await resolveFfmpegDir();

  // mkdtemp inside outDir keeps the temp dir on the same filesystem so the
  // final rename is atomic rather than a cross-device copy.
  const workDir = await fs.promises.mkdtemp(path.join(outDir, '.dl-'));
  try {
    const args = [
      url,
      '-x', '--audio-format', 'mp3', '--audio-quality', String(quality),
      '--no-playlist',
      // ASCII-only filenames: keeps the name safe for the lalal.ai upload
      // Content-Disposition header and for cross-platform paths.
      '--restrict-filenames',
      '-o', path.join(workDir, '%(title)s [%(id)s].%(ext)s'),
      '--no-warnings',
    ];
    if (ffmpegDir) args.push('--ffmpeg-location', ffmpegDir);
    await run(bin, args, { inherit: true, timeout: 900_000 });

    const mp3s = (await fs.promises.readdir(workDir)).filter((f) => f.toLowerCase().endsWith('.mp3'));
    if (!mp3s.length) throw new Error('yt-dlp finished but produced no .mp3 file');
    const src = path.join(workDir, mp3s[0]);
    const dest = path.join(outDir, mp3s[0]);
    await fs.promises.rename(src, dest);
    return dest;
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
