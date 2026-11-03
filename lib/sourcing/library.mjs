// Phase 1 — do I already own this?
//
// The authority is the Rekordbox collection plus candybar.db's reflection of
// it (read by read_library.py), NOT a filesystem walk. A track can be in
// Rekordbox while its volume is unmounted, and a file can sit on disk without
// ever having been imported — those are different answers, and only the first
// means "don't buy it".

import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { PYTHON } from './config.mjs';
import {
  buildLibraryIndex, findLibraryMatches, makeTrackKey,
  MATCH_THRESHOLD, UNCERTAIN_THRESHOLD,
} from './matching.mjs';

const execFileAsync = promisify(execFile);
const READER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'read_library.py');

/**
 * Load the library index. Returns { index, ignored, stats }.
 *
 * `stats.errors` names any source that couldn't be read; a caller that relies
 * on Rekordbox must refuse rather than treat an unread collection as empty.
 * Options (all optional, for the app): `python`, the interpreter with
 * pyrekordbox; `candybarDbPath`, the app's candybar.db when it isn't at the
 * default user-data location; `timeoutMs`, default 3 minutes.
 */
export async function loadLibrary({ python = PYTHON, candybarDbPath = null, timeoutMs = 180000 } = {}) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(python, [READER], {
      maxBuffer: 256 * 1024 * 1024,
      timeout: timeoutMs,
      env: candybarDbPath ? { ...process.env, CANDYBAR_DB: candybarDbPath } : process.env,
    }));
  } catch (err) {
    const why = err.killed ? `timed out after ${Math.round(timeoutMs / 1000)} s` : (err.stderr || err.message || String(err)).trim().split('\n').pop();
    throw new Error(`The library reader failed: ${why}`);
  }
  let data;
  try { data = JSON.parse(stdout); } catch {
    throw new Error(`The library reader returned something unreadable: ${stdout.slice(0, 200)}`);
  }
  for (const t of data.tracks) t.key = makeTrackKey(t.artist, t.title);
  return {
    index: buildLibraryIndex(data.tracks),
    ignored: new Set(data.ignored || []),
    stats: data.stats,
  };
}

/**
 * Bucket wanted tracks against the library.
 *
 * Returns { owned, probable, missing, skipped } — the four always sum to the
 * input length, so nothing can silently disappear.
 *
 *   owned    — confidence >= 0.90 AND the match is in Rekordbox. Not searched.
 *   probable — 0.60..0.89, or a >=0.90 hit that is only a file on disk.
 *              Searched anyway; surfaced for you to confirm.
 *   missing  — below 0.60. Searched.
 *
 * The "high confidence but not in Rekordbox" case lands in `probable` on
 * purpose: you own the file, but it isn't in your collection, and that's a
 * decision (import it) rather than a purchase.
 */
export function bucketTracks(wanted, { index, ignored }, onProgress) {
  const owned = [], probable = [], missing = [], skipped = [];

  wanted.forEach((want, i) => {
    want.key = want.key || makeTrackKey(want.artist, want.title);
    // Explicitly ignored tracks leave the pipeline, but they're reported so the
    // buckets always account for every row of the input.
    if (ignored.has(want.key)) { skipped.push(want); return; }

    const candidates = findLibraryMatches(want, index);
    const best = candidates[0];
    const confidence = best?.confidence ?? 0;
    const row = {
      ...want,
      libraryConfidence: confidence,
      libraryMatch: best?.track
        ? {
            artist: best.track.artist,
            title: best.track.title,
            filePath: best.track.file_path,
            inRekordbox: !!best.track.in_rekordbox,
            lossless: best.track.lossless ?? null,
            container: best.track.container ?? null,
          }
        : null,
    };

    if (confidence >= UNCERTAIN_THRESHOLD && best.track.in_rekordbox) {
      owned.push({ ...row, libraryStatus: 'owned' });
    } else if (confidence >= UNCERTAIN_THRESHOLD) {
      probable.push({ ...row, libraryStatus: 'probable', reason: 'file on disk, not in Rekordbox' });
    } else if (confidence >= MATCH_THRESHOLD) {
      probable.push({ ...row, libraryStatus: 'probable', reason: 'uncertain match' });
    } else {
      missing.push({ ...row, libraryStatus: 'missing' });
    }

    if (onProgress && ((i + 1) % 10 === 0 || i === wanted.length - 1)) {
      onProgress(i + 1, wanted.length, { owned: owned.length, probable: probable.length, missing: missing.length });
    }
  });

  return { owned, probable, missing, skipped };
}
