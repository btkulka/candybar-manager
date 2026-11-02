// The history is the permanent record, so double-counting and data loss are
// the two failures that matter.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { recordEvents, readHistory, queryHistory, eventFromRow } from '../history.mjs';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-hist-')), 'h.jsonl');

describe('sourcing history', () => {
  it('records each event once across repeated writes', () => {
    const f = tmp();
    const e = { event: 'downloaded', source: 'soundcloud', id: 1, artist: 'A', title: 'T' };
    expect(recordEvents([e, e], f).added).toBe(1);
    expect(recordEvents([e], f).added).toBe(0);
    expect(recordEvents([{ ...e, event: 'purchased', source: 'beatport' }], f).added).toBe(1);
    expect(readHistory(f)).toHaveLength(2);
  });

  it('survives a torn last line and keeps appending', () => {
    const f = tmp();
    recordEvents([{ event: 'downloaded', source: 'soundcloud', id: 1 }], f);
    fs.appendFileSync(f, '{"event":"down');
    expect(readHistory(f)).toHaveLength(1);
  });

  it('reports a write failure instead of throwing', () => {
    const r = recordEvents([{ event: 'downloaded', source: 'soundcloud', id: 1 }], '/dev/null/nope/h.jsonl');
    expect(r.added).toBe(0);
    expect(r.error).toBeTruthy();
  });

  it('classifies a row by what happened to its files', () => {
    const row = { scId: 1, artist: 'A', title: 'T' };
    expect(eventFromRow(row, { files: [{ path: 'x', lossless: true }] }).event).toBe('downloaded');
    expect(eventFromRow(row, { files: [{ path: 'x', lossless: false }] }).event).toBe('lossy-kept');
    expect(eventFromRow(row, { files: [], dropped: [{ codec: 'mp3' }] }).event).toBe('lossy-dropped');
    expect(eventFromRow(row, { files: [] })).toBeNull();
    expect(eventFromRow(row, { status: 'duplicate', files: [], dropped: [{ codec: 'pcm_s24le' }] })).toBeNull();
    expect(eventFromRow(row, { files: [{ path: 'x', lossless: true }], dropped: [{ codec: 'pcm_s24le', reason: 'already in library' }] }).deleted).toBeUndefined();
  });

  it('filters and sorts newest first', () => {
    const f = tmp();
    recordEvents([
      { at: '2026-01-01T00:00:00Z', event: 'downloaded', source: 'soundcloud', id: 1, artist: 'Old', title: 'One' },
      { at: '2026-06-01T00:00:00Z', event: 'purchased', source: 'beatport', id: 2, artist: 'New', title: 'Two' },
    ], f);
    expect(queryHistory({ file: f }).map(e => e.id)).toEqual([2, 1]);
    expect(queryHistory({ file: f, event: 'purchased' })).toHaveLength(1);
    expect(queryHistory({ file: f, since: '2026-03-01' })).toHaveLength(1);
    expect(queryHistory({ file: f, search: 'old' })).toHaveLength(1);
  });
});
