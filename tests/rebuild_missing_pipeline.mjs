// Rebuilds: /tmp/missing_tracks.json, /tmp/owned_beatport.json, /tmp/owned_qobuz.json,
// /tmp/redownload_beatport.json, /tmp/still_missing_after_beatport.json,
// /tmp/redownload_qobuz.json, /tmp/still_missing_after_qobuz.json
// Using: current Rekordbox XML, current Library on disk, DB's downloaded_tracks.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const fuzzball = await import('fuzzball');
const XML = '/Volumes/Time Machin/rekordbox/export.xml';
const LIB = '/Volumes/Time Machin/Library';
const DB = path.join(os.homedir(), 'Library/Application Support/candybar-manager/candybar.db');

// --- Parse Rekordbox XML ---
const xml = fs.readFileSync(XML, 'utf8');
const trackRe = /<TRACK\s+([^>]*?)(?:\/>|>)/g;
const attrRe = /(\w+)="([^"]*)"/g;
const tracks = [];
let m;
while ((m = trackRe.exec(xml))) {
  const attrs = {};
  let a;
  const block = m[1];
  while ((a = attrRe.exec(block))) attrs[a[1]] = a[2];
  if (attrs.TrackID) tracks.push(attrs);
}
console.log(`Parsed ${tracks.length} tracks from Rekordbox XML`);

// --- Walk library ---
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const libFiles = walk(LIB);
console.log(`Library has ${libFiles.length} files`);
const byBasename = new Map();
for (const f of libFiles) {
  const base = path.basename(f).toLowerCase();
  if (!byBasename.has(base)) byBasename.set(base, []);
  byBasename.get(base).push(f);
}

function decodeLoc(loc) {
  try { const u = new URL(loc); return decodeURIComponent(u.pathname); }
  catch { return decodeURIComponent((loc || '').replace(/^file:\/\/localhost/, '')); }
}
function normalize(s) {
  return (s || '').toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/feat\.?|ft\.?|featuring/g, ' ')
    .replace(/original mix|extended mix|radio edit|club mix/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// --- Find missing tracks ---
const missing = [];
for (const t of tracks) {
  const origPath = decodeLoc(t.Location || '');
  const base = path.basename(origPath).toLowerCase();
  if (byBasename.has(base)) continue;
  // Fuzzy: artist folder + title tokens >=60% in filename
  const nTitle = normalize(t.Name).split(' ').filter(Boolean);
  if (nTitle.length === 0) { continue; }
  const artistFirst = (t.Artist || '').split(/[,&]/)[0].trim();
  const artistTokens = normalize(artistFirst).split(' ').filter(Boolean);
  const candidate = libFiles.find(f => {
    const rel = f.slice(LIB.length + 1);
    const folder = rel.split('/')[0] || '';
    const fname = path.basename(f);
    const nFolder = normalize(folder);
    const nFile = normalize(fname);
    if (!artistTokens.every(w => nFolder.includes(w))) return false;
    const hits = nTitle.filter(w => nFile.includes(w)).length;
    return hits / nTitle.length >= 0.6;
  });
  if (candidate) continue;
  missing.push({
    artist: t.Artist, title: t.Name, album: t.Album, label: t.Label,
    genre: t.Genre, year: t.Year, bpm: t.AverageBpm, key: t.Tonality,
    origPath,
  });
}
console.log(`Missing: ${missing.length}`);
fs.writeFileSync('/tmp/missing_tracks.json', JSON.stringify(missing, null, 2));

// --- Load owned from DB ---
function sqliteRows(query) {
  const json = execSync(`sqlite3 -json ${JSON.stringify(DB)} ${JSON.stringify(query)}`).toString();
  return json.trim() ? JSON.parse(json) : [];
}
const ownedBp = sqliteRows("SELECT track_id, artist, title FROM downloaded_tracks WHERE source='beatport'")
  .map(r => ({ source: 'beatport', trackId: r.track_id, artist: r.artist, title: r.title }));
const ownedQz = sqliteRows("SELECT track_id, artist, title FROM downloaded_tracks WHERE source='qobuz'")
  .map(r => ({ source: 'qobuz', trackId: r.track_id, artist: r.artist, title: r.title }));
console.log(`DB owned: ${ownedBp.length} beatport, ${ownedQz.length} qobuz`);
fs.writeFileSync('/tmp/owned_beatport.json', JSON.stringify(ownedBp, null, 2));
fs.writeFileSync('/tmp/owned_qobuz.json', JSON.stringify(ownedQz, null, 2));

// --- Match missing against each ---
function score(a, b) {
  const aN = normalize(a), bN = normalize(b);
  if (!aN || !bN) return 0;
  return Math.max(fuzzball.ratio(aN, bN), fuzzball.token_set_ratio(aN, bN)) / 100;
}
function findBest(m, pool) {
  let best = null, bestScore = 0;
  for (const o of pool) {
    const s = score(m.title, o.title) * 0.6 + score(m.artist, o.artist) * 0.4;
    if (s > bestScore) { bestScore = s; best = o; }
  }
  return { best, score: bestScore };
}

const MATCH = 0.80;
const afterBp = [];
for (const m of missing) {
  const r = findBest(m, ownedBp);
  if (r.score < MATCH) afterBp.push(m);
}
console.log(`Still missing after Beatport DB match: ${afterBp.length}`);
fs.writeFileSync('/tmp/still_missing_after_beatport.json', JSON.stringify(afterBp, null, 2));

const afterQz = [];
for (const m of afterBp) {
  const r = findBest(m, ownedQz);
  if (r.score < MATCH) afterQz.push(m);
}
console.log(`Still missing after Qobuz DB match: ${afterQz.length}`);
fs.writeFileSync('/tmp/still_missing_after_qobuz.json', JSON.stringify(afterQz, null, 2));
