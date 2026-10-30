import { getAuthToken, getSampleAssetFiles } from '../lib/spliceClient.mjs';

// Try with the catalog_uuid from KSHMR_Stadium_Kick_04_Ouch
const catalogUuid = '6bf171bf-9bbc-4e3a-aee8-62329f79216a';
console.log(`fetching files for catalog_uuid: ${catalogUuid}`);
try {
  const files = await getSampleAssetFiles(catalogUuid, { verbose: true });
  console.log(JSON.stringify(files, null, 2));
} catch (err) {
  console.error('ERROR:', err.message);
}
