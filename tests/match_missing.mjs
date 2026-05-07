import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const fuzzball = await import('fuzzball');

const missing = JSON.parse(fs.readFileSync('/tmp/missing_tracks.json', 'utf8'));
const ownedBP = JSON.parse(fs.readFileSync('/tmp/owned_beatport.json', 'utf8'));

// Same normalization + weighting as matchesOwnedTrack in storePurchase.ts
function normalize(s) {
  return (s || '').toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/feat\.?|ft\.?|featuring/g, ' ')
    .replace(/original mix|extended mix|radio edit|club mix/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function score(a, b) {
  const aN = normalize(a), bN = normalize(b);
  if (!aN && !bN) return 1;
  if (!aN || !bN) return 0;
  return Math.max(fuzzball.ratio(aN, bN), fuzzball.token_set_ratio(aN, bN)) / 100;
}

function findBest(missingTrack, ownedPool) {
  let best = null, bestScore = 0;
  for (const o of ownedPool) {
    const titleScore = score(missingTrack.title, o.title);
    const artistScore = score(missingTrack.artist, o.artist);
    const combined = titleScore * 0.6 + artistScore * 0.4;
    if (combined > bestScore) { bestScore = combined; best = o; }
  }
  return { best, score: bestScore };
}

const MATCH_THRESHOLD = 0.80;
const UNCERTAIN_THRESHOLD = 0.65;

const beatportRedownload = [];
const uncertain = [];
const stillMissing = [];

for (const m of missing) {
  const { best, score: s } = findBest(m, ownedBP);
  if (s >= MATCH_THRESHOLD) {
    beatportRedownload.push({ missing: m, owned: best, score: +s.toFixed(3) });
  } else if (s >= UNCERTAIN_THRESHOLD) {
    uncertain.push({ missing: m, owned: best, score: +s.toFixed(3) });
  } else {
    stillMissing.push(m);
  }
}

console.log(`Missing: ${missing.length}`);
console.log(`Beatport redownloadable (score >= ${MATCH_THRESHOLD}): ${beatportRedownload.length}`);
console.log(`Uncertain (${UNCERTAIN_THRESHOLD} <= score < ${MATCH_THRESHOLD}): ${uncertain.length}`);
console.log(`Still missing after Beatport check: ${stillMissing.length}`);

fs.writeFileSync('/tmp/redownload_beatport.json', JSON.stringify(beatportRedownload, null, 2));
fs.writeFileSync('/tmp/uncertain_beatport.json', JSON.stringify(uncertain, null, 2));
fs.writeFileSync('/tmp/still_missing_after_beatport.json', JSON.stringify(stillMissing, null, 2));

console.log('\nSample redownloadable (first 10):');
beatportRedownload.slice(0, 10).forEach(r => {
  console.log(`  [${r.score}] ${r.missing.artist} — ${r.missing.title}`);
  console.log(`          → ${r.owned.artist} — ${r.owned.title} (bp id ${r.owned.trackId})`);
});
console.log('\nSample uncertain (first 5):');
uncertain.slice(0, 5).forEach(r => {
  console.log(`  [${r.score}] missing: ${r.missing.artist} — ${r.missing.title}`);
  console.log(`          best:     ${r.owned.artist} — ${r.owned.title}`);
});
