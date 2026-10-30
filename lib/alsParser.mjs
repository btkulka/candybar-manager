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

// A path is "Splice-flavored" if it lives under a Splice-managed folder.
// Real examples we've seen:
//   /Users/x/Splice/Sounds/packs/<provider>/<pack>/<sample>.wav      (mac)
//   /Volumes/External/Splice/Sounds/packs/...                        (mac)
//   C:\Users\x\Splice\Sounds\packs\<provider>\<pack>\<sample>.wav    (win)
//   C:\Users\x\Documents\Splice - alt-account\Samples\packs\...      (multi-account)
// The trailing `(\s|[\/\\]|$)` allows "Splice " followed by an account
// suffix ("Splice - thetexaswave/...") in addition to the canonical
// "Splice/..." form.
const SPLICE_PATH_RE = /[\/\\]Splice(\s|[\/\\]|$)/i;

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
 * Parse a .als file and return ALL missing samples — not just Splice-
 * pathed ones. Live frequently rewrites Splice samples to consolidated
 * project-local paths (`Samples/Imported/<file>.wav`,
 * `Samples/Processed/Consolidate/<file>.wav`), so a /Splice/-only filter
 * misses a large portion of recoverable samples. The classify step
 * downstream attempts a Splice search by basename for every missing item;
 * non-Splice files just fall through to `notFound`.
 *
 * @param {string} alsPath  Absolute path to the .als file.
 * @returns {{
 *   alsPath: string,
 *   totalRefs: number,
 *   spliceRefs: number,
 *   missing: Array<{ originalPath: string, basename: string, searchKey: string }>
 * }}
 *   `searchKey` is the basename minus extension — what we'll feed to
 *   Splice's `filepath`/`query` filter. `spliceRefs` is kept for
 *   informational stats (how many *paths* explicitly came from a Splice
 *   folder) but no longer gates which items get searched.
 */
export function findMissingSpliceSamples(alsPath) {
  const xml = decompressAls(alsPath);
  const allPaths = extractAllPaths(xml);
  const splicePaths = allPaths.filter((p) => SPLICE_PATH_RE.test(p));
  const missing = allPaths
    .filter((p) => !fs.existsSync(p))
    .map((p) => {
      const basename = path.basename(p);
      // Live's "Consolidate" feature appends a timestamp suffix in square
      // brackets: `Lev2_Kick_F#_06 [2024-08-23 203418].wav`. Strip that
      // before searching — the original Splice filename won't have it.
      const ext = path.extname(basename);
      const stem = ext ? basename.slice(0, -ext.length) : basename;
      const searchKey = stem.replace(/\s*\[\d{4}-\d{2}-\d{2}\s+\d+\]\s*$/, '').trim();
      return {
        originalPath: p,
        basename,
        searchKey,
      };
    });
  return {
    alsPath,
    totalRefs: allPaths.length,
    spliceRefs: splicePaths.length,
    missing,
  };
}
