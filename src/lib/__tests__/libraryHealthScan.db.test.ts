import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => os.tmpdir()) } }));
// Count byte-swap reads so the per-fingerprint cache can be checked.
vi.mock('../audioIntegrityCheck', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../audioIntegrityCheck')>();
  return { ...orig, checkAiffIntegrity: vi.fn(orig.checkAiffIntegrity) };
});

// Needs better-sqlite3, which is built for Electron. Run with Electron as Node
// (see db.tombstones.test.ts); skips under plain `npx vitest`.
let sqliteLoads = true;
try { new Database(':memory:').close(); } catch { sqliteLoads = false; }

import { initDatabase, closeDatabase } from '../db';
import { scanLibraryHealth } from '../libraryHealthScan';
import { getScanRun, getTracksForRoot } from '../libraryStore';
import { checkAiffIntegrity } from '../audioIntegrityCheck';

let tmp: string;
let lib: string;

function aiff(out: string, artist: string, bpm: string): void {
  const r = spawnSync(ffmpegPath as unknown as string, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=duration=12', '-ac', '2', '-c:a', 'pcm_s16be',
    '-metadata', `artist=${artist}`, '-metadata', 'title=Song', '-metadata', `TBPM=${bpm}`,
    '-write_id3v2', '1', out]);
  if (r.status !== 0) throw new Error(r.stderr.toString());
}

describe.skipIf(!sqliteLoads)('scanLibraryHealth with the real DB', () => {
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'health-db-'));
    lib = path.join(tmp, 'Music');
    fs.mkdirSync(path.join(lib, 'A'), { recursive: true });
    fs.mkdirSync(path.join(lib, 'B'), { recursive: true });
    aiff(path.join(lib, 'A', 'a.aif'), 'A', '124');
    aiff(path.join(lib, 'B', 'b.aif'), 'B', '128');
    initDatabase(path.join(tmp, 'candybar.db'));
  });
  afterAll(() => {
    closeDatabase();
    try { fs.chmodSync(path.join(lib, 'B'), 0o755); } catch { /* already restored */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('stores BPM from tags', async () => {
    const r = await scanLibraryHealth({ libraryRoot: lib });
    expect(r.summary.total).toBe(2);
    expect(Object.fromEntries(r.tracks.map(t => [path.basename(t.filePath), t.bpm]))).toEqual({ 'a.aif': 124, 'b.aif': 128 });
  });

  it("doesn't re-read unchanged AIFFs for the byte-swap check", async () => {
    vi.mocked(checkAiffIntegrity).mockClear();
    await scanLibraryHealth({ libraryRoot: lib });
    expect(checkAiffIntegrity).not.toHaveBeenCalled();
  });

  it('keeps rows under a folder it could not read instead of pruning them', async () => {
    fs.chmodSync(path.join(lib, 'B'), 0o000);
    try {
      await scanLibraryHealth({ libraryRoot: lib });
      expect(getTracksForRoot(lib).map(t => path.basename(t.filePath)).sort()).toEqual(['a.aif', 'b.aif']);
    } finally {
      fs.chmodSync(path.join(lib, 'B'), 0o755);
    }
  });

  it('an empty walk writes nothing and returns the last good snapshot', async () => {
    const before = getScanRun(lib)!;
    const parked = path.join(tmp, 'parked');
    fs.renameSync(lib, parked);
    fs.mkdirSync(lib); // root exists but is empty, like a stale mount point
    try {
      const r = await scanLibraryHealth({ libraryRoot: lib });
      expect(r.summary.total).toBe(2);
      expect(r.tracks).toHaveLength(2);
      expect(getScanRun(lib)).toEqual(before);
    } finally {
      fs.rmdirSync(lib);
      fs.renameSync(parked, lib);
    }
  });

  it('keeps the "Library directory not found" message for a missing root', async () => {
    await expect(scanLibraryHealth({ libraryRoot: path.join(tmp, 'nope') })).rejects.toThrow(/Library directory not found/);
  });

  it('stops when cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(scanLibraryHealth({ libraryRoot: lib, signal: ac.signal })).rejects.toThrow(/cancel/i);
  });
});
