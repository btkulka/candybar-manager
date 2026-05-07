import fs from 'fs/promises';
import path from 'path';
import { parseFile } from 'music-metadata';
import { parse } from 'csv-parse/sync';
import { normalizeForComparison, normalizeBasic } from './stringUtils';
import { walkAudioDir } from './fileUtils';
import { METADATA_CONCURRENCY } from './constants';
import { createScopedLogger } from './logger';
import fuzzball from 'fuzzball';
import type { SpotifyTrack } from './spotify';

const log = createScopedLogger('LibraryCheck');

// Fuzzy matching confidence thresholds (0-1 scale)
const MATCH_THRESHOLD = 0.60; // Below this = no match
const UNCERTAIN_THRESHOLD = 0.90; // Below this but above MATCH_THRESHOLD = uncertain, needs confirmation

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
 * Returns 0-1 score using the best of ratio and token_set_ratio.
 * Note: partial_ratio is intentionally excluded - it matches substrings
 * and produces too many false positives (e.g. "Love" matching "Falling In Love").
 */
function fieldSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const ratio = fuzzball.ratio(a, b);
  const tokenSet = fuzzball.token_set_ratio(a, b);
  return Math.max(ratio, tokenSet) / 100;
}

/**
 * Calculate overall match confidence between a CSV track and a library track
 * Returns a confidence score from 0 to 1
 */
function calculateMatchConfidence(csvTrack: TrackRecord, libraryTrack: TrackRecord): number {
  // Exact key match = 100%
  if (csvTrack.key === libraryTrack.key) return 1;

  // --- Pass 1: Raw comparison ---
  const artistSim = fieldSimilarity(
    csvTrack.artist.toLowerCase(),
    libraryTrack.artist.toLowerCase()
  );
  const titleSim = fieldSimilarity(
    csvTrack.title.toLowerCase(),
    libraryTrack.title.toLowerCase()
  );

  const rawScore = artistSim * 0.6 + titleSim * 0.4;

  // --- Pass 2: Normalized comparison (strips remix tags, feat, etc.) ---
  const csvArtistNorm = normalizeForComparison(csvTrack.artist);
  const libArtistNorm = normalizeForComparison(libraryTrack.artist);
  const csvTitleNorm = normalizeForComparison(csvTrack.title);
  const libTitleNorm = normalizeForComparison(libraryTrack.title);

  const normArtistSim = fieldSimilarity(csvArtistNorm, libArtistNorm);
  const normTitleSim = fieldSimilarity(csvTitleNorm, libTitleNorm);

  const normScore = normArtistSim * 0.6 + normTitleSim * 0.4;

  // Use the better of the two passes
  const weightedScore = Math.max(rawScore, normScore);

  // Bonus for exact matches on either field (check both raw and normalized)
  let bonus = 0;
  if (csvArtistNorm === libArtistNorm && csvArtistNorm.length > 0) bonus += 0.1;
  if (csvTitleNorm === libTitleNorm && csvTitleNorm.length > 0) bonus += 0.15;

  return Math.min(1, weightedScore + bonus);
}

/**
 * Find the best matching library track for a CSV track
 */
type MatchCandidate = { track: TrackRecord; confidence: number };

function findTopMatches(
  csvTrack: TrackRecord,
  libraryTracks: TrackRecord[],
  libraryMap: Map<string, TrackRecord>,
  normalizedLibraryMap: Map<string, TrackRecord>,
  count = 5
): MatchCandidate[] {
  // First try exact match on raw key
  const exactMatch = libraryMap.get(csvTrack.key);
  if (exactMatch) {
    return [{ track: exactMatch, confidence: 1 }];
  }

  // Try exact match on normalized key (strips remix tags, feat, etc.)
  const csvNormKey = buildNormalizedKey(csvTrack.artist, csvTrack.title);
  const normMatch = normalizedLibraryMap.get(csvNormKey);
  if (normMatch) {
    return [{ track: normMatch, confidence: 0.98 }];
  }

  // Fuzzy search — keep top N candidates
  const candidates: MatchCandidate[] = [];

  for (const libraryTrack of libraryTracks) {
    const confidence = calculateMatchConfidence(csvTrack, libraryTrack);
    if (candidates.length < count) {
      candidates.push({ track: libraryTrack, confidence });
      if (candidates.length === count) {
        candidates.sort((a, b) => b.confidence - a.confidence);
      }
    } else if (confidence > candidates[count - 1].confidence) {
      candidates[count - 1] = { track: libraryTrack, confidence };
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
};

type CheckFromTracksParams = {
  libraryRoot: string;
  tracks: TrackRecord[];
  onProgress?: ProgressFn;
  preScannedFiles?: string[];
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

function pickField(record: Record<string, string>, names: string[]) {
  for (const [key, value] of Object.entries(record)) {
    const normalized = key.toLowerCase().trim();
    if (names.includes(normalized)) return value?.trim();
  }
  return '';
}


function recordToTrack(record: Record<string, string>): TrackRecord | null {
  const artist = pickField(record, ['artist', 'artists', 'performer']);
  const title = pickField(record, ['title', 'track', 'name', 'song']);

  if (!title && !artist) return null;

  const key = artist && title
    ? normalizeBasic(`${artist} - ${title}`)
    : normalizeBasic(title || artist);

  return {
    key,
    artist: artist || 'Unknown Artist',
    title: title || 'Unknown Title',
    album: pickField(record, ['album']),
    year: pickField(record, ['year', 'date']),
    genre: pickField(record, ['genre'])
  };
}

async function processFileMetadata(filePath: string): Promise<TrackRecord | null> {
  try {
    const metadata = await parseFile(filePath, { duration: true });
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
  onProgress: (processed: number, total: number) => void
): Promise<TrackRecord[]> {
  const results: TrackRecord[] = [];
  let processed = 0;
  const total = files.length;

  // Process in batches
  for (let i = 0; i < files.length; i += METADATA_CONCURRENCY) {
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
  preScannedFiles?: string[]
): Promise<CheckResult> {
  // Phase 2: Discover files (or use pre-scanned list from job queue)
  let files: string[];
  if (preScannedFiles) {
    files = preScannedFiles;
    progress({ phase: 'discovering', current: files.length, total: files.length, message: `Using ${files.length} pre-scanned files` });
  } else {
    progress({ phase: 'discovering', current: 0, total: 0, message: 'Discovering audio files...' });
    files = await walkAudioDir(libraryRoot, {
      skipHidden: true,
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
  });

  // Build lookup maps
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
    const sourceTrack = sourceTracks[i];

    // Use fuzzy matching to find top candidates
    const candidates = findTopMatches(sourceTrack, libraryTracks, libraryMap, normalizedLibraryMap);
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

export async function checkLibrary({ libraryRoot, csvPath, onProgress, preScannedFiles }: CheckParams): Promise<CheckResult> {
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

  return matchTracksAgainstLibrary(csvTracks, libraryRoot, progress, preScannedFiles);
}

/**
 * Check library using a pre-built track list (e.g. from Spotify playlist).
 * Skips CSV parsing and goes straight to matching.
 */
export async function checkLibraryFromTracks({ libraryRoot, tracks, onProgress, preScannedFiles }: CheckFromTracksParams): Promise<CheckResult> {
  const progress = onProgress || (() => {});

  const libraryStat = await fs.stat(libraryRoot);
  if (!libraryStat.isDirectory()) {
    throw new Error('Library root must be a directory.');
  }

  if (tracks.length === 0) {
    throw new Error('No tracks provided.');
  }

  return matchTracksAgainstLibrary(tracks, libraryRoot, progress, preScannedFiles);
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
  const lowerColumns = columns.map(c => c.toLowerCase().trim());
  const hasArtistColumn = lowerColumns.some(c =>
    ['artist', 'artists', 'performer'].includes(c)
  );
  const hasTitleColumn = lowerColumns.some(c =>
    ['title', 'track', 'name', 'song'].includes(c)
  );

  return {
    columns,
    rows: previewRows,
    totalRows,
    hasArtistColumn,
    hasTitleColumn
  };
}
