#!/usr/bin/env node
// From review bucket, select entries that are safe to apply:
//  - Title score == 100 AND artist score == 100 (exact by fuzz)
//  - File path is uniquely claimed (no other XML entry matches same file)
// Skip the rest.

import { promises as fs } from 'fs';

const REPORT = '/tmp/candybar-missing/xml_match_report.json';
const OUT_APPROVE = '/tmp/candybar-missing/review_approved.json';
const OUT_SKIP = '/tmp/candybar-missing/review_skipped.json';

const report = JSON.parse(await fs.readFile(REPORT, 'utf8'));
const review = report.review;

// Count how often each best.path is claimed across review (and auto)
const pathCount = new Map();
for (const m of [...report.auto, ...review]) {
  if (!m.best) continue;
  pathCount.set(m.best.path, (pathCount.get(m.best.path) || 0) + 1);
}

const approve = [];
const skip = [];
for (const m of review) {
  const b = m.best;
  const uniquePath = pathCount.get(b.path) === 1;
  const perfect = b.artistScore === 100 && b.titleScore === 100;
  if (perfect && uniquePath) approve.push(m);
  else {
    const reason = !perfect
      ? `score below 100 (a=${b.artistScore} t=${b.titleScore})`
      : `file claimed by ${pathCount.get(b.path)} XML entries`;
    skip.push({ ...m, skipReason: reason });
  }
}

await fs.writeFile(OUT_APPROVE, JSON.stringify(approve, null, 2));
await fs.writeFile(OUT_SKIP, JSON.stringify(skip, null, 2));

console.log(`Review total: ${review.length}`);
console.log(`Approved:     ${approve.length}`);
console.log(`Skipped:      ${skip.length}`);
console.log('\n=== Approve list ===');
for (const m of approve) {
  console.log(`  [${m.trackId}] ${m.xmlArtist || '(no artist)'} - ${m.xmlTitle}`);
  console.log(`    -> ${m.best.path.split('/').pop()}`);
}
console.log('\n=== Skip (reasons) ===');
for (const m of skip) {
  console.log(`  [${m.trackId}] ${m.xmlArtist || '(no artist)'} - ${m.xmlTitle}`);
  console.log(`    skip: ${m.skipReason}`);
}
