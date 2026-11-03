import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Restore's store stages pull in Electron sessions, so the store module is
// mocked: tests either switch every source off or drive the mocks directly.
vi.mock('../storePurchase', () => ({
  fetchAllBeatportPurchases: vi.fn(), downloadBeatportPurchases: vi.fn(),
  fetchAllQobuzPurchases: vi.fn(), downloadQobuzPurchases: vi.fn(),
  matchesOwnedTrack: vi.fn(), LEGACY_ACCOUNT_ID: 'legacy',
}));

import { restoreLibrary } from '../restoreLibrary';
import * as store from '../storePurchase';

let tmp: string;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-missing-')); });
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const noSources = { usb: false, beatport: false, qobuz: false, soundcloud: false };

async function writeXml(tracks: { id: string; artist: string; name: string; location: string }[]): Promise<string> {
  const xmlPath = path.join(tmp, 'collection.xml');
  const body = tracks.map(t =>
    `<TRACK TrackID="${t.id}" Name="${t.name}" Artist="${t.artist}" Location="${t.location}"></TRACK>`).join('\n');
  await fs.writeFile(xmlPath, `<?xml version="1.0"?><DJ_PLAYLISTS><COLLECTION>${body}</COLLECTION></DJ_PLAYLISTS>`);
  return xmlPath;
}

describe('restoreLibrary: deciding what is missing', () => {
  it('throws "Library directory not found" instead of reporting everything missing', async () => {
    const xmlPath = await writeXml([{ id: '1', artist: 'A', name: 'T', location: 'file://localhost/x/A/T.aif' }]);
    await expect(restoreLibrary({
      xmlPath, libraryRoot: path.join(tmp, 'not-mounted'), stageDir: path.join(tmp, 'stage'),
      sources: noSources, concurrency: 1,
    })).rejects.toThrow(/Library directory not found/);
  });

  it('refuses an empty library walk rather than marking the whole collection missing', async () => {
    const lib = path.join(tmp, 'Music');
    await fs.mkdir(lib);
    const xmlPath = await writeXml([{ id: '1', artist: 'A', name: 'T', location: 'file://localhost/x/A/T.aif' }]);
    await expect(restoreLibrary({
      xmlPath, libraryRoot: lib, stageDir: path.join(tmp, 'stage'), sources: noSources, concurrency: 1,
    })).rejects.toThrow(/no audio files/);
  });

  it('finds owned files whose names carry XML entities or a different Unicode form', async () => {
    const lib = path.join(tmp, 'Music');
    await fs.mkdir(path.join(lib, 'Above & Beyond'), { recursive: true });
    await fs.mkdir(path.join(lib, 'Beyonce'), { recursive: true });
    await fs.writeFile(path.join(lib, 'Above & Beyond', "Don't Stop.aif"), 'x');
    // On disk in NFD; the XML location below is NFC.
    await fs.writeFile(path.join(lib, 'Beyonce', 'Café.aif'), 'x');
    const xmlPath = await writeXml([
      { id: '1', artist: 'Above &amp; Beyond', name: 'Don&apos;t Stop',
        location: "file://localhost/Old/Above%20&amp;%20Beyond/Don't%20Stop.aif" },
      { id: '2', artist: 'Beyonce', name: 'Café', location: `file://localhost/Old/Beyonce/${encodeURIComponent('Café')}.aif` },
      { id: '3', artist: 'Gone', name: 'Missing', location: 'file://localhost/Old/Gone/Missing.aif' },
    ]);
    const report = await restoreLibrary({
      xmlPath, libraryRoot: lib, stageDir: path.join(tmp, 'stage'), sources: noSources, concurrency: 1,
    });
    expect(report.totals.alreadyInLibrary).toBe(2);
    expect(report.results.map(r => r.track.trackId)).toEqual(['3']);
  });
});

describe('restoreLibrary: store stages', () => {
  it('lists tracks the user deleted separately and reports unreadable accounts as "couldn\'t check"', async () => {
    const lib = path.join(tmp, 'Music');
    await fs.mkdir(path.join(lib, 'Have'), { recursive: true });
    await fs.writeFile(path.join(lib, 'Have', 'Owned.aif'), 'x');
    const xmlPath = await writeXml([
      { id: '1', artist: 'Have', name: 'Owned', location: 'file://localhost/Old/Have/Owned.aif' },
      { id: '2', artist: 'Deleted', name: 'By Ben', location: 'file://localhost/Old/Deleted/By%20Ben.aif' },
      { id: '3', artist: 'Nobody', name: 'Has It', location: 'file://localhost/Old/Nobody/Has%20It.aif' },
    ]);
    const owned = Object.assign(
      [{ trackId: 'bp-2', artist: 'Deleted', title: 'By Ben', sourceAccountId: 'acct1' }],
      { errors: ['Beatport (acct2): login required'] },
    );
    vi.mocked(store.fetchAllBeatportPurchases).mockResolvedValue(owned as never);
    vi.mocked(store.matchesOwnedTrack).mockImplementation(((input: { artist: string }) =>
      input.artist === 'Deleted' ? owned[0] : null) as never);
    vi.mocked(store.downloadBeatportPurchases).mockResolvedValue({
      downloaded: [], failed: [],
      skipped: [{ trackId: 'bp-2', artist: 'Deleted', title: 'By Ben', reason: 'you deleted this track' }],
      destDir: path.join(tmp, 'stage'),
    } as never);

    const report = await restoreLibrary({
      xmlPath, libraryRoot: lib, stageDir: path.join(tmp, 'stage'),
      sources: { ...noSources, beatport: true }, concurrency: 1,
      beatportAccounts: [{ id: 'acct1', email: 'a@x', label: 'A' }, { id: 'acct2', email: 'b@x', label: 'B' }],
    });

    // The deleted track is neither missing nor failed.
    expect(report.deletedSkipped.map(d => d.trackId)).toEqual(['2']);
    expect(report.results.map(r => r.track.trackId)).toEqual(['3']);
    expect(report.totals).toMatchObject({ alreadyInLibrary: 1, missing: 1, stillMissing: 1, deletedSkipped: 1 });
    // An unreadable account means "couldn't check", not "doesn't own it".
    expect(report.storeErrors).toEqual(['Beatport (acct2): login required']);
    expect(report.results[0]).toMatchObject({ status: 'still_missing', failureCategory: 'login' });
    expect(report.results[0].detail).toMatch(/couldn't check/);
  });
});
