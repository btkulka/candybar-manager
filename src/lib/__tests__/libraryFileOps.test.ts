import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { organizeTracks, normalizeArtist } from '../organizeByArtist';
import { archiveTrackFile } from '../libraryHealthScan';
import { scanTracks } from '../trackScanner';
import { setManualTrashDir } from '../safeDelete';

let tmp: string;
let trashDir: string;
const noLog = () => {};

function ffmpeg(args: string[]): void {
  const r = spawnSync(ffmpegPath as unknown as string, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr?.toString()}`);
}

function mp3(out: string, artist: string, title = 'Song'): string {
  ffmpeg(['-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'libmp3lame', '-id3v2_version', '3',
    '-metadata', `artist=${artist}`, '-metadata', `title=${title}`, out]);
  return out;
}

beforeAll(() => {
  // Manual-trash moves (no OS handler in tests) land here, never in ~/.Trash.
  setManualTrashDir(path.join(os.tmpdir(), `fileops-trash-${process.pid}`));
});
afterAll(async () => {
  setManualTrashDir(null);
  await fs.rm(path.join(os.tmpdir(), `fileops-trash-${process.pid}`), { recursive: true, force: true });
});
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fileops-'));
  trashDir = path.join(os.tmpdir(), `fileops-trash-${process.pid}`);
});
afterEach(async () => { if (tmp) await fs.rm(tmp, { recursive: true, force: true }); });

describe('normalizeArtist', () => {
  it("keeps names that contain '&', ',' or '/'", () => {
    expect(normalizeArtist('Above & Beyond')).toBe('Above & Beyond');
    expect(normalizeArtist('Earth, Wind & Fire')).toBe('Earth, Wind & Fire');
    expect(normalizeArtist('AC/DC')).toBe('AC-DC'); // '/' can't be in a folder name
  });

  it('splits only on unambiguous multi-artist separators', () => {
    expect(normalizeArtist('Fred again..; Brian Eno')).toBe('Fred again');
    expect(normalizeArtist('Four Tet feat. Burial')).toBe('Four Tet');
  });

  it('never yields a hidden, empty or exFAT-illegal folder name', () => {
    expect(normalizeArtist('...And You Will Know Us')).toBe('And You Will Know Us');
    expect(normalizeArtist('..')).toBe('Unknown Artist');
    expect(normalizeArtist('Who? What: "Why"*')).toBe('Who- What- -Why-');
    expect(normalizeArtist('Trailing dots. ')).toBe('Trailing dots');
  });

  it('normalizes to NFC', () => {
    const nfd = 'Beyoncé';
    expect(normalizeArtist(nfd)).toBe('Beyoncé');
  });
});

describe('organizeTracks', () => {
  it('files "Above & Beyond" under its full name', async () => {
    const intake = path.join(tmp, 'intake');
    const root = path.join(tmp, 'Music');
    await fs.mkdir(intake); await fs.mkdir(root);
    const f = mp3(path.join(intake, 'a.mp3'), 'Above & Beyond');
    const [r] = await organizeTracks({ tracks: [{ filePath: f, ignored: false }], rootDir: root, log: noLog });
    expect(r.success).toBe(true);
    expect(r.resultPath).toBe(path.join(root, 'Above & Beyond', 'a.mp3'));
  });

  it('joins an existing artist folder whatever its case', async () => {
    const intake = path.join(tmp, 'intake');
    const root = path.join(tmp, 'Music');
    await fs.mkdir(intake); await fs.mkdir(path.join(root, 'DJ Koze'), { recursive: true });
    const f = mp3(path.join(intake, 'k.mp3'), 'Dj Koze');
    const [r] = await organizeTracks({ tracks: [{ filePath: f, ignored: false }], rootDir: root, log: noLog });
    expect(r.resultPath).toBe(path.join(root, 'DJ Koze', 'k.mp3'));
  });

  it('treats a track that is already in place as organized, not as a conflict with itself', async () => {
    const root = path.join(tmp, 'Music');
    await fs.mkdir(path.join(root, 'Artist'), { recursive: true });
    const f = mp3(path.join(root, 'Artist', 'x.mp3'), 'Artist');
    const [r] = await organizeTracks({ tracks: [{ filePath: f, ignored: false }], rootDir: root, log: noLog });
    expect(r.success).toBe(true);
    expect(r.conflict).toBeUndefined();
    expect(r.resultPath).toBe(f);
    await expect(fs.access(f)).resolves.toBeUndefined();
  });

  it('still reports a real conflict with a different file', async () => {
    const intake = path.join(tmp, 'intake');
    const root = path.join(tmp, 'Music');
    await fs.mkdir(intake); await fs.mkdir(path.join(root, 'Artist'), { recursive: true });
    mp3(path.join(root, 'Artist', 'x.mp3'), 'Artist', 'Existing');
    const f = mp3(path.join(intake, 'x.mp3'), 'Artist', 'Incoming');
    const [r] = await organizeTracks({ tracks: [{ filePath: f, ignored: false }], rootDir: root, log: noLog });
    expect(r.success).toBe(false);
    expect(r.conflict?.targetPath).toBe(path.join(root, 'Artist', 'x.mp3'));
  });
});

describe('archiveTrackFile', () => {
  it('archives a different same-named file under a numbered name instead of deleting it', async () => {
    const lib = path.join(tmp, 'Music');
    const archive = path.join(tmp, '.archive');
    await fs.mkdir(path.join(lib, 'A'), { recursive: true });
    await fs.mkdir(path.join(archive, 'A'), { recursive: true });
    await fs.writeFile(path.join(archive, 'A', 't.mp3'), 'older copy');
    await fs.writeFile(path.join(lib, 'A', 't.mp3'), 'newer, different copy');
    const r = await archiveTrackFile(path.join(lib, 'A', 't.mp3'), lib, archive);
    expect(r.success).toBe(true);
    expect(r.archivePath).toBe(path.join(archive, 'A', 't (2).mp3'));
    expect(await fs.readFile(path.join(archive, 'A', 't.mp3'), 'utf8')).toBe('older copy');
    expect(await fs.readFile(r.archivePath!, 'utf8')).toBe('newer, different copy');
  });

  it('only discards the source (to the Trash) when the archived copy is byte-identical', async () => {
    const lib = path.join(tmp, 'Music');
    const archive = path.join(tmp, '.archive');
    await fs.mkdir(path.join(lib, 'A'), { recursive: true });
    await fs.mkdir(path.join(archive, 'A'), { recursive: true });
    await fs.writeFile(path.join(archive, 'A', 'same.mp3'), 'identical');
    await fs.writeFile(path.join(lib, 'A', 'same.mp3'), 'identical');
    const r = await archiveTrackFile(path.join(lib, 'A', 'same.mp3'), lib, archive);
    expect(r.success).toBe(true);
    await expect(fs.access(path.join(lib, 'A', 'same.mp3'))).rejects.toThrow();
    const trashed = await fs.readdir(trashDir);
    expect(trashed.some(n => n.startsWith('same'))).toBe(true);
  });
});

describe('scanTracks intake flatten', () => {
  it('moves audio up but leaves zips, partial downloads, unknown files and the restore staging dir alone', async () => {
    const intake = path.join(tmp, 'tracks_to_organize');
    await fs.mkdir(path.join(intake, 'Album Folder', 'CD1'), { recursive: true });
    await fs.mkdir(path.join(intake, 'restore_recovered'));
    await fs.mkdir(path.join(intake, 'Empty Folder'));
    mp3(path.join(intake, 'Album Folder', 'CD1', 'deep.mp3'), 'Deep');
    await fs.writeFile(path.join(intake, 'Album Folder', 'cover.jpg'), 'jpg');
    await fs.writeFile(path.join(intake, 'Album Folder', '.DS_Store'), 'junk');
    await fs.writeFile(path.join(intake, 'Empty Folder', '.DS_Store'), 'junk');
    mp3(path.join(intake, 'restore_recovered', 'staged.mp3'), 'Staged');
    await fs.writeFile(path.join(intake, 'bundle.zip'), 'zip');
    await fs.writeFile(path.join(intake, 'track.aiff.crdownload'), 'partial');
    await fs.writeFile(path.join(intake, 'take.ogg'), 'ogg');
    await fs.writeFile(path.join(intake, '.DS_Store'), 'junk');
    mp3(path.join(intake, 'x.converting-1730000000000-abc123.mp3'), 'Temp');

    const tracks = await scanTracks(intake);
    const root = (await fs.readdir(intake)).sort();

    // Audio pulled up from the subfolder; converter temp file not treated as a track.
    expect(tracks.map(t => t.fileName).sort()).toEqual(['deep.mp3']);
    // Kept: zip, partial download, unknown format, the non-empty album folder (has cover.jpg),
    // the staging dir and its contents. Gone: .DS_Store files and the emptied folder.
    expect(root).toEqual(['Album Folder', 'bundle.zip', 'deep.mp3', 'restore_recovered', 'take.ogg',
      'track.aiff.crdownload', 'x.converting-1730000000000-abc123.mp3'].sort());
    expect(await fs.readdir(path.join(intake, 'Album Folder'))).toEqual(['cover.jpg']);
    expect(await fs.readdir(path.join(intake, 'restore_recovered'))).toEqual(['staged.mp3']);
  });
});
