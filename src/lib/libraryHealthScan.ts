import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
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
  getDuplicatesForRoot,
  getScanRun,
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
/** True when two files have the same size and SHA-256 (streamed, not read whole). */
async function sameFileContent(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([fs.promises.stat(a), fs.promises.stat(b)]);
  if (sa.size !== sb.size) return false;
  const hash = (p: string) => new Promise<string>((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
  const [ha, hb] = await Promise.all([hash(a), hash(b)]);
  return ha === hb;
}

/** `X (2).aif`, `X (3).aif`, ... — the first name not already taken. */
async function uniqueSiblingPath(p: string): Promise<string> {
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!(await fs.promises.access(candidate).then(() => true, () => false))) return candidate;
  }
}

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

    // Move the file (handles cross-filesystem moves; a failed copy never
    // leaves a partial at archiveDest). If the archive already holds a file of
    // that name, the source is only redundant when the two are byte-identical;
    // a different file gets a numbered name instead of being thrown away.
    let finalDest = archiveDest;
    try {
      await safeMove(filePath, archiveDest, 'archive');
    } catch (moveErr) {
      if ((moveErr as NodeJS.ErrnoException).code !== 'EEXIST') throw moveErr;
      if (await sameFileContent(filePath, archiveDest)) {
        await safeDelete(filePath, { context: 'archive', detail: { reason: 'identical-copy-already-archived', archiveDest } });
        log.info(`Identical copy already archived; moved source to Trash: ${filePath}`);
      } else {
        finalDest = await uniqueSiblingPath(archiveDest);
        await safeMove(filePath, finalDest, 'archive');
        log.info(`Archive name taken by a different file; archived as ${path.basename(finalDest)}`);
      }
    }

    return {
      success: true,
      originalPath: filePath,
      archivePath: finalDest
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
  preScannedFiles,
  signal
}: {
  libraryRoot: string;
  onProgress?: ProgressCallback;
  preScannedFiles?: string[];
  signal?: AbortSignal;
}): Promise<LibraryHealthResult> {
  log.info('Starting library health scan:', libraryRoot);
  const checkAbort = () => { if (signal?.aborted) throw new Error('Cancelled'); };

  if (!fs.existsSync(libraryRoot)) {
    throw new Error(`Library directory not found: ${libraryRoot}`);
  }
  const stat = await fs.promises.stat(libraryRoot);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${libraryRoot}`);
  }

  // An empty pre-scanned list proves nothing (a walker that dropped every
  // dirent looks identical to an empty library), so walk again ourselves.
  let audioFiles: string[];
  const failedDirs: string[] = [];
  if (preScannedFiles && preScannedFiles.length > 0) {
    audioFiles = preScannedFiles;
  } else {
    onProgress?.({ phase: 'discovering', current: 0, total: 0 });
    audioFiles = await walkAudioDir(libraryRoot, { signal, failedDirs });
  }

  const total = audioFiles.length;
  const existingFingerprints = getExistingFingerprints(libraryRoot);
  const presentPaths = new Set<string>(audioFiles);

  if (total === 0) {
    // An empty walk almost always means the library root is unavailable
    // (unmounted drive, permission error) rather than "every track was deleted".
    // Write nothing — no prune, no zeroed summary, no cleared duplicates — and
    // hand back the last good snapshot so the UI keeps showing real data.
    log.warn(`Library walk found no audio files under ${libraryRoot}; keeping the stored snapshot untouched`);
    onProgress?.({ phase: 'complete', current: 0, total: 0 });
    const lastRun = getScanRun(libraryRoot);
    const tracks = getTracksForRoot(libraryRoot);
    return {
      summary: lastRun?.summary ?? summarizeHealth(tracks),
      tracks,
      duplicates: getDuplicatesForRoot(libraryRoot),
      scannedAt: lastRun?.scannedAt ?? Date.now(),
      libraryRoot
    };
  }

  // Prune tracks that no longer exist on disk (only once we know the walk found
  // files, so a transient empty result can't wipe the whole index). Rows under
  // folders the walk couldn't read are kept.
  if (failedDirs.length > 0) log.warn(`Not pruning under ${failedDirs.length} unreadable folder(s)`);
  const pruned = pruneTracksNotIn(libraryRoot, presentPaths, failedDirs);
  if (pruned > 0) log.info(`Pruned ${pruned} missing tracks from DB`);

  // Incremental scan: stat each file, compare mtime, re-parse only changed/new
  const BATCH_SIZE = 50;
  let batch: { track: LibraryHealthTrack; fingerprint: TrackFingerprint }[] = [];
  let scanned = 0;
  let reused = 0;
  const reusedFingerprints = new Map<string, TrackFingerprint>();

  const flushBatch = () => {
    if (batch.length === 0) return;
    upsertTracksBatch(libraryRoot, batch);
    batch = [];
  };

  for (let i = 0; i < audioFiles.length; i++) {
    checkAbort();
    const filePath = audioFiles[i];
    let fingerprint: TrackFingerprint;
    try {
      const s = await fs.promises.stat(filePath);
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
      reusedFingerprints.set(filePath, prior);
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

  // Audio integrity sweep. Every parse above already ran the byte-swap check,
  // so only unchanged AIFF rows that were never checked at their current mtime
  // (rows from before the check existed, or imported) need reading here.
  {
    const toCheck = audioFiles.filter((filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if (ext !== '.aiff' && ext !== '.aif' && ext !== '.aifc') return false;
      const fp = reusedFingerprints.get(filePath);
      return !!fp && fp.integrityMtimeMs !== fp.mtimeMs;
    });
    if (toCheck.length > 0) {
      const trackByPath = new Map(getTracksForRoot(libraryRoot).map(t => [t.filePath, t]));
      const integrityUpdates: { track: LibraryHealthTrack; fingerprint: TrackFingerprint }[] = [];
      for (const filePath of toCheck) {
        checkAbort();
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
        } else if (integrity.status === 'ok' && hasBroken) {
          // The track was flagged before but is now clean (user re-imported a
          // fresh source). Drop the stale issue.
          track.issues = track.issues.filter(i => i.code !== 'BROKEN_AUDIO');
          track.isHealthy = !track.issues.some(i => i.severity === 'error');
        }
        // Upsert either way so the row records it was checked at this mtime.
        integrityUpdates.push({ track, fingerprint: reusedFingerprints.get(filePath)! });
      }
      if (integrityUpdates.length > 0) {
        upsertTracksBatch(libraryRoot, integrityUpdates);
        log.info(`Integrity sweep checked ${integrityUpdates.length} AIFF tracks`);
      }
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
