// ============================================================
// "Do I already own this?" for the app's sourcing flows.
//
// The answer comes from the Rekordbox collection plus candybar.db's
// reflection of it — lib/sourcing/library.mjs (loadLibrary +
// bucketTracks), the same engine the MCP tool and the CLI use — not
// from walking the library folder. A track can be in Rekordbox while
// its drive is unplugged, and a file can sit on disk without ever
// having been imported; only the first means "don't buy it".
//
// main.ts loads the .mjs engine; this file holds the pure adapters
// between it and the CheckResult shape the IPC handlers return.
// ============================================================

import path from 'path';
import { normalizeBasic } from './stringUtils';
import type { CheckResult, TrackRecord, MatchedTrack, UncertainMatch, MissingTrack } from './musicLibraryCheck';

/** What read_library.py reports about the sources it read. */
export type OwnershipStats = {
  rekordbox: number;
  candybar: number;
  disk_only: number;
  errors: string[];
};

/** One row of bucketTracks() output (it spreads the input row back out). */
export type OwnershipRow = {
  sourceIndex: number;
  artist: string;
  title: string;
  libraryConfidence: number;
  libraryMatch: {
    artist: string;
    title: string;
    filePath: string;
    inRekordbox: boolean;
    lossless: boolean | null;
    container: string | null;
  } | null;
  libraryStatus: 'owned' | 'probable' | 'missing';
  reason?: string;
};

export type OwnershipBuckets = {
  owned: OwnershipRow[];
  probable: OwnershipRow[];
  missing: OwnershipRow[];
  skipped: unknown[];
};

/** An uncertain match carrying bucketTracks' reason ("file on disk, not in
 *  Rekordbox" vs "uncertain match"). */
export type OwnershipUncertainMatch = UncertainMatch & { reason?: string };

/** Rows handed to bucketTracks. No `key`: it computes its own (makeTrackKey),
 *  which its exact-match index is built on. Ignored tracks are filtered by the
 *  callers with the app's own keys, so the engine's ignore set is left empty. */
export function toOwnershipInput(tracks: TrackRecord[]): Array<{ sourceIndex: number; artist: string; title: string; album?: string; duration?: number }> {
  return tracks.map((t, sourceIndex) => ({
    sourceIndex,
    artist: t.artist,
    title: t.title,
    album: t.album,
    duration: t.duration,
  }));
}

/** Non-null when the collection couldn't be read: every track would then look
 *  missing (or disk-only), so the caller must refuse rather than offer purchases. */
export function rekordboxReadError(stats: OwnershipStats | undefined): string | null {
  if (!stats) return 'the library reader returned no stats';
  const rbError = (stats.errors || []).find(e => /^rekordbox:/i.test(e));
  if (rbError) return rbError.replace(/^rekordbox:\s*/i, '');
  if (!stats.rekordbox) return 'the Rekordbox collection is empty';
  return null;
}

function libraryTrackOf(row: OwnershipRow): TrackRecord {
  const m = row.libraryMatch!;
  return {
    key: normalizeBasic(`${m.artist} - ${m.title}`),
    artist: m.artist,
    title: m.title,
    filePath: m.filePath,
  };
}

/** Map bucketTracks() output back onto the CheckResult the IPC handlers have
 *  always returned. `libraryTracks` stays empty: the renderer never needs the
 *  whole collection, only the per-track answers. */
export function bucketsToCheckResult(tracks: TrackRecord[], buckets: OwnershipBuckets, libraryTotal: number): CheckResult {
  const src = (row: OwnershipRow): TrackRecord => tracks[row.sourceIndex];

  const matchedTracks: MatchedTrack[] = buckets.owned.map(row => {
    const lib = libraryTrackOf(row);
    return { ...src(row), filePath: lib.filePath, confidence: row.libraryConfidence, matchedLibraryTrack: lib };
  });

  const uncertainMatches: OwnershipUncertainMatch[] = buckets.probable
    .filter(row => row.libraryMatch)
    .map(row => ({ csvTrack: src(row), libraryTrack: libraryTrackOf(row), confidence: row.libraryConfidence, reason: row.reason }));

  const missingTracks: MissingTrack[] = [
    // A probable row without a match can't happen in bucketTracks, but if it
    // did it would be a track nobody owns, so it's missing rather than dropped.
    ...buckets.probable.filter(row => !row.libraryMatch),
    ...buckets.missing,
  ].map(row => ({
    ...src(row),
    bestMatch: row.libraryMatch ? { track: libraryTrackOf(row), confidence: row.libraryConfidence } : undefined,
  }));

  return {
    csvTotal: tracks.length,
    libraryTotal,
    matchedCount: matchedTracks.length,
    missingCount: missingTracks.length,
    uncertainCount: uncertainMatches.length,
    csvTracks: tracks,
    libraryTracks: [],
    matchedTracks,
    missingTracks,
    uncertainMatches,
    missing: missingTracks.map(t => `${t.artist} - ${t.title}`),
    total: tracks.length,
  };
}

function pickField(record: Record<string, string>, names: string[]): string {
  for (const [key, value] of Object.entries(record)) {
    if (names.includes(key.toLowerCase().trim())) return (value ?? '').trim();
  }
  return '';
}

/** CSV rows (from previewCsv) → TrackRecords, keyed the way the rest of the app
 *  keys them so the ignore list still applies. Same columns checkLibrary read. */
export function csvRecordsToTrackRecords(records: Array<Record<string, string>>): TrackRecord[] {
  const out: TrackRecord[] = [];
  for (const record of records) {
    const artist = pickField(record, ['artist', 'artists', 'performer']);
    const title = pickField(record, ['title', 'track', 'name', 'song']);
    if (!artist && !title) continue;
    out.push({
      key: artist && title ? normalizeBasic(`${artist} - ${title}`) : normalizeBasic(title || artist),
      artist: artist || 'Unknown Artist',
      title: title || 'Unknown Title',
      album: pickField(record, ['album']) || undefined,
      year: pickField(record, ['year', 'date']) || undefined,
      genre: pickField(record, ['genre']) || undefined,
    });
  }
  return out;
}

/** Comparable form of a collection path: Rekordbox and the filesystem disagree
 *  on case and on composed vs decomposed accents. */
export function collectionPathKey(p: string): string {
  return path.normalize(p).normalize('NFC').toLowerCase();
}
