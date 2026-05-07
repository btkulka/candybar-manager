#!/usr/bin/env node
// Match XML-missing tracks against candidate files in on_hold + tracks_to_organize.
// Produces a dry-run report with confidence buckets.

import { promises as fs } from 'fs';
import path from 'path';
import { parseFile } from 'music-metadata';
import * as fuzzball from 'fuzzball';

const XML_MISSING = '/tmp/candybar-missing/xml_missing.json';
const CAND_DIRS = [
  { dir: '/Volumes/Time Machin/on_hold', label: 'on_hold' },
  { dir: '/Volumes/Time Machin/tracks_to_organize', label: 'tracks_to_organize' },
];
const OUT = '/tmp/candybar-missing/xml_match_report.json';
const SUMMARY = '/tmp/candybar-missing/xml_match_summary.txt';
const AUDIO_EXTS = new Set(['.aif', '.aiff', '.wav', '.mp3', '.m4a', '.flac']);
const CONCURRENCY = 12;

// Confidence thresholds (both artist + title fuzzy scores must clear)
const AUTO_LINK = 90;
const REVIEW = 70;

function normalize(s) {
  if (!s) return '';
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\(\[].*?[\)\]]/g, ' ')
    .replace(/feat\..*$|ft\..*$/g, ' ')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

// NOTE: keep bracketed content (remix/mix/version info) — stripping it causes
// "Innerbloom (Original Mix)" to match "Innerbloom (Ship Wrek Remix)".
function normalizeForFuzz(s) {
  if (!s) return '';
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function walk(root) {
  const out = [];
  async function rec(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await rec(p);
      else if (e.isFile() && AUDIO_EXTS.has(path.extname(e.name).toLowerCase())) out.push(p);
    }
  }
  await rec(root);
  return out;
}

async function readMeta(p) {
  try {
    const m = await parseFile(p, { duration: false, skipCovers: true });
    return {
      path: p,
      artist: m.common.artist || m.common.artists?.[0] || '',
      title: m.common.title || '',
    };
  } catch {
    return { path: p, artist: '', title: '' };
  }
}

async function scanAll(label, paths) {
  const total = paths.length;
  const out = new Array(total);
  let idx = 0, done = 0;
  async function worker() {
    while (idx < total) {
      const i = idx++;
      out[i] = await readMeta(paths[i]);
      done++;
      if (done % 100 === 0 || done === total) {
        process.stderr.write(`  [${label}] ${done}/${total}\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

// Derive artist/title for a candidate: prefer tags, fall back to filename parsing.
function candidateAT(cand) {
  if (cand.artist && cand.title) return { artist: cand.artist, title: cand.title, source: 'tags' };
  const base = path.basename(cand.path, path.extname(cand.path));
  const sepIdx = base.indexOf(' - ');
  if (sepIdx > 0) {
    return { artist: base.slice(0, sepIdx), title: base.slice(sepIdx + 3), source: 'filename' };
  }
  return { artist: '', title: base, source: 'filename-unparsed' };
}

async function main() {
  const missing = JSON.parse(await fs.readFile(XML_MISSING, 'utf8'));
  console.error(`XML missing: ${missing.length}`);

  // Load candidates
  const candidates = [];
  for (const { dir, label } of CAND_DIRS) {
    const files = await walkAudioFiles(dir);
    console.error(`${label}: ${files.length} files`);
    const metas = await scanAll(label, files);
    for (const m of metas) candidates.push({ ...m, bucket: label });
  }
  console.error(`Total candidates: ${candidates.length}`);

  // Precompute normalized forms for candidates
  for (const c of candidates) {
    const at = candidateAT(c);
    c.effArtist = at.artist;
    c.effTitle = at.title;
    c.source = at.source;
    c.normArtist = normalizeForFuzz(at.artist);
    c.normTitle = normalizeForFuzz(at.title);
    c.exactKey = `${normalize(at.artist)}|${normalize(at.title)}`;
  }

  // Index candidates by exact key for fast first-pass
  const exactIdx = new Map();
  for (const c of candidates) {
    if (!c.exactKey || c.exactKey === '|') continue;
    if (!exactIdx.has(c.exactKey)) exactIdx.set(c.exactKey, []);
    exactIdx.get(c.exactKey).push(c);
  }

  const buckets = { auto: [], review: [], none: [] };

  for (const m of missing) {
    const mArtist = m.artist || '';
    const mTitle = m.name || '';
    const mExactKey = `${normalize(mArtist)}|${normalize(mTitle)}`;
    const mNormArtist = normalizeForFuzz(mArtist);
    const mNormTitle = normalizeForFuzz(mTitle);

    // First: exact matches
    const exactHits = exactIdx.get(mExactKey) || [];

    // Score every candidate (cap the pool to save time isn't needed — 200 cands total)
    const scored = [];
    for (const c of candidates) {
      if (!c.normTitle) continue;
      const titleScore = fuzzball.token_set_ratio(mNormTitle, c.normTitle);
      const artistScore = mNormArtist && c.normArtist
        ? fuzzball.token_set_ratio(mNormArtist, c.normArtist)
        : (mNormArtist || c.normArtist ? 0 : 100); // if both empty, neutral
      const exact = c.exactKey === mExactKey;
      scored.push({
        path: c.path,
        bucket: c.bucket,
        source: c.source,
        candArtist: c.effArtist,
        candTitle: c.effTitle,
        titleScore,
        artistScore,
        minScore: Math.min(titleScore, artistScore),
        exact,
      });
    }
    scored.sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      return b.minScore - a.minScore;
    });
    const top = scored.slice(0, 3);

    const best = top[0];
    const rec = {
      trackId: m.trackId,
      xmlArtist: mArtist,
      xmlTitle: mTitle,
      xmlAlbum: m.album,
      oldPath: m.path,
      best: best ? {
        path: best.path,
        bucket: best.bucket,
        source: best.source,
        candArtist: best.candArtist,
        candTitle: best.candTitle,
        titleScore: best.titleScore,
        artistScore: best.artistScore,
        exact: best.exact,
      } : null,
      alternates: top.slice(1),
    };

    // Require non-empty artist on both sides for auto-link — otherwise we
    // end up matching tagless files to tagless XML entries by title alone,
    // which is unreliable.
    const bothArtistsPresent = !!(mNormArtist && best && best.candArtist && normalizeForFuzz(best.candArtist));
    if (best && bothArtistsPresent && best.artistScore >= AUTO_LINK && best.titleScore >= AUTO_LINK) {
      buckets.auto.push(rec);
    } else if (best && best.artistScore >= REVIEW && best.titleScore >= REVIEW) {
      buckets.review.push(rec);
    } else {
      buckets.none.push(rec);
    }
  }

  await fs.writeFile(OUT, JSON.stringify(buckets, null, 2));

  const lines = [
    `XML missing:         ${missing.length}`,
    `Candidates scanned:  ${candidates.length} (on_hold + tracks_to_organize)`,
    ``,
    `Auto-link (>=${AUTO_LINK}/${AUTO_LINK} or exact): ${buckets.auto.length}`,
    `Needs review (${REVIEW}-${AUTO_LINK - 1}):            ${buckets.review.length}`,
    `No match (<${REVIEW}):                ${buckets.none.length}`,
    ``,
    `=== Sample auto-link (first 10) ===`,
    ...buckets.auto.slice(0, 10).map(r =>
      `  [${r.best.bucket}] ${r.xmlArtist} - ${r.xmlTitle}\n    -> ${path.basename(r.best.path)}  (a=${r.best.artistScore} t=${r.best.titleScore}${r.best.exact ? ' EXACT' : ''})`
    ),
    ``,
    `=== Sample needs-review (first 10) ===`,
    ...buckets.review.slice(0, 10).map(r =>
      `  [${r.best.bucket}] ${r.xmlArtist} - ${r.xmlTitle}\n    -> ${path.basename(r.best.path)}  (a=${r.best.artistScore} t=${r.best.titleScore})`
    ),
    ``,
    `=== Sample no-match (first 10) ===`,
    ...buckets.none.slice(0, 10).map(r =>
      `  ${r.xmlArtist} - ${r.xmlTitle}` +
      (r.best ? `\n    best: ${path.basename(r.best.path)} (a=${r.best.artistScore} t=${r.best.titleScore})` : '')
    ),
  ];
  await fs.writeFile(SUMMARY, lines.join('\n') + '\n');
  console.error('\n' + lines.join('\n'));
  console.error(`\nReport:  ${OUT}`);
  console.error(`Summary: ${SUMMARY}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
