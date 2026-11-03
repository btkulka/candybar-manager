import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { safeDelete, setTrashHandler, hasTrashHandler, setManualTrashDir } from '../safeDelete';
import { initWriteJournal, flushWriteJournal, getWriteJournalDir } from '../writeJournal';

let tmp: string;
let trashDir: string;

async function lastJournalEntry(): Promise<Record<string, unknown>> {
  const dir = getWriteJournalDir()!;
  const files = await fs.readdir(dir);
  const raw = await fs.readFile(path.join(dir, files[0]), 'utf8');
  const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
  return lines[lines.length - 1];
}

describe('safeDelete', () => {
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'safe-delete-test-'));
    trashDir = path.join(tmp, 'Trash');
    // Never touch the real ~/.Trash from a test run.
    setManualTrashDir(trashDir);
    initWriteJournal(tmp);
  });
  afterAll(async () => {
    setManualTrashDir(null);
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  // Order matters: the fallback path must be exercised BEFORE a trash handler is set.
  it('moves into a Trash folder (never unlinks) when no trash handler is set', async () => {
    expect(hasTrashHandler()).toBe(false);
    const f = path.join(tmp, 'a.aif');
    await fs.writeFile(f, 'audio');
    const res = await safeDelete(f, { context: 'test' });
    await flushWriteJournal();

    await expect(fs.access(f)).rejects.toThrow();
    expect(res.method).toBe('manual-trash');
    expect(await fs.readFile(path.join(trashDir, 'a.aif'), 'utf8')).toBe('audio');
    expect(await lastJournalEntry()).toMatchObject({
      op: 'delete', src: f, dest: path.join(trashDir, 'a.aif'), context: 'test', outcome: 'ok',
      detail: { trashed: true, manualTrash: true },
    });
  });

  it('gives a second same-named item a unique Trash name instead of clobbering', async () => {
    const f = path.join(tmp, 'a.aif');
    await fs.writeFile(f, 'second');
    const res = await safeDelete(f, { context: 'test' });
    expect(res.trashPath).not.toBe(path.join(trashDir, 'a.aif'));
    expect(await fs.readFile(path.join(trashDir, 'a.aif'), 'utf8')).toBe('audio');
    expect(await fs.readFile(res.trashPath!, 'utf8')).toBe('second');
  });

  it('throws and journals an error (and keeps the file) when no Trash is usable', async () => {
    const blocker = path.join(tmp, 'not-a-dir');
    await fs.writeFile(blocker, 'x');
    setManualTrashDir(path.join(blocker, 'Trash')); // mkdir under a file fails
    const f = path.join(tmp, 'keep.aif');
    await fs.writeFile(f, 'audio');
    await expect(safeDelete(f, { context: 'test' })).rejects.toThrow();
    await flushWriteJournal();
    expect(await fs.readFile(f, 'utf8')).toBe('audio');
    expect(await lastJournalEntry()).toMatchObject({ op: 'delete', src: f, outcome: 'error' });
    setManualTrashDir(trashDir);
  });

  it('unlinks only when permanent:true is passed explicitly', async () => {
    const f = path.join(tmp, '.DS_Store');
    await fs.writeFile(f, 'junk');
    const res = await safeDelete(f, { context: 'test', permanent: true });
    await flushWriteJournal();
    expect(res.method).toBe('permanent');
    await expect(fs.access(f)).rejects.toThrow();
    expect(await lastJournalEntry()).toMatchObject({ op: 'delete', src: f, outcome: 'ok', detail: { permanent: true } });
  });

  it('routes through the trash handler (recoverable) and journals trashed:true', async () => {
    const trashed: string[] = [];
    setTrashHandler(async (p) => { trashed.push(p); });
    expect(hasTrashHandler()).toBe(true);

    const f = path.join(tmp, 'b.aif');
    await fs.writeFile(f, 'audio');
    await safeDelete(f, { context: 'test' });
    await flushWriteJournal();

    expect(trashed).toEqual([f]);
    // The handler is a no-op that doesn't actually delete → file remains recoverable.
    await expect(fs.access(f)).resolves.toBeUndefined();
    expect(await lastJournalEntry()).toMatchObject({
      op: 'delete', src: f, context: 'test', outcome: 'ok', detail: { trashed: true },
    });
  });
});
