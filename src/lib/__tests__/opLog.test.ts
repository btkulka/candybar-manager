import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  initOpLog, resetOpLog, flushOpLog, withOp, startOp, currentOp, recordEvent, summarize,
} from '../opLog';
import { listOps, getOp, readTextLog, textLogFiles, queryWriteJournal, type OpEvent } from '../logQuery';

let userData: string;
let opsDir: string;

function events(): OpEvent[] {
  return fs.readdirSync(opsDir).sort().flatMap((n) =>
    fs.readFileSync(path.join(opsDir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'oplog-'));
  opsDir = initOpLog(userData, { proc: 'app' });
});

afterEach(() => {
  resetOpLog();
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('summarize', () => {
  it('redacts anything named like a secret, at any depth', () => {
    const out = summarize({ spotifyClientSecret: 's3cret', claudeOauthToken: 'tok', nested: { lalalApiKey: 'k', password: 'p' }, key: '8A', empty: '' }) as any;
    expect(out.spotifyClientSecret).toBe('[redacted]');
    expect(out.claudeOauthToken).toBe('[redacted]');
    expect(out.nested).toEqual({ lalalApiKey: '[redacted]', password: '[redacted]' });
    expect(out.key).toBe('8A'); // a musical key isn't a secret
    expect(out.empty).toBe('');
  });

  it('cuts long strings, samples long lists, and survives cycles', () => {
    const cyclic: any = { name: 'a' };
    cyclic.self = cyclic;
    const out = summarize({ text: 'x'.repeat(1000), list: Array.from({ length: 20 }, (_, i) => i), cyclic }, { maxString: 10, maxItems: 3 }) as any;
    expect(out.text).toBe('xxxxxxxxxx…(+990 chars)');
    expect(out.list).toEqual([0, 1, 2, '…17 more (20 total)']);
    expect(out.cyclic.self).toBe('[circular]');
  });

  it('keeps a shared (not circular) object both times it appears', () => {
    const shared = { a: 1 };
    expect(summarize({ x: shared, y: shared })).toEqual({ x: { a: 1 }, y: { a: 1 } });
  });

  it('describes inline images and buffers instead of copying them', () => {
    const out = summarize({ art: `data:image/jpeg;base64,${'A'.repeat(5000)}`, buf: Buffer.alloc(64) }) as any;
    expect(out.art).toMatch(/^data:image\/jpeg;base64,…\[\d+ chars\]$/);
    expect(out.buf).toBe('[64 bytes]');
  });
});

describe('withOp', () => {
  it('records start and end with the arguments and a result summary', async () => {
    const result = await withOp('organize-tracks', { source: 'ui', args: { tracks: [{ filePath: '/a.aif' }] } }, async () => ({ success: true, moved: 1 }));
    expect(result).toEqual({ success: true, moved: 1 });
    await flushOpLog();
    const [start, end] = events();
    expect(start).toMatchObject({ ev: 'start', name: 'organize-tracks', source: 'ui', args: { tracks: [{ filePath: '/a.aif' }] }, proc: 'app', pid: process.pid });
    expect(end).toMatchObject({ ev: 'end', op: start.op, outcome: 'ok', result: { success: true, moved: 1 } });
  });

  it('counts { success: false } and thrown errors as failures', async () => {
    await withOp('a', {}, async () => ({ success: false, error: 'Drive not mounted' }));
    await expect(withOp('b', {}, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await flushOpLog();
    const ends = events().filter((e) => e.ev === 'end');
    expect(ends.map((e) => [e.outcome, e.error])).toEqual([['error', 'Drive not mounted'], ['error', 'boom']]);
  });

  it('makes the operation current inside its work, and links operations it starts', async () => {
    let inner: string | undefined;
    await withOp('outer', { source: 'claude' }, async (outer) => {
      await new Promise((r) => setTimeout(r, 1));
      expect(currentOp()?.id).toBe(outer.id);
      await withOp('inner', {}, async (op) => { inner = op.id; });
    });
    expect(currentOp()).toBeUndefined();
    await flushOpLog();
    const innerStart = events().find((e) => e.ev === 'start' && e.op === inner)!;
    expect(innerStart.source).toBe('claude'); // inherited
    expect(innerStart.parent).toMatch(/^app-/);
  });

  it('throttles progress per channel but always keeps the last message', async () => {
    await withOp('scan', {}, async (op) => {
      for (let i = 1; i <= 50; i++) op.progress('scan-progress', { current: i, total: 50 });
      op.progress('other', 'once');
    });
    await flushOpLog();
    const progress = events().filter((e) => e.ev === 'progress');
    expect(progress.map((e) => [e.channel, (e.data as any)?.current ?? e.data])).toEqual([
      ['scan-progress', 1], ['other', 'once'], ['scan-progress', 50],
    ]);
  });

  it('drops a quiet operation that succeeded fast, keeps one that failed', async () => {
    await withOp('get-track-album-art', {}, async () => 'data:…', { quiet: true });
    await withOp('list-volumes', {}, async () => { throw new Error('diskutil failed'); }, { quiet: true }).catch(() => {});
    await flushOpLog();
    expect(events().map((e) => [e.name ?? e.ev, e.ev])).toEqual([['list-volumes', 'start'], ['end', 'end']]);
  });

  it('records output and log lines, counting past the limit instead of writing', async () => {
    await withOp('organize', {}, async (op) => {
      op.label('Organizing tracks');
      op.output('Moved a.aif\n', 'stdout');
      op.log('warn', 'Organize', 'Skipped b.mp3');
    });
    await flushOpLog();
    expect(events().map((e) => e.ev)).toEqual(['start', 'label', 'output', 'log', 'end']);
    expect(events()[2].text).toBe('Moved a.aif');
  });
});

describe('reading operations back', () => {
  it('lists newest first with status, label and counts, and filters', async () => {
    await withOp('scan-tracks', { source: 'ui', args: { sourceDir: '/Volumes/Intake' } }, async (op) => {
      op.label('Scanning tracks to organize');
      op.output('found 3');
    });
    await withOp('search_beatport', { source: 'claude' }, async () => ({ error: 'nope' }), { failure: (r) => (r as any).error });
    recordEvent('app:start', { source: 'app' });
    const running = startOp('organize-tracks', { source: 'ui' });
    await flushOpLog();

    const all = listOps(opsDir);
    expect(all.map((o) => o.name)).toEqual(['organize-tracks', 'app:start', 'search_beatport', 'scan-tracks']);
    expect(all[0].status).toBe('running');
    expect(all[2]).toMatchObject({ status: 'error', error: 'nope', source: 'claude' });
    expect(all[3]).toMatchObject({ status: 'ok', label: 'Scanning tracks to organize', counts: { output: 1 } });

    expect(listOps(opsDir, { status: 'error' }).map((o) => o.name)).toEqual(['search_beatport']);
    expect(listOps(opsDir, { name: 'scanning' }).map((o) => o.name)).toEqual(['scan-tracks']);
    expect(listOps(opsDir, { search: '/volumes/intake' }).map((o) => o.name)).toEqual(['scan-tracks']);
    expect(listOps(opsDir, { source: 'app' }).map((o) => o.name)).toEqual(['app:start']);
    running.end('ok');
  });

  it('marks an operation whose process died as interrupted', () => {
    const ts = new Date().toISOString();
    const day = path.join(opsDir, `${ts.slice(0, 10)}.jsonl`);
    // pid 2^22+1 is above any real pid on macOS/Linux defaults.
    fs.appendFileSync(day, JSON.stringify({ ts, op: `app-${Date.now().toString(36)}-z`, ev: 'start', name: 'organize-tracks', pid: 4194305 }) + '\n');
    expect(listOps(opsDir, { since: new Date(Date.now() - 86_400_000) })[0].status).toBe('interrupted');
  });

  it('expands one operation with its events and the operations it started', async () => {
    let parentId = '';
    await withOp('download_track', { source: 'claude' }, async (op) => {
      parentId = op.id;
      op.progress('bridge', 'Downloading…');
      await withOp('store-download-purchases', { source: 'claude' }, async () => ({ success: true }));
    });
    await flushOpLog();
    const op = getOp(opsDir, parentId)!;
    expect(op.summary.name).toBe('download_track');
    expect(op.events.map((e) => e.ev)).toEqual(['start', 'progress', 'end']);
    expect(op.children.map((c) => c.name)).toEqual(['store-download-purchases']);
    expect(getOp(opsDir, parentId, { events: ['progress'] })!.events).toHaveLength(1);
    expect(getOp(opsDir, 'app-nope-0')).toBeNull();
  });
});

describe('text logs and the write journal', () => {
  it('reads the newest matching entries across archives, keeping stack lines', () => {
    const logs = path.join(userData, 'logs');
    fs.writeFileSync(path.join(logs, 'main-2026-11-01.log'), '[2026-11-01 10:00:00.000] [error] (Main) old failure\n');
    fs.writeFileSync(path.join(logs, 'main.log'), [
      '[2026-11-04 10:00:00.000] [info] (Main) App ready',
      '[2026-11-04 10:00:01.000] [error] (Organize) Move failed',
      '    at safeMove (fileUtils.ts:10)',
      '[2026-11-04 10:00:02.000] [debug] (Scan) 3 files',
    ].join('\n'));
    const files = textLogFiles(logs, 'main');
    expect(files.map((f) => path.basename(f))).toEqual(['main-2026-11-01.log', 'main.log']);
    expect(readTextLog(files, { level: 'error' })).toEqual([
      '[2026-11-01 10:00:00.000] [error] (Main) old failure',
      '[2026-11-04 10:00:01.000] [error] (Organize) Move failed\n    at safeMove (fileUtils.ts:10)',
    ]);
    expect(readTextLog(files, { lines: 1 })).toEqual(['[2026-11-04 10:00:02.000] [debug] (Scan) 3 files']);
    expect(readTextLog(files, { search: 'ready' })).toHaveLength(1);
  });

  it('queries the write journal newest first', () => {
    const dir = path.join(userData, 'write-journal');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '2026-11.jsonl'), [
      { ts: '2026-11-03T10:00:00Z', op: 'move', src: '/in/Artist - Title.aif', outcome: 'ok' },
      { ts: '2026-11-04T10:00:00Z', op: 'delete', src: '/lib/other.mp3', outcome: 'ok' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    expect(queryWriteJournal(dir).map((e) => e.op)).toEqual(['delete', 'move']);
    expect(queryWriteJournal(dir, { search: 'artist - title' }).map((e) => e.op)).toEqual(['move']);
    expect(queryWriteJournal(dir, { op: 'delete' })).toHaveLength(1);
  });
});
