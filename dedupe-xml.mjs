#!/usr/bin/env node
// Dedupe Rekordbox export.xml after a bulk Import Folder created duplicate TRACK entries.
//
// Match rule: two TRACKs are duplicates if ANY of
//   (a) their Location resolves to the same filePath, OR
//   (b) their basename + Size attribute match, OR
//   (c) their normalized (artist|title) tag key matches.
// Clusters are the connected components of that relation (union-find).
// Rule (a) catches "auto-relocate updated Location but left stale cached Size, then
// Import Folder added a second entry at the same path."
// Rule (b) catches same bytes at a different path (renamed file, same size).
// Rule (c) catches the nasty case: old entry with cues still points at a now-missing
// path, and the re-imported new entry has a renamed + re-encoded file, so neither
// path nor size links them. Tag-only clusters are handled carefully -- only acted on
// when exactly one member's file exists; otherwise flagged as suspects for review.
//
// Per cluster: keep the entry with oldest DateAdded (tiebreak: smallest TrackID).
//   - Winner's path exists on disk -> other entries are losers (delete in Rekordbox).
//   - Winner's path missing but a loser's path exists -> plan a Location rewrite on
//     the winner to that loser's path, then all others are losers.
//   - Every entry's path missing -> park in cluster-all-missing for manual review.
// Non-clustered entries whose path is missing -> orphans.
//
// Default: dry-run (reports only). With --apply, also rewrites the XML (with
// timestamped backup) for planned relocations. Never deletes TRACK entries;
// deletion happens in Rekordbox UI after the user reviews the losers CSV.
//
// Usage:
//   node dedupe-xml.mjs                          # dry-run, reports only
//   node dedupe-xml.mjs --apply                  # also rewrite XML in place
//   node dedupe-xml.mjs --xml=/path/to/export.xml

import { promises as fs } from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';
import { locToPath, pathToLocation } from './lib/xmlUtils.mjs';
import { normalizeTrackKey, makeTagKey } from './lib/stringUtils.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const xmlArg = args.find((a) => a.startsWith('--xml='));
const XML = xmlArg ? xmlArg.slice('--xml='.length) : '/Volumes/Time Machin/rekordbox/export.xml';
const EXISTENCE_CONCURRENCY = 32;
// For tag-only clusters with >1 existing file: if the size span across existing members
// is within this tolerance, treat the cluster as confident (same audio with tag rewrite
// overhead). 8KB catches ID3v2 header rewrites but not full album-art embedding.
const TAG_SIZE_TOLERANCE_BYTES = 8192;

async function fileExists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function mapWithConcurrency(items, limit, fn) {
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function parseIntOrNull(s) {
  if (s == null || s === '') return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function dateAddedRank(dateAdded) {
  if (!dateAdded) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(dateAdded);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows, headers) {
  const out = [headers.map(csvCell).join(',')];
  for (const r of rows) out.push(headers.map((h) => csvCell(r[h])).join(','));
  return out.join('\n') + '\n';
}

async function main() {
  const xmlText = await fs.readFile(XML, 'utf8');
  const dom = new JSDOM(xmlText, { contentType: 'text/xml' });
  const doc = dom.window.document;

  const collection = doc.querySelector('COLLECTION');
  if (!collection) throw new Error(`No <COLLECTION> node in ${XML}`);

  const trackNodes = Array.from(collection.querySelectorAll('TRACK'));
  console.error(`XML tracks: ${trackNodes.length}`);

  const tracks = trackNodes.map((t) => {
    const location = t.getAttribute('Location') || '';
    const filePath = locToPath(location);
    const size = parseIntOrNull(t.getAttribute('Size'));
    const artist = t.getAttribute('Artist') || '';
    const title = t.getAttribute('Name') || '';
    const tagKey = artist && title ? makeTagKey(artist, title) : '';
    return {
      trackId: t.getAttribute('TrackID') || '',
      artist,
      title,
      album: t.getAttribute('Album') || '',
      dateAdded: t.getAttribute('DateAdded') || '',
      location,
      filePath,
      size,
      tagKey,
      basename: filePath ? path.basename(filePath) : '',
      exists: false,
    };
  });

  await mapWithConcurrency(tracks, EXISTENCE_CONCURRENCY, async (t) => {
    t.exists = t.filePath ? await fileExists(t.filePath) : false;
  });

  // Union-find over tracks. Three edge kinds: path, (basename + size), tagKey.
  // Track which kinds linked each cluster so we can handle tag-only clusters more cautiously.
  const parent = new Array(tracks.length).fill(0).map((_, i) => i);
  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(i, j) {
    const ri = find(i), rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  }
  const rootEdges = new Map();
  function recordEdge(i, kind) {
    const r = find(i);
    let set = rootEdges.get(r);
    if (!set) { set = new Set(); rootEdges.set(r, set); }
    set.add(kind);
  }
  const pathFirst = new Map();
  const bsFirst = new Map();
  const tagFirst = new Map();
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (t.filePath) {
      if (pathFirst.has(t.filePath)) { union(pathFirst.get(t.filePath), i); recordEdge(i, 'path'); }
      else pathFirst.set(t.filePath, i);
    }
    if (t.basename && t.size != null) {
      const bk = `${t.basename}|${t.size}`;
      if (bsFirst.has(bk)) { union(bsFirst.get(bk), i); recordEdge(i, 'bs'); }
      else bsFirst.set(bk, i);
    }
    if (t.tagKey) {
      if (tagFirst.has(t.tagKey)) { union(tagFirst.get(t.tagKey), i); recordEdge(i, 'tag'); }
      else tagFirst.set(t.tagKey, i);
    }
  }
  // Re-key rootEdges by final root (earlier recordEdge calls used intermediate roots).
  const edgesByRoot = new Map();
  for (const [r, set] of rootEdges.entries()) {
    const finalRoot = find(r);
    let merged = edgesByRoot.get(finalRoot);
    if (!merged) { merged = new Set(); edgesByRoot.set(finalRoot, merged); }
    for (const k of set) merged.add(k);
  }
  const byRoot = new Map();
  for (let i = 0; i < tracks.length; i++) {
    const r = find(i);
    let arr = byRoot.get(r);
    if (!arr) { arr = []; byRoot.set(r, arr); }
    arr.push(tracks[i]);
  }
  const groups = new Map();
  const groupEdges = new Map();
  for (const [r, members] of byRoot.entries()) {
    const key = members[0].filePath || `tid:${members[0].trackId}`;
    const gkey = `${r}:${key}`;
    groups.set(gkey, members);
    groupEdges.set(gkey, edgesByRoot.get(r) || new Set());
  }

  const inCluster = new Set();
  const losers = [];
  const relocations = [];
  const clusterAllMissing = [];
  const tagSuspects = []; // tag-only clusters with >1 existing file -- needs manual review

  for (const [key, members] of groups.entries()) {
    if (members.length < 2) continue;
    for (const m of members) inCluster.add(m.trackId);

    members.sort((a, b) => {
      const da = dateAddedRank(a.dateAdded);
      const db = dateAddedRank(b.dateAdded);
      if (da !== db) return da - db;
      const ia = parseIntOrNull(a.trackId) ?? Number.POSITIVE_INFINITY;
      const ib = parseIntOrNull(b.trackId) ?? Number.POSITIVE_INFINITY;
      return ia - ib;
    });

    const edges = groupEdges.get(key) || new Set();
    const hasStrongLink = edges.has('path') || edges.has('bs');
    const tagOnly = !hasStrongLink && edges.has('tag');
    let linkage = hasStrongLink
      ? Array.from(edges).filter((e) => e !== 'tag').join('+')
      : 'tag';
    const existing = members.filter((m) => m.exists);

    // Safety guard: tag-only cluster with >1 existing file at distinct paths could be
    // legitimately different copies (e.g., MP3 + lossless). BUT if existing members'
    // sizes are within TAG_SIZE_TOLERANCE_BYTES of each other, that's consistent with
    // identical audio + tag-rewrite overhead -- escalate to confident match.
    if (tagOnly && existing.length > 1) {
      const distinctPaths = new Set(existing.map((m) => m.filePath));
      if (distinctPaths.size > 1) {
        const sizes = existing.map((m) => m.size).filter((s) => s != null);
        const sizeSpan = sizes.length > 1 ? Math.max(...sizes) - Math.min(...sizes) : Infinity;
        if (sizeSpan <= TAG_SIZE_TOLERANCE_BYTES) {
          linkage = 'tag+size~'; // escalated: near-identical sizes imply same audio
        } else {
          for (const m of members) {
            tagSuspects.push({
              trackId: m.trackId,
              artist: m.artist,
              title: m.title,
              album: m.album,
              filePath: m.filePath,
              exists: m.exists ? 'yes' : 'no',
              size: m.size,
              dateAdded: m.dateAdded,
              clusterKey: key,
            });
          }
          continue;
        }
      }
    }

    const winner = members[0];
    const others = members.slice(1);

    if (winner.exists) {
      for (const o of others) {
        losers.push({
          trackId: o.trackId,
          artist: o.artist,
          title: o.title,
          album: o.album,
          filePath: o.filePath,
          loserFileExists: o.exists ? 'yes' : 'no',
          winnerTrackId: winner.trackId,
          linkage,
          reason: 'duplicate (winner path OK)',
          clusterKey: key,
        });
      }
      continue;
    }

    const donor = others.find((o) => o.exists);
    if (donor) {
      relocations.push({
        trackId: winner.trackId,
        artist: winner.artist,
        title: winner.title,
        album: winner.album,
        oldPath: winner.filePath,
        newPath: donor.filePath,
        fromLoserTrackId: donor.trackId,
        linkage,
        clusterKey: key,
      });
      for (const o of others) {
        losers.push({
          trackId: o.trackId,
          artist: o.artist,
          title: o.title,
          album: o.album,
          filePath: o.filePath,
          loserFileExists: o.exists ? 'yes' : 'no',
          winnerTrackId: winner.trackId,
          linkage,
          reason: o.trackId === donor.trackId
            ? 'duplicate (path donated to winner)'
            : 'duplicate (path missing)',
          clusterKey: key,
        });
      }
      continue;
    }

    for (const m of members) {
      clusterAllMissing.push({
        trackId: m.trackId,
        artist: m.artist,
        title: m.title,
        album: m.album,
        filePath: m.filePath,
        linkage,
        clusterKey: key,
      });
    }
  }

  const orphans = [];
  for (const t of tracks) {
    if (inCluster.has(t.trackId)) continue;
    if (!t.exists && t.filePath) {
      orphans.push({
        trackId: t.trackId,
        artist: t.artist,
        title: t.title,
        album: t.album,
        filePath: t.filePath,
      });
    }
  }

  const summary = {
    xmlPath: XML,
    totalTracks: tracks.length,
    duplicateClusters: Array.from(groups.values()).filter((m) => m.length > 1).length,
    losersToDelete: losers.length,
    plannedRelocations: relocations.length,
    clusterAllMissingEntries: clusterAllMissing.length,
    tagSuspectEntries: tagSuspects.length,
    orphans: orphans.length,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.dirname(XML);
  const losersCsvPath = path.join(dir, `dedupe-losers-${stamp}.csv`);
  const relocsCsvPath = path.join(dir, `dedupe-relocations-${stamp}.csv`);
  const orphansCsvPath = path.join(dir, `dedupe-orphans-${stamp}.csv`);
  const allMissingCsvPath = path.join(dir, `dedupe-cluster-all-missing-${stamp}.csv`);
  const tagSuspectsCsvPath = path.join(dir, `dedupe-tag-suspects-${stamp}.csv`);
  const jsonPath = path.join(dir, `dedupe-report-${stamp}.json`);

  await fs.writeFile(losersCsvPath, toCsv(losers, [
    'trackId', 'artist', 'title', 'album', 'filePath', 'loserFileExists', 'winnerTrackId', 'linkage', 'reason', 'clusterKey',
  ]));
  await fs.writeFile(relocsCsvPath, toCsv(relocations, [
    'trackId', 'artist', 'title', 'album', 'oldPath', 'newPath', 'fromLoserTrackId', 'linkage', 'clusterKey',
  ]));
  await fs.writeFile(orphansCsvPath, toCsv(orphans, [
    'trackId', 'artist', 'title', 'album', 'filePath',
  ]));
  await fs.writeFile(allMissingCsvPath, toCsv(clusterAllMissing, [
    'trackId', 'artist', 'title', 'album', 'filePath', 'linkage', 'clusterKey',
  ]));
  await fs.writeFile(tagSuspectsCsvPath, toCsv(tagSuspects, [
    'trackId', 'artist', 'title', 'album', 'filePath', 'exists', 'size', 'dateAdded', 'clusterKey',
  ]));
  await fs.writeFile(jsonPath, JSON.stringify({
    summary, losers, relocations, orphans, clusterAllMissing, tagSuspects,
  }, null, 2));

  console.error('');
  console.error('Summary:');
  for (const [k, v] of Object.entries(summary)) console.error(`  ${k.padEnd(26)} ${v}`);
  console.error('');
  console.error(`Losers CSV:        ${losersCsvPath}`);
  console.error(`Relocations CSV:   ${relocsCsvPath}`);
  console.error(`Orphans CSV:       ${orphansCsvPath}`);
  console.error(`All-missing CSV:   ${allMissingCsvPath}`);
  console.error(`Tag-suspects CSV:  ${tagSuspectsCsvPath}`);
  console.error(`JSON:              ${jsonPath}`);

  if (!APPLY) {
    console.error('');
    console.error('Dry-run. Re-run with --apply to rewrite Location attributes for planned relocations.');
    return;
  }

  if (relocations.length === 0) {
    console.error('');
    console.error('No relocations planned - XML untouched.');
    return;
  }

  const backupPath = `${XML}.backup-${stamp}`;
  await fs.writeFile(backupPath, xmlText);
  console.error(`\nBacked up XML -> ${backupPath}`);

  let newXml = xmlText;
  const rewritten = [];
  const missed = [];
  for (const r of relocations) {
    const newLoc = pathToLocation(r.newPath);
    const escId = r.trackId.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    const rx = new RegExp(
      `(<TRACK\\b[^>]*\\bTrackID="${escId}"[\\s\\S]*?\\bLocation=")[^"]*(")`,
    );
    const before = newXml;
    newXml = newXml.replace(rx, `$1${newLoc}$2`);
    if (newXml === before) missed.push(r.trackId);
    else rewritten.push(r.trackId);
  }
  await fs.writeFile(XML, newXml);
  console.error(`Rewrote Location for ${rewritten.length} winner track(s); ${missed.length} missed.`);
  if (missed.length) {
    console.error(`  Missed TrackIDs: ${missed.slice(0, 20).join(', ')}${missed.length > 20 ? '...' : ''}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
