import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { rewriteLocations, pathToLocation, parseRekordboxXml } from '../rekordboxXml';

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS>
  <COLLECTION Entries="2">
    <TRACK TrackID="100" Name="Innerbloom" Artist="RÜFÜS DU SOL"
           Location="file://localhost/Volumes/Old/Music/RDS/Innerbloom.aiff"/>
    <TRACK TrackID="200" Name="Still D.R.E." Artist="Dr. Dre"
           Location="file://localhost/Volumes/Old/Music/Dr.%20Dre/Still_DRE.flac"/>
  </COLLECTION>
</DJ_PLAYLISTS>
`;

let tmp: string;
let xmlPath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'candybar-xml-test-'));
  xmlPath = path.join(tmp, 'export.xml');
  await fs.writeFile(xmlPath, SAMPLE_XML);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('pathToLocation', () => {
  it('URI-encodes spaces but preserves commas and slashes', () => {
    expect(pathToLocation('/Volumes/Time Machin/Library/A,B/track.aif'))
      .toBe('file://localhost/Volumes/Time%20Machin/Library/A,B/track.aif');
  });
});

describe('rewriteLocations', () => {
  it('rewrites Location for matching TrackIDs and leaves others untouched', async () => {
    const res = await rewriteLocations(xmlPath, [
      { trackId: '100', newPath: '/Volumes/New/Library/RDS/Innerbloom.aiff' },
    ], { backup: false });

    expect(res.updated).toEqual(['100']);
    expect(res.notFound).toEqual([]);

    const tracks = await parseRekordboxXml(xmlPath);
    const t100 = tracks.find(t => t.trackId === '100')!;
    const t200 = tracks.find(t => t.trackId === '200')!;
    expect(t100.origPath).toBe('/Volumes/New/Library/RDS/Innerbloom.aiff');
    // Other track's origPath must be unchanged.
    expect(t200.origPath).toBe('/Volumes/Old/Music/Dr. Dre/Still_DRE.flac');
  });

  it('reports notFound for unknown TrackIDs without modifying the file', async () => {
    const before = await fs.readFile(xmlPath, 'utf8');
    const res = await rewriteLocations(xmlPath, [
      { trackId: '999', newPath: '/nowhere' },
    ], { backup: false });
    expect(res.updated).toEqual([]);
    expect(res.notFound).toEqual(['999']);
    const after = await fs.readFile(xmlPath, 'utf8');
    expect(after).toBe(before);
  });

  it('creates a backup when backup option is default/true', async () => {
    const res = await rewriteLocations(xmlPath, [
      { trackId: '100', newPath: '/Volumes/New/x.aiff' },
    ]);
    expect(res.backupPath).toBeTruthy();
    const backup = await fs.readFile(res.backupPath!, 'utf8');
    expect(backup).toBe(SAMPLE_XML);
  });

  it('URL-encodes the new path in the written Location attribute', async () => {
    await rewriteLocations(xmlPath, [
      { trackId: '100', newPath: '/Volumes/Time Machin/Library/A B C.aiff' },
    ], { backup: false });
    const xml = await fs.readFile(xmlPath, 'utf8');
    expect(xml).toContain('Location="file://localhost/Volumes/Time%20Machin/Library/A%20B%20C.aiff"');
  });

  it('escapes regex metacharacters in TrackIDs', async () => {
    // Write an XML with a weird TrackID to confirm escape works.
    const odd = `<TRACK TrackID="a.b+c" Name="x" Artist="y" Location="file://localhost/old.aif"/>`;
    await fs.writeFile(xmlPath, `<root>${odd}</root>`);
    const res = await rewriteLocations(xmlPath, [
      { trackId: 'a.b+c', newPath: '/new.aif' },
    ], { backup: false });
    expect(res.updated).toEqual(['a.b+c']);
    expect(res.notFound).toEqual([]);
  });
});
