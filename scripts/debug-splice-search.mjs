// Run one searchSamples call against Splice and dump the raw response so we
// can see what `uuid` / `catalog_uuid` actually resolve to.
//
// Usage: node scripts/debug-splice-search.mjs <basename-without-extension>

import { searchSamples } from '../lib/spliceClient.mjs';

const key = process.argv[2] || 'KSHMR_Stadium_Kick_04_Ouch';
console.log(`searching: filepath=${key}, licensed=true`);

const res = await searchSamples({ filepath: key, licensed: true, limit: 5, verbose: true });
console.log('\n=== response ===');
console.log(JSON.stringify(res, null, 2));
