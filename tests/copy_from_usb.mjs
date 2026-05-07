// Copy missing tracks from NHI 2-0 BAK USB to Library/.
// Primary strategy: rewrite Rekordbox XML path /Volumes/Candy Bar/Music/ → /Volumes/NHI 2-0 BAK/Contents/
// Fallback: fuzzy scan for artist+title match within USB.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const USB = '/Volumes/NHI 2-0 BAK/Contents';
const LIB = '/Volumes/Time Machin/Library';
const STAGE = '/Volumes/Time Machin/tracks_to_organize/usb_recovered';

const missing = JSON.parse(fs.readFileSync('/tmp/still_missing_after_qobuz.json', 'utf8'));
console.log(`${missing.length} tracks to try`);

fs.mkdirSync(STAGE, { recursive: true });

// Build USB file index for fuzzy fallback
function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out, depth + 1);
      else if (/\.(aiff?|wav|mp3|flac|m4a)$/i.test(e.name)) out.push(p);
    }
  } catch {}
  return out;
}

console.log('Indexing USB...');
const usbFiles = walk(USB);
console.log(`USB: ${usbFiles.length} audio files`);

function normalize(s) {
  return (s || '').toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/feat\.?|ft\.?|featuring/g, ' ')
    .replace(/original mix|extended mix|radio edit|club mix/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const fuzzball = await import('fuzzball');
function score(a, b) {
  const aN = normalize(a), bN = normalize(b);
  if (!aN || !bN) return 0;
  return Math.max(fuzzball.ratio(aN, bN), fuzzball.token_set_ratio(aN, bN)) / 100;
}

// Build artist-folder index
const byArtistFolder = new Map();
for (const f of usbFiles) {
  const rel = f.slice(USB.length + 1);
  const folder = rel.split('/')[0];
  if (!byArtistFolder.has(folder)) byArtistFolder.set(folder, []);
  byArtistFolder.get(folder).push(f);
}

function findCandidate(m) {
  // Strategy 1: direct path rewrite
  const orig = m.origPath || '';
  const rewritten = orig.replace(/^.*?\/Music\//, USB + '/');
  if (rewritten && rewritten !== orig && fs.existsSync(rewritten)) {
    return { path: rewritten, method: 'exact_path' };
  }

  // Strategy 2: fuzzy artist folder + title token match
  const firstArtist = (m.artist || '').split(/[,&]/)[0].trim();
  const nArtist = normalize(firstArtist);
  const nTitle = normalize(m.title);
  const titleTokens = nTitle.split(' ').filter(Boolean);
  if (titleTokens.length === 0) return null;

  // Find matching artist folder (score >= 0.8)
  let bestFolder = null, bestFolderScore = 0;
  for (const folder of byArtistFolder.keys()) {
    const s = score(firstArtist, folder);
    if (s > bestFolderScore) { bestFolderScore = s; bestFolder = folder; }
  }
  if (!bestFolder || bestFolderScore < 0.75) return null;

  // Within that folder, find best matching file by title — REQUIRE at least one title token hit
  const candidates = byArtistFolder.get(bestFolder) || [];
  let bestFile = null, bestFileScore = 0, bestHits = 0;
  for (const f of candidates) {
    const fname = path.basename(f);
    const nFile = normalize(fname);
    const hitRatio = titleTokens.filter(w => nFile.includes(w)).length / titleTokens.length;
    if (hitRatio === 0) continue; // reject if NO title tokens in filename
    const s = score(m.title, fname) * 0.6 + hitRatio * 0.4;
    if (s > bestFileScore) { bestFileScore = s; bestFile = f; bestHits = hitRatio; }
  }
  if (bestFile && bestFileScore >= 0.55 && bestHits >= 0.4) {
    return { path: bestFile, method: 'fuzzy', folder: bestFolder, folderScore: +bestFolderScore.toFixed(3), fileScore: +bestFileScore.toFixed(3), hits: +bestHits.toFixed(2) };
  }
  return null;
}

function sanitize(s) {
  return s.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim();
}

const copied = [];
const notFound = [];
for (let i = 0; i < missing.length; i++) {
  const m = missing[i];
  const hit = findCandidate(m);
  if (!hit) {
    notFound.push(m);
    continue;
  }
  const ext = path.extname(hit.path);
  const destName = sanitize(`${m.artist} - ${m.title}${ext}`);
  const destPath = path.join(STAGE, destName);
  try {
    if (!fs.existsSync(destPath)) {
      fs.copyFileSync(hit.path, destPath);
    }
    copied.push({ missing: m, source: hit.path, dest: destPath, method: hit.method });
    if ((i + 1) % 25 === 0) console.log(`  [${i + 1}/${missing.length}] copied=${copied.length} notfound=${notFound.length}`);
  } catch (e) {
    notFound.push({ ...m, error: e.message });
  }
}

console.log(`\nDone: copied ${copied.length} / missing ${missing.length}`);
console.log(`Still not found: ${notFound.length}`);
console.log(`\nBy method:`, copied.reduce((acc, x) => { acc[x.method] = (acc[x.method] || 0) + 1; return acc; }, {}));

fs.writeFileSync('/tmp/usb_copy_result.json', JSON.stringify({ copied, notFound }, null, 2));
console.log(`\nCopied files staged at: ${STAGE}`);
console.log(`Run Organize-by-Artist next to move them into Library/.`);
