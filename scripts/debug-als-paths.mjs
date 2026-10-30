import fs from 'fs';
import zlib from 'zlib';

const ALS = process.argv[2];
if (!ALS) { console.error('usage: node debug-als-paths.mjs <als-path>'); process.exit(1); }

const buf = fs.readFileSync(ALS);
const xml = zlib.gunzipSync(buf).toString('utf8');
const PATH_RE = /<Path\s+Value\s*=\s*(["'])([^"']*)\1\s*\/?>/g;
const seen = new Set();
for (const m of xml.matchAll(PATH_RE)) if (m[2]) seen.add(m[2]);
const all = [...seen];
console.log('total unique paths:', all.length);

const SPLICE_RE = /[\/\\]Splice([\/\\]|$)/i;
const splice = all.filter(p => SPLICE_RE.test(p));
console.log('splice-flavored:', splice.length);
console.log('--- first 10 splice paths ---');
splice.slice(0, 10).forEach(p => console.log('  ', p));
console.log('--- first 10 non-splice paths (sanity) ---');
all.filter(p => !SPLICE_RE.test(p)).slice(0, 10).forEach(p => console.log('  ', p));

const missing = splice.filter(p => !fs.existsSync(p));
console.log(`--- missing on disk: ${missing.length} of ${splice.length} ---`);
missing.slice(0, 10).forEach(p => console.log('  ', p));
