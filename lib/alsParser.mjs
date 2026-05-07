// Ableton Live Set (.als) parser — just enough to find Splice sample
// references and report which ones are missing on disk.
//
// .als files are gzipped XML. We don't need a real XML parser: every
// sample reference is a `<SampleRef><FileRef>` block with a `<Path
// Value="..."/>` child holding the absolute path Live last knew about.
// Regex-extracting those is reliable enough and avoids pulling in a
// schema-aware parser.

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

// Matches <Path Value="..." /> — the absolute path field inside a FileRef.
// Ableton single-quotes the value sometimes; handle both.
const PATH_RE = /<Path\s+Value\s*=\s*(["'])([^"']*)\1\s*\/?>/g;

// A path is "Splice-flavored" if it lives under a Splice folder. Real
// examples we've seen:
//   /Users/x/Splice/Sounds/packs/<provider>/<pack>/<sample>.wav
//   /Volumes/External/Splice/Sounds/packs/...
// We're permissive — any segment named "Splice" with "Sounds" downstream.
const SPLICE_PATH_RE = /\/Splice(\/|$)/i;

function decompressAls(absPath) {
  const gz = fs.readFileSync(absPath);
  return zlib.gunzipSync(gz).toString('utf8');
}

/**
 * Extract every `<Path Value="..."/>` from the decompressed XML, dedupe,
 * and return them. Many .als files reference the same sample several
 * times (one per clip); we only care about the unique set.
 */
function extractAllPaths(xml) {
  const seen = new Set();
  for (const m of xml.matchAll(PATH_RE)) {
    if (m[2]) seen.add(m[2]);
  }
  return [...seen];
}

/**
 * Parse a .als file and return missing Splice samples.
 *
 * @param {string} alsPath  Absolute path to the .als file.
 * @returns {{
 *   alsPath: string,
 *   totalRefs: number,
 *   spliceRefs: number,
 *   missing: Array<{ originalPath: string, basename: string, searchKey: string }>
 * }}
 *   `searchKey` is the basename minus extension — what we'll feed to
 *   Splice's `filepath` filter.
 */
export function findMissingSpliceSamples(alsPath) {
  const xml = decompressAls(alsPath);
  const allPaths = extractAllPaths(xml);
  const splicePaths = allPaths.filter((p) => SPLICE_PATH_RE.test(p));
  const missing = splicePaths
    .filter((p) => !fs.existsSync(p))
    .map((p) => {
      const basename = path.basename(p);
      const ext = path.extname(basename);
      return {
        originalPath: p,
        basename,
        searchKey: ext ? basename.slice(0, -ext.length) : basename,
      };
    });
  return {
    alsPath,
    totalRefs: allPaths.length,
    spliceRefs: splicePaths.length,
    missing,
  };
}
