#!/usr/bin/env node
// For each XML track whose expected file is missing, look in the expected
// parent folder for a candidate with the right byte size (primary) or
// duration + filename signal (fallback). Emit a plan and optionally apply
// renames in place so Rekordbox autolocate can find the files by filename.
//
// Usage:
//   node rename-to-xml.mjs           # dry run, writes plan JSON
//   node rename-to-xml.mjs --apply   # execute auto-confidence renames

import { promises as fs } from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';
import { parseFile } from 'music-metadata';
import { locToPath } from './lib/xmlUtils.mjs';
import { AUDIO_EXTS } from './lib/audioExts.mjs';

const XML = '/Volumes/Time Machin/rekordbox/export.xml';
const PLAN_OUT = '/tmp/candybar-missing/rename_plan.json';
const APPLY = process.argv.includes('--apply');

const AIF_GROUP = new Set(['.aif', '.aiff']);

async function stat(p) {
  try { return await fs.stat(p); } catch { return null; }
}

async function listAudioFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    process.stderr.write(`[listAudioFiles] readdir failed: ${dir} (${err.code || err.message})\n`);
    return [];
  }
  return entries
    .filter(e => e.isFile() && !e.name.startsWith('.') && AUDIO_EXTS.has(path.extname(e.name).toLowerCase()))
    .map(e => path.join(dir, e.name));
}

function isCompatibleExt(candidate, expected) {
  const a = path.extname(candidate).toLowerCase();
  const b = path.extname(expected).toLowerCase();
  if (a === b) return true;
  if (AIF_GROUP.has(a) && AIF_GROUP.has(b)) return true;
  return false;
}

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function nameSignal(candidatePath, artist, title) {
  const base = normalize(path.basename(candidatePath, path.extname(candidatePath)));
  const a = normalize(artist);
  const t = normalize(title);
  if (!base) return 0;
  let score = 0;
  if (a && base.includes(a)) score += 1;
  if (t && base.includes(t)) score += 2;
  return score;
}

async function buildPlan() {
  const xmlText = await fs.readFile(XML, 'utf8');
  const dom = new JSDOM(xmlText, { contentType: 'text/xml' });
  const doc = dom.window.document;
  const tracks = Array.from(
    doc.querySelector('COLLECTION').querySelectorAll('TRACK'),
  );

  // Collect every expected path so we never propose renaming a file that is
  // already the right filename for some other track.
  const claimed = new Set();
  const recs = [];
  for (const t of tracks) {
    const expected = locToPath(t.getAttribute('Location'));
    if (!expected) continue;
    claimed.add(expected);
    recs.push({
      trackId: t.getAttribute('TrackID'),
      artist: t.getAttribute('Artist') || '',
      name: t.getAttribute('Name') || '',
      album: t.getAttribute('Album') || '',
      size: parseInt(t.getAttribute('Size') || '0', 10),
      duration: parseInt(t.getAttribute('TotalTime') || '0', 10),
      kind: t.getAttribute('Kind') || '',
      expected,
    });
  }

  const folderCache = new Map();
  const plan = [];

  for (const rec of recs) {
    const exists = await stat(rec.expected);
    if (exists && exists.isFile()) continue;

    const dir = path.dirname(rec.expected);
    let allFiles = folderCache.get(dir);
    if (!allFiles) {
      allFiles = await listAudioFiles(dir);
      folderCache.set(dir, allFiles);
    }

    // Skip files whose path is already the expected location of some track.
    const candidates = allFiles.filter(f => !claimed.has(f));

    const scored = [];
    for (const c of candidates) {
      if (!isCompatibleExt(c, rec.expected)) continue;
      const st = await stat(c);
      const sz = st ? st.size : null;
      scored.push({
        path: c,
        size: sz,
        sizeMatch: sz != null && rec.size > 0 && sz === rec.size,
        nameScore: nameSignal(c, rec.artist, rec.name),
      });
    }

    let choice = null;
    let confidence = 'none';
    let reason = '';

    const sizeHits = scored.filter(s => s.sizeMatch);
    if (sizeHits.length === 1) {
      choice = sizeHits[0];
      confidence = 'auto';
      reason = 'unique size match';
    } else if (sizeHits.length > 1) {
      const best = sizeHits.slice().sort((a, b) => b.nameScore - a.nameScore);
      if (best[0].nameScore > 0 && best[0].nameScore > (best[1]?.nameScore ?? -1)) {
        choice = best[0];
        confidence = 'auto';
        reason = `${sizeHits.length} size matches; unique name tiebreak`;
      } else {
        choice = best[0];
        confidence = 'review';
        reason = `${sizeHits.length} size matches, name ambiguous`;
      }
    } else if (rec.duration > 0) {
      // Fall back to duration + filename. Read duration lazily only when no size hit.
      for (const s of scored) {
        try {
          const m = await parseFile(s.path, { duration: true, skipCovers: true });
          s.duration = Math.round(m.format.duration || 0);
        } catch { s.duration = 0; }
        s.durationMatch = s.duration > 0 && Math.abs(s.duration - rec.duration) <= 1;
      }
      const durHits = scored.filter(s => s.durationMatch);
      const named = durHits.filter(s => s.nameScore >= 2);
      if (named.length === 1) {
        choice = named[0];
        confidence = 'review';
        reason = 'duration + title name match';
      } else if (durHits.length > 0) {
        choice = durHits.sort((a, b) => b.nameScore - a.nameScore)[0];
        confidence = 'review';
        reason = `${durHits.length} duration matches`;
      } else {
        reason = scored.length === 0
          ? (allFiles.length === 0 ? 'folder empty or missing' : 'no compatible-format candidates')
          : 'no size or duration match';
      }
    } else {
      reason = 'no size match and no duration to fall back on';
    }

    plan.push({
      trackId: rec.trackId,
      artist: rec.artist,
      name: rec.name,
      expected: rec.expected,
      expectedSize: rec.size,
      expectedDuration: rec.duration,
      confidence,
      reason,
      choice: choice ? { path: choice.path, size: choice.size, nameScore: choice.nameScore, duration: choice.duration } : null,
      candidates: scored.map(s => ({
        path: s.path, size: s.size, sizeMatch: s.sizeMatch,
        nameScore: s.nameScore, duration: s.duration, durationMatch: s.durationMatch,
      })),
    });
  }

  // Collision pass: demote to review whenever an auto entry shares its source
  // file or its target path with another plan entry (dup XML Locations can
  // legitimately exist and would otherwise cause a rename to clobber).
  const bySource = new Map();
  const byTarget = new Map();
  for (const p of plan) {
    if (p.choice) {
      const arr = bySource.get(p.choice.path) || [];
      arr.push(p);
      bySource.set(p.choice.path, arr);
    }
    const arr = byTarget.get(p.expected) || [];
    arr.push(p);
    byTarget.set(p.expected, arr);
  }
  const demote = (p, why) => { p.confidence = 'review'; p.reason = why; };
  for (const [src, arr] of bySource) {
    if (arr.length > 1 && arr.some(p => p.confidence === 'auto')) {
      for (const p of arr) demote(p, `source collision on ${path.basename(src)}`);
    }
  }
  for (const [tgt, arr] of byTarget) {
    if (arr.length > 1 && arr.some(p => p.confidence === 'auto')) {
      for (const p of arr) demote(p, `target collision on ${path.basename(tgt)}`);
    }
  }

  return plan;
}

async function applyPlan(plan) {
  let done = 0, failed = 0, skipped = 0;
  const log = { renamed: [], failed: [], skipped: [] };
  for (const p of plan) {
    if (p.confidence !== 'auto' || !p.choice) continue;
    const from = p.choice.path;
    const to = p.expected;
    const existing = await stat(to);
    if (existing) {
      skipped++;
      log.skipped.push({ trackId: p.trackId, to, reason: 'target exists' });
      continue;
    }
    try {
      await fs.rename(from, to);
      done++;
      log.renamed.push({ trackId: p.trackId, from, to });
    } catch (e) {
      failed++;
      log.failed.push({ trackId: p.trackId, from, to, error: String(e.message || e) });
      console.error(`FAIL ${from} -> ${to}: ${e.message}`);
    }
  }
  return { done, failed, skipped, log };
}

async function main() {
  await fs.mkdir(path.dirname(PLAN_OUT), { recursive: true });
  const plan = await buildPlan();
  await fs.writeFile(PLAN_OUT, JSON.stringify(plan, null, 2));

  const counts = { auto: 0, review: 0, none: 0 };
  for (const p of plan) counts[p.confidence]++;
  console.error(`Missing tracks: ${plan.length}`);
  console.error(`  auto:   ${counts.auto}`);
  console.error(`  review: ${counts.review}`);
  console.error(`  none:   ${counts.none}`);
  console.error(`Plan:   ${PLAN_OUT}`);

  if (APPLY) {
    const res = await applyPlan(plan);
    const logPath = '/tmp/candybar-missing/rename_apply_log.json';
    await fs.writeFile(logPath, JSON.stringify(res.log, null, 2));
    console.error(`Renamed: ${res.done}, Failed: ${res.failed}, Skipped: ${res.skipped}`);
    console.error(`Log:    ${logPath}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
