import fs from 'fs';
import path from 'path';
import { checkTrackHealth, TrackHealth, HealthSummary, summarizeHealth } from './trackHealthCheck';
import { checkAiffIntegrity } from './audioIntegrityCheck';
import type { LibraryHealthTrack } from '../types';
import { findDuplicates, DuplicatePair, TrackForDuplicateCheck } from './duplicateDetection';
import { walkAudioDir, safeMove } from './fileUtils';
import { safeDelete } from './safeDelete';
import { getDefaultArchivePath } from './config';
import { createScopedLogger } from './logger';
import { getDismissedDuplicateKeys, makeDuplicatePairKey } from './db';
import {
  getExistingFingerprints,
  upsertTracksBatch,
  pruneTracksNotIn,
  getTracksForRoot,
  saveDuplicates,
  saveScanRun,
  type TrackFingerprint
} from './libraryStore';

const log = createScopedLogger('LibraryHealth');
import type { ArchiveResult } from '../types';
export type { ArchiveResult };

// Re-export for backwards compatibility
export const getArchivePath = getDefaultArchivePath;

/**
 * Archive a track file by moving it to the archive folder.
 * Preserves the relative path structure from the library root.
 * @param filePath - The file to archive
 * @param libraryRoot - The library root path (used to compute relative path)
 * @param archivePath - Optional custom archive path (defaults to .archive sibling of library)
 */
export async function archiveTrackFile(
  filePath: string,
  libraryRoot: string,
  archivePath?: string
): Promise<ArchiveResult> {
  try {
    const archiveRoot = archivePath || getArchivePath(libraryRoot);

    // Anchor the archive destination so sibling folders (e.g. tracks_to_organize)
    // don't collapse back onto the source path via `..` segments.
    const relFromLibrary = path.relative(libraryRoot, filePath);
    let archiveDest: string;
    if (!relFromLibrary.startsWith('..') && !path.isAbsolute(relFromLibrary)) {
      archiveDest = path.join(archiveRoot, relFromLibrary);
    } else {
      const relFromParent = path.relative(path.dirname(libraryRoot), filePath);
      archiveDest = !relFromParent.startsWith('..') && !path.isAbsolute(relFromParent)
        ? path.join(archiveRoot, relFromParent)
        : path.join(archiveRoot, path.basename(filePath));
    }

    // Ensure archive directory structure exists
    const archiveDir = path.dirname(archiveDest);
    await fs.promises.mkdir(archiveDir, { recursive: true });

    // Move the file (handles cross-filesystem moves). If the archive
    // destination already has a copy (prior archive attempt), the source is
    // redundant — delete it so the library is cleaned up either way.
    try {
      await safeMove(filePath, archiveDest, 'archive');
    } catch (moveErr) {
      const destExists = await fs.promises.access(archiveDest).then(() => true, () => false);
      if (!destExists) throw moveErr;
      await safeDelete(filePath, { context: 'archive', detail: { reason: 'archive-dest-already-existed', archiveDest } });
      log.info(`Archive destination already existed; removed source: ${filePath}`);
    }

    return {
      success: true,
      originalPath: filePath,
      archivePath: archiveDest
    };
  } catch (error) {
    log.error('Failed to archive track:', filePath, error);
    return {
      success: false,
      originalPath: filePath,
      errorMessage: error instanceof Error ? error.message : 'Failed to archive file'
    };
  }
}

export type LibraryHealthResult = {
  summary: HealthSummary;
  tracks: TrackHealth[];
  duplicates: DuplicatePair[];
  scannedAt: number;
  libraryRoot: string;
};

export type { DuplicatePair };

export type HealthScanProgress = {
  phase: 'discovering' | 'scanning' | 'duplicates' | 'complete';
  current: number;
  total: number;
  track?: TrackHealth; // The track that was just scanned (for streaming display)
};

type ProgressCallback = (progress: HealthScanProgress) => void;

export async function scanLibraryHealth({
  libraryRoot,
  onProgress,
  preScannedFiles
}: {
  libraryRoot: string;
  onProgress?: ProgressCallback;
  preScannedFiles?: string[];
}): Promise<LibraryHealthResult> {
  log.info('Starting library health scan:', libraryRoot);

  if (!fs.existsSync(libraryRoot)) {
    throw new Error(`Library directory not found: ${libraryRoot}`);
  }
  const stat = await fs.promises.stat(libraryRoot);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${libraryRoot}`);
  }

  let audioFiles: string[];
  if (preScannedFiles) {
    audioFiles = preScannedFiles;
  } else {
    onProgress?.({ phase: 'discovering', current: 0, total: 0 });
    audioFiles = await walkAudioDir(libraryRoot);
  }

  const total = audioFiles.length;
  const existingFingerprints = getExistingFingerprints(libraryRoot);
  const presentPaths = new Set<string>(audioFiles);

  if (total === 0) {
    // An empty walk almost always means the library root is unavailable
    // (unmounted drive, permission error) rather than "every track was deleted".
    // Return WITHOUT pruning — pruning here would wipe all persisted metadata.
    const emptySummary: HealthSummary = { total: 0, healthy: 0, warnings: 0, errors: 0, byIssueCode: {} };
    saveScanRun(libraryRoot, emptySummary, Date.now());
    saveDuplicates(libraryRoot, []);
    onProgress?.({ phase: 'complete', current: 0, total: 0 });
    return { summary: emptySummary, tracks: [], duplicates: [], scannedAt: Date.now(), libraryRoot };
  }

  // Prune tracks that no longer exist on disk (only once we know the walk found
  // files, so a transient empty result can't wipe the whole index).
  const pruned = pruneTracksNotIn(libraryRoot, presentPaths);
  if (pruned > 0) log.info(`Pruned ${pruned} missing tracks from DB`);

  // Incremental scan: stat each file, compare mtime, re-parse only changed/new
  const BATCH_SIZE = 50;
  let batch: { track: LibraryHealthTrack; fingerprint: TrackFingerprint }[] = [];
  let scanned = 0;
  let reused = 0;

  const flushBatch = () => {
    if (batch.length === 0) return;
    upsertTracksBatch(libraryRoot, batch);
    batch = [];
  };

  for (let i = 0; i < audioFiles.length; i++) {
    const filePath = audioFiles[i];
    let fingerprint: TrackFingerprint;
    try {
      const s = fs.statSync(filePath);
      fingerprint = { mtimeMs: s.mtimeMs, sizeBytes: s.size };
    } catch {
      fingerprint = { mtimeMs: null, sizeBytes: null };
    }

    const prior = existingFingerprints.get(filePath);
    const unchanged = prior &&
      prior.mtimeMs !== null && fingerprint.mtimeMs !== null &&
      prior.mtimeMs === fingerprint.mtimeMs &&
      prior.sizeBytes === fingerprint.sizeBytes;

    if (unchanged) {
      reused++;
      onProgress?.({ phase: 'scanning', current: i + 1, total });
    } else {
      const health = await checkTrackHealth(filePath);
      batch.push({ track: health, fingerprint });
      scanned++;
      onProgress?.({ phase: 'scanning', current: i + 1, total, track: health });
      if (batch.length >= BATCH_SIZE) flushBatch();
    }
  }
  flushBatch();

  log.info(`Scan: ${scanned} parsed, ${reused} unchanged (skipped parse)`);

  // Audio integrity sweep: the byte-swap corruption detector is cheap and
  // decoupled from the fingerprint cache, so we run it on every AIFF/AIFC
  // file every scan. A file can pass a full-metadata parse and still be
  // byte-swapped — and the cache skips the metadata parse when mtime is
  // unchanged, so we can't piggyback on checkTrackHealth for this pass.
  {
    const integrityUpdates: { track: LibraryHealthTrack; fingerprint: TrackFingerprint }[] = [];
    const currentTracks = getTracksForRoot(libraryRoot);
    const trackByPath = new Map(currentTracks.map(t => [t.filePath, t]));
    for (const filePath of audioFiles) {
      const ext = path.extname(filePath).toLowerCase();
      if (ext !== '.aiff' && ext !== '.aif' && ext !== '.aifc') continue;
      const track = trackByPath.get(filePath);
      if (!track) continue;
      const integrity = await checkAiffIntegrity(filePath);
      const hasBroken = track.issues.some(i => i.code === 'BROKEN_AUDIO');
      if (integrity.status === 'byte_swapped' && !hasBroken) {
        track.issues.push({
          code: 'BROKEN_AUDIO',
          severity: 'error',
          message: 'Audio bytes are scrambled (byte-swap)',
          detail:
            `Adjacent-sample coherence in the header-claimed byte order is ` +
            `${integrity.coherence.expected.toFixed(2)} vs ${integrity.coherence.swapped.toFixed(2)} ` +
            `if byte-swapped. This file plays back as static. Re-import from the ` +
            `original source (WAV/FLAC) to recover.`,
          suggestedAction: 'none'
        });
        track.isHealthy = false;
        integrityUpdates.push({ track, fingerprint: { mtimeMs: null, sizeBytes: null } });
      } else if (integrity.status === 'ok' && hasBroken) {
        // The track was flagged before but is now clean (user re-imported a
        // fresh source). Drop the stale issue.
        track.issues = track.issues.filter(i => i.code !== 'BROKEN_AUDIO');
        track.isHealthy = !track.issues.some(i => i.severity === 'error');
        integrityUpdates.push({ track, fingerprint: { mtimeMs: null, sizeBytes: null } });
      }
    }
    if (integrityUpdates.length > 0) {
      // Preserve existing fingerprints rather than clobbering with nulls.
      const freshFingerprints = getExistingFingerprints(libraryRoot);
      const scoped = integrityUpdates.map(u => ({
        track: u.track,
        fingerprint: freshFingerprints.get(u.track.filePath) ?? u.fingerprint
      }));
      upsertTracksBatch(libraryRoot, scoped);
      log.info(`Integrity sweep updated ${integrityUpdates.length} AIFF tracks`);
    }
  }

  // Load all tracks back from DB for duplicate detection + result assembly
  const allTracks = getTracksForRoot(libraryRoot);

  const tracksForDuplicateCheck: TrackForDuplicateCheck[] = allTracks.map(t => {
    const tagFields = [t.artist, t.title, t.album, t.year, t.genre, t.hasAlbumArt];
    const filledTags = tagFields.filter(v => v !== null && v !== '' && v !== false).length;
    return {
      filePath: t.filePath,
      artist: t.artist || '',
      title: t.title || path.basename(t.filePath, path.extname(t.filePath)),
      format: t.format.container || path.extname(t.filePath).slice(1).toUpperCase(),
      bitRate: t.format.bitRate,
      duration: t.format.duration,
      album: t.album || null,
      year: t.year,
      genre: t.genre || null,
      hasAlbumArt: t.hasAlbumArt,
      tagCompleteness: filledTags / tagFields.length,
      dateAdded: t.dateAdded
    };
  });

  onProgress?.({ phase: 'duplicates', current: 0, total: tracksForDuplicateCheck.length });
  const allDuplicates = findDuplicates(tracksForDuplicateCheck, 0.85);
  const dismissedKeys = getDismissedDuplicateKeys();
  const duplicates = allDuplicates.filter(pair => {
    const key = makeDuplicatePairKey(
      pair.track1.artist, pair.track1.title,
      pair.track2.artist, pair.track2.title
    );
    return !dismissedKeys.has(key);
  });
  saveDuplicates(libraryRoot, duplicates);

  const summary = summarizeHealth(allTracks);
  const scannedAt = Date.now();
  saveScanRun(libraryRoot, summary, scannedAt);

  onProgress?.({ phase: 'complete', current: total, total });

  log.info('Library health scan complete:', total, 'tracks,', summary.healthy, 'healthy,', summary.errors, 'errors,', duplicates.length, 'duplicates');

  return {
    summary,
    tracks: allTracks,
    duplicates,
    scannedAt,
    libraryRoot
  };
}
