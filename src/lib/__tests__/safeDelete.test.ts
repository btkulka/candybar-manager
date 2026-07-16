import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { safeDelete, setTrashHandler, hasTrashHandler } from '../safeDelete';
import { initWriteJournal, flushWriteJournal, getWriteJournalDir } from '../writeJournal';

let tmp: string;

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
    initWriteJournal(tmp);
  });
  afterAll(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  // Order matters: the fallback path must be exercised BEFORE a trash handler is set.
  it('permanently unlinks and journals trashed:false when no trash handler is set', async () => {
    expect(hasTrashHandler()).toBe(false);
    const f = path.join(tmp, 'a.aif');
    await fs.writeFile(f, 'audio');
    await safeDelete(f, { context: 'test' });
    await flushWriteJournal();

    await expect(fs.access(f)).rejects.toThrow(); // actually gone
    expect(await lastJournalEntry()).toMatchObject({
      op: 'delete', src: f, context: 'test', outcome: 'ok', detail: { trashed: false },
    });
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
