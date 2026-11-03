import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => os.tmpdir()) } }));

// better-sqlite3 is rebuilt for Electron (postinstall), so it only loads under
// Electron's Node. Run these with:
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
//     node_modules/vitest/vitest.mjs run src/lib/__tests__/db.tombstones.test.ts
// Under plain `npx vitest` they skip.
let sqliteLoads = true;
try { new Database(':memory:').close(); } catch { sqliteLoads = false; }

import {
  initDatabase, closeDatabase, getDatabase, recordDownload, getDownloadedTrackPath,
  recordDeletedTrack, isTrackDeleted, updateDownloadedTrackPath, isDatabaseReady,
} from '../db';
import { safeMove } from '../fileUtils';

let tmp: string;

describe.skipIf(!sqliteLoads)('db: deleted-track tombstones and download paths', () => {
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'db-tombstones-'));
    initDatabase(path.join(tmp, 'candybar.db'));
  });
  afterAll(() => {
    closeDatabase();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('records a deletion by store id when the file was a download', () => {
    recordDownload('qobuz', '12345', 'Above & Beyond', 'Sun & Moon', '/intake/sun.aif');
    recordDeletedTrack({ filePath: '/intake/sun.aif' });
    expect(isTrackDeleted({ source: 'qobuz', trackId: '12345' })).toBe(true);
    // ...and by artist + title, picked up from the download row.
    expect(isTrackDeleted({ artist: 'ABOVE & BEYOND', title: 'Sun & Moon' })).toBe(true);
    expect(isTrackDeleted({ source: 'qobuz', trackId: '999' })).toBe(false);
  });

  it('matches by artist + title for non-downloads, keeping versions distinct', () => {
    recordDeletedTrack({ filePath: '/intake/x.mp3', artist: 'Tiësto', title: 'Adagio (Extended Mix)' });
    expect(isTrackDeleted({ artist: 'Tiesto', title: 'Adagio (Extended Mix)' })).toBe(true);
    expect(isTrackDeleted({ artist: 'Tiesto', title: 'Adagio (Radio Edit)' })).toBe(false);
    expect(isTrackDeleted({ artist: '', title: '' })).toBe(false);
  });

  it('finds the download row under the other Unicode form of the path', () => {
    recordDownload('beatport', 'b1', 'Beyoncé', 'Song', '/intake/Beyoncé.aif'); // NFC
    recordDeletedTrack({ filePath: '/intake/Beyoncé.aif' }); // NFD
    expect(isTrackDeleted({ source: 'beatport', trackId: 'b1' })).toBe(true);
  });

  it('follows a moved download so it is not mistaken for "gone"', () => {
    recordDownload('qobuz', 'm1', 'A', 'B', '/intake/b.aif');
    updateDownloadedTrackPath('/intake/b.aif', '/Music/A/b.aif');
    expect(getDownloadedTrackPath('qobuz', 'm1')).toBe('/Music/A/b.aif');
  });

  it('safeMove updates the download record automatically', async () => {
    const src = path.join(tmp, 'dl.aif');
    const dest = path.join(tmp, 'moved.aif');
    fs.writeFileSync(src, 'x');
    recordDownload('qobuz', 'sm1', 'A', 'C', src);
    await safeMove(src, dest, 'organize');
    expect(getDownloadedTrackPath('qobuz', 'sm1')).toBe(dest);
  });

  it('is ready once initialized', () => {
    expect(isDatabaseReady()).toBe(true);
  });
});

describe.skipIf(!sqliteLoads)('db: migrations on an existing database', () => {
  it('adds library_tracks.bpm to an old DB and forces a one-time re-read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-migrate-'));
    const file = path.join(dir, 'candybar.db');
    // An old-shape library_tracks table, with one scanned row.
    const old = new Database(file);
    old.exec(`CREATE TABLE library_tracks (
      library_root TEXT NOT NULL, file_path TEXT NOT NULL, file_name TEXT NOT NULL,
      mtime_ms REAL, size_bytes INTEGER, artist TEXT DEFAULT '', title TEXT DEFAULT '',
      album TEXT DEFAULT '', year INTEGER, genre TEXT DEFAULT '', has_album_art INTEGER DEFAULT 0,
      is_healthy INTEGER DEFAULT 1, date_added INTEGER, container TEXT, codec TEXT,
      sample_rate INTEGER, bit_depth INTEGER, bit_rate INTEGER, channels INTEGER, duration REAL,
      lossless INTEGER, last_scanned INTEGER, PRIMARY KEY (library_root, file_path))`);
    old.prepare(`INSERT INTO library_tracks (library_root, file_path, file_name, mtime_ms) VALUES ('/r', '/r/a.aif', 'a.aif', 123)`).run();
    old.close();

    closeDatabase();
    initDatabase(file);
    const cols = (getDatabase().prepare('PRAGMA table_info(library_tracks)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain('bpm');
    expect(cols).toContain('integrity_mtime');
    const row = getDatabase().prepare('SELECT mtime_ms FROM library_tracks').get() as { mtime_ms: number | null };
    expect(row.mtime_ms).toBeNull(); // next scan re-reads it and fills bpm

    // Re-opening doesn't wipe fingerprints again.
    getDatabase().prepare('UPDATE library_tracks SET mtime_ms = 456').run();
    closeDatabase();
    initDatabase(file);
    expect((getDatabase().prepare('SELECT mtime_ms FROM library_tracks').get() as { mtime_ms: number }).mtime_ms).toBe(456);
    closeDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
