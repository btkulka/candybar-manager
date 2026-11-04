import Database from 'better-sqlite3';
import path from 'path';
import { app } from 'electron';
import { createScopedLogger } from './logger';
import { makeTagKey } from './stringUtils';
import type { SavedSource, SavedSourceInput, SavedSourceKind } from '../types';

const log = createScopedLogger('DB');

let db: Database.Database | null = null;

/** True once initDatabase() has run. Lib code shared with the MCP server uses
 *  this to skip DB bookkeeping (e.g. path updates after a move) when no DB is open. */
export function isDatabaseReady(): boolean {
  return db !== null;
}

/** Add a column to an existing table if it isn't there yet. Returns true when added. */
function ensureColumn(database: Database.Database, table: string, column: string, decl: string): boolean {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some(c => c.name === column)) return false;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  return true;
}

/** Migrations for DBs created by older builds (CREATE TABLE IF NOT EXISTS never adds columns). */
function runMigrations(database: Database.Database): void {
  // BPM was added after library_tracks shipped. NULL the fingerprints so the
  // next health scan re-reads every file once and fills the new column.
  if (ensureColumn(database, 'library_tracks', 'bpm', 'REAL')) {
    database.exec('UPDATE library_tracks SET mtime_ms = NULL');
    log.info('Migration: added library_tracks.bpm; existing rows will be re-read on the next scan');
  }
  // mtime at which the byte-swap integrity check last ran for a row, so the
  // per-scan sweep only reads files it hasn't checked at their current mtime.
  ensureColumn(database, 'library_tracks', 'integrity_mtime', 'REAL');
  // pruneTracksNotIn / deleteTrack filter duplicates on path_b too.
  database.exec('CREATE INDEX IF NOT EXISTS idx_library_duplicates_b ON library_duplicates(library_root, path_b)');
}

export type IgnoredTrack = {
  key: string;
  artist: string;
  title: string;
  ignored_at: string;
};

export function initDatabase(dbPath: string = path.join(app.getPath('userData'), 'candybar.db')): void {
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
        bpm REAL,
        integrity_mtime REAL,
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
    // Tombstones: tracks the user deleted. Anything here is never re-fetched
    // or restored (matched by store id, and by version-preserving tag key).
    db.exec(`
      CREATE TABLE IF NOT EXISTS deleted_tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT,
        source TEXT,
        track_id TEXT,
        tag_key TEXT,
        artist TEXT,
        title TEXT,
        deleted_at INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_deleted_tracks_store ON deleted_tracks(source, track_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_deleted_tracks_tag ON deleted_tracks(tag_key)`);
    // Playlists, sets and spreadsheets checked on Find and buy, so they can be
    // checked again in one click. One row per source (ref_key), with the counts
    // from its last check. Columns added later go through ensureColumn in
    // runMigrations, like library_tracks.
    db.exec(`
      CREATE TABLE IF NOT EXISTS saved_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        ref_key TEXT NOT NULL UNIQUE,
        ref TEXT NOT NULL,
        name TEXT NOT NULL,
        custom_name TEXT,
        image_url TEXT,
        owner TEXT NOT NULL DEFAULT '',
        track_count INTEGER NOT NULL DEFAULT 0,
        to_buy INTEGER NOT NULL DEFAULT 0,
        maybe_owned INTEGER NOT NULL DEFAULT 0,
        owned INTEGER NOT NULL DEFAULT 0,
        not_for_sale INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_checked_at INTEGER NOT NULL
      )
    `);
    runMigrations(db);
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

/** The same path in its stored, NFC and NFD forms. exFAT keeps whichever form it
 *  was given, so a path recorded by one writer may come back decomposed from another. */
function pathVariants(p: string): string[] {
  return Array.from(new Set([p, p.normalize('NFC'), p.normalize('NFD')]));
}

/**
 * Point a downloaded_tracks row at a file's new location after a move (organize,
 * flatten, archive), so "already downloaded" keeps resolving to the real file
 * instead of looking gone and triggering a re-download. No-op without a DB.
 */
export function updateDownloadedTrackPath(oldPath: string, newPath: string): void {
  if (!db || oldPath === newPath) return;
  try {
    const stmt = db.prepare('UPDATE downloaded_tracks SET file_path = ? WHERE file_path = ?');
    for (const variant of pathVariants(oldPath)) stmt.run(newPath, variant);
  } catch (error) {
    log.error('Failed to update downloaded track path:', oldPath, '->', newPath, error);
  }
}

// ========== Deleted-track tombstones ==========

export type DeletedTrackInput = { filePath: string; artist?: string; title?: string };
export type DeletedTrackQuery = { source?: string; trackId?: string; artist?: string; title?: string };

/** Version-preserving tag key, or null when artist/title don't carry enough to match on. */
function tombstoneTagKey(artist?: string, title?: string): string | null {
  if (!artist?.trim() || !title?.trim()) return null;
  const key = makeTagKey(artist, title);
  return key.startsWith('|') || key.endsWith('|') ? null : key;
}

/**
 * Remember that the user deleted a track so it is never re-fetched or restored.
 * Captures the store source + track id from downloaded_tracks when the file was a
 * download, and a normalized artist/title key either way. No-op without a DB.
 */
export function recordDeletedTrack(e: DeletedTrackInput): void {
  if (!db) return;
  try {
    let source: string | null = null;
    let trackId: string | null = null;
    let artist = e.artist ?? '';
    let title = e.title ?? '';
    const lookup = db.prepare('SELECT source, track_id, artist, title FROM downloaded_tracks WHERE file_path = ?');
    for (const variant of pathVariants(e.filePath)) {
      const row = lookup.get(variant) as { source: string; track_id: string; artist: string; title: string } | undefined;
      if (row) {
        source = row.source;
        trackId = row.track_id;
        if (!artist.trim()) artist = row.artist;
        if (!title.trim()) title = row.title;
        break;
      }
    }
    db.prepare(`
      INSERT INTO deleted_tracks (file_path, source, track_id, tag_key, artist, title, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(e.filePath, source, trackId, tombstoneTagKey(artist, title), artist, title, Date.now());
  } catch (error) {
    log.error('Failed to record deleted track:', e.filePath, error);
  }
}

/** True if a matching track was deleted by the user (by store id, or by artist + title). */
export function isTrackDeleted(q: DeletedTrackQuery): boolean {
  if (!db) return false;
  try {
    if (q.source && q.trackId) {
      const hit = db.prepare('SELECT 1 FROM deleted_tracks WHERE source = ? AND track_id = ? LIMIT 1')
        .get(q.source, String(q.trackId));
      if (hit) return true;
    }
    const key = tombstoneTagKey(q.artist, q.title);
    if (key) {
      const hit = db.prepare('SELECT 1 FROM deleted_tracks WHERE tag_key = ? LIMIT 1').get(key);
      if (hit) return true;
    }
    return false;
  } catch (error) {
    log.error('Failed to check deleted track:', q, error);
    return false;
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
    // Chunk the IN list: SQLite caps bound variables (32766), and an over-limit
    // query would throw and fall through to "nothing processed yet".
    const CHUNK = 500;
    const found = new Set<string>();
    for (let i = 0; i < paths.length; i += CHUNK) {
      const chunk = paths.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = getDb()
        .prepare(`SELECT file_path FROM autopopulated_tracks WHERE file_path IN (${placeholders})`)
        .all(...chunk) as { file_path: string }[];
      for (const r of rows) found.add(r.file_path);
    }
    return found;
  } catch (error) {
    log.error('Failed to query autopopulated paths:', error);
    return new Set();
  }
}

// ========== Saved sources (Find and buy → "Your playlists") ==========

type SavedSourceDbRow = {
  id: number;
  kind: SavedSourceKind;
  ref: string;
  name: string;
  custom_name: string | null;
  image_url: string | null;
  owner: string;
  track_count: number;
  to_buy: number;
  maybe_owned: number;
  owned: number;
  not_for_sale: number;
  created_at: number;
  last_checked_at: number;
};

const SAVED_SOURCE_KINDS: readonly SavedSourceKind[] = ['spotify', 'soundcloud', 'csv'];

/**
 * The de-dupe key for a saved source: the same playlist pasted twice (with a
 * different `?si=` share token, `www.`, a trailing slash) is one entry.
 *   - Spotify: the playlist id, from a link, a spotify:playlist: URI or a bare id.
 *   - SoundCloud: host + path, without protocol, www./m., query or trailing slash.
 *     Short on.soundcloud.com links can't be expanded here, so they key as given.
 *   - CSV: the file path (NFC, so an exFAT-decomposed path matches).
 */
export function savedSourceKey(kind: SavedSourceKind, ref: string): string {
  const r = ref.trim();
  if (kind === 'spotify') {
    const id = r.match(/playlist[/:]([A-Za-z0-9]+)/)?.[1] ?? (/^[A-Za-z0-9]{22}$/.test(r) ? r : null);
    return id ? `spotify:playlist:${id}` : `spotify:${r}`;
  }
  if (kind === 'soundcloud') {
    const bare = r
      .replace(/^https?:\/\//i, '')
      .replace(/^(www\.|m\.)/i, '')
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '');
    const slash = bare.indexOf('/');
    const host = (slash === -1 ? bare : bare.slice(0, slash)).toLowerCase();
    return `soundcloud:${host}${slash === -1 ? '' : bare.slice(slash)}`;
  }
  return `csv:${r.normalize('NFC')}`;
}

function toSavedSource(row: SavedSourceDbRow): SavedSource {
  const custom = row.custom_name?.trim() || null;
  return {
    id: row.id,
    kind: row.kind,
    ref: row.ref,
    name: custom ?? row.name,
    originalName: row.name,
    renamed: custom !== null,
    imageUrl: row.image_url,
    owner: row.owner,
    trackCount: row.track_count,
    counts: { toBuy: row.to_buy, maybeOwned: row.maybe_owned, owned: row.owned, notForSale: row.not_for_sale },
    createdAt: row.created_at,
    lastCheckedAt: row.last_checked_at,
  };
}

/** A whole, non-negative number from IPC input (anything else is 0). */
const savedCount = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/** Every saved source, most recently checked first. */
export function listSavedSources(): SavedSource[] {
  const rows = getDb()
    .prepare('SELECT * FROM saved_sources ORDER BY last_checked_at DESC, id DESC')
    .all() as SavedSourceDbRow[];
  return rows.map(toSavedSource);
}

export function getSavedSource(id: number): SavedSource | null {
  const row = getDb().prepare('SELECT * FROM saved_sources WHERE id = ?').get(id) as SavedSourceDbRow | undefined;
  return row ? toSavedSource(row) : null;
}

/**
 * Save a source after a successful check: a new row, or the existing row for
 * the same source (see savedSourceKey) refreshed with this check's name, cover,
 * counts and time. A rename the user gave it is kept. With `keepExisting`, an
 * existing row is returned untouched (used to seed the list from an older
 * session without overwriting a newer check).
 */
export function saveSavedSource(input: SavedSourceInput, opts: { keepExisting?: boolean } = {}): SavedSource {
  if (!SAVED_SOURCE_KINDS.includes(input.kind)) throw new Error(`Unknown source kind: ${String(input.kind)}`);
  const ref = String(input.ref ?? '').trim();
  if (!ref) throw new Error('A saved source needs a link or file path.');
  const key = savedSourceKey(input.kind, ref);
  const database = getDb();
  const existing = database.prepare('SELECT * FROM saved_sources WHERE ref_key = ?').get(key) as SavedSourceDbRow | undefined;
  if (existing && opts.keepExisting) return toSavedSource(existing);

  const checkedAt = savedCount(input.checkedAt) || Date.now();
  const name = String(input.name ?? '').trim() || ref;
  const c = input.counts ?? { toBuy: 0, maybeOwned: 0, owned: 0, notForSale: 0 };
  if (existing) {
    database.prepare(`
      UPDATE saved_sources SET ref = ?, name = ?, image_url = COALESCE(?, image_url), owner = ?,
        track_count = ?, to_buy = ?, maybe_owned = ?, owned = ?, not_for_sale = ?, last_checked_at = ?
      WHERE id = ?
    `).run(ref, name, input.imageUrl ?? null, input.owner ?? existing.owner, savedCount(input.trackCount),
      savedCount(c.toBuy), savedCount(c.maybeOwned), savedCount(c.owned), savedCount(c.notForSale), checkedAt, existing.id);
    return getSavedSource(existing.id)!;
  }
  const res = database.prepare(`
    INSERT INTO saved_sources (kind, ref_key, ref, name, image_url, owner, track_count,
      to_buy, maybe_owned, owned, not_for_sale, created_at, last_checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.kind, key, ref, name, input.imageUrl ?? null, input.owner ?? '', savedCount(input.trackCount),
    savedCount(c.toBuy), savedCount(c.maybeOwned), savedCount(c.owned), savedCount(c.notForSale), checkedAt, checkedAt);
  return getSavedSource(Number(res.lastInsertRowid))!;
}

/** Rename a saved source. An empty name goes back to the playlist's own name. */
export function renameSavedSource(id: number, name: string | null): SavedSource | null {
  const custom = name?.trim() ? name.trim().slice(0, 200) : null;
  getDb().prepare('UPDATE saved_sources SET custom_name = ? WHERE id = ?').run(custom, id);
  return getSavedSource(id);
}

/** Forget a saved source. The playlist itself (or the CSV file) isn't touched. */
export function removeSavedSource(id: number): boolean {
  return getDb().prepare('DELETE FROM saved_sources WHERE id = ?').run(id).changes > 0;
}
