// Store preview clips for the review page.
//
// A published artifact runs under a CSP that blocks media from every external
// host, so the page cannot point an <audio> at Qobuz or Beatport — the clip has
// to travel inside the HTML as a data: URI. That puts a budget on it: the
// rendered page must stay under 16 MB, and cover art already costs a little.
// Each clip is therefore trimmed to CLIP_SECONDS and re-encoded to CLIP_KBPS
// (about 300 KB apiece), which keeps a 40-track list comfortably inside.
//
// Where the clips come from:
//   Qobuz    — the album page carries a signed 30-second stream per track
//              (`data-source`, eid = track id). Plain HTTP, no login.
//   Beatport — the track page's __NEXT_DATA__ carries `sample_url`, a ~2 min
//              LOFI mp3 on geo-samples.beatport.com. The page needs the real
//              Chrome session (Cloudflare); the sample host does not.
//
// Clips are written next to the session as <session>.previews/<hash>.mp3 and
// referenced by `previewPath` on each buy row, so the session JSON stays small.

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { openBeatport } from './beatport.mjs';

const CLIP_SECONDS = 30;
const CLIP_KBPS = 96;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/** Signed preview stream for one track on a Qobuz album page, or null. */
export async function qobuzPreviewUrl(albumUrl, trackId) {
  const res = await fetch(albumUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Qobuz ${res.status} for ${albumUrl}`);
  const html = await res.text();
  const re = /data-source="([^"]+)"/g;
  let first = null;
  for (const m of html.matchAll(re)) {
    const url = m[1].replace(/&amp;/g, '&');
    if (!first) first = url;
    if (trackId && url.includes(`eid=${trackId}&`)) return url;
  }
  // Single-track release: the only stream is the one we want.
  return trackId ? null : first;
}

/** Preview sample for a Beatport track page, read through the browser. */
export async function beatportPreview(page, trackUrl, trackId) {
  const resp = await page.goto(trackUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (resp && resp.status() !== 200) throw new Error(`Beatport track page ${resp.status()}`);
  const raw = await page.evaluate(() => document.getElementById('__NEXT_DATA__')?.textContent || null);
  if (!raw) throw new Error('Beatport page had no __NEXT_DATA__');
  const queries = JSON.parse(raw)?.props?.pageProps?.dehydratedState?.queries || [];
  // The page dehydrates several queries (the track, its charts, related
  // tracks). The track payload carries no id of its own — the id is in the
  // query key ("track-details-<id>") — so match on that, and fall back to the
  // first non-list payload that has a sample at all.
  const wanted = trackId ? `track-details-${trackId}` : null;
  let track = null;
  for (const q of queries) {
    const d = q?.state?.data;
    if (!d || Array.isArray(d) || !d.sample_url) continue;
    const key = JSON.stringify(q.queryKey || '');
    if (!wanted || key.includes(wanted)) { track = d; break; }
    if (!track) track = d;
  }
  if (!track) return null;
  // sample_start_ms/end_ms locate the excerpt within the full track; the LOFI
  // file IS that excerpt, so the clip starts at its beginning.
  return {
    url: track.sample_url,
    startMs: 0,
    excerpt: [track.sample_start_ms ?? null, track.sample_end_ms ?? null],
  };
}

async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.qobuz.com/' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Trim + re-encode with ffmpeg. `startSec` picks where the clip begins. */
function transcode(inBuf, outPath, { startSec = 0 } = {}) {
  const tmpIn = outPath + '.src.mp3';
  fs.writeFileSync(tmpIn, inBuf);
  try {
    execFileSync('ffmpeg', [
      '-y', '-v', 'error',
      '-ss', String(startSec), '-i', tmpIn,
      '-t', String(CLIP_SECONDS),
      '-ac', '2', '-ar', '44100', '-b:a', `${CLIP_KBPS}k`,
      '-map_metadata', '-1',
      outPath,
    ], { stdio: 'ignore' });
  } finally {
    try { fs.unlinkSync(tmpIn); } catch { /* fine */ }
  }
}

/**
 * Fetch a preview clip for every buy row that lacks one, write the clips next
 * to the session, and record `previewPath` on each row. Rewrites the session.
 * Beatport rows need the browser; it is opened once, only if any exist.
 */
export async function fetchPreviews(sessionPath, { log = () => {}, force = false } = {}) {
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  const dir = sessionPath.replace(/\.json$/, '') + '.previews';
  fs.mkdirSync(dir, { recursive: true });

  const rows = (session.buy || []).filter(r => r.match && (force || !r.previewPath || !fs.existsSync(r.previewPath)));
  const beatportRows = rows.filter(r => r.store === 'beatport');
  let bp = null;
  if (beatportRows.length) {
    log(`      previews: opening Beatport for ${beatportRows.length} clip(s)…`);
    try { bp = await openBeatport(); } catch (err) { log(`      previews: Beatport unavailable (${err.message}) — skipping its rows`); }
  }

  let ok = 0, failed = 0;
  const save = () => fs.writeFileSync(sessionPath, JSON.stringify(session, null, 1));

  try {
    for (const r of rows) {
      const m = r.match;
      const label = `${r.artist} - ${r.title}`;
      try {
        let src, startSec = 0;
        if (r.store === 'qobuz') {
          src = await qobuzPreviewUrl(m.trackUrl || m.url, m.trackId);
        } else if (r.store === 'beatport') {
          if (!bp) continue;
          const p = await beatportPreview(bp.page, m.url, m.id || m.trackId);
          if (p) { src = p.url; startSec = Math.max(0, (p.startMs || 0) / 1000); }
        }
        if (!src) { log(`      previews: no clip for ${label}`); failed++; continue; }
        const out = path.join(dir, hashStr(src) + '.mp3');
        if (!fs.existsSync(out)) transcode(await download(src), out, { startSec });
        r.previewPath = out;
        r.previewSource = src;
        ok++;
        save();
      } catch (err) {
        failed++;
        log(`      previews: ${label}: ${err.message}`);
      }
    }
  } finally {
    if (bp) await bp.close();
  }
  save();
  log(`      previews: ${ok} clip(s) fetched, ${failed} failed, ${(session.buy || []).filter(r => r.previewPath).length}/${(session.buy || []).length} rows have one`);
  return session;
}

// CLI: node lib/sourcing/previews.mjs <session.json> [--force]
if (process.argv[1] && process.argv[1].endsWith('previews.mjs')) {
  const [, , sessionPath, ...flags] = process.argv;
  if (!sessionPath) {
    console.error('usage: node lib/sourcing/previews.mjs <session.json> [--force]');
    process.exit(1);
  }
  await fetchPreviews(sessionPath, { log: m => console.error(m), force: flags.includes('--force') });
}
