// Path A: native SoundCloud downloads — lossless only.
// Standalone; runs via plain Node, no Electron needed.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const fuzzball = await import('fuzzball');
const ffmpegPath = (await import(path.join(ROOT, 'node_modules/ffmpeg-static/index.js'))).default;

const DEST_DIR = '/Volumes/Time Machin/tracks_to_organize/soundcloud_native';
const CONCURRENCY = 5;
const MATCH_THRESHOLD = 0.75;
const LOSSLESS_FORMATS = new Set(['wav', 'aiff', 'aif', 'flac']);

fs.mkdirSync(DEST_DIR, { recursive: true });
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

const missing = JSON.parse(fs.readFileSync('/tmp/still_missing_after_qobuz.json', 'utf8'));
log(`${missing.length} stragglers to try`);

// --- Scrape SoundCloud client_id ---
let clientId = null;
async function getClientId() {
  if (clientId) return clientId;
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
  const home = await (await fetch('https://soundcloud.com/', { headers: { 'User-Agent': UA } })).text();
  const assetUrls = Array.from(home.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^\s"']+\.js/g)).map(m => m[0]);
  for (const url of assetUrls.reverse()) {
    try {
      const js = await (await fetch(url, { headers: { 'User-Agent': UA } })).text();
      const m = js.match(/client_id:\s*"([a-zA-Z0-9]{20,})"/);
      if (m) { clientId = m[1]; log(`client_id from ${url.slice(-20)}: ${clientId.slice(0, 10)}...`); return clientId; }
    } catch {}
  }
  throw new Error('Could not extract SoundCloud client_id');
}

// --- Search ---
async function searchSC(query) {
  const id = await getClientId();
  const res = await fetch(`https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${id}&limit=15`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.collection || [];
}

// --- Download URL ---
async function getDownloadUrl(trackId) {
  const id = await getClientId();
  const res = await fetch(`https://api-v2.soundcloud.com/tracks/${trackId}/download?client_id=${id}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.redirectUri || data.url || null;
}

// --- Fuzzy match ---
function normalize(s) {
  return (s || '').toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/feat\.?|ft\.?|featuring/g, ' ')
    .replace(/original mix|extended mix|radio edit|club mix/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function score(a, b) {
  const aN = normalize(a), bN = normalize(b);
  if (!aN || !bN) return 0;
  return Math.max(fuzzball.ratio(aN, bN), fuzzball.token_set_ratio(aN, bN)) / 100;
}

// --- FFmpeg convert ---
function runFfmpeg(inPath, outPath) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-y', '-i', inPath, '-f', 'aiff', outPath], { stdio: 'pipe' });
    let err = '';
    p.stderr.on('data', d => err += d.toString());
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(-400)}`)));
  });
}

function sanitizeFilename(s) {
  return s.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim();
}

// --- Download + convert one track ---
async function processMissingTrack(m) {
  const query = `${m.artist} ${m.title}`;
  let results;
  try { results = await searchSC(query); } catch (e) { return { status: 'search_failed', error: e.message }; }
  if (!results.length) return { status: 'no_results' };

  // Score candidates
  let best = null, bestScore = 0;
  for (const r of results) {
    const rTitle = r.title || '';
    const rArtist = r.publisher_metadata?.artist || r.user?.username || '';
    const combined = score(m.title, rTitle) * 0.6 + score(m.artist, rArtist) * 0.4;
    if (combined > bestScore) { bestScore = combined; best = r; }
  }
  if (!best || bestScore < MATCH_THRESHOLD) return { status: 'no_match', bestScore: +bestScore.toFixed(3), bestTitle: best ? `${best.user?.username} — ${best.title}` : null };
  if (!best.downloadable) return { status: 'not_downloadable', bestScore: +bestScore.toFixed(3), match: `${best.user?.username} — ${best.title}` };
  const fmt = (best.original_format || '').toLowerCase();
  if (!LOSSLESS_FORMATS.has(fmt)) return { status: 'not_lossless', format: fmt || 'unknown', match: `${best.user?.username} — ${best.title}` };

  // Attempt download
  const dlUrl = await getDownloadUrl(best.id);
  if (!dlUrl) return { status: 'no_download_url', match: `${best.user?.username} — ${best.title}` };

  const rawPath = path.join(DEST_DIR, sanitizeFilename(`${m.artist} - ${m.title}.${fmt}`));
  const finalPath = rawPath.replace(/\.[a-z0-9]+$/i, '.aiff');

  const res = await fetch(dlUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) return { status: 'download_failed', httpStatus: res.status };
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(rawPath, buf);

  try {
    if (fmt === 'aiff' || fmt === 'aif') {
      if (rawPath !== finalPath) fs.renameSync(rawPath, finalPath);
    } else {
      await runFfmpeg(rawPath, finalPath);
      fs.unlinkSync(rawPath);
    }
    return { status: 'downloaded', format: fmt, path: finalPath, match: `${best.user?.username} — ${best.title}` };
  } catch (e) {
    return { status: 'convert_failed', error: e.message };
  }
}

// --- Worker pool ---
const results = [];
let next = 0;
const startedAt = Date.now();
async function worker() {
  while (next < missing.length) {
    const idx = next++;
    const m = missing[idx];
    const r = await processMissingTrack(m);
    results.push({ missing: m, ...r });
    const counts = results.reduce((acc, x) => { acc[x.status] = (acc[x.status] || 0) + 1; return acc; }, {});
    if (idx % 10 === 0 || r.status === 'downloaded') {
      log(`[${idx + 1}/${missing.length}] ${r.status}: ${m.artist} — ${m.title}${r.match ? ` → ${r.match}` : ''}`);
    }
    if (idx % 20 === 0) log(`  totals:`, counts);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const counts = results.reduce((acc, x) => { acc[x.status] = (acc[x.status] || 0) + 1; return acc; }, {});
log(`Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — totals:`, counts);
fs.writeFileSync('/tmp/soundcloud_native_result.json', JSON.stringify(results, null, 2));
log('Wrote /tmp/soundcloud_native_result.json');
