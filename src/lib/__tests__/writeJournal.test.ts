import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  initWriteJournal,
  recordWrite,
  flushWriteJournal,
  getWriteJournalDir,
} from '../writeJournal';
import { safeMove } from '../fileUtils';

let tmp: string;

async function readJournalLines(): Promise<Record<string, unknown>[]> {
  const dir = path.join(tmp, 'write-journal');
  const files = await fs.readdir(dir);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^\d{4}-\d{2}\.jsonl$/);
  const raw = await fs.readFile(path.join(dir, files[0]), 'utf8');
  return raw.trim().split('\n').map((l) => JSON.parse(l));
}

describe('writeJournal', () => {
  afterAll(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it('is a no-op before init', async () => {
    expect(getWriteJournalDir()).toBeNull();
    recordWrite({ op: 'delete', src: '/never-written', outcome: 'ok' });
    await flushWriteJournal();
  });

  it('appends timestamped JSONL entries after init', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'write-journal-test-'));
    initWriteJournal(tmp);

    recordWrite({ op: 'delete', src: '/a.flac', bytes: 123, context: 'convert-cleanup', outcome: 'ok' });
    recordWrite({ op: 'move', src: '/a', dest: '/b', outcome: 'error', error: 'boom' });
    await flushWriteJournal();

    const lines = await readJournalLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      op: 'delete', src: '/a.flac', bytes: 123, context: 'convert-cleanup', outcome: 'ok',
    });
    expect(new Date(lines[0].ts as string).getTime()).toBeGreaterThan(0);
    expect(lines[1]).toMatchObject({ op: 'move', src: '/a', dest: '/b', outcome: 'error', error: 'boom' });
  });

  it('journals safeMove with size and context', async () => {
    const src = path.join(tmp, 'track.aif');
    const dest = path.join(tmp, 'moved.aif');
    await fs.writeFile(src, 'audio-bytes');

    await safeMove(src, dest, 'organize');
    await flushWriteJournal();

    const lines = await readJournalLines();
    expect(lines[lines.length - 1]).toMatchObject({
      op: 'move', src, dest, bytes: 11, context: 'organize', outcome: 'ok',
    });
  });

  it('journals the already-moved no-op case', async () => {
    const src = path.join(tmp, 'track.aif'); // gone — moved by previous test
    const dest = path.join(tmp, 'moved.aif'); // still present

    await safeMove(src, dest, 'organize');
    await flushWriteJournal();

    const lines = await readJournalLines();
    expect(lines[lines.length - 1]).toMatchObject({
      op: 'move', src, dest, context: 'organize', outcome: 'ok',
      detail: { noop: 'already-moved' },
    });
  });
});
