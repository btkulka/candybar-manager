import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { safeMove, walkAudioDir, isTransientAudioName, isPathUnder } from '../fileUtils';
import { SharedResultStore } from '../jobQueue/sharedResultStore';

let tmp: string;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'safemove-')); });
afterEach(async () => { if (tmp) await fs.rm(tmp, { recursive: true, force: true }); });

describe('safeMove', () => {
  it('moves a file to a free destination', async () => {
    const src = path.join(tmp, 'a.aif');
    const dest = path.join(tmp, 'b.aif');
    await fs.writeFile(src, 'x');
    await safeMove(src, dest);
    await expect(fs.access(src)).rejects.toThrow();
    expect(await fs.readFile(dest, 'utf8')).toBe('x');
  });

  it('refuses to overwrite a DIFFERENT existing destination', async () => {
    const src = path.join(tmp, 'a.aif');
    const dest = path.join(tmp, 'b.aif');
    await fs.writeFile(src, 'source');
    await fs.writeFile(dest, 'existing');
    await expect(safeMove(src, dest)).rejects.toMatchObject({ code: 'EEXIST' });
    // Both files remain untouched — no silent clobber.
    expect(await fs.readFile(src, 'utf8')).toBe('source');
    expect(await fs.readFile(dest, 'utf8')).toBe('existing');
  });

  it('overwrites when overwrite:true is explicitly passed', async () => {
    const src = path.join(tmp, 'a.aif');
    const dest = path.join(tmp, 'b.aif');
    await fs.writeFile(src, 'source');
    await fs.writeFile(dest, 'existing');
    await safeMove(src, dest, 'test', { overwrite: true });
    expect(await fs.readFile(dest, 'utf8')).toBe('source');
  });

  it('treats source-missing + destination-present as an already-moved no-op', async () => {
    const src = path.join(tmp, 'gone.aif');
    const dest = path.join(tmp, 'here.aif');
    await fs.writeFile(dest, 'x');
    await expect(safeMove(src, dest)).resolves.toBeUndefined();
    expect(await fs.readFile(dest, 'utf8')).toBe('x');
  });

  it('drops cached library file lists after a move', async () => {
    const store = new SharedResultStore();
    store.set('library-file-list', 'r', { libraryRoot: 'r', files: ['x'], discoveredAt: 0 });
    const src = path.join(tmp, 'a.aif');
    await fs.writeFile(src, 'x');
    await safeMove(src, path.join(tmp, 'b.aif'));
    expect(store.get('library-file-list', 'r')).toBeNull();
  });
});

// Simulate a cross-volume move: the first rename reports EXDEV so safeMove
// takes the copy + verify + rename-into-place path.
describe('safeMove across filesystems (EXDEV)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function exdevOnFirstRename() {
    const real = fs.rename.bind(fs);
    let first = true;
    return vi.spyOn(fs, 'rename').mockImplementation(async (a, b) => {
      if (first) {
        first = false;
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
      }
      return real(a, b);
    });
  }

  it('copies, verifies, then removes the source', async () => {
    exdevOnFirstRename();
    const src = path.join(tmp, 'a.aif');
    const dest = path.join(tmp, 'b.aif');
    await fs.writeFile(src, 'audio-bytes');
    await safeMove(src, dest);
    expect(await fs.readFile(dest, 'utf8')).toBe('audio-bytes');
    await expect(fs.access(src)).rejects.toThrow();
    expect((await fs.readdir(tmp)).filter(n => n.includes('.partial-'))).toEqual([]);
  });

  it('leaves no partial at the destination and keeps the source when the copy fails', async () => {
    exdevOnFirstRename();
    vi.spyOn(fs, 'copyFile').mockRejectedValueOnce(Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }));
    const src = path.join(tmp, 'a.aif');
    const dest = path.join(tmp, 'b.aif');
    await fs.writeFile(src, 'audio-bytes');
    await expect(safeMove(src, dest)).rejects.toThrow(/ENOSPC/);
    expect(await fs.readFile(src, 'utf8')).toBe('audio-bytes');
    await expect(fs.access(dest)).rejects.toThrow();
    expect((await fs.readdir(tmp)).filter(n => n.includes('.partial-'))).toEqual([]);
  });
});

describe('walkAudioDir', () => {
  it('skips hidden files and this app\'s temp files, honours maxDepth, and reports unreadable dirs', async () => {
    await fs.mkdir(path.join(tmp, 'A', 'deep', 'deeper'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'top.aif'), 'x');
    await fs.writeFile(path.join(tmp, 'A', 'one.mp3'), 'x');
    await fs.writeFile(path.join(tmp, 'A', 'deep', 'deeper', 'three.flac'), 'x');
    await fs.writeFile(path.join(tmp, '.hidden.aif'), 'x');
    await fs.writeFile(path.join(tmp, 'song.converting-1730000000000-abc123.aif'), 'x');
    await fs.writeFile(path.join(tmp, 'song_tagtmp.aiff'), 'x');
    await fs.writeFile(path.join(tmp, 'notes.txt'), 'x');
    await fs.writeFile(path.join(tmp, 'take.aifc'), 'x');

    const all = (await walkAudioDir(tmp)).map(f => path.relative(tmp, f)).sort();
    expect(all).toEqual(['A/deep/deeper/three.flac', 'A/one.mp3', 'take.aifc', 'top.aif']);

    const shallow = (await walkAudioDir(tmp, { maxDepth: 1 })).map(f => path.relative(tmp, f)).sort();
    expect(shallow).toEqual(['A/one.mp3', 'take.aifc', 'top.aif']);

    const failedDirs: string[] = [];
    await walkAudioDir(path.join(tmp, 'missing'), { failedDirs });
    expect(failedDirs).toEqual([path.join(tmp, 'missing')]);
  });

  it('stops when the signal is aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(walkAudioDir(tmp, { signal: ac.signal })).rejects.toThrow(/cancel/i);
  });

  it('classifies temp names and nested paths', () => {
    expect(isTransientAudioName('X.converting-123-ab12cd.aif')).toBe(true);
    expect(isTransientAudioName('X_tagtmp.aiff')).toBe(true);
    expect(isTransientAudioName('.X.aif.partial-123')).toBe(true);
    expect(isTransientAudioName('Converting People.aif')).toBe(false);
    expect(isPathUnder('/a/b/c.aif', ['/a/b'])).toBe(true);
    expect(isPathUnder('/a/bc/c.aif', ['/a/b'])).toBe(false);
  });
});
