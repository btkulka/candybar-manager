import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => os.tmpdir()) } }));

// better-sqlite3 is rebuilt for Electron (postinstall), so it only loads under
// Electron's Node. Run these with:
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
//     node_modules/vitest/vitest.mjs run src/lib/__tests__/db.savedSources.test.ts
// Under plain `npx vitest` the DB cases skip (savedSourceKey still runs).
let sqliteLoads = true;
try { new Database(':memory:').close(); } catch { sqliteLoads = false; }

import {
  initDatabase, closeDatabase, getDatabase, savedSourceKey, listSavedSources, saveSavedSource,
  renameSavedSource, removeSavedSource, getSavedSource,
} from '../db';
import type { SavedSourceInput } from '../../types';

const counts = (toBuy = 0, maybeOwned = 0, owned = 0, notForSale = 0) => ({ toBuy, maybeOwned, owned, notForSale });

const spotify = (over: Partial<SavedSourceInput> = {}): SavedSourceInput => ({
  kind: 'spotify',
  ref: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc123',
  name: '2026 Prospects',
  imageUrl: 'https://i.scdn.co/image/cover.jpg',
  owner: 'Ben Kulka',
  trackCount: 43,
  counts: counts(18, 8, 17, 0),
  checkedAt: 1_761_800_000_000,
  ...over,
});

describe('savedSourceKey', () => {
  it('keys a Spotify playlist by its id, whatever form it was pasted in', () => {
    const k = 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M';
    expect(savedSourceKey('spotify', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc')).toBe(k);
    expect(savedSourceKey('spotify', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')).toBe(k);
    expect(savedSourceKey('spotify', 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M')).toBe(k);
    expect(savedSourceKey('spotify', '  37i9dQZF1DXcBWIGoYBM5M ')).toBe(k);
  });

  it('keys a SoundCloud set by host + path, ignoring protocol, www, query and trailing slash', () => {
    const k = 'soundcloud:soundcloud.com/nhi-dj/sets/warmup';
    expect(savedSourceKey('soundcloud', 'https://soundcloud.com/nhi-dj/sets/warmup')).toBe(k);
    expect(savedSourceKey('soundcloud', 'http://www.SoundCloud.com/nhi-dj/sets/warmup/')).toBe(k);
    expect(savedSourceKey('soundcloud', 'https://m.soundcloud.com/nhi-dj/sets/warmup?utm_source=x')).toBe(k);
    // A secret link's token is part of the set, so two tokens stay two sets.
    expect(savedSourceKey('soundcloud', 'https://soundcloud.com/nhi-dj/sets/warmup/s-AbC12'))
      .not.toBe(savedSourceKey('soundcloud', 'https://soundcloud.com/nhi-dj/sets/warmup/s-XyZ98'));
  });

  it('keys a CSV by its path, matching NFC and NFD spellings', () => {
    const nfc = '/Users/ben/Lists/Tiësto.csv'.normalize('NFC');
    const nfd = nfc.normalize('NFD');
    expect(savedSourceKey('csv', nfd)).toBe(savedSourceKey('csv', nfc));
    expect(savedSourceKey('csv', '/a/one.csv')).not.toBe(savedSourceKey('csv', '/a/two.csv'));
  });
});

let tmp: string;

describe.skipIf(!sqliteLoads)('db: saved sources', () => {
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'db-saved-sources-'));
    initDatabase(path.join(tmp, 'candybar.db'));
  });
  afterAll(() => {
    closeDatabase();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(() => {
    getDatabase().exec('DELETE FROM saved_sources');
  });

  it('saves a checked playlist with its counts and cover', () => {
    const s = saveSavedSource(spotify());
    expect(s).toMatchObject({
      kind: 'spotify',
      name: '2026 Prospects',
      originalName: '2026 Prospects',
      renamed: false,
      imageUrl: 'https://i.scdn.co/image/cover.jpg',
      owner: 'Ben Kulka',
      trackCount: 43,
      counts: { toBuy: 18, maybeOwned: 8, owned: 17, notForSale: 0 },
      createdAt: 1_761_800_000_000,
      lastCheckedAt: 1_761_800_000_000,
    });
    expect(listSavedSources()).toHaveLength(1);
  });

  it('de-dupes the same playlist pasted with a different share link, refreshing its counts', () => {
    const first = saveSavedSource(spotify());
    const again = saveSavedSource(spotify({
      ref: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
      trackCount: 45,
      counts: counts(3, 1, 41, 0),
      imageUrl: null,
      checkedAt: 1_761_900_000_000,
    }));
    expect(again.id).toBe(first.id);
    expect(listSavedSources()).toHaveLength(1);
    expect(again.trackCount).toBe(45);
    expect(again.counts).toEqual({ toBuy: 3, maybeOwned: 1, owned: 41, notForSale: 0 });
    expect(again.createdAt).toBe(1_761_800_000_000);
    expect(again.lastCheckedAt).toBe(1_761_900_000_000);
    // A check that brought no cover keeps the one already saved.
    expect(again.imageUrl).toBe('https://i.scdn.co/image/cover.jpg');
  });

  it('keeps a rename across later checks, and an empty rename goes back to the original name', () => {
    const s = saveSavedSource(spotify());
    const renamed = renameSavedSource(s.id, '  Warm-up ideas  ');
    expect(renamed).toMatchObject({ name: 'Warm-up ideas', originalName: '2026 Prospects', renamed: true });

    const rechecked = saveSavedSource(spotify({ name: '2026 Prospects (new name on Spotify)' }));
    expect(rechecked).toMatchObject({ name: 'Warm-up ideas', originalName: '2026 Prospects (new name on Spotify)', renamed: true });

    expect(renameSavedSource(s.id, '   ')).toMatchObject({ name: '2026 Prospects (new name on Spotify)', renamed: false });
    expect(renameSavedSource(s.id, null)?.renamed).toBe(false);
  });

  it('lists the most recently checked first', () => {
    saveSavedSource(spotify({ checkedAt: 1_000 }));
    saveSavedSource({ kind: 'soundcloud', ref: 'https://soundcloud.com/nhi-dj/sets/warmup', name: 'Warmup', trackCount: 12, counts: counts(5), checkedAt: 3_000 });
    saveSavedSource({ kind: 'csv', ref: '/Users/ben/Lists/gig.csv', name: 'gig', trackCount: 20, counts: counts(2, 0, 18), checkedAt: 2_000 });
    expect(listSavedSources().map(s => s.kind)).toEqual(['soundcloud', 'csv', 'spotify']);
  });

  it('with keepExisting, seeds a new entry but never overwrites a newer check', () => {
    const fresh = saveSavedSource(spotify({ checkedAt: 5_000, counts: counts(1) }));
    const seeded = saveSavedSource(spotify({ checkedAt: 1_000, counts: counts(18) }), { keepExisting: true });
    expect(seeded.id).toBe(fresh.id);
    expect(seeded.counts.toBuy).toBe(1);
    expect(seeded.lastCheckedAt).toBe(5_000);

    const other = saveSavedSource({ kind: 'csv', ref: '/x/new.csv', name: 'new', trackCount: 1, counts: counts() }, { keepExisting: true });
    expect(getSavedSource(other.id)?.name).toBe('new');
  });

  it('removes an entry, and removing it again reports nothing removed', () => {
    const s = saveSavedSource(spotify());
    expect(removeSavedSource(s.id)).toBe(true);
    expect(removeSavedSource(s.id)).toBe(false);
    expect(getSavedSource(s.id)).toBeNull();
    expect(listSavedSources()).toEqual([]);
  });

  it('cleans up bad input: unknown kinds and empty refs are refused, odd counts become 0', () => {
    expect(() => saveSavedSource({ ...spotify(), kind: 'tidal' as never })).toThrow(/Unknown source kind/);
    expect(() => saveSavedSource({ ...spotify(), ref: '   ' })).toThrow(/link or file path/);
    const s = saveSavedSource(spotify({ name: '', trackCount: -4, counts: { toBuy: Number.NaN, maybeOwned: 2.6, owned: -1, notForSale: 1 } }));
    expect(s.name).toBe(s.ref); // falls back to the link rather than a blank row
    expect(s.trackCount).toBe(0);
    expect(s.counts).toEqual({ toBuy: 0, maybeOwned: 3, owned: 0, notForSale: 1 });
  });

  it('survives a reopen (the table is created once, not reset)', () => {
    saveSavedSource(spotify());
    closeDatabase();
    initDatabase(path.join(tmp, 'candybar.db'));
    expect(listSavedSources()).toHaveLength(1);
  });
});
