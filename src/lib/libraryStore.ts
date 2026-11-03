import fs from 'fs';
import path from 'path';
import { getDatabase } from './db';
import { isPathUnder } from './fileUtils';
import { createScopedLogger } from './logger';
import type {
  LibraryHealthTrack,
  HealthIssue,
  HealthSummary,
  OrganizeState,
  TrackInfo,
  OrganizeConflict,
  DuplicatePair,
  SuggestedAction
} from '../types';
import type { LibraryHealthResult } from './libraryHealthScan';

const log = createScopedLogger('LibraryStore');

export type TrackFingerprint = {
  mtimeMs: number | null;
  sizeBytes: number | null;
  /** mtime at which the AIFF byte-swap check last ran (read-only; set by upserts). */
  integrityMtimeMs?: number | null;
};

type TrackRow = {
  library_root: string;
  file_path: string;
  file_name: string;
  mtime_ms: number | null;
  size_bytes: number | null;
  artist: string;
  title: string;
  album: string;
  year: number | null;
  genre: string;
  has_album_art: number;
  is_healthy: number;
  date_added: number | null;
  container: string | null;
  codec: string | null;
  sample_rate: number | null;
  bit_depth: number | null;
  bit_rate: number | null;
  channels: number | null;
  duration: number | null;
  lossless: number | null;
  last_scanned: number | null;
  bpm: number | null;
};

type IssueRow = {
  library_root: string;
  file_path: string;
  code: string;
  severity: string;
  message: string;
  detail: string | null;
  suggested_action: string | null;
};

type DuplicateRow = {
  library_root: string;
  path_a: string;
  path_b: string;
  similarity: number;
  reason: string | null;
  pair_json: string;
};

type ScanRunRow = {
  library_root: string;
  scanned_at: number;
  total: number;
  healthy: number;
  warnings: number;
  errors: number;
  by_issue_code_json: string;
};

function rowToTrack(row: TrackRow, issues: HealthIssue[]): LibraryHealthTrack {
  return {
    filePath: row.file_path,
    fileName: row.file_name,
    artist: row.artist,
    title: row.title,
    album: row.album,
    year: row.year,
    genre: row.genre,
    hasAlbumArt: row.has_album_art === 1,
    isHealthy: row.is_healthy === 1,
    dateAdded: row.date_added,
    bpm: row.bpm ?? null,
    issues,
    format: {
      container: row.container,
      codec: row.codec,
      sampleRate: row.sample_rate,
      bitDepth: row.bit_depth,
      bitRate: row.bit_rate,
      channels: row.channels,
      duration: row.duration,
      lossless: row.lossless === null ? null : row.lossless === 1
    }
  };
}

/** `integrityChecked`: the track's issues include a byte-swap check run against
 *  this fingerprint (true for anything produced by checkTrackHealth). */
function trackToRowValues(libraryRoot: string, track: LibraryHealthTrack, fingerprint: TrackFingerprint, integrityChecked = true) {
  const now = Date.now();
  return [
    libraryRoot,
    track.filePath,
    track.fileName,
    fingerprint.mtimeMs,
    fingerprint.sizeBytes,
    track.artist,
    track.title,
    track.album,
    track.year,
    track.genre,
    track.hasAlbumArt ? 1 : 0,
    track.isHealthy ? 1 : 0,
    track.dateAdded,
    track.format.container,
    track.format.codec,
    track.format.sampleRate,
    track.format.bitDepth,
    track.format.bitRate,
    track.format.channels,
    track.format.duration,
    track.format.lossless === null ? null : (track.format.lossless ? 1 : 0),
    now,
    track.bpm ?? null,
    integrityChecked ? fingerprint.mtimeMs : null
  ];
}

// ========== Fingerprints (for incremental scan) ==========

export function getExistingFingerprints(libraryRoot: string): Map<string, TrackFingerprint> {
  const rows = getDatabase()
    .prepare('SELECT file_path, mtime_ms, size_bytes, integrity_mtime FROM library_tracks WHERE library_root = ?')
    .all(libraryRoot) as { file_path: string; mtime_ms: number | null; size_bytes: number | null; integrity_mtime: number | null }[];

  const map = new Map<string, TrackFingerprint>();
  for (const r of rows) {
    map.set(r.file_path, { mtimeMs: r.mtime_ms, sizeBytes: r.size_bytes, integrityMtimeMs: r.integrity_mtime });
  }
  return map;
}

// ========== Upsert tracks ==========

const UPSERT_SQL = `
  INSERT INTO library_tracks (
    library_root, file_path, file_name, mtime_ms, size_bytes,
    artist, title, album, year, genre,
    has_album_art, is_healthy, date_added,
    container, codec, sample_rate, bit_depth, bit_rate, channels, duration, lossless,
    last_scanned, bpm, integrity_mtime
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(library_root, file_path) DO UPDATE SET
    file_name = excluded.file_name,
    mtime_ms = excluded.mtime_ms,
    size_bytes = excluded.size_bytes,
    artist = excluded.artist,
    title = excluded.title,
    album = excluded.album,
    year = excluded.year,
    genre = excluded.genre,
    has_album_art = excluded.has_album_art,
    is_healthy = excluded.is_healthy,
    date_added = excluded.date_added,
    container = excluded.container,
    codec = excluded.codec,
    sample_rate = excluded.sample_rate,
    bit_depth = excluded.bit_depth,
    bit_rate = excluded.bit_rate,
    channels = excluded.channels,
    duration = excluded.duration,
    lossless = excluded.lossless,
    last_scanned = excluded.last_scanned,
    bpm = excluded.bpm,
    integrity_mtime = excluded.integrity_mtime
`;

export function upsertTrack(libraryRoot: string, track: LibraryHealthTrack, fingerprint: TrackFingerprint): void {
  const db = getDatabase();
  const values = trackToRowValues(libraryRoot, track, fingerprint);
  const tx = db.transaction(() => {
    db.prepare(UPSERT_SQL).run(...values);
    db.prepare('DELETE FROM library_issues WHERE library_root = ? AND file_path = ?')
      .run(libraryRoot, track.filePath);
    const issueInsert = db.prepare(`
      INSERT INTO library_issues (library_root, file_path, code, severity, message, detail, suggested_action)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const issue of track.issues) {
      issueInsert.run(
        libraryRoot,
        track.filePath,
        issue.code,
        issue.severity,
        issue.message,
        issue.detail ?? null,
        issue.suggestedAction
      );
    }
  });
  tx();
}

export function upsertTracksBatch(
  libraryRoot: string,
  entries: { track: LibraryHealthTrack; fingerprint: TrackFingerprint }[]
): void {
  if (entries.length === 0) return;
  const db = getDatabase();
  const upsertStmt = db.prepare(UPSERT_SQL);
  const deleteIssues = db.prepare('DELETE FROM library_issues WHERE library_root = ? AND file_path = ?');
  const insertIssue = db.prepare(`
    INSERT INTO library_issues (library_root, file_path, code, severity, message, detail, suggested_action)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const { track, fingerprint } of entries) {
      upsertStmt.run(...trackToRowValues(libraryRoot, track, fingerprint));
      deleteIssues.run(libraryRoot, track.filePath);
      for (const issue of track.issues) {
        insertIssue.run(
          libraryRoot,
          track.filePath,
          issue.code,
          issue.severity,
          issue.message,
          issue.detail ?? null,
          issue.suggestedAction
        );
      }
    }
  });
  tx();
}

// ========== Delete / prune ==========

export function deleteTrack(libraryRoot: string, filePath: string): void {
  const db = getDatabase();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM library_issues WHERE library_root = ? AND file_path = ?').run(libraryRoot, filePath);
    db.prepare('DELETE FROM library_tracks WHERE library_root = ? AND file_path = ?').run(libraryRoot, filePath);
    db.prepare('DELETE FROM library_duplicates WHERE library_root = ? AND (path_a = ? OR path_b = ?)')
      .run(libraryRoot, filePath, filePath);
  });
  tx();
}

/**
 * Drop rows whose files the walk didn't find. Rows under `keepUnder` (folders the
 * walk couldn't read) are kept: their files may well exist, and this table is
 * part of the "do I own this" record.
 */
export function pruneTracksNotIn(libraryRoot: string, presentPaths: Set<string>, keepUnder: string[] = []): number {
  const db = getDatabase();
  const existing = db.prepare('SELECT file_path FROM library_tracks WHERE library_root = ?')
    .all(libraryRoot) as { file_path: string }[];
  const toDelete = existing.filter(r => !presentPaths.has(r.file_path) && !isPathUnder(r.file_path, keepUnder));
  if (toDelete.length === 0) return 0;
  const tx = db.transaction((paths: string[]) => {
    const delIssues = db.prepare('DELETE FROM library_issues WHERE library_root = ? AND file_path = ?');
    const delTrack = db.prepare('DELETE FROM library_tracks WHERE library_root = ? AND file_path = ?');
    const delDupes = db.prepare('DELETE FROM library_duplicates WHERE library_root = ? AND (path_a = ? OR path_b = ?)');
    for (const p of paths) {
      delIssues.run(libraryRoot, p);
      delTrack.run(libraryRoot, p);
      delDupes.run(libraryRoot, p, p);
    }
  });
  tx(toDelete.map(r => r.file_path));
  return toDelete.length;
}

export function clearLibraryRoot(libraryRoot: string): void {
  const db = getDatabase();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM library_issues WHERE library_root = ?').run(libraryRoot);
    db.prepare('DELETE FROM library_tracks WHERE library_root = ?').run(libraryRoot);
    db.prepare('DELETE FROM library_duplicates WHERE library_root = ?').run(libraryRoot);
    db.prepare('DELETE FROM library_scan_runs WHERE library_root = ?').run(libraryRoot);
  });
  tx();
}

// ========== Reads ==========

export function getTracksForRoot(libraryRoot: string): LibraryHealthTrack[] {
  const db = getDatabase();
  const trackRows = db.prepare('SELECT * FROM library_tracks WHERE library_root = ? ORDER BY file_path')
    .all(libraryRoot) as TrackRow[];
  if (trackRows.length === 0) return [];

  const issueRows = db.prepare('SELECT * FROM library_issues WHERE library_root = ?')
    .all(libraryRoot) as IssueRow[];
  const issuesByPath = new Map<string, HealthIssue[]>();
  for (const r of issueRows) {
    const list = issuesByPath.get(r.file_path) ?? [];
    list.push({
      code: r.code,
      severity: r.severity as HealthIssue['severity'],
      message: r.message,
      detail: r.detail ?? undefined,
      suggestedAction: (r.suggested_action ?? 'none') as SuggestedAction
    });
    issuesByPath.set(r.file_path, list);
  }

  return trackRows.map(row => rowToTrack(row, issuesByPath.get(row.file_path) ?? []));
}

// ========== Duplicates ==========

export function saveDuplicates(libraryRoot: string, pairs: DuplicatePair[]): void {
  const db = getDatabase();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM library_duplicates WHERE library_root = ?').run(libraryRoot);
    const insert = db.prepare(`
      INSERT INTO library_duplicates (library_root, path_a, path_b, similarity, reason, pair_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const pair of pairs) {
      insert.run(
        libraryRoot,
        pair.track1.filePath,
        pair.track2.filePath,
        pair.similarity,
        pair.reason,
        JSON.stringify(pair)
      );
    }
  });
  tx();
}

export function getDuplicatesForRoot(libraryRoot: string): DuplicatePair[] {
  const rows = getDatabase()
    .prepare('SELECT pair_json FROM library_duplicates WHERE library_root = ?')
    .all(libraryRoot) as { pair_json: string }[];
  return rows.map(r => JSON.parse(r.pair_json) as DuplicatePair);
}

// ========== Scan summary ==========

export function saveScanRun(libraryRoot: string, summary: HealthSummary, scannedAt: number): void {
  getDatabase().prepare(`
    INSERT INTO library_scan_runs (library_root, scanned_at, total, healthy, warnings, errors, by_issue_code_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(library_root) DO UPDATE SET
      scanned_at = excluded.scanned_at,
      total = excluded.total,
      healthy = excluded.healthy,
      warnings = excluded.warnings,
      errors = excluded.errors,
      by_issue_code_json = excluded.by_issue_code_json
  `).run(
    libraryRoot,
    scannedAt,
    summary.total,
    summary.healthy,
    summary.warnings,
    summary.errors,
    JSON.stringify(summary.byIssueCode)
  );
}

export function getScanRun(libraryRoot: string): { summary: HealthSummary; scannedAt: number } | null {
  const row = getDatabase()
    .prepare('SELECT * FROM library_scan_runs WHERE library_root = ?')
    .get(libraryRoot) as ScanRunRow | undefined;
  if (!row) return null;
  return {
    scannedAt: row.scanned_at,
    summary: {
      total: row.total,
      healthy: row.healthy,
      warnings: row.warnings,
      errors: row.errors,
      byIssueCode: JSON.parse(row.by_issue_code_json)
    }
  };
}

// ========== Full snapshot ==========

export function getHealthSnapshot(libraryRoot: string): LibraryHealthResult | null {
  const run = getScanRun(libraryRoot);
  if (!run) return null;
  const tracks = getTracksForRoot(libraryRoot);
  const duplicates = getDuplicatesForRoot(libraryRoot);
  return {
    summary: run.summary,
    tracks,
    duplicates,
    scannedAt: run.scannedAt,
    libraryRoot
  };
}

// ========== Bulk write from an in-memory result (used by sync-back + migration) ==========

export function replaceLibraryFromResult(result: LibraryHealthResult, fingerprints?: Map<string, TrackFingerprint>): void {
  const db = getDatabase();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM library_issues WHERE library_root = ?').run(result.libraryRoot);
    db.prepare('DELETE FROM library_tracks WHERE library_root = ?').run(result.libraryRoot);
    db.prepare('DELETE FROM library_duplicates WHERE library_root = ?').run(result.libraryRoot);

    const upsert = db.prepare(UPSERT_SQL);
    const insIssue = db.prepare(`
      INSERT INTO library_issues (library_root, file_path, code, severity, message, detail, suggested_action)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const track of result.tracks) {
      const fp = fingerprints?.get(track.filePath) ?? readFingerprint(track.filePath);
      // Imported results may predate the byte-swap check: leave them unchecked.
      upsert.run(...trackToRowValues(result.libraryRoot, track, fp, false));
      for (const issue of track.issues) {
        insIssue.run(
          result.libraryRoot,
          track.filePath,
          issue.code,
          issue.severity,
          issue.message,
          issue.detail ?? null,
          issue.suggestedAction
        );
      }
    }

    const insDupe = db.prepare(`
      INSERT INTO library_duplicates (library_root, path_a, path_b, similarity, reason, pair_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const pair of result.duplicates) {
      insDupe.run(
        result.libraryRoot,
        pair.track1.filePath,
        pair.track2.filePath,
        pair.similarity,
        pair.reason,
        JSON.stringify(pair)
      );
    }
  });
  tx();
  saveScanRun(result.libraryRoot, result.summary, result.scannedAt);
}

export function readFingerprint(filePath: string): TrackFingerprint {
  try {
    const stat = fs.statSync(filePath);
    return { mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
  } catch {
    return { mtimeMs: null, sizeBytes: null };
  }
}

// ========== Organize queue ==========

type OrganizeTrackRow = { track_json: string };
type OrganizeConflictRow = { conflict_json: string };

export function getOrganizeState(): OrganizeState | null {
  const db = getDatabase();
  const trackRows = db.prepare('SELECT track_json FROM organize_tracks ORDER BY position')
    .all() as OrganizeTrackRow[];
  const conflictRows = db.prepare('SELECT conflict_json FROM organize_conflicts')
    .all() as OrganizeConflictRow[];
  if (trackRows.length === 0 && conflictRows.length === 0) return null;
  return {
    tracks: trackRows.map(r => JSON.parse(r.track_json) as TrackInfo),
    conflicts: conflictRows.map(r => JSON.parse(r.conflict_json) as OrganizeConflict)
  };
}

export function saveOrganizeState(state: OrganizeState): void {
  const db = getDatabase();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM organize_tracks').run();
    db.prepare('DELETE FROM organize_conflicts').run();
    const insT = db.prepare('INSERT INTO organize_tracks (file_path, position, track_json) VALUES (?, ?, ?)');
    state.tracks.forEach((t, i) => insT.run(t.filePath, i, JSON.stringify(t)));
    const insC = db.prepare('INSERT INTO organize_conflicts (target_path, conflict_json) VALUES (?, ?)');
    for (const c of state.conflicts) insC.run(c.targetPath, JSON.stringify(c));
  });
  tx();
}

export function clearOrganizeState(): void {
  const db = getDatabase();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM organize_tracks').run();
    db.prepare('DELETE FROM organize_conflicts').run();
  });
  tx();
}

// ========== One-shot migration from scan-cache.json ==========

type LegacyScanCache = {
  libraryHealth?: { data: LibraryHealthResult; libraryRoot: string };
  organizeState?: OrganizeState;
};

export function migrateFromJsonCacheIfNeeded(userDataDir: string): void {
  const jsonPath = path.join(userDataDir, 'scan-cache.json');
  if (!fs.existsSync(jsonPath)) return;

  let raw: LegacyScanCache;
  try {
    raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as LegacyScanCache;
  } catch (err) {
    log.warn('Could not parse scan-cache.json for migration:', err);
    return;
  }

  let migrated = false;

  if (raw.libraryHealth?.data) {
    const existing = getScanRun(raw.libraryHealth.data.libraryRoot);
    if (!existing) {
      log.info(`Migrating ${raw.libraryHealth.data.tracks.length} tracks from JSON cache to SQLite`);
      replaceLibraryFromResult(raw.libraryHealth.data);
      migrated = true;
    }
  }

  if (raw.organizeState && (raw.organizeState.tracks.length > 0 || raw.organizeState.conflicts.length > 0)) {
    const existing = getOrganizeState();
    if (!existing) {
      log.info(`Migrating organize state (${raw.organizeState.tracks.length} tracks) from JSON cache to SQLite`);
      saveOrganizeState(raw.organizeState);
      migrated = true;
    }
  }

  if (migrated) {
    log.info('Migration complete. JSON cache kept as backup.');
  }
}
