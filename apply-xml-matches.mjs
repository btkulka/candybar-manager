#!/usr/bin/env node
// Apply auto-link XML matches:
//  1. Backup XML
//  2. For each match:
//     - Convert WAV/FLAC -> AIFF (if applicable) while rewriting tags with XML artist/title/album
//     - Else: rewrite tags in place (if differ from XML)
//     - Update XML Location to new path
//  3. Write XML

import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { parseFile } from 'music-metadata';

const require = createRequire(import.meta.url);
const ffmpegPath = require('ffmpeg-static');

const REPORT = process.env.MATCH_REPORT || '/tmp/candybar-missing/xml_match_report.json';
const XML = '/Volumes/Time Machin/rekordbox/export.xml';
const LOG = process.env.APPLY_LOG || '/tmp/candybar-missing/apply_log.json';

function pathToLocation(p) {
  return 'file://localhost' + encodeURI(p);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => reject(new Error(`spawn failed: ${e.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-400)}`));
    });
  });
}

async function detectBitsPerSample(p) {
  try {
    const m = await parseFile(p, { duration: false, skipCovers: true });
    return m.format?.bitsPerSample || 16;
  } catch { return 16; }
}

function aiffPcmCodec(bits) {
  if (bits >= 32) return 'pcm_s32be';
  if (bits >= 24) return 'pcm_s24be';
  return 'pcm_s16be';
}

// Process a single match. Returns { src, finalPath, converted, tagsUpdated }
async function processMatch(match) {
  const src = match.best.path;
  const ext = path.extname(src).toLowerCase();
  const willConvert = ext === '.wav' || ext === '.flac';
  const targetExt = willConvert ? '.aiff' : ext;
  const finalPath = willConvert
    ? src.slice(0, src.length - ext.length) + targetExt
    : src;

  // Read current tags to decide if we even need to rewrite
  let cur = { artist: '', title: '', album: '' };
  try {
    const m = await parseFile(src, { duration: false, skipCovers: true });
    cur.artist = m.common.artist || m.common.artists?.[0] || '';
    cur.title = m.common.title || '';
    cur.album = m.common.album || '';
  } catch {}

  const wantArtist = match.xmlArtist || '';
  const wantTitle = match.xmlTitle || '';
  const wantAlbum = match.xmlAlbum || '';

  const tagsDiffer =
    cur.artist !== wantArtist ||
    cur.title !== wantTitle ||
    (wantAlbum && cur.album !== wantAlbum);

  if (!willConvert && !tagsDiffer) {
    return { src, finalPath, converted: false, tagsUpdated: false, reason: 'no-op' };
  }

  // Collision guard (pre-check): if converting and finalPath already exists at a
  // different file, abort early before spending ffmpeg time. Race-safe final check
  // happens at the link step below.
  if (willConvert) {
    try {
      const s = await fs.stat(finalPath);
      if (s.isFile() && path.resolve(finalPath) !== path.resolve(src)) {
        throw new Error(`target exists: ${finalPath}`);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  const tempPath = finalPath + '.tagtmp' + targetExt;

  const args = ['-i', src, '-map', '0:a', '-map_metadata', '0'];

  if (willConvert && ext === '.flac') {
    const bits = await detectBitsPerSample(src);
    args.push('-c:a', aiffPcmCodec(bits));
  } else {
    args.push('-c:a', 'copy');
  }

  if (wantArtist !== undefined) args.push('-metadata', `artist=${wantArtist}`);
  if (wantTitle !== undefined) args.push('-metadata', `title=${wantTitle}`);
  if (wantAlbum) args.push('-metadata', `album=${wantAlbum}`);

  if (targetExt === '.aiff' || targetExt === '.aif') {
    args.push('-write_id3v2', '1', '-id3v2_version', '3');
  }
  args.push('-y', tempPath);

  await runFfmpeg(args);

  // Atomic publish: link() into place, fails with EEXIST if another process
  // created finalPath during ffmpeg. fs.rename() would silently overwrite.
  // In-place rewrite (src === finalPath) is the one case we DO want overwrite,
  // so fall back to rename for that path.
  if (path.resolve(src) === path.resolve(finalPath)) {
    await fs.rename(tempPath, finalPath);
  } else {
    try {
      await fs.link(tempPath, finalPath);
      await fs.unlink(tempPath);
    } catch (err) {
      await fs.unlink(tempPath).catch(() => {});
      if (err.code === 'EEXIST') throw new Error(`target appeared during convert: ${finalPath}`);
      throw err;
    }
  }
  if (willConvert && path.resolve(src) !== path.resolve(finalPath)) {
    try { await fs.unlink(src); } catch {}
  }

  return { src, finalPath, converted: willConvert, tagsUpdated: true };
}

async function main() {
  const report = JSON.parse(await fs.readFile(REPORT, 'utf8'));
  const auto = report.auto;
  console.error(`Auto-link matches: ${auto.length}`);

  // Backup XML
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${XML}.backup-${stamp}`;
  await fs.copyFile(XML, backup);
  console.error(`Backed up XML -> ${backup}`);

  let xmlText = await fs.readFile(XML, 'utf8');

  const log = { applied: [], failed: [], skipped: [] };

  for (let i = 0; i < auto.length; i++) {
    const m = auto[i];
    try {
      const res = await processMatch(m);
      const newLoc = pathToLocation(res.finalPath);

      // Replace Location within the matching <TRACK> element (match by TrackID).
      const rx = new RegExp(
        `(<TRACK\\b[^>]*\\bTrackID="${m.trackId}"[\\s\\S]*?\\bLocation=")[^"]*(")`,
      );
      const before = xmlText;
      xmlText = xmlText.replace(rx, `$1${newLoc}$2`);
      if (before === xmlText) {
        log.failed.push({ trackId: m.trackId, error: 'XML Location replace missed (TrackID not found or regex failed)' });
        console.error(`  FAIL [xml] TrackID=${m.trackId}`);
        continue;
      }

      log.applied.push({
        trackId: m.trackId,
        xmlArtist: m.xmlArtist,
        xmlTitle: m.xmlTitle,
        oldPath: res.src,
        newPath: res.finalPath,
        converted: res.converted,
        tagsUpdated: res.tagsUpdated,
      });
      if ((i + 1) % 5 === 0 || i === auto.length - 1) {
        console.error(`  ${i + 1}/${auto.length}  ${m.xmlArtist} - ${m.xmlTitle}${res.converted ? ' [CONVERTED]' : ''}`);
      }
    } catch (err) {
      log.failed.push({
        trackId: m.trackId,
        xmlArtist: m.xmlArtist,
        xmlTitle: m.xmlTitle,
        src: m.best?.path,
        error: String(err.message || err).slice(0, 400),
      });
      console.error(`  FAIL ${m.xmlArtist} - ${m.xmlTitle}: ${err.message}`);
    }
  }

  await fs.writeFile(XML, xmlText);
  await fs.writeFile(LOG, JSON.stringify(log, null, 2));

  console.error(`\nApplied:  ${log.applied.length}`);
  console.error(`Failed:   ${log.failed.length}`);
  console.error(`Skipped:  ${log.skipped.length}`);
  console.error(`Backup:   ${backup}`);
  console.error(`Log:      ${LOG}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
