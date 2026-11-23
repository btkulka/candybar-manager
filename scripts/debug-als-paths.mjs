import fs from 'fs';
import { readAbletonXmlSync, listFileRefs, isSplicePath } from '@btkulka/ableton-als';

const ALS = process.argv[2];
if (!ALS) { console.error('usage: node debug-als-paths.mjs <als-path>'); process.exit(1); }

const all = [...new Set(listFileRefs(readAbletonXmlSync(ALS)).map(r => r.path).filter(Boolean))];
console.log('total unique paths:', all.length);

const splice = all.filter(p => isSplicePath(p));
console.log('splice-flavored:', splice.length);
console.log('--- first 10 splice paths ---');
splice.slice(0, 10).forEach(p => console.log('  ', p));
console.log('--- first 10 non-splice paths (sanity) ---');
all.filter(p => !isSplicePath(p)).slice(0, 10).forEach(p => console.log('  ', p));

const missing = splice.filter(p => !fs.existsSync(p));
console.log(`--- missing on disk: ${missing.length} of ${splice.length} ---`);
missing.slice(0, 10).forEach(p => console.log('  ', p));
