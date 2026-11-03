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

// Rekordbox escapes attribute values (&amp; &apos; ...) — the parser must decode
// them and the rewriter must produce well-formed XML for any path.
const ENTITY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS>
  <COLLECTION Entries="3">
    <TRACK TrackID="1" Name="Don&apos;t Stop" Artist="Above &amp; Beyond" TotalTime="412"
           Location="file://localhost/Volumes/X/Music/Above%20&amp;%20Beyond/Don't%20Stop.aif"></TRACK>
    <TRACK TrackID="2" Name="A > B" Artist="Gt" Location="file://localhost/old2.aif"></TRACK>
    <TRACK TrackID="3" Name="Plain" Artist="P" Location="file://localhost/old3.aif"></TRACK>
  </COLLECTION>
  <PLAYLISTS><NODE Name="ROOT"><NODE Name="p"><TRACK Key="3"/></NODE></NODE></PLAYLISTS>
</DJ_PLAYLISTS>
`;

describe('XML entities and special characters', () => {
  it('decodes entities in parsed attributes (artist, title, location)', async () => {
    await fs.writeFile(xmlPath, ENTITY_XML);
    const tracks = await parseRekordboxXml(xmlPath);
    expect(tracks.map(t => t.trackId)).toEqual(['1', '2', '3']);
    expect(tracks[0]).toMatchObject({
      artist: 'Above & Beyond',
      title: "Don't Stop",
      origPath: "/Volumes/X/Music/Above & Beyond/Don't Stop.aif",
      totalTime: 412,
    });
    // A raw '>' inside a quoted value doesn't cut the tag short.
    expect(tracks[1]).toMatchObject({ title: 'A > B', origPath: '/old2.aif' });
  });

  it('writes "&" and "$1"/"$&" in a new path as well-formed, literal XML', async () => {
    await fs.writeFile(xmlPath, ENTITY_XML);
    const weird = "/Volumes/X/Music/Above & Beyond/Ca$h $1 $& Deal.aif";
    const res = await rewriteLocations(xmlPath, [{ trackId: '3', newPath: weird }], { backup: false });
    expect(res.updated).toEqual(['3']);
    const xml = await fs.readFile(xmlPath, 'utf8');
    // No raw '&' outside an entity anywhere in the document.
    expect(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i.test(xml)).toBe(false);
    // Exactly one TRACK 3 element; nothing got spliced in.
    expect(xml.match(/TrackID="3"/g)).toHaveLength(1);
    // Round trip: parsing gives back the exact path.
    const back = (await parseRekordboxXml(xmlPath)).find(t => t.trackId === '3');
    expect(back?.origPath).toBe(weird);
  });

  it('updates many tracks in one pass and only touches the named TRACK tags', async () => {
    await fs.writeFile(xmlPath, ENTITY_XML);
    const res = await rewriteLocations(xmlPath, [
      { trackId: '1', newPath: '/new/1.aif' },
      { trackId: '2', newPath: '/new/2.aif' },
      { trackId: '99', newPath: '/new/99.aif' },
    ], { backup: false });
    expect(res.updated).toEqual(['1', '2']);
    expect(res.notFound).toEqual(['99']);
    const tracks = await parseRekordboxXml(xmlPath);
    expect(tracks.map(t => t.origPath)).toEqual(['/new/1.aif', '/new/2.aif', '/old3.aif']);
    // Playlist entries are untouched.
    expect(await fs.readFile(xmlPath, 'utf8')).toContain('<TRACK Key="3"/>');
  });
});
