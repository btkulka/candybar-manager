/**
 * Plan + apply end to end on a COPY of master.db, with real files — all of
 * them synthetic and inside a temp folder. One existing MP3 entry with cues is
 * first repointed (in the copy) at a generated MP3, so the alignment, the
 * AIFF write, the tag carry-over, the archive move and the Trash all act on
 * test files only. The live DB is only ever copied.
 *
 * Opt-in (it copies the collection and takes ~20 s):
 *   RBX_SWAP_E2E=1 npx vitest run src/lib/__tests__/rekordboxUpgradeSwap.e2e.test.ts
 *   RBX_SOURCE_DB=<master.db to copy>   default: the active Rekordbox one
 *   RBX_SWAP_APPROOT=<dir>              default: this repo (where lib/rekordbox + .venv-rbx live)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { parseFile } from 'music-metadata';
import { planUpgradeSwap, applyUpgradeSwap, _resetSwapState, type SwapDeps } from '../rekordboxUpgradeSwap';
import { setManualTrashDir } from '../safeDelete';
import { normalizeArtist } from '../organizeByArtist';

const REPO = path.resolve(__dirname, '..', '..', '..');
const APP_ROOT = process.env.RBX_SWAP_APPROOT || REPO;
const PY = path.join(REPO, '.venv-rbx', 'bin', 'python');
const LIVE = [path.join(os.homedir(), 'Library', 'Pioneer', 'rekordbox', 'master.db'), path.join(os.homedir(), 'Library', 'Pioneer', 'rekordbox7', 'master.db')];
const SOURCE = process.env.RBX_SOURCE_DB || LIVE.filter(p => fs.existsSync(p)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const enabled = !!process.env.RBX_SWAP_E2E && !!SOURCE && fs.existsSync(PY);

function py(code: string, ...args: string[]): unknown {
  const r = spawnSync(PY, ['-c', code, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout);
}

function ffmpeg(args: string[]): void {
  const r = spawnSync(ffmpegPath as unknown as string, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
}

// Same synthetic "track" as lib/rekordbox/tests/test_audio_align.py.
const GEN = `
import sys, wave, numpy as np
sys.path.insert(0, ${JSON.stringify(path.join(REPO, 'lib', 'rekordbox', 'tests'))})
from test_audio_align import make, write_wav
from pathlib import Path
write_wav(Path(sys.argv[1]), make(float(sys.argv[2]), seed=int(sys.argv[3])))
print("{}")
`;

const PICK = `
import sys, json
from pyrekordbox import Rekordbox6Database
from pyrekordbox.db6 import tables as t
db = Rekordbox6Database(path=sys.argv[1])
best = None
for c in db.session.query(t.DjmdContent).filter(t.DjmdContent.FileType == 1).all():
    if getattr(c, "rb_local_deleted", 0) or not (60 <= (c.Length or 0) <= 420): continue
    cues = db.session.query(t.DjmdCue).filter(t.DjmdCue.ContentID == c.ID).all()
    cc = db.session.query(t.ContentCue).filter(t.ContentCue.ContentID == c.ID).all()
    if len(cues) < 3 or len(cc) != 1: continue
    if any(q.InMsec < 25 and q.OutMsec >= 0 for q in cues): continue
    if best is None or len(cues) > best[0]: best = (len(cues), c.ID)
other = next(c.ID for c in db.session.query(t.DjmdContent).filter(t.DjmdContent.FileType == 12).all() if c.FolderPath)
stream = next((c.ID for c in db.session.query(t.DjmdContent).filter(t.DjmdContent.FileType == 25).all()), None)
print(json.dumps({"mp3": best[1] if best else None, "aiff": other, "stream": stream}))
db.close()
`;

// Test setup on the COPY only: point the chosen MP3 entry, and one AIFF entry,
// at generated files, so nothing the test does reaches a real track.
const REPOINT = `
import sys, json, os
from pyrekordbox import Rekordbox6Database
db = Rekordbox6Database(path=sys.argv[1])
db.playlist_xml = None
for rb_id, p in ((sys.argv[2], sys.argv[3]), (sys.argv[4], sys.argv[5])):
    c = db.get_content(ID=rb_id)
    c.FolderPath = p; c.FileNameL = os.path.basename(p); c.FileSize = os.path.getsize(p)
c = db.get_content(ID=sys.argv[2])
out = {"artist": c.ArtistName or "", "length": c.Length}
# Setup on a throwaway copy: a plain session commit (pyrekordbox's commit()
# also refuses while any process named rekordbox exists, which a test of the
# copy doesn't need). The swap itself goes through the full ceremony.
db.session.commit(); db.close()
print(json.dumps(out))
`;

describe.skipIf(!enabled)('lossless swap, plan + apply on a copy of master.db', () => {
  let tmp: string;
  let db: string;
  let deps: SwapDeps;
  let ids: { mp3: string | null; aiff: string; stream: string | null };
  let setup: { artist: string; length: number };
  let origMp3: string;
  let otherAiff: string;
  let storeFlac: string;
  let lossyDownload: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-ts-e2e-'));
    db = path.join(tmp, 'master.db');
    fs.copyFileSync(SOURCE!, db);
    for (const live of LIVE) expect(path.resolve(db)).not.toBe(path.resolve(live));
    ids = py(PICK, db) as typeof ids;
    if (!ids.mp3) throw new Error('no MP3 entry with cues to test with');

    const lib = path.join(tmp, 'Library');
    const intake = path.join(tmp, 'tracks_to_organize');
    fs.mkdirSync(intake, { recursive: true });
    const probe = py(`import sys,json\nfrom pyrekordbox import Rekordbox6Database\nd=Rekordbox6Database(path=sys.argv[1]); c=d.get_content(ID=sys.argv[2]); print(json.dumps({"artist": c.ArtistName or "", "length": c.Length})); d.close()`, db, ids.mp3) as { artist: string; length: number };
    const master = path.join(tmp, 'master.wav');
    py(GEN, master, String(probe.length + 1), '7');
    const cover = path.join(tmp, 'cover.png');
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1', '-frames:v', '1', cover]);

    origMp3 = path.join(lib, 'Old Rips', `0A1B2C3D_Original Track (Extended Mix).mp3`);
    fs.mkdirSync(path.dirname(origMp3), { recursive: true });
    ffmpeg(['-i', master, '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-b:a', '320k', '-c:v', 'png', '-disposition:v', 'attached_pic',
      '-metadata', 'title=Original Title', '-metadata', 'artist=Original Artist', '-metadata', 'album=Original Album', '-metadata', 'genre=Tech House',
      '-metadata', 'comment=from the original', '-metadata', 'TBPM=124', '-metadata', 'TKEY=8A', '-id3v2_version', '3', origMp3]);
    storeFlac = path.join(intake, 'Store Artist - Store Title.flac');
    ffmpeg(['-i', master, '-c:a', 'flac', '-metadata', 'title=Store Title', '-metadata', 'artist=Store Artist', '-metadata', 'label=Store Label', '-metadata', 'ISRC=GBXXX2600001', storeFlac]);
    lossyDownload = path.join(intake, 'lossy.mp3');
    fs.copyFileSync(origMp3, lossyDownload);
    // Another entry's lossless file (the "relink" case).
    otherAiff = path.join(lib, 'Someone Else', 'Owned Already.aif');
    fs.mkdirSync(path.dirname(otherAiff), { recursive: true });
    ffmpeg(['-i', master, '-c:a', 'pcm_s16be', otherAiff]);

    setup = py(REPOINT, db, ids.mp3, origMp3, ids.aiff, otherAiff) as typeof setup;
    const trash = path.join(tmp, 'Trash');
    fs.mkdirSync(trash);
    setManualTrashDir(trash);
    deps = { appRoot: APP_ROOT, libraryRoot: lib, archiveRoot: path.join(tmp, '_archived'), backupDir: path.join(tmp, 'backups'), dbPath: db };
  }, 120_000);

  afterAll(() => {
    _resetSwapState();
    setManualTrashDir(null);
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('skips what it must not swap, in plain words', async () => {
    const inputs = [
      { rbId: ids.mp3!, newFilePath: lossyDownload },
      { rbId: ids.mp3!.concat('0'), newFilePath: storeFlac },
      ...(ids.stream ? [{ rbId: ids.stream, newFilePath: storeFlac }] : []),
    ];
    const lossy = (await planUpgradeSwap([inputs[0]], deps))[0];
    expect(lossy).toMatchObject({ action: 'skip', reason: expect.stringMatching(/only lossless files/) });
    const rest = await planUpgradeSwap(inputs.slice(1), deps);
    expect(rest[0]).toMatchObject({ action: 'skip', reason: expect.stringMatching(/isn't in your Rekordbox collection/) });
    if (ids.stream) expect(rest[1]).toMatchObject({ action: 'skip', reason: expect.stringMatching(/stream/i), alignment: { status: 'unchecked' } });
    // A lossless file another entry already uses (the "relink" case) is never merged.
    const relink = (await planUpgradeSwap([{ rbId: ids.mp3!, newFilePath: otherAiff }], deps))[0];
    expect(relink).toMatchObject({ action: 'skip', reason: expect.stringMatching(/already has its own entry/) });
    // Already lossless: nothing to upgrade.
    const lossless = (await planUpgradeSwap([{ rbId: ids.aiff, newFilePath: storeFlac }], deps))[0];
    expect(lossless).toMatchObject({ action: 'skip', reason: expect.stringMatching(/already has this as a lossless file/) });
  }, 120_000);

  it('plans the MP3 → lossless swap with the encoder-delay shift, then applies it in place', async () => {
    const [plan] = await planUpgradeSwap([{ rbId: ids.mp3!, newFilePath: storeFlac }], deps);
    expect(plan.action).toBe('swap');
    expect(plan.alignment.status).toBe('shifted');
    expect(plan.alignment.offsetMs).toBeCloseTo(-25.06, 0);
    expect(plan.cueShiftMs).toBe(-25);
    expect(plan.checkBeatgrid).toBe(true);
    // <library>/<the entry's artist>/<original basename, hash prefix dropped>.aif
    expect(plan.after.path).toBe(path.join(deps.libraryRoot, normalizeArtist(setup.artist), 'Original Track (Extended Mix).aif'));
    expect(plan.keeps.dateAdded).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(plan.after).toMatchObject({ format: 'AIFF 16/44.1', sampleRate: 44100, bitDepth: 16, fileSize: null });
    expect(plan.oldFileGoesTo).toBe(path.join(deps.archiveRoot, 'upgraded-originals', 'Old Rips', path.basename(origMp3)));

    const before = py(`import sys,json\nsys.path.insert(0, ${JSON.stringify(path.join(REPO, 'lib', 'rekordbox'))})\nimport upgrade_swap as u\nfrom rbx_safety import open_db\nfrom pathlib import Path\nd=open_db(Path(sys.argv[1])); c=d.get_content(ID=sys.argv[2]); print(json.dumps(u.read_row(d,c), default=str)); d.close()`, db, ids.mp3!) as Record<string, unknown> & { cues: Array<Record<string, number>> };
    const progress: string[] = [];
    const result = await applyUpgradeSwap([ids.mp3!], { ...deps, onProgress: p => progress.push(p.phase) });
    expect(result, JSON.stringify(result.items)).toMatchObject({ swapped: 1, skipped: 0, failed: 0 });
    expect(result.items[0]).toMatchObject({ status: 'swapped', cueShiftMs: -25, checkBeatgrid: true });
    expect(fs.existsSync(result.backupPath!)).toBe(true);
    expect(fs.existsSync(result.rollbackPath!)).toBe(true);
    expect(progress).toEqual(expect.arrayContaining(['converting', 'writing', 'verifying', 'archiving', 'done']));

    // The entry: same row, history kept, pointing at the AIFF, cues 25 ms earlier.
    const after = py(`import sys,json\nsys.path.insert(0, ${JSON.stringify(path.join(REPO, 'lib', 'rekordbox'))})\nimport upgrade_swap as u\nfrom rbx_safety import open_db\nfrom pathlib import Path\nd=open_db(Path(sys.argv[1])); c=d.get_content(ID=sys.argv[2]); print(json.dumps(u.read_row(d,c), default=str)); d.close()`, db, ids.mp3!) as typeof before;
    for (const k of ['ID', 'UUID', 'StockDate', 'DJPlayCount', 'Rating', 'ColorID', 'Commnt', 'Title', 'counts']) expect(after[k]).toEqual(before[k]);
    expect(after).toMatchObject({ FolderPath: plan.after.path, FileType: 12, BitRate: 1411, SampleRate: 44100, BitDepth: 16, FileSize: fs.statSync(plan.after.path).size });
    const byId = new Map(after.cues.map(c => [c.ID, c]));
    for (const c of before.cues) {
      const n = byId.get(c.ID)!;
      expect(n.InMsec).toBe(Math.max(0, c.InMsec - 25));
      expect(n.InFrame).toBe(Math.floor(n.InMsec * 0.15));
      expect([n.InMpegFrame, n.InMpegAbs, n.OutMpegFrame, n.OutMpegAbs]).toEqual([0, 0, 0, 0]);
      if (c.OutMsec >= 0) expect(n.OutMsec).toBe(c.OutMsec - 25);
    }

    // The files: the AIFF carries the ORIGINAL's tags (the store's where it had none) and cover.
    const meta = await parseFile(plan.after.path);
    expect(meta.format.container).toMatch(/AIFF/);
    expect(meta.common).toMatchObject({ title: 'Original Title', artist: 'Original Artist', album: 'Original Album', bpm: 124, key: '8A' });
    expect(meta.common.genre).toEqual(['Tech House']);
    expect(meta.common.label).toEqual(['Store Label']);
    expect(meta.common.isrc).toEqual(['GBXXX2600001']);
    expect(meta.common.picture?.length).toBe(1);
    // The comment as a real COMM frame (rewritten by mutagen; ffmpeg alone writes TXXX:comment).
    const id3 = meta.native['ID3v2.3'] ?? [];
    expect(id3.find(t => t.id === 'COMM')?.value).toMatchObject({ text: 'from the original' });
    expect(id3.some(t => t.id === 'TXXX:comment')).toBe(false);
    expect(fs.existsSync(origMp3)).toBe(false);
    expect(fs.existsSync(plan.oldFileGoesTo!)).toBe(true);
    expect(fs.existsSync(storeFlac)).toBe(false); // to the (test) Trash
    expect(fs.readdirSync(path.join(tmp, 'Trash')).some(n => n.startsWith('Store Artist - Store Title'))).toBe(true);

    // The plan is spent: applying again does nothing.
    const again = await applyUpgradeSwap([ids.mp3!], deps);
    expect(again).toMatchObject({ swapped: 0, skipped: 1 });
  }, 240_000);
});
