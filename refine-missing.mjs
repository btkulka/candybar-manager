#!/usr/bin/env node
// Second-pass refinement:
//  - Dedupe missing list by (normalized artist, title)
//  - Cross-check against HDD filenames (normalized) to catch matches where HDD files lack tags

import { promises as fs } from 'fs';
import path from 'path';
import { walkAudioFiles } from './lib/walkAudioFiles.mjs';
import { normalizeAggressive as normalize, makeAggressiveKey as keyAT } from './lib/stringUtils.mjs';

const HDD_ROOT = '/Volumes/Time Machin/Library';
const IN_FILE = '/tmp/candybar-missing/missing.json';
const OUT_FILE = '/tmp/candybar-missing/missing_refined.json';
const DROPPED_FILE = '/tmp/candybar-missing/dropped_by_filename_match.json';

async function main() {
  const missing = JSON.parse(await fs.readFile(IN_FILE, 'utf8'));
  console.error(`Loaded ${missing.length} missing`);

  // Walk HDD for filenames
  const hddFiles = await walkAudioFiles(HDD_ROOT);
  console.error(`HDD files: ${hddFiles.length}`);

  // Build normalized-filename set for HDD.
  // HDD filename style: "Artist - Title.ext" (mostly). Build two keys:
  //  - whole filename normalized (no ext)
  //  - if it contains " - ", also the artist|title version
  const hddFullKeys = new Set();
  const hddATKeys = new Set();
  for (const p of hddFiles) {
    const base = path.basename(p, path.extname(p));
    hddFullKeys.add(normalize(base));
    const idx = base.indexOf(' - ');
    if (idx > 0) {
      const a = base.slice(0, idx);
      const t = base.slice(idx + 3);
      hddATKeys.add(keyAT(a, t));
    }
  }

  // Dedupe missing by normalized (artist|title); keep first occurrence.
  const seen = new Set();
  const deduped = [];
  const duplicatesRemoved = [];
  for (const m of missing) {
    const k = keyAT(m.artist, m.title);
    if (seen.has(k)) {
      duplicatesRemoved.push(m);
      continue;
    }
    seen.add(k);
    deduped.push(m);
  }
  console.error(`After dedupe: ${deduped.length} (removed ${duplicatesRemoved.length})`);

  // Filename-based cross-check: drop any missing whose USB filename (normalized)
  // matches an HDD filename, OR whose artist|title matches HDD's parsed " - " pair.
  const refined = [];
  const dropped = [];
  for (const m of deduped) {
    const usbBase = path.basename(m.path, path.extname(m.path));
    const usbFullNorm = normalize(usbBase);
    const atKey = keyAT(m.artist, m.title);

    let matchReason = null;
    if (hddFullKeys.has(usbFullNorm)) matchReason = 'filename-exact';
    else if (hddATKeys.has(atKey)) matchReason = 'filename-artist-title';
    else {
      // Also try parsing USB filename as "Artist - Title" since some USB files
      // follow that pattern too.
      const idx = usbBase.indexOf(' - ');
      if (idx > 0) {
        const a = usbBase.slice(0, idx);
        const t = usbBase.slice(idx + 3);
        if (hddATKeys.has(keyAT(a, t))) matchReason = 'filename-parsed';
      }
    }

    if (matchReason) dropped.push({ ...m, matchReason });
    else refined.push(m);
  }

  await fs.writeFile(OUT_FILE, JSON.stringify(refined, null, 2));
  await fs.writeFile(DROPPED_FILE, JSON.stringify(dropped, null, 2));
  await fs.writeFile(
    '/tmp/candybar-missing/duplicates_removed.json',
    JSON.stringify(duplicatesRemoved, null, 2)
  );

  console.error('\n--- Refinement summary ---');
  console.error(`Missing (initial):            ${missing.length}`);
  console.error(`Duplicates removed:           ${duplicatesRemoved.length}`);
  console.error(`After dedupe:                 ${deduped.length}`);
  console.error(`Dropped by filename match:    ${dropped.length}`);
  console.error(`FINAL missing to copy:        ${refined.length}`);
  console.error(`\nOutput: ${OUT_FILE}`);
  console.error('\nFirst 20 final:');
  for (const m of refined.slice(0, 20)) {
    console.error(`  ${m.artist} - ${m.title}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
