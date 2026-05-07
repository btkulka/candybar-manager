// Splice sample recovery for an Ableton project.
//
// Usage:
//   node splice-recover.mjs <project.als>
//       Scans the .als for missing Splice samples, searches Splice for
//       each, writes a manifest to /tmp/splice-recover-<basename>.json,
//       prints a bucket summary. Does NOT download anything.
//
//   node splice-recover.mjs <project.als> --download-owned
//       Same as above, plus actually downloads the "owned" bucket
//       (free re-downloads) into the original paths the .als referenced.
//
// Buckets:
//   - owned:    Found via licensed:true search. Free to re-download.
//   - credits:  Found via licensed:null but not licensed:true. Costs
//               credits — we don't auto-download these. Eventual UI lets
//               the user pick which to spend on.
//   - notFound: Search returned no hits at all. Sample may be renamed,
//               taken down, or wasn't from Splice in the first place.

import fs from 'fs';
import path from 'path';
import { findMissingSpliceSamples } from './lib/alsParser.mjs';
import { searchSamples, downloadSample } from './lib/spliceClient.mjs';

const args = process.argv.slice(2);
const alsPath = args.find((a) => !a.startsWith('--'));
const downloadOwned = args.includes('--download-owned');

if (!alsPath) {
  console.error('usage: node splice-recover.mjs <project.als> [--download-owned]');
  process.exit(1);
}
if (!fs.existsSync(alsPath)) {
  console.error(`not found: ${alsPath}`);
  process.exit(1);
}

const VERBOSE = true;

console.log(`scanning ${alsPath}`);
const scan = findMissingSpliceSamples(alsPath);
console.log(`  total sample refs: ${scan.totalRefs}`);
console.log(`  splice-flavored:   ${scan.spliceRefs}`);
console.log(`  missing on disk:   ${scan.missing.length}`);
console.log();

if (scan.missing.length === 0) {
  console.log('nothing to recover.');
  process.exit(0);
}

// For each missing sample: licensed:true first (free), fall back to
// licensed:null (full catalog). Pick the first hit either way — Splice's
// filename matching is precise enough that the top result on a basename
// query is almost always the right sample.
const owned = [];
const credits = [];
const notFound = [];

for (let i = 0; i < scan.missing.length; i++) {
  const m = scan.missing[i];
  const tag = `[${i + 1}/${scan.missing.length}]`;
  process.stdout.write(`${tag} ${m.basename} … `);

  try {
    const ownedHit = await searchSamples({ filepath: m.searchKey, licensed: true, limit: 5, verbose: false });
    if (ownedHit.assets?.length) {
      const a = ownedHit.assets[0];
      owned.push({ ...m, asset: { uuid: a.uuid, filename: a.filename, name: a.name } });
      console.log(`OWNED (uuid=${a.uuid})`);
      continue;
    }

    const fullHit = await searchSamples({ filepath: m.searchKey, licensed: null, limit: 5, verbose: false });
    if (fullHit.assets?.length) {
      const a = fullHit.assets[0];
      credits.push({ ...m, asset: { uuid: a.uuid, filename: a.filename, name: a.name } });
      console.log(`CREDITS (uuid=${a.uuid})`);
      continue;
    }

    notFound.push(m);
    console.log('NOT FOUND');
  } catch (err) {
    notFound.push({ ...m, error: err.message });
    console.log(`ERROR: ${err.message}`);
  }
}

console.log();
console.log(`owned (free):     ${owned.length}`);
console.log(`credits (paid):   ${credits.length}`);
console.log(`not found:        ${notFound.length}`);

const manifestPath = `/tmp/splice-recover-${path.basename(alsPath, '.als')}.json`;
fs.writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      alsPath,
      scannedAt: new Date().toISOString(),
      summary: { owned: owned.length, credits: credits.length, notFound: notFound.length },
      owned,
      credits,
      notFound,
    },
    null,
    2,
  ),
);
console.log();
console.log(`manifest: ${manifestPath}`);

if (!downloadOwned) {
  console.log();
  console.log('re-run with --download-owned to pull the free bucket into the original paths.');
  process.exit(0);
}

if (owned.length === 0) {
  console.log('nothing in the owned bucket to download.');
  process.exit(0);
}

console.log();
console.log(`downloading ${owned.length} owned samples…`);
let okCount = 0;
let failCount = 0;
for (let i = 0; i < owned.length; i++) {
  const item = owned[i];
  const tag = `[${i + 1}/${owned.length}]`;
  process.stdout.write(`${tag} ${item.basename} → ${item.originalPath} … `);
  try {
    await downloadSample(item.asset.uuid, item.originalPath, { verbose: false });
    console.log('OK');
    okCount++;
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    failCount++;
  }
}
console.log();
console.log(`downloaded: ${okCount}, failed: ${failCount}`);
