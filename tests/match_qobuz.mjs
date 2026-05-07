import fs from 'fs';
const fuzzball = await import('fuzzball');

const stillMissing = JSON.parse(fs.readFileSync('/tmp/still_missing_after_beatport.json', 'utf8'));
const ownedQ = JSON.parse(fs.readFileSync('/tmp/owned_qobuz.json', 'utf8'));

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
function findBest(m, pool) {
  let best = null, bestScore = 0;
  for (const o of pool) {
    const combined = score(m.title, o.title) * 0.6 + score(m.artist, o.artist) * 0.4;
    if (combined > bestScore) { bestScore = combined; best = o; }
  }
  return { best, score: bestScore };
}

const MATCH = 0.80, UNCERTAIN = 0.65;
const redownload = [], uncertain = [], stillMiss = [];
for (const m of stillMissing) {
  const r = findBest(m, ownedQ);
  if (r.score >= MATCH) redownload.push({ missing: m, owned: r.best, score: +r.score.toFixed(3) });
  else if (r.score >= UNCERTAIN) uncertain.push({ missing: m, owned: r.best, score: +r.score.toFixed(3) });
  else stillMiss.push(m);
}

console.log(`Input (still missing after beatport): ${stillMissing.length}`);
console.log(`Qobuz re-downloadable (>=${MATCH}): ${redownload.length}`);
console.log(`Qobuz uncertain (${UNCERTAIN}..${MATCH}): ${uncertain.length}`);
console.log(`Still unresolved: ${stillMiss.length}`);

fs.writeFileSync('/tmp/redownload_qobuz.json', JSON.stringify(redownload, null, 2));
fs.writeFileSync('/tmp/uncertain_qobuz.json', JSON.stringify(uncertain, null, 2));
fs.writeFileSync('/tmp/still_missing_after_qobuz.json', JSON.stringify(stillMiss, null, 2));

console.log('\nMatched:');
redownload.forEach(r => {
  console.log(`  [${r.score}] ${r.missing.artist} — ${r.missing.title}`);
  console.log(`          → ${r.owned.artist} — ${r.owned.title}`);
});
