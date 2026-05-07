import Database from 'better-sqlite3';
import path from 'path';
import { app } from 'electron';
import { createScopedLogger } from './logger';
import { makeTrackKey } from './stringUtils';

const log = createScopedLogger('DB');

let db: Database.Database | null = null;

export type IgnoredTrack = {
  key: string;
  artist: string;
  title: string;
  ignored_at: string;
};

export function initDatabase(): void {
  const dbPath = path.join(app.getPath('userData'), 'candybar.db');
  log.info('Initializing database at:', dbPath);
  try {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS ignored_tracks (
        key TEXT PRIMARY KEY,
        artist TEXT NOT NULL,
        title TEXT NOT NULL,
        ignored_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS dismissed_duplicates (
        key TEXT PRIMARY KEY,
        track1_artist TEXT NOT NULL,
        track1_title TEXT NOT NULL,
        track2_artist TEXT NOT NULL,
        track2_title TEXT NOT NULL,
        dismissed_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS downloaded_tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        track_id TEXT NOT NULL,
        artist TEXT NOT NULL,
        title TEXT NOT NULL,
        file_path TEXT,
        downloaded_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(source, track_id)
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS library_tracks (
        library_root TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mtime_ms REAL,
        size_bytes INTEGER,
        artist TEXT DEFAULT '',
        title TEXT DEFAULT '',
        album TEXT DEFAULT '',
        year INTEGER,
        genre TEXT DEFAULT '',
        has_album_art INTEGER DEFAULT 0,
        is_healthy INTEGER DEFAULT 1,
        date_added INTEGER,
        container TEXT,
        codec TEXT,
        sample_rate INTEGER,
        bit_depth INTEGER,
        bit_rate INTEGER,
        channels INTEGER,
        duration REAL,
        lossless INTEGER,
        last_scanned INTEGER,
        PRIMARY KEY (library_root, file_path)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_library_tracks_root ON library_tracks(library_root)`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS library_issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        library_root TEXT NOT NULL,
        file_path TEXT NOT NULL,
        code TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        detail TEXT,
        suggested_action TEXT
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_library_issues_track ON library_issues(library_root, file_path)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_library_issues_code ON library_issues(library_root, code)`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS dismissed_issues (
        library_root TEXT NOT NULL,
        file_path TEXT NOT NULL,
        issue_code TEXT NOT NULL,
        dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (library_root, file_path, issue_code)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_dismissed_issues_root ON dismissed_issues(library_root)`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS library_duplicates (
        library_root TEXT NOT NULL,
        path_a TEXT NOT NULL,
        path_b TEXT NOT NULL,
        similarity REAL NOT NULL,
        reason TEXT,
        pair_json TEXT NOT NULL,
        PRIMARY KEY (library_root, path_a, path_b)
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS library_scan_runs (
        library_root TEXT PRIMARY KEY,
        scanned_at INTEGER NOT NULL,
        total INTEGER NOT NULL,
        healthy INTEGER NOT NULL,
        warnings INTEGER NOT NULL,
        errors INTEGER NOT NULL,
        by_issue_code_json TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS autopopulated_tracks (
        file_path TEXT PRIMARY KEY,
        processed_at INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS organize_tracks (
        file_path TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        track_json TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS organize_conflicts (
        target_path TEXT PRIMARY KEY,
        conflict_json TEXT NOT NULL
      )
    `);
    log.info('Database initialized successfully');
  } catch (error) {
    log.error('Database initialization failed:', error);
    throw error;
  }
}

export function getDatabase(): Database.Database {
  return getDb();
}

export function closeDatabase(): void {
  log.info('Closing database');
  try {
    db?.close();
    db = null;
  } catch (error) {
    log.error('Database close failed:', error);
  }
}

function getDb(): Database.Database {
  if (!db) {
    log.error('Database accessed before initialization');
    throw new Error('Database not initialized');
  }
  return db;
}

export function ignoreTrack(key: string, artist: string, title: string): void {
  log.debug('Ignoring track:', key);
  try {
    getDb()
      .prepare('INSERT OR REPLACE INTO ignored_tracks (key, artist, title) VALUES (?, ?, ?)')
      .run(key, artist, title);
  } catch (error) {
    log.error('Failed to ignore track:', key, error);
    throw error;
  }
}

export function unignoreTrack(key: string): void {
  log.debug('Unignoring track:', key);
  try {
    getDb()
      .prepare('DELETE FROM ignored_tracks WHERE key = ?')
      .run(key);
  } catch (error) {
    log.error('Failed to unignore track:', key, error);
    throw error;
  }
}

export function getIgnoredTracks(): IgnoredTrack[] {
  try {
    return getDb()
      .prepare('SELECT key, artist, title, ignored_at FROM ignored_tracks ORDER BY ignored_at DESC')
      .all() as IgnoredTrack[];
  } catch (error) {
    log.error('Failed to get ignored tracks:', error);
    throw error;
  }
}

// ========== Downloaded Tracks ==========

export type DownloadedTrack = {
  id: number;
  source: string;
  track_id: string;
  artist: string;
  title: string;
  file_path: string | null;
  downloaded_at: string;
};

export function recordDownload(source: string, trackId: string, artist: string, title: string, filePath?: string): void {
  log.debug('Recording download:', source, trackId);
  try {
    getDb()
      .prepare('INSERT OR REPLACE INTO downloaded_tracks (source, track_id, artist, title, file_path) VALUES (?, ?, ?, ?, ?)')
      .run(source, trackId, artist, title, filePath || null);
  } catch (error) {
    log.error('Failed to record download:', source, trackId, error);
    throw error;
  }
}

export function isTrackDownloaded(source: string, trackId: string): boolean {
  try {
    const row = getDb()
      .prepare('SELECT 1 FROM downloaded_tracks WHERE source = ? AND track_id = ?')
      .get(source, trackId);
    return !!row;
  } catch (error) {
    log.error('Failed to check downloaded track:', source, trackId, error);
    return false;
  }
}

export function getDownloadedTrackPath(source: string, trackId: string): string | null {
  try {
    const row = getDb()
      .prepare('SELECT file_path FROM downloaded_tracks WHERE source = ? AND track_id = ?')
      .get(source, trackId) as { file_path: string | null } | undefined;
    return row?.file_path ?? null;
  } catch (error) {
    log.error('Failed to read downloaded track path:', source, trackId, error);
    return null;
  }
}

export function forgetDownloadedTrack(source: string, trackId: string): void {
  try {
    getDb()
      .prepare('DELETE FROM downloaded_tracks WHERE source = ? AND track_id = ?')
      .run(source, trackId);
  } catch (error) {
    log.error('Failed to forget downloaded track:', source, trackId, error);
  }
}

export function getDownloadedTracks(): DownloadedTrack[] {
  try {
    return getDb()
      .prepare('SELECT * FROM downloaded_tracks ORDER BY downloaded_at DESC')
      .all() as DownloadedTrack[];
  } catch (error) {
    log.error('Failed to get downloaded tracks:', error);
    throw error;
  }
}

export function getIgnoredTrackKeys(): Set<string> {
  try {
    const rows = getDb()
      .prepare('SELECT key FROM ignored_tracks')
      .all() as { key: string }[];
    return new Set(rows.map(r => r.key));
  } catch (error) {
    log.error('Failed to get ignored track keys:', error);
    throw error;
  }
}

// ========== Dismissed Duplicates ==========

/**
 * Ensure the dismissed_duplicates table exists (handles DBs created before this table was added).
 */
function ensureDismissedDuplicatesTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS dismissed_duplicates (
      key TEXT PRIMARY KEY,
      track1_artist TEXT NOT NULL,
      track1_title TEXT NOT NULL,
      track2_artist TEXT NOT NULL,
      track2_title TEXT NOT NULL,
      dismissed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

/**
 * Create a canonical key for a duplicate pair from both tracks' artist+title.
 * Sorted alphabetically so order doesn't matter.
 */
export function makeDuplicatePairKey(
  artist1: string, title1: string,
  artist2: string, title2: string
): string {
  const k1 = `${artist1.toLowerCase().trim()} - ${title1.toLowerCase().trim()}`;
  const k2 = `${artist2.toLowerCase().trim()} - ${title2.toLowerCase().trim()}`;
  return [k1, k2].sort().join('||');
}

export function dismissDuplicate(
  key: string,
  track1Artist: string, track1Title: string,
  track2Artist: string, track2Title: string
): void {
  log.debug('Dismissing duplicate pair:', key);
  try {
    ensureDismissedDuplicatesTable();
    getDb()
      .prepare('INSERT OR REPLACE INTO dismissed_duplicates (key, track1_artist, track1_title, track2_artist, track2_title) VALUES (?, ?, ?, ?, ?)')
      .run(key, track1Artist, track1Title, track2Artist, track2Title);
  } catch (error) {
    log.error('Failed to dismiss duplicate:', key, error);
    throw error;
  }
}

export function getDismissedDuplicateKeys(): Set<string> {
  try {
    ensureDismissedDuplicatesTable();
    const rows = getDb()
      .prepare('SELECT key FROM dismissed_duplicates')
      .all() as { key: string }[];
    return new Set(rows.map(r => r.key));
  } catch (error) {
    log.error('Failed to get dismissed duplicate keys:', error);
    return new Set();
  }
}

export function undismissDuplicate(key: string): void {
  log.debug('Undismissing duplicate:', key);
  try {
    ensureDismissedDuplicatesTable();
    getDb()
      .prepare('DELETE FROM dismissed_duplicates WHERE key = ?')
      .run(key);
  } catch (error) {
    log.error('Failed to undismiss duplicate:', key, error);
    throw error;
  }
}

// ========== Dismissed Health Issues ==========

function ensureDismissedIssuesTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS dismissed_issues (
      library_root TEXT NOT NULL,
      file_path TEXT NOT NULL,
      issue_code TEXT NOT NULL,
      dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (library_root, file_path, issue_code)
    )
  `);
  getDb().exec(`CREATE INDEX IF NOT EXISTS idx_dismissed_issues_root ON dismissed_issues(library_root)`);
}

export type DismissedIssue = {
  filePath: string;
  issueCode: string;
};

export function dismissHealthIssue(libraryRoot: string, filePath: string, issueCode: string): void {
  try {
    ensureDismissedIssuesTable();
    getDb()
      .prepare('INSERT OR REPLACE INTO dismissed_issues (library_root, file_path, issue_code) VALUES (?, ?, ?)')
      .run(libraryRoot, filePath, issueCode);
  } catch (error) {
    log.error('Failed to dismiss health issue:', libraryRoot, filePath, issueCode, error);
    throw error;
  }
}

export function undismissHealthIssue(libraryRoot: string, filePath: string, issueCode: string): void {
  try {
    ensureDismissedIssuesTable();
    getDb()
      .prepare('DELETE FROM dismissed_issues WHERE library_root = ? AND file_path = ? AND issue_code = ?')
      .run(libraryRoot, filePath, issueCode);
  } catch (error) {
    log.error('Failed to undismiss health issue:', libraryRoot, filePath, issueCode, error);
    throw error;
  }
}

export function getDismissedIssues(libraryRoot: string): DismissedIssue[] {
  try {
    ensureDismissedIssuesTable();
    const rows = getDb()
      .prepare('SELECT file_path, issue_code FROM dismissed_issues WHERE library_root = ?')
      .all(libraryRoot) as { file_path: string; issue_code: string }[];
    return rows.map(r => ({ filePath: r.file_path, issueCode: r.issue_code }));
  } catch (error) {
    log.error('Failed to get dismissed health issues:', libraryRoot, error);
    return [];
  }
}

// ========== Autopopulated tracks ==========

function ensureAutopopulatedTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS autopopulated_tracks (
      file_path TEXT PRIMARY KEY,
      processed_at INTEGER NOT NULL
    )
  `);
}

export function markTrackAutopopulated(filePath: string): void {
  try {
    ensureAutopopulatedTable();
    getDb()
      .prepare('INSERT OR REPLACE INTO autopopulated_tracks (file_path, processed_at) VALUES (?, ?)')
      .run(filePath, Date.now());
  } catch (error) {
    log.error('Failed to mark track autopopulated:', filePath, error);
  }
}

export function getAutopopulatedPaths(paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  try {
    ensureAutopopulatedTable();
    const placeholders = paths.map(() => '?').join(',');
    const rows = getDb()
      .prepare(`SELECT file_path FROM autopopulated_tracks WHERE file_path IN (${placeholders})`)
      .all(...paths) as { file_path: string }[];
    return new Set(rows.map(r => r.file_path));
  } catch (error) {
    log.error('Failed to query autopopulated paths:', error);
    return new Set();
  }
}
