import fs from 'fs/promises';
import path from 'path';
import { parseFile } from 'music-metadata';
import { parse } from 'csv-parse/sync';
import { normalizeForComparison, normalizeBasic, sameTitleVersion, titleVersionSignature } from './stringUtils';
import { walkAudioDir } from './fileUtils';
import { METADATA_CONCURRENCY } from './constants';
import { createScopedLogger } from './logger';
import { CSV_ARTIST_HEADERS, CSV_TITLE_HEADERS, CSV_ALBUM_HEADERS, CSV_YEAR_HEADERS, normalizeCsvHeader } from './csvHeaders';
import * as fuzzball from 'fuzzball';
import type { SpotifyTrack } from './spotify';

const log = createScopedLogger('LibraryCheck');

// Fuzzy matching confidence thresholds (0-1 scale). Exported for tests.
export const MATCH_THRESHOLD = 0.60; // Below this = no match
export const UNCERTAIN_THRESHOLD = 0.90; // Below this but above MATCH_THRESHOLD = uncertain, needs confirmation
// A remix/edit/extended/radio variant of a song you own is a DIFFERENT track a
// DJ still needs to buy, so it must never be auto-filed as "already in library".
// When two titles are the same song but different versions, cap confidence just
// below UNCERTAIN_THRESHOLD so it surfaces for review instead of being hidden.
const VERSION_MISMATCH_CAP = UNCERTAIN_THRESHOLD - 0.01; // 0.89
// Minimum title similarity for a match to count as the same song at all. Below
// this the titles are unrelated, so a strong artist match cannot pull it into
// the "maybe owned" bucket — it's a different track the DJ still needs. Chosen
// below the ~0.45 similarity a remix/edit variant scores so those still route
// through the version cap (uncertain) rather than being demoted to brand-new.
export const TITLE_MATCH_FLOOR = 0.40;

/**
 * Build a normalized key for matching, stripping remix tags, feat info, etc.
 */
export function buildNormalizedKey(artist: string, title: string): string {
  const a = normalizeForComparison(artist);
  const t = normalizeForComparison(title);
  if (a && t) return `${a} - ${t}`;
  return a || t;
}

/**
 * Calculate field similarity using fuzzball's best algorithms.
 * Returns 0-1 score using the best of ratio and token_sort_ratio.
 * Note: both partial_ratio AND token_set_ratio are intentionally excluded — they
 * score a perfect 100 whenever one string's tokens are a subset of the other's,
 * which collapses genuinely different tracks (e.g. "Home" vs "Home (Nobody Is
 * Not Loved)", or "Adam Beyer" vs "Adam Beyer, Layton Giordani") onto each other.
 * token_sort_ratio still absorbs word-reordering ("Beyer, Adam" ≈ "Adam Beyer")
 * but penalizes extra tokens, so subset relationships no longer read as identical.
 */
function fieldSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const ratio = fuzzball.ratio(a, b);
  const tokenSort = fuzzball.token_sort_ratio(a, b);
  return Math.max(ratio, tokenSort) / 100;
}

/** Per-track strings the scorer needs, computed once per track instead of once
 *  per (source, library) pair — the normalization regexes were the hot path. */
type PreparedTrack = {
  track: TrackRecord;
  artistLower: string;
  titleLower: string;
  artistNorm: string;
  titleNorm: string;
  versionSig: string;
};

function prepareTrack(track: TrackRecord): PreparedTrack {
  return {
    track,
    artistLower: track.artist.toLowerCase(),
    titleLower: track.title.toLowerCase(),
    artistNorm: normalizeForComparison(track.artist),
    titleNorm: normalizeForComparison(track.title),
    versionSig: titleVersionSignature(track.title),
  };
}

function scorePrepared(csv: PreparedTrack, lib: PreparedTrack): number {
  // Exact key match = 100%. The key (normalizeBasic) preserves version tags, so
  // this only fires for a true same-version match.
  if (csv.track.key === lib.track.key) return 1;

  // --- Pass 1: Raw comparison ---
  const artistSim = fieldSimilarity(csv.artistLower, lib.artistLower);
  const titleSim = fieldSimilarity(csv.titleLower, lib.titleLower);

  const rawScore = artistSim * 0.6 + titleSim * 0.4;

  // --- Pass 2: Normalized comparison (strips remix tags, feat, etc.) ---
  const normArtistSim = fieldSimilarity(csv.artistNorm, lib.artistNorm);
  const normTitleSim = fieldSimilarity(csv.titleNorm, lib.titleNorm);

  const normScore = normArtistSim * 0.6 + normTitleSim * 0.4;

  // Use the better of the two passes
  const weightedScore = Math.max(rawScore, normScore);

  // Bonus for exact matches on either field (check both raw and normalized)
  let bonus = 0;
  if (csv.artistNorm === lib.artistNorm && csv.artistNorm.length > 0) bonus += 0.1;
  if (csv.titleNorm === lib.titleNorm && csv.titleNorm.length > 0) bonus += 0.15;

  let confidence = Math.min(1, weightedScore + bonus);

  // Title floor: if the titles are essentially unrelated, it's a different song
  // no matter how well the artist matches — otherwise a same-artist track ending
  // in "(Original Mix)" soaks up unrelated songs by that artist into the
  // "maybe owned" bucket on the 0.6-weighted artist score alone. Uses the better
  // of raw/normalized title similarity, so version variants (which share the base
  // title, hence a high normalized title score) stay above the floor and fall to
  // the version cap below instead of being force-classified as brand new.
  const bestTitleSim = Math.max(titleSim, normTitleSim);
  if (bestTitleSim < TITLE_MATCH_FLOOR) {
    confidence = Math.min(confidence, MATCH_THRESHOLD - 0.01);
  }

  // Same song, different version → cap below the "already in library" bar. The
  // fuzzy score above matches on version-STRIPPED fields (so an owned remix and
  // this remix still read as the same song), but a version mismatch means it's a
  // distinct track to source, not a duplicate to hide.
  if (csv.versionSig !== lib.versionSig) {
    confidence = Math.min(confidence, VERSION_MISMATCH_CAP);
  }
  return confidence;
}

/**
 * Calculate overall match confidence between a CSV track and a library track
 * Returns a confidence score from 0 to 1.
 * Exported for unit testing of the version-aware bucketing.
 */
export function calculateMatchConfidence(csvTrack: TrackRecord, libraryTrack: TrackRecord): number {
  return scorePrepared(prepareTrack(csvTrack), prepareTrack(libraryTrack));
}

/**
 * Find the best matching library track for a CSV track
 */
type MatchCandidate = { track: TrackRecord; confidence: number };

function findTopMatches(
  csvTrack: TrackRecord,
  preparedLibrary: PreparedTrack[],
  libraryMap: Map<string, TrackRecord>,
  normalizedLibraryMap: Map<string, TrackRecord>,
  count = 5
): MatchCandidate[] {
  // First try exact match on raw key
  const exactMatch = libraryMap.get(csvTrack.key);
  if (exactMatch) {
    return [{ track: exactMatch, confidence: 1 }];
  }

  // Try exact match on normalized key (strips remix tags, feat, etc.). Because
  // the normalized key is version-agnostic, only accept it as a near-certain
  // match when the versions also agree — otherwise a remix/edit collapses onto
  // the base track. On a version mismatch, fall through to the fuzzy pass, which
  // caps same-song/different-version pairs into the "uncertain" bucket.
  const csvNormKey = buildNormalizedKey(csvTrack.artist, csvTrack.title);
  const normMatch = normalizedLibraryMap.get(csvNormKey);
  if (normMatch && sameTitleVersion(csvTrack.title, normMatch.title)) {
    return [{ track: normMatch, confidence: 0.98 }];
  }

  // Fuzzy search — keep top N candidates
  const prepared = prepareTrack(csvTrack);
  const candidates: MatchCandidate[] = [];

  for (const lib of preparedLibrary) {
    const confidence = scorePrepared(prepared, lib);
    if (candidates.length < count) {
      candidates.push({ track: lib.track, confidence });
      if (candidates.length === count) {
        candidates.sort((a, b) => b.confidence - a.confidence);
      }
    } else if (confidence > candidates[count - 1].confidence) {
      candidates[count - 1] = { track: lib.track, confidence };
      candidates.sort((a, b) => b.confidence - a.confidence);
    }
  }

  if (candidates.length < count) {
    candidates.sort((a, b) => b.confidence - a.confidence);
  }

  return candidates;
}

// CSV Preview types
export type CsvPreview = {
  columns: string[];
  rows: Record<string, string>[];
  totalRows: number;
  hasArtistColumn: boolean;
  hasTitleColumn: boolean;
};

type ProgressFn = (progress: ProgressUpdate) => void;

export type ProgressUpdate = {
  phase: 'csv' | 'playlist' | 'discovering' | 'scanning' | 'matching' | 'complete';
  current: number;
  total: number;
  message: string;
};

type CheckParams = {
  libraryRoot: string;
  csvPath: string;
  onProgress?: ProgressFn;
  preScannedFiles?: string[];
  signal?: AbortSignal;
};

type CheckFromTracksParams = {
  libraryRoot: string;
  tracks: TrackRecord[];
  onProgress?: ProgressFn;
  preScannedFiles?: string[];
  signal?: AbortSignal;
};

// Individual track record with full metadata
export type TrackRecord = {
  key: string; // Normalized "artist - title" key for matching
  artist: string;
  title: string;
  filePath?: string; // Only set for library tracks
  album?: string;
  year?: string;
  genre?: string;
  duration?: number; // In seconds
  format?: string; // e.g., "MP3", "FLAC"
  bitRate?: number; // In kbps
  ignored?: boolean; // Set by main process after matching
};

// A match result with confidence score
export type MatchedTrack = TrackRecord & {
  confidence: number;
  matchedLibraryTrack?: TrackRecord;
  topMatches?: MatchCandidate[];
};

// An uncertain match that needs user confirmation
export type UncertainMatch = {
  csvTrack: TrackRecord;
  libraryTrack: TrackRecord;
  confidence: number;
  topMatches?: MatchCandidate[];
};

// A missing track with its closest library match
export type MissingTrack = TrackRecord & {
  bestMatch?: {
    track: TrackRecord;
    confidence: number;
  };
  topMatches?: MatchCandidate[];
};

// Comprehensive check result
export type CheckResult = {
  // Summary stats
  csvTotal: number;
  libraryTotal: number;
  matchedCount: number;
  missingCount: number;
  uncertainCount: number;

  // Full track lists
  csvTracks: TrackRecord[]; // All tracks from CSV
  libraryTracks: TrackRecord[]; // All tracks found in library
  matchedTracks: MatchedTrack[]; // Tracks that exist in both (with library file info)
  missingTracks: MissingTrack[]; // Tracks in CSV but not in library (with best match info)
  uncertainMatches: UncertainMatch[]; // Matches between 60-90% confidence needing confirmation

  // For backwards compatibility
  missing: string[];
  total: number;
};

/** The first non-empty value under any of `names` (see csvHeaders.ts, shared
 *  with the CLI's spellings), tried in priority order. */
function pickField(record: Record<string, string>, names: string[]) {
  const keys = Object.keys(record);
  for (const name of names) {
    const hit = keys.find(k => normalizeCsvHeader(k) === name);
    const value = hit ? record[hit]?.trim() : '';
    if (value) return value;
  }
  return '';
}


function recordToTrack(record: Record<string, string>): TrackRecord | null {
  const artist = pickField(record, CSV_ARTIST_HEADERS);
  const title = pickField(record, CSV_TITLE_HEADERS);

  if (!title && !artist) return null;

  const key = artist && title
    ? normalizeBasic(`${artist} - ${title}`)
    : normalizeBasic(title || artist);

  return {
    key,
    artist: artist || 'Unknown Artist',
    title: title || 'Unknown Title',
    album: pickField(record, CSV_ALBUM_HEADERS),
    year: pickField(record, CSV_YEAR_HEADERS),
    genre: pickField(record, ['genre'])
  };
}

async function processFileMetadata(filePath: string): Promise<TrackRecord | null> {
  try {
    // duration:false still gets the length from the header (Xing/VBRI or a CBR
    // estimate); `true` scans every frame of every MP3 in the library.
    const metadata = await parseFile(filePath, { duration: false, skipCovers: true });
    const artist = metadata.common.artist || metadata.common.artists?.[0] || '';
    const title = metadata.common.title || '';

    let key: string;
    if (artist && title) {
      key = normalizeBasic(`${artist} - ${title}`);
    } else if (title) {
      key = normalizeBasic(title);
    } else {
      const fallback = path.basename(filePath, path.extname(filePath));
      key = normalizeBasic(fallback);
    }

    const ext = path.extname(filePath).slice(1).toUpperCase();
    return {
      key,
      artist: artist || 'Unknown Artist',
      title: title || path.basename(filePath, path.extname(filePath)),
      filePath,
      album: metadata.common.album,
      year: metadata.common.year?.toString(),
      genre: metadata.common.genre?.[0],
      duration: metadata.format.duration,
      format: ext,
      bitRate: metadata.format.bitrate ? Math.round(metadata.format.bitrate / 1000) : undefined
    };
  } catch (err) {
    log.warn(`Metadata read failed for ${path.basename(filePath)}:`, err);
    return null;
  }
}

// Process files in parallel with concurrency limit
async function processFilesParallel(
  files: string[],
  onProgress: (processed: number, total: number) => void,
  signal?: AbortSignal
): Promise<TrackRecord[]> {
  const results: TrackRecord[] = [];
  let processed = 0;
  const total = files.length;

  // Process in batches
  for (let i = 0; i < files.length; i += METADATA_CONCURRENCY) {
    if (signal?.aborted) throw new Error('Cancelled');
    const batch = files.slice(i, i + METADATA_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(processFileMetadata));

    for (const result of batchResults) {
      if (result) {
        results.push(result);
      }
      processed++;
    }

    onProgress(processed, total);
  }

  return results;
}

/**
 * Core matching engine: takes a source track list and matches against library files.
 * Shared by both CSV-based and Spotify-based checks.
 */
async function matchTracksAgainstLibrary(
  sourceTracks: TrackRecord[],
  libraryRoot: string,
  progress: ProgressFn,
  preScannedFiles?: string[],
  signal?: AbortSignal
): Promise<CheckResult> {
  // Phase 2: Discover files (or use pre-scanned list from job queue). An empty
  // pre-scanned list isn't trusted: it would mark every source track missing.
  let files: string[];
  if (preScannedFiles && preScannedFiles.length > 0) {
    files = preScannedFiles;
    progress({ phase: 'discovering', current: files.length, total: files.length, message: `Using ${files.length} pre-scanned files` });
  } else {
    progress({ phase: 'discovering', current: 0, total: 0, message: 'Discovering audio files...' });
    files = await walkAudioDir(libraryRoot, {
      skipHidden: true,
      signal,
      onProgress: (count) => {
        progress({ phase: 'discovering', current: count, total: 0, message: `Found ${count} audio files...` });
      }
    });
    progress({ phase: 'discovering', current: files.length, total: files.length, message: `Found ${files.length} audio files` });
  }

  // Phase 3: Scan files in parallel
  progress({ phase: 'scanning', current: 0, total: files.length, message: 'Scanning metadata...' });

  const libraryTracks = await processFilesParallel(files, (processed, total) => {
    const percent = Math.round((processed / total) * 100);
    progress({
      phase: 'scanning',
      current: processed,
      total,
      message: `Scanning: ${percent}% (${processed}/${total})`
    });
  }, signal);

  // Build lookup maps (and the per-track normalized strings for fuzzy scoring)
  const preparedLibrary = libraryTracks.map(prepareTrack);
  const libraryMap = new Map<string, TrackRecord>();
  const normalizedLibraryMap = new Map<string, TrackRecord>();
  for (const track of libraryTracks) {
    libraryMap.set(track.key, track);
    const normKey = buildNormalizedKey(track.artist, track.title);
    if (!normalizedLibraryMap.has(normKey)) {
      normalizedLibraryMap.set(normKey, track);
    }
  }

  // Phase 4: Match tracks with fuzzy matching
  progress({ phase: 'matching', current: 0, total: sourceTracks.length, message: 'Matching tracks: 0 matched, 0 uncertain, 0 missing' });

  const matchedTracks: MatchedTrack[] = [];
  const missingTracks: MissingTrack[] = [];
  const uncertainMatches: UncertainMatch[] = [];

  for (let i = 0; i < sourceTracks.length; i++) {
    if (signal?.aborted) throw new Error('Cancelled');
    const sourceTrack = sourceTracks[i];

    // Use fuzzy matching to find top candidates
    const candidates = findTopMatches(sourceTrack, preparedLibrary, libraryMap, normalizedLibraryMap);
    const bestMatch = candidates[0]?.track ?? null;
    const confidence = candidates[0]?.confidence ?? 0;

    if (bestMatch && confidence >= UNCERTAIN_THRESHOLD) {
      matchedTracks.push({
        ...sourceTrack,
        filePath: bestMatch.filePath,
        duration: bestMatch.duration,
        format: bestMatch.format,
        bitRate: bestMatch.bitRate,
        confidence,
        matchedLibraryTrack: bestMatch,
        topMatches: candidates
      });
    } else if (bestMatch && confidence >= MATCH_THRESHOLD) {
      uncertainMatches.push({
        csvTrack: sourceTrack,
        libraryTrack: bestMatch,
        confidence,
        topMatches: candidates
      });
    } else {
      missingTracks.push({
        ...sourceTrack,
        bestMatch: bestMatch ? { track: bestMatch, confidence } : undefined,
        topMatches: candidates
      });
    }

    if ((i + 1) % 10 === 0 || i === sourceTracks.length - 1) {
      progress({
        phase: 'matching',
        current: i + 1,
        total: sourceTracks.length,
        message: `Matching: ${matchedTracks.length} matched, ${uncertainMatches.length} uncertain, ${missingTracks.length} missing`
      });
    }
  }

  // Phase 5: Complete
  progress({
    phase: 'complete',
    current: sourceTracks.length,
    total: sourceTracks.length,
    message: `Complete: ${matchedTracks.length} matched, ${uncertainMatches.length} need review, ${missingTracks.length} missing`
  });

  return {
    csvTotal: sourceTracks.length,
    libraryTotal: libraryTracks.length,
    matchedCount: matchedTracks.length,
    missingCount: missingTracks.length,
    uncertainCount: uncertainMatches.length,
    csvTracks: sourceTracks,
    libraryTracks,
    matchedTracks,
    missingTracks,
    uncertainMatches,
    missing: missingTracks.map((t) => `${t.artist} - ${t.title}`),
    total: sourceTracks.length
  };
}

export async function checkLibrary({ libraryRoot, csvPath, onProgress, preScannedFiles, signal }: CheckParams): Promise<CheckResult> {
  const progress = onProgress || (() => {});

  const libraryStat = await fs.stat(libraryRoot);
  if (!libraryStat.isDirectory()) {
    throw new Error('Library root must be a directory.');
  }

  // Phase 1: Parse CSV
  progress({ phase: 'csv', current: 0, total: 1, message: 'Reading CSV file...' });

  const csvContent = await fs.readFile(csvPath, 'utf8');
  let records: Record<string, string>[] = [];

  try {
    records = parse(csvContent, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
  } catch (err) {
    log.warn('CSV column parse failed, falling back to flat format:', err);
    try {
      const rows = parse(csvContent, { columns: false, skip_empty_lines: true, trim: true, relax_column_count: true });
      records = rows.map((row: string[]) => ({ track: row[0] ?? '' }));
    } catch (fallbackErr) {
      const lineMatch = String(fallbackErr).match(/line (\d+)/i);
      if (lineMatch) {
        const lineNum = parseInt(lineMatch[1], 10);
        const lines = csvContent.split('\n');
        const offendingLine = lines[lineNum - 1]?.trim() ?? '(could not read line)';
        throw new Error(`CSV parse error on line ${lineNum}: "${offendingLine}"`);
      }
      throw fallbackErr;
    }
  }

  const csvTracks: TrackRecord[] = [];
  for (const record of records) {
    const track = recordToTrack(record);
    if (track) {
      csvTracks.push(track);
    }
  }

  if (csvTracks.length === 0) {
    throw new Error('No track data found in CSV.');
  }

  progress({ phase: 'csv', current: 1, total: 1, message: `Found ${csvTracks.length} tracks in CSV` });

  return matchTracksAgainstLibrary(csvTracks, libraryRoot, progress, preScannedFiles, signal);
}

/**
 * Check library using a pre-built track list (e.g. from Spotify playlist).
 * Skips CSV parsing and goes straight to matching.
 */
export async function checkLibraryFromTracks({ libraryRoot, tracks, onProgress, preScannedFiles, signal }: CheckFromTracksParams): Promise<CheckResult> {
  const progress = onProgress || (() => {});

  const libraryStat = await fs.stat(libraryRoot);
  if (!libraryStat.isDirectory()) {
    throw new Error('Library root must be a directory.');
  }

  if (tracks.length === 0) {
    throw new Error('No tracks provided.');
  }

  return matchTracksAgainstLibrary(tracks, libraryRoot, progress, preScannedFiles, signal);
}

/**
 * Convert Spotify tracks to TrackRecord format for matching.
 */
export function spotifyTracksToTrackRecords(tracks: SpotifyTrack[]): TrackRecord[] {
  return tracks.map(t => {
    const artist = t.artists.join(', ');
    const title = t.name;
    const key = artist && title
      ? normalizeBasic(`${artist} - ${title}`)
      : normalizeBasic(title || artist);

    return {
      key,
      artist: artist || 'Unknown Artist',
      title: title || 'Unknown Title',
      album: t.album,
      year: t.release_year ?? undefined,
      duration: Math.round(t.duration_ms / 1000)
    };
  });
}

/**
 * Preview CSV file - returns first 10 rows with column info
 */
export async function previewCsv(csvPath: string, maxRows = 10): Promise<CsvPreview> {
  const csvContent = await fs.readFile(csvPath, 'utf8');
  let records: Record<string, string>[] = [];
  let columns: string[] = [];

  try {
    records = parse(csvContent, { columns: true, skip_empty_lines: true, trim: true });
    if (records.length > 0) {
      columns = Object.keys(records[0]);
    }
  } catch {
    // Fallback: try parsing without headers
    const rows = parse(csvContent, { columns: false, skip_empty_lines: true, trim: true }) as string[][];
    if (rows.length > 0) {
      // Use first row as headers if it looks like headers
      const firstRow = rows[0];
      const looksLikeHeaders = firstRow.some(cell =>
        /^(artist|title|track|album|name|song|performer)/i.test(cell)
      );

      if (looksLikeHeaders) {
        columns = firstRow;
        records = rows.slice(1).map(row => {
          const obj: Record<string, string> = {};
          columns.forEach((col, i) => {
            obj[col] = row[i] ?? '';
          });
          return obj;
        });
      } else {
        // No headers - create generic column names
        columns = firstRow.map((_, i) => `Column ${i + 1}`);
        records = rows.map(row => {
          const obj: Record<string, string> = {};
          columns.forEach((col, i) => {
            obj[col] = row[i] ?? '';
          });
          return obj;
        });
      }
    }
  }

  const totalRows = records.length;
  const previewRows = records.slice(0, maxRows);

  // Check for required columns
  const normalizedColumns = columns.map(normalizeCsvHeader);
  const hasArtistColumn = normalizedColumns.some(c => CSV_ARTIST_HEADERS.includes(c));
  const hasTitleColumn = normalizedColumns.some(c => CSV_TITLE_HEADERS.includes(c));

  return {
    columns,
    rows: previewRows,
    totalRows,
    hasArtistColumn,
    hasTitleColumn
  };
}
