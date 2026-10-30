import { findMissingSpliceSamples } from '../lib/alsParser.mjs';

const alsPath = process.argv[2];
if (!alsPath) { console.error('usage: node debug-als-missing.mjs <als-path>'); process.exit(1); }

const res = findMissingSpliceSamples(alsPath);
console.log('totalRefs:', res.totalRefs);
console.log('spliceRefs (path-flagged):', res.spliceRefs);
console.log('missing total:', res.missing.length);
console.log('--- missing searchKeys ---');
res.missing.forEach(it => console.log(' -', it.searchKey));
