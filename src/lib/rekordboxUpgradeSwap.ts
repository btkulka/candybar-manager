/**
 * Lossless swap: the step after Lossless Upgrades' "Download purchases". Each
 * downloaded lossless file takes the place of its Rekordbox entry's file IN
 * PLACE — the same DjmdContent row (same ID) points at the new file, so cue
 * points, loops, Date Added, play count, rating, colour, comments, playlists
 * and MyTags all stay attached. Nothing is re-imported.
 *
 *   plan   (read-only, safe while Rekordbox runs): read each entry, check the
 *          new file is lossless and lines up with the old one (cue points must
 *          land on the same musical moment), pick the library path, decide.
 *   apply  (Rekordbox closed): write each AIFF beside its final path with the
 *          ORIGINAL file's tags, rename it into place, then ONE guarded write
 *          session through lib/rekordbox/rbx_safety.py (snapshot, commit,
 *          reopen + verify, restore on failure). Only after that verifies are
 *          old files archived; if it fails, only the new files are removed.
 *
 * The DB side lives in lib/rekordbox/upgrade_swap.py (pyrekordbox, the repo's
 * .venv-rbx). Beatgrids and waveforms live in ANLZ files, which this never
 * touches: when cue points move, the result says which tracks to re-analyze.
 * No Electron import here, so the pure parts are unit-testable.
 */

import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { parseFile, type IAudioMetadata } from 'music-metadata';
import { createScopedLogger } from './logger';
import { rbxPython } from './rbxPython';
import { recordWrite, statBytes } from './writeJournal';
import { safeDelete } from './safeDelete';
import { normalizeArtist } from './organizeByArtist';
import { archiveTrackFile } from './libraryHealthScan';
import { classifyEntry, type RekordboxEntry } from './losslessUpgrade';
import { readDjTags } from './djTags';
import { updateDownloadedTrackPath } from './db';
import { invalidateLibraryFileLists } from './jobQueue/sharedResultStore';
import type {
  UpgradeSwapAlignment, UpgradeSwapInput, UpgradeSwapPlanItem, UpgradeSwapPreflight,
  UpgradeSwapProgress, UpgradeSwapResult, UpgradeSwapResultItem,
} from '../types';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string = require('ffmpeg-static');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffprobePath: string = require('ffprobe-static').path;

const log = createScopedLogger('UpgradeSwap');

// ---------- Policy ----------

/** At or under this offset the files count as lined up and cue points stay
 *  put. 5 ms is under one 1/150 s step (6.7 ms) — the resolution Rekordbox
 *  stores cue frames and draws its detail waveform at — and under the ~10 ms
 *  where two kicks start to flam. */
export const ALIGNED_MS = 5;
/** Every window must correlate at least this well (pre-emphasised NCC). On
 *  test material the same master measures 0.88–0.99 (320 and 128 kbps LAME,
 *  AAC, 96 kHz, padded) and a different track at the same tempo 0.05. */
export const MIN_CORRELATION = 0.5;
/** The windows' offsets may spread this much and still be one offset: a cue
 *  anywhere in the track then lands within ALIGNED_MS of where it should. */
export const MAX_WINDOW_SPREAD_MS = ALIGNED_MS;
/** Longer or shorter than this and it's a different edit or version. */
export const MAX_LENGTH_DIFF_SEC = 2;
/** A plain cue pushed up to this far before 0:00 is pinned to 0:00 (a
 *  first-beat cue meeting the MP3 delay); further, the swap is refused.
 *  Mirrors CLAMP_TOLERANCE_MS in lib/rekordbox/swap_cues.py. */
export const CUE_CLAMP_MS = 50;

const AIFF_FILE_TYPE = 12;
const STREAMING_FILE_TYPE = 25;
const HASH_PREFIX_RE = /^[0-9A-F]{8}_/i;
const MAX_SAMPLE_RATE = 96000; // CDJ-3000 ceiling for AIFF
const PLAN_TTL_MS = 12 * 60 * 60 * 1000;
const LOSSLESS_CODEC_RE = /^(pcm_(s|u|f)\d+(le|be)?(planar)?|flac|alac)$/;

// ---------- Types shared with lib/rekordbox/upgrade_swap.py ----------

/** A DjmdCue row's fields, as upgrade_swap.py reads them. */
export type SwapCue = {
  ID: string; Kind: number | null;
  InMsec: number; InFrame: number; InMpegFrame: number; InMpegAbs: number;
  OutMsec: number; OutFrame: number; OutMpegFrame: number; OutMpegAbs: number;
  CueMicrosec: number | null;
  [k: string]: unknown;
};

/** A DjmdContent row plus what hangs off it, from `upgrade_swap.py read`. */
export type SwapRow = {
  rbId: string; artist: string; album: string;
  FolderPath: string; FileNameL: string; FileSize: number; FileType: number;
  BitRate: number; SampleRate: number; BitDepth: number; Length: number; OrgFolderPath: string | null;
  ID: string; UUID: string; StockDate: string | null; DJPlayCount: number | null; Rating: number | null;
  ColorID: string | null; Commnt: string | null; Title: string | null;
  cues: SwapCue[];
  counts: { hotCues: number; memoryCues: number; loops: number; playlists: number; myTags: number };
  contentCueCount: number;
  contentCue: string | null;
};

/** `upgrade_swap.py align` output. lagMs is new minus original: a moment at
 *  t on the original's Rekordbox timeline is at t + lagMs in the new file. */
export type AlignMeasurement = {
  originalDurationSec: number;
  newDurationSec: number;
  globalLagMs: number;
  globalPeak: number;
  windows: Array<{ atSec: number; lagMs: number; ncc: number; inverted: boolean; atEdge: boolean }>;
  originalTimeline: 'untrimmed' | 'as-decoded';
  /** What a gapless decoder trims off the original's start (25.06 ms for a LAME MP3). */
  gaplessTrimMs?: number;
};

export type AudioProbe = {
  codec: string; container: string; sampleRate: number; bitDepth: number; channels: number; durationSec: number;
};

export type SwapDeps = {
  /** Where lib/rekordbox and .venv-rbx live (app.getAppPath()). */
  appRoot: string;
  libraryRoot: string;
  /** config.archivePath, resolved. Old files go to <archiveRoot>/upgraded-originals/. */
  archiveRoot: string;
  /** resolveRekordboxBackupDir(config). */
  backupDir: string;
  /** Tests only: a copy of master.db. The app never sets it (the active DB is detected). */
  dbPath?: string;
  onProgress?: (p: UpgradeSwapProgress) => void;
};

/** What the plan remembers for apply. The renderer only ever sends rbIds back. */
type PlannedSwap = {
  item: UpgradeSwapPlanItem;
  row: SwapRow;
  newFilePath: string;
  newFile: { size: number; mtimeMs: number; probe: AudioProbe };
  /** The original exists on disk (so there's something to archive and to tag from). */
  originalOnDisk: boolean;
  /** Other Rekordbox entries use the original file too: it stays where it is. */
  originalShared: boolean;
  conversion: { copyAudio: boolean; codec: string; sampleRate: number; bitDepth: number };
  plannedAt: number;
};

const planCache = new Map<string, PlannedSwap>();
let applyRunning = false;

// ---------- Pure helpers (unit-tested) ----------

/** "5:03" */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatMs(ms: number): string {
  const a = Math.abs(ms);
  return a >= 1000 ? `${(a / 1000).toFixed(2)} s` : `${Math.round(a)} ms`;
}

/** Rekordbox's BitRate for uncompressed audio: floor(rate × bits × channels / 1000)
 *  — 1411 for 16/44.1, 2116 for 24/44.1, 4608 for 24/96, as the live rows hold. */
export function losslessBitRate(sampleRate: number, bitDepth: number, channels: number): number {
  return Math.floor((sampleRate * bitDepth * channels) / 1000);
}

/** The new file's name: the original's basename (no legacy 8-hex `XXXXXXXX_`
 *  prefix) with `.aif`. */
export function swapFileName(originalPath: string): string {
  const base = path.basename(originalPath);
  const stem = base.slice(0, base.length - path.extname(base).length).replace(HASH_PREFIX_RE, '').trim();
  return `${stem || 'Untitled'}.aif`;
}

/** Case/Unicode-insensitive key for paths and folder names (APFS and exFAT
 *  treat "DJ Koze" and "Dj Koze" as one). */
export function folderKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** Where the new file goes: beside the file it replaces (its folder, its
 *  basename with .aif), so the library keeps the layout it has. Only when that
 *  folder isn't there (a streaming entry, a drive that isn't connected) does it
 *  go to <libraryRoot>/<Artist>/, joining an artist folder that already exists
 *  under another case or Unicode form. `existingFolders` maps folderKey → name. */
export function swapTargetBase(libraryRoot: string, artist: string, originalPath: string, existingFolders: Map<string, string>, originalDirExists = false): string {
  if (originalDirExists && path.isAbsolute(originalPath)) return path.join(path.dirname(originalPath), swapFileName(originalPath));
  const folder = normalizeArtist(artist || '');
  const dir = existingFolders.get(folderKey(folder)) ?? folder;
  return path.join(libraryRoot, dir, swapFileName(originalPath));
}

/** "X.aif", "X (2).aif", "X (3).aif"… for the first n. */
export function numberedVariants(p: string, n: number): string[] {
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  return [p, ...Array.from({ length: n - 1 }, (_, i) => `${base} (${i + 2})${ext}`)];
}

/** Where archiveTrackFile will put the old file: the same layout under
 *  <archiveRoot>/upgraded-originals, relative to the library (or its parent). */
export function archivePathFor(originalPath: string, libraryRoot: string, archiveRoot: string): string {
  const root = path.join(archiveRoot, 'upgraded-originals');
  const rel = path.relative(libraryRoot, originalPath);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return path.join(root, rel);
  const relParent = path.relative(path.dirname(libraryRoot), originalPath);
  return !relParent.startsWith('..') && !path.isAbsolute(relParent)
    ? path.join(root, relParent)
    : path.join(root, path.basename(originalPath));
}

/** Whether ffmpeg decodes this as lossless audio Rekordbox can take as AIFF. */
export function isLosslessCodec(codec: string): boolean {
  return LOSSLESS_CODEC_RE.test(codec) && !/^pcm_(alaw|mulaw)/.test(codec);
}

/** Copy the audio as it is (an AIFF already within CDJ limits), or convert:
 *  16-bit stays 16-bit, deeper or float becomes 24-bit, rates over 96 kHz
 *  come down to 96 kHz. */
export function conversionFor(probe: AudioProbe): PlannedSwap['conversion'] {
  const aiffPcm = probe.container === 'aiff' && /^pcm_s(16|24|32)be$/.test(probe.codec);
  if (aiffPcm && probe.sampleRate <= MAX_SAMPLE_RATE && probe.bitDepth <= 24) {
    return { copyAudio: true, codec: 'copy', sampleRate: probe.sampleRate, bitDepth: probe.bitDepth };
  }
  const bitDepth = probe.bitDepth > 0 && probe.bitDepth <= 16 ? 16 : 24;
  return {
    copyAudio: false,
    codec: bitDepth === 16 ? 'pcm_s16be' : 'pcm_s24be',
    sampleRate: Math.min(probe.sampleRate || 44100, MAX_SAMPLE_RATE),
    bitDepth,
  };
}

/**
 * Turn the measurement into a verdict. Conservative on purpose: anything that
 * doesn't clearly say "same recording, one offset throughout" is a mismatch,
 * and a mismatch is never swapped.
 */
export function classifyAlignment(m: AlignMeasurement): UpgradeSwapAlignment {
  const confidence = m.windows.length ? Math.min(...m.windows.map(w => w.ncc)) : 0;
  const lags = m.windows.map(w => w.lagMs);
  const sorted = [...lags].sort((a, b) => a - b);
  const offset = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
  const result = (status: UpgradeSwapAlignment['status'], note: string): UpgradeSwapAlignment => ({
    status, offsetMs: Math.round(offset * 100) / 100, confidence: Math.round(confidence * 1000) / 1000, note,
  });

  if (m.windows.length === 0) return result('unchecked', 'The original is too short (or too quiet) to compare.');
  const lengthDiff = Math.abs(m.newDurationSec - m.originalDurationSec);
  if (lengthDiff > MAX_LENGTH_DIFF_SEC) {
    return result('mismatch', `Different length (${formatDuration(m.newDurationSec)} vs ${formatDuration(m.originalDurationSec)}): probably a different version or edit.`);
  }
  if (m.windows.some(w => w.atEdge) || confidence < MIN_CORRELATION) {
    const firstOk = m.windows[0] && !m.windows[0].atEdge && m.windows[0].ncc >= MIN_CORRELATION;
    return result('mismatch', firstOk
      ? 'Lines up at the start but not further in: probably a different edit.'
      : "Doesn't sound like the same recording.");
  }
  if (sorted[sorted.length - 1] - sorted[0] > MAX_WINDOW_SPREAD_MS) {
    return result('mismatch', `The offset changes through the track (${lags.map(l => `${Math.round(l)} ms`).join(', ')}): probably a different edit.`);
  }
  if (Math.abs(offset) <= ALIGNED_MS) {
    return result('aligned', `Same recording, lined up with the file Rekordbox has now (within ${Math.max(0.1, Math.abs(offset)).toFixed(1)} ms).`);
  }
  // The usual MP3 case: the new file matches the original once the encoder
  // delay Rekordbox counts (and a gapless decoder drops) is taken off.
  const trim = m.gaplessTrimMs ?? 0;
  if (trim > ALIGNED_MS && Math.abs(offset + trim) <= ALIGNED_MS) {
    return result('shifted', `Same recording. Rekordbox times this ${m.originalTimeline === 'untrimmed' ? 'compressed file' : 'file'} including its ${formatMs(trim)} encoder delay, which the lossless file doesn't have, so cue points move ${formatMs(offset)} earlier.`);
  }
  return result('shifted', `Same recording, but the music sits ${formatMs(offset)} ${offset > 0 ? 'later' : 'earlier'} in the new file, so cue points move with it.`);
}

/** Why the cues can't follow `shiftMs` onto a file `newLengthMs` long, or null.
 *  Mirrors swap_cues.shift_cue. */
export function cueShiftProblem(cues: SwapCue[], shiftMs: number, newLengthMs: number): string | null {
  for (const c of cues) {
    const loop = c.OutMsec != null && c.OutMsec >= 0;
    const newIn = c.InMsec + shiftMs;
    if (newIn < 0 && (loop || newIn < -CUE_CLAMP_MS)) return `a ${loop ? 'loop' : 'cue point'} at ${formatDuration(c.InMsec / 1000)} would fall before the start of the new file`;
    const last = loop ? c.OutMsec + shiftMs : Math.max(0, newIn);
    if (last > newLengthMs) return `a ${loop ? 'loop' : 'cue point'} at ${formatDuration(c.InMsec / 1000)} would fall past the end of the new file`;
  }
  return null;
}

function asEntry(row: SwapRow): RekordboxEntry {
  return {
    rbId: row.rbId, artist: row.artist, title: row.Title ?? '', album: row.album, filePath: row.FolderPath ?? '',
    fileType: row.FileType, bitRate: row.BitRate ?? 0, sampleRate: row.SampleRate ?? 0, bitDepth: row.BitDepth ?? 0, length: row.Length ?? 0,
  };
}

function aiffLabel(bitDepth: number, sampleRate: number): string {
  return `AIFF ${bitDepth}/${sampleRate / 1000}`;
}

/** The plan entry for a row, before the swap/skip decision fills it in. */
function blankItem(rbId: string, row: SwapRow | undefined, newFilePath: string): UpgradeSwapPlanItem {
  return {
    rbId,
    title: row?.Title ?? '',
    artist: row?.artist ?? '',
    action: 'skip',
    before: {
      path: row?.FolderPath ?? '', format: row ? classifyEntry(asEntry(row)).label : '',
      bitRate: row?.BitRate ?? 0, sampleRate: row?.SampleRate ?? 0, bitDepth: row?.BitDepth ?? 0,
      fileSize: row?.FileSize ?? 0, lengthSec: row?.Length ?? 0,
    },
    after: { path: newFilePath, format: '', sampleRate: 0, bitDepth: 0, fileSize: null, lengthSec: 0 },
    keeps: {
      hotCues: row?.counts.hotCues ?? 0, memoryCues: row?.counts.memoryCues ?? 0, loops: row?.counts.loops ?? 0,
      playlists: row?.counts.playlists ?? 0, myTags: row?.counts.myTags ?? 0,
      playCount: row?.DJPlayCount ?? 0, dateAdded: row?.StockDate ?? '', rating: row?.Rating ?? 0,
    },
    alignment: { status: 'unchecked', offsetMs: 0, confidence: 0, note: '' },
    cueShiftMs: 0,
    checkBeatgrid: false,
    oldFileGoesTo: null,
  };
}

function cueCount(row: SwapRow): number {
  return row.counts.hotCues + row.counts.memoryCues + row.counts.loops;
}

/** The DB edit for one written file. Every field set has an expectBefore
 *  guard; the history fields are guarded too, so a plan Rekordbox has moved
 *  past since is refused rather than applied. */
export function buildApplyItem(p: Pick<PlannedSwap, 'row' | 'item'>, written: { path: string; size: number; sampleRate: number; bitDepth: number; channels: number; durationSec: number }) {
  const { row } = p;
  const set: Record<string, unknown> = {
    FolderPath: written.path,
    FileNameL: path.basename(written.path),
    FileSize: written.size,
    FileType: AIFF_FILE_TYPE,
    BitRate: losslessBitRate(written.sampleRate, written.bitDepth, written.channels),
    SampleRate: written.sampleRate,
    BitDepth: written.bitDepth,
  };
  // Length is whole seconds; only rewrite it when the new file really differs.
  if (Math.abs(written.durationSec - (row.Length ?? 0)) > 1) set.Length = Math.floor(written.durationSec);
  // OrgFolderPath follows the file when it named the old one (as pyrekordbox's
  // own update_content_path does); in Ben's collection it's always empty.
  if (row.OrgFolderPath && row.OrgFolderPath === row.FolderPath) set.OrgFolderPath = written.path;
  const expectBefore: Record<string, unknown> = { StockDate: row.StockDate, DJPlayCount: row.DJPlayCount, Rating: row.Rating, ColorID: row.ColorID, UUID: row.UUID };
  for (const k of Object.keys(set)) expectBefore[k] = (row as unknown as Record<string, unknown>)[k];
  return {
    rbId: row.rbId,
    expectBefore,
    set,
    cueShiftMs: p.item.cueShiftMs,
    // AIFF rows carry 0 in the four MPEG seek fields; only MP3 rows fill them.
    zeroMpeg: row.FileType !== AIFF_FILE_TYPE,
    newLengthMs: Math.floor(written.durationSec * 1000),
    cuesBefore: row.cues,
    contentCueBefore: row.contentCue,
  };
}

// ---------- Tags ----------

type TagSet = Partial<Record<'title' | 'artist' | 'album' | 'albumArtist' | 'genre' | 'comment' | 'date' | 'label' | 'bpm' | 'key' | 'remixer' | 'track' | 'disc' | 'composer' | 'isrc' | 'copyright', string>>;

function firstText(v: unknown): string {
  const x = Array.isArray(v) ? v[0] : v;
  if (x == null) return '';
  if (typeof x === 'object' && 'text' in (x as Record<string, unknown>)) return String((x as { text?: unknown }).text ?? '').trim();
  return String(x).trim();
}

/** A comment ffmpeg wrote (the app's own tag editor included) sits in an ID3
 *  TXXX:comment frame, which music-metadata doesn't count as the comment. */
function txxxComment(meta: IAudioMetadata): string {
  for (const [format, tags] of Object.entries(meta.native ?? {})) {
    if (!format.startsWith('ID3v2')) continue;
    const hit = tags.find(t => t.id.toLowerCase() === 'txxx:comment');
    if (hit && hit.value != null && String(hit.value).trim()) return String(hit.value).trim();
  }
  return '';
}

export function tagsFromMetadata(meta: IAudioMetadata): TagSet {
  const c = meta.common;
  const dj = readDjTags(meta);
  return {
    title: firstText(c.title), artist: firstText(c.artist), album: firstText(c.album), albumArtist: firstText(c.albumartist),
    genre: firstText(c.genre), comment: firstText(c.comment) || txxxComment(meta), date: firstText(c.date) || (c.year ? String(c.year) : ''),
    label: firstText(c.label), bpm: dj.bpm, key: dj.key, remixer: dj.remixer,
    track: c.track?.no ? String(c.track.no) : '', disc: c.disk?.no ? String(c.disk.no) : '',
    composer: firstText(c.composer), isrc: firstText(c.isrc), copyright: firstText(c.copyright),
  };
}

/** The original's tags, field by field; the store file's where the original has none. */
export function mergeTags(original: TagSet | null, store: TagSet): TagSet {
  const out: TagSet = {};
  for (const k of new Set([...Object.keys(store), ...Object.keys(original ?? {})]) as Set<keyof TagSet>) {
    const v = original?.[k] || store[k];
    if (v) out[k] = v;
  }
  return out;
}

/** -metadata args for an ID3v2.3 tag in AIFF. Frame ids are written directly
 *  where ffmpeg has no mapping (TBPM/TKEY/TPE4/TSRC), the way updateTagsFfmpeg does. */
export function id3MetadataArgs(tags: TagSet): string[] {
  const map: Array<[keyof TagSet, string]> = [
    ['title', 'title'], ['artist', 'artist'], ['album', 'album'], ['albumArtist', 'album_artist'], ['genre', 'genre'],
    ['comment', 'comment'], ['date', 'date'], ['label', 'publisher'], ['bpm', 'TBPM'], ['key', 'TKEY'], ['remixer', 'TPE4'],
    ['track', 'track'], ['disc', 'disc'], ['composer', 'composer'], ['isrc', 'TSRC'], ['copyright', 'copyright'],
  ];
  return map.flatMap(([k, frame]) => (tags[k] ? ['-metadata', `${frame}=${tags[k]}`] : []));
}

// ---------- Processes ----------

class SwapScriptError extends Error {
  constructor(message: string, readonly code: string, readonly extra: Record<string, unknown>) {
    super(message);
  }
}

/** Run lib/rekordbox/upgrade_swap.py. JSON in on stdin, JSON out on stdout;
 *  progress lines ({"progress": …}) on stderr. A refusal or failure comes back
 *  as {"error", "code"} and is thrown as SwapScriptError. */
function runSwapScript<T>(deps: SwapDeps, args: string[], opts: { input?: unknown; timeoutMs: number; onPhase?: (phase: string) => void }): Promise<T> {
  // dbPath is for tests on a copy. The live folder is only ever reached by
  // letting the helper detect it, never by a path handed in.
  if (deps.dbPath && path.resolve(deps.dbPath).startsWith(path.join(os.homedir(), 'Library', 'Pioneer') + path.sep)) {
    return Promise.reject(new Error('dbPath must be a copy of master.db, not the live Rekordbox folder'));
  }
  const script = path.join(deps.appRoot, 'lib', 'rekordbox', 'upgrade_swap.py');
  const dbArgs = deps.dbPath && ['preflight', 'read', 'apply'].includes(args[0]) ? ['--db', deps.dbPath] : [];
  return new Promise((resolve, reject) => {
    Promise.resolve(rbxPython(deps.appRoot)).then((python) => {
      const proc = spawn(python, [script, ...args, ...dbArgs], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderrBuf = '';
      let stderrTail = '';
      const timer = setTimeout(() => proc.kill('SIGTERM'), opts.timeoutMs);
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => {
        stderrBuf += d.toString();
        let nl: number;
        while ((nl = stderrBuf.indexOf('\n')) >= 0) {
          const line = stderrBuf.slice(0, nl).trim();
          stderrBuf = stderrBuf.slice(nl + 1);
          try {
            const ev = JSON.parse(line) as { progress?: string };
            if (ev.progress) { opts.onPhase?.(ev.progress); continue; }
          } catch { /* not a progress line */ }
          if (line) stderrTail = (stderrTail + '\n' + line).slice(-2000);
        }
      });
      proc.on('error', (err) => { clearTimeout(timer); reject(new Error(`Couldn't run the Rekordbox helper: ${err.message}`)); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        let data: (T & { error?: string; code?: string }) | null = null;
        try { data = JSON.parse(stdout); } catch { /* handled below */ }
        if (!data) {
          if (stderrTail) log.warn('upgrade_swap.py stderr:', stderrTail);
          reject(new Error(code === null ? 'The Rekordbox helper took too long and was stopped.' : `The Rekordbox helper returned something unreadable (exit ${code}): ${(stdout || stderrTail).slice(0, 200)}`));
          return;
        }
        if (data.error) {
          const { error, code: errCode, ...extra } = data as unknown as { error: string; code?: string } & Record<string, unknown>;
          reject(new SwapScriptError(error, errCode ?? 'internal', extra));
          return;
        }
        resolve(data);
      });
      if (opts.input !== undefined) proc.stdin.end(JSON.stringify(opts.input));
      else proc.stdin.end();
    }, reject);
  });
}

function runCapture(bin: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => proc.kill('SIGTERM'), timeoutMs);
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    proc.on('error', (err) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: err.message }); });
  });
}

export async function probeAudio(file: string): Promise<AudioProbe> {
  const r = await runCapture(ffprobePath, [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'format=format_name,duration:stream=codec_name,sample_rate,channels,bits_per_raw_sample,bits_per_sample,sample_fmt,duration',
    '-of', 'json', file,
  ], 60_000);
  if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || 'ffprobe failed');
  const data = JSON.parse(r.stdout) as { format?: { format_name?: string; duration?: string }; streams?: Array<Record<string, string | number | undefined>> };
  const s = data.streams?.[0];
  if (!s) throw new Error('no audio stream');
  const fmtBits: Record<string, number> = { s16: 16, s16p: 16, s32: 32, s32p: 32, flt: 32, fltp: 32, dbl: 64, dblp: 64, u8: 8 };
  const bits = Number(s.bits_per_raw_sample) || Number(s.bits_per_sample) || fmtBits[String(s.sample_fmt)] || 0;
  return {
    codec: String(s.codec_name ?? ''),
    container: String(data.format?.format_name ?? '').split(',')[0],
    sampleRate: Number(s.sample_rate) || 0,
    bitDepth: bits,
    channels: Number(s.channels) || 2,
    durationSec: Number(s.duration) || Number(data.format?.duration) || 0,
  };
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

async function readFolders(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) out.set(folderKey(e.name), e.name);
  }
  return out;
}

// ---------- Preflight ----------

/** Nearest existing folder at or above `dir` is writable (so `dir` can be made),
 *  and — for a path under /Volumes — the volume is mounted. */
async function folderUsable(dir: string): Promise<boolean> {
  const vol = /^\/Volumes\/[^/]+/.exec(dir)?.[0];
  if (vol && !(await exists(vol))) return false;
  let cur = dir;
  for (;;) {
    try {
      const st = await fs.stat(cur);
      if (!st.isDirectory()) return false;
      await fs.access(cur, fs.constants.W_OK);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      const up = path.dirname(cur);
      if (up === cur) return false;
      cur = up;
    }
  }
}

export async function preflightUpgradeSwap(deps: SwapDeps): Promise<UpgradeSwapPreflight> {
  const base = { backupDir: deps.backupDir, archiveDir: path.join(deps.archiveRoot, 'upgraded-originals'), libraryRoot: deps.libraryRoot };
  try {
    const [py, backupDirOk] = await Promise.all([
      runSwapScript<{ rekordboxRunning: boolean; dbFound: boolean }>(deps, ['preflight'], { timeoutMs: 30_000 }),
      folderUsable(deps.backupDir),
    ]);
    const errors: string[] = [];
    if (!py.dbFound) errors.push("Couldn't find Rekordbox's collection on this Mac.");
    if (!backupDirOk) errors.push(`The backup folder (${deps.backupDir}) can't be written — is the drive connected?`);
    if (!(await exists(deps.libraryRoot))) errors.push(`The library folder (${deps.libraryRoot}) isn't there — is the drive connected?`);
    return { ...base, rekordboxRunning: py.rekordboxRunning, dbFound: py.dbFound, backupDirOk, ...(errors.length ? { error: errors.join(' ') } : {}) };
  } catch (err) {
    return { ...base, rekordboxRunning: false, dbFound: false, backupDirOk: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------- Plan ----------

const VARIANTS = 8;

/** Plan (read-only). Never writes a file or the DB; safe while Rekordbox runs. */
export async function planUpgradeSwap(inputs: UpgradeSwapInput[], deps: SwapDeps): Promise<UpgradeSwapPlanItem[]> {
  // One entry per rbId (the last input wins), in the order given.
  const byId = new Map<string, UpgradeSwapInput>();
  for (const i of inputs) if (i?.rbId && i.newFilePath) byId.set(String(i.rbId), { rbId: String(i.rbId), newFilePath: path.resolve(i.newFilePath) });
  const wanted = [...byId.values()];
  const progress = (current: number, message: string) => deps.onProgress?.({ phase: 'planning', current, total: wanted.length, message });
  progress(0, 'Reading the tracks from Rekordbox…');

  // The rows first (for artist and original path), then one more read for who
  // owns which candidate paths.
  const first = await runSwapScript<{ rows: Record<string, SwapRow> }>(deps, ['read'], { input: { ids: wanted.map(w => w.rbId), paths: [] }, timeoutMs: 120_000 });
  const libraryOk = await exists(deps.libraryRoot);
  const folders = libraryOk ? await readFolders(deps.libraryRoot) : new Map<string, string>();
  const candidates = new Map<string, string[]>();
  for (const w of wanted) {
    const row = first.rows[w.rbId];
    if (!row) continue;
    const originalDirExists = !!row.FolderPath && path.isAbsolute(row.FolderPath) && await exists(path.dirname(row.FolderPath));
    candidates.set(w.rbId, numberedVariants(swapTargetBase(deps.libraryRoot, row.artist, row.FolderPath, folders, originalDirExists), VARIANTS));
  }
  const paths = wanted.flatMap(w => [w.newFilePath, first.rows[w.rbId]?.FolderPath ?? '', ...(candidates.get(w.rbId) ?? [])]).filter(Boolean);
  const { pathOwners } = await runSwapScript<{ pathOwners: Record<string, string[]> }>(deps, ['read'], { input: { ids: [], paths }, timeoutMs: 120_000 });
  const owners = new Map(Object.entries(pathOwners).map(([p, ids]) => [folderKey(p), ids]));
  const ownersOf = (p: string) => owners.get(folderKey(p)) ?? [];

  const claimed = new Set<string>();
  const items: UpgradeSwapPlanItem[] = [];
  for (const [i, w] of wanted.entries()) {
    const row = first.rows[w.rbId];
    progress(i, `Checking ${row ? `${row.artist} – ${row.Title}` : w.rbId}…`);
    const planned = await planOne(w, row, {
      deps, libraryOk, ownersOf, claimed,
      candidates: candidates.get(w.rbId) ?? [],
    });
    items.push(planned.item);
    if (planned.item.action === 'swap') {
      claimed.add(folderKey(planned.item.after.path));
      planCache.set(w.rbId, planned);
    } else {
      planCache.delete(w.rbId);
    }
  }
  progress(wanted.length, `Planned ${items.filter(x => x.action === 'swap').length} of ${items.length} swaps`);
  return items;
}

type PlanCtx = {
  deps: SwapDeps;
  libraryOk: boolean;
  ownersOf: (p: string) => string[];
  claimed: Set<string>;
  candidates: string[];
};

async function planOne(w: UpgradeSwapInput, row: SwapRow | undefined, ctx: PlanCtx): Promise<PlannedSwap> {
  const item = blankItem(w.rbId, row, w.newFilePath);
  const planned: PlannedSwap = {
    item, row: row as SwapRow, newFilePath: w.newFilePath,
    newFile: { size: 0, mtimeMs: 0, probe: { codec: '', container: '', sampleRate: 0, bitDepth: 0, channels: 2, durationSec: 0 } },
    originalOnDisk: false, originalShared: false,
    conversion: { copyAudio: false, codec: '', sampleRate: 0, bitDepth: 0 },
    plannedAt: Date.now(),
  };
  const skip = (reason: string, alignment?: Partial<UpgradeSwapAlignment>): PlannedSwap => {
    item.action = 'skip';
    item.reason = reason;
    item.cueShiftMs = 0;
    item.checkBeatgrid = false;
    item.oldFileGoesTo = null;
    if (alignment) item.alignment = { ...item.alignment, ...alignment };
    return planned;
  };

  if (!row) return skip("This track isn't in your Rekordbox collection any more, so there's nothing to swap.");
  const held = classifyEntry(asEntry(row));
  if (row.FileType === STREAMING_FILE_TYPE || held.format === 'streaming') {
    return skip(`This is a ${held.label} in Rekordbox, not a file. Rekordbox ties streaming entries to the service (it even stores their titles encrypted), so one can't safely be pointed at a file. Import the new file into Rekordbox as a normal track instead; the stream's cue points stay on the stream.`,
      { status: 'unchecked', note: 'Streaming entry: nothing to compare.' });
  }
  if (held.format === 'lossless') return skip(`Rekordbox already has this as a lossless file (${held.label}), so there's nothing to upgrade.`);
  if (folderKey(row.FolderPath) === folderKey(w.newFilePath)) return skip('Rekordbox already uses this file for the track.');
  if (row.contentCueCount > 1) return skip("Rekordbox keeps two copies of this track's cue points, which has never been seen before, so it was left alone.");
  // Before the file is even opened: a lossless file that is already another
  // entry's (the "relink" rows) is never merged.
  if (ctx.ownersOf(w.newFilePath).some(id => id !== row.rbId)) {
    return skip('This lossless file already has its own entry in Rekordbox, with its own cue points and history. Joining two entries means deleting one, which this never does: in Rekordbox, keep whichever entry you want and remove the other yourself.');
  }

  // The new file: there, readable, lossless.
  let stat: { size: number; mtimeMs: number };
  try {
    stat = await fs.stat(w.newFilePath);
  } catch {
    return skip(`The new file isn't there any more (${path.basename(w.newFilePath)}). Download it again, then try again.`);
  }
  let probe: AudioProbe;
  try {
    probe = await probeAudio(w.newFilePath);
  } catch {
    return skip(`The new file (${path.basename(w.newFilePath)}) couldn't be read as audio.`);
  }
  planned.newFile = { size: stat.size, mtimeMs: stat.mtimeMs, probe };
  if (!isLosslessCodec(probe.codec)) {
    return skip(`The new file is ${probe.codec.toUpperCase() || 'not lossless'} — only lossless files (FLAC, WAV, AIFF or ALAC) are swapped in.`);
  }
  if (!ctx.libraryOk) return skip(`Your library folder (${ctx.deps.libraryRoot}) isn't available — is the drive connected?`);

  // Where it goes: the first name nothing on disk, in Rekordbox or earlier in
  // this plan already uses.
  let target: string | null = null;
  for (const c of ctx.candidates) {
    if (ctx.claimed.has(folderKey(c)) || ctx.ownersOf(c).length || await exists(c)) continue;
    target = c;
    break;
  }
  if (!target) return skip(`There's no free file name for it in ${path.dirname(ctx.candidates[0] ?? ctx.deps.libraryRoot)}.`);
  planned.conversion = conversionFor(probe);
  item.after = {
    path: target, format: aiffLabel(planned.conversion.bitDepth, planned.conversion.sampleRate),
    sampleRate: planned.conversion.sampleRate, bitDepth: planned.conversion.bitDepth,
    fileSize: null, lengthSec: Math.round(probe.durationSec * 10) / 10,
  };

  // The original: is it there to compare with (and archive afterwards)?
  planned.originalOnDisk = await exists(row.FolderPath);
  planned.originalShared = ctx.ownersOf(row.FolderPath).some(id => id !== row.rbId);
  if (!planned.originalOnDisk) {
    item.alignment = { status: 'unchecked', offsetMs: 0, confidence: 0, note: 'The original file is missing, so the new one could not be compared with it.' };
    if (cueCount(row) > 0) {
      return skip(`The file Rekordbox has now is missing, so there's no way to check the new one lines up with your ${cueCount(row)} cue point${cueCount(row) === 1 ? '' : 's'}. Reconnect the drive (or relocate the track in Rekordbox) and plan again.`);
    }
    if (Math.abs(probe.durationSec - (row.Length ?? 0)) > MAX_LENGTH_DIFF_SEC + 1) {
      return skip(`The new file seems to be a different version (${formatDuration(probe.durationSec)} vs ${formatDuration(row.Length ?? 0)}), so it wasn't swapped.`);
    }
    item.action = 'swap';
    item.checkBeatgrid = true;
    item.reason = "The old file is missing, so the timing couldn't be checked. The track has no cue points to misplace; check its beatgrid in Rekordbox afterwards.";
    return planned;
  }

  // An M4A Rekordbox recorded no bit rate for could be AAC or ALAC: ask the file.
  let originalLossy = held.format === 'lossy';
  if (held.format === 'unknown') {
    const orig = await probeAudio(row.FolderPath).catch(() => null);
    if (orig && isLosslessCodec(orig.codec)) return skip(`Rekordbox already has this as a lossless file (${orig.codec.toUpperCase()}), so there's nothing to upgrade.`);
    originalLossy = true;
  }

  let measurement: AlignMeasurement;
  try {
    measurement = await runSwapScript<AlignMeasurement>(ctx.deps, ['align', '--ffmpeg', ffmpegPath, '--original', row.FolderPath, '--new', w.newFilePath, ...(originalLossy ? ['--original-lossy'] : [])], { timeoutMs: 300_000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return skip(`The two files couldn't be compared (${msg}), so it wasn't swapped.`, { status: 'unchecked', note: msg });
  }
  item.alignment = classifyAlignment(measurement);
  const a = item.alignment;
  if (a.status === 'mismatch') {
    const lengths = Math.abs(measurement.newDurationSec - measurement.originalDurationSec) > MAX_LENGTH_DIFF_SEC;
    return skip(lengths
      ? `The new file seems to be a different version (${formatDuration(measurement.newDurationSec)} vs ${formatDuration(measurement.originalDurationSec)}), so it wasn't swapped.`
      : `The new file doesn't line up with the one in Rekordbox (${a.note.replace(/\.$/, '').toLowerCase()}), so it wasn't swapped.`);
  }
  if (a.status === 'unchecked') return skip(`The two files couldn't be compared (${a.note.replace(/\.$/, '').toLowerCase()}), so it wasn't swapped.`);

  item.cueShiftMs = a.status === 'shifted' ? Math.round(a.offsetMs) : 0;
  const problem = cueShiftProblem(row.cues, item.cueShiftMs, Math.floor(probe.durationSec * 1000));
  if (problem) return skip(`Not swapped: ${problem}.`);

  item.action = 'swap';
  item.checkBeatgrid = item.cueShiftMs !== 0;
  item.oldFileGoesTo = planned.originalShared ? null : archivePathFor(row.FolderPath, ctx.deps.libraryRoot, ctx.deps.archiveRoot);
  const notes: string[] = [];
  if (item.cueShiftMs !== 0) {
    notes.push(`Cue points move ${formatMs(item.cueShiftMs)} ${item.cueShiftMs < 0 ? 'earlier' : 'later'} to stay on the same beat. The beatgrid isn't moved: re-analyze the track in Rekordbox afterwards (or shift its grid ${formatMs(item.cueShiftMs)} ${item.cueShiftMs < 0 ? 'earlier' : 'later'}).`);
  }
  if (planned.originalShared) notes.push('Another Rekordbox entry uses the old file too, so it stays where it is.');
  if (notes.length) item.reason = notes.join(' ');
  return planned;
}

// ---------- Apply ----------

type Written = { path: string; size: number; sampleRate: number; bitDepth: number; channels: number; durationSec: number };

/** Write the AIFF next to its final path with the original's tags and cover,
 *  check it, then rename it into place. Never replaces an existing file. */
async function writeSwapFile(p: PlannedSwap, deps: SwapDeps): Promise<Written> {
  const target = p.item.after.path;
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (await exists(target)) throw new Error(`a file appeared at ${target} since the plan`);

  const readTags = (f: string) => parseFile(f, { duration: false, skipCovers: false }).catch(() => null);
  const [origMeta, storeMeta] = await Promise.all([p.originalOnDisk ? readTags(p.row.FolderPath) : Promise.resolve(null), readTags(p.newFilePath)]);
  // Without the original file, Rekordbox's own title/artist/album stand in for its tags.
  const original: TagSet | null = origMeta
    ? tagsFromMetadata(origMeta)
    : { title: p.row.Title ?? '', artist: p.row.artist, album: p.row.album };
  const tags = mergeTags(original, storeMeta ? tagsFromMetadata(storeMeta) : {});
  const origArt = Boolean(origMeta?.common.picture?.length);
  const storeArt = Boolean(storeMeta?.common.picture?.length);

  const ext = path.extname(target);
  const tmp = `${target.slice(0, target.length - ext.length)}.converting-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext}`;
  const inputs = ['-i', p.newFilePath, ...(origArt ? ['-i', p.row.FolderPath] : [])];
  const art = origArt ? '1:v:0' : storeArt ? '0:v:0' : null;
  const conv = p.conversion;
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', ...inputs,
    '-map', '0:a:0',
    ...(art ? ['-map', art, '-c:v', 'copy', '-disposition:v:0', 'attached_pic', '-metadata:s:v:0', 'title=Album cover', '-metadata:s:v:0', 'comment=Cover (front)'] : []),
    ...(conv.copyAudio ? ['-c:a', 'copy'] : ['-c:a', conv.codec, '-ar', String(conv.sampleRate)]),
    '-map_metadata', '-1',
    ...id3MetadataArgs(tags),
    '-write_id3v2', '1', '-id3v2_version', '3',
    '-f', 'aiff', '-n', tmp,
  ];
  const bytes = await statBytes(p.newFilePath);
  const r = await runCapture(ffmpegPath, args, 15 * 60_000);
  if (r.code !== 0) {
    await fs.unlink(tmp).catch(() => {});
    const msg = r.stderr.trim().split('\n').pop() || `ffmpeg exited ${r.code}`;
    recordWrite({ op: 'convert', src: p.newFilePath, dest: target, bytes, context: 'lossless-swap', outcome: 'error', error: msg });
    throw new Error(`couldn't write the AIFF (${msg})`);
  }
  try {
    if (tags.comment) {
      // ffmpeg only manages TXXX:comment; make it the COMM frame players read.
      const r = await runSwapScript<{ ok: boolean; reason?: string }>(deps, ['comment', '--file', tmp, '--text', tags.comment], { timeoutMs: 60_000 })
        .catch((err: unknown) => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }));
      if (!r.ok) log.warn(`Comment left as ffmpeg wrote it (${r.reason}): ${target}`);
    }
    const probe = await probeAudio(tmp);
    if (Math.abs(probe.durationSec - p.newFile.probe.durationSec) > 0.5) throw new Error(`the written file is ${probe.durationSec.toFixed(1)} s, the download ${p.newFile.probe.durationSec.toFixed(1)} s`);
    if (await exists(target)) throw new Error(`a file appeared at ${target} while writing`);
    await fs.rename(tmp, target);
    const size = (await fs.stat(target)).size;
    recordWrite({ op: 'convert', src: p.newFilePath, dest: target, bytes, context: 'lossless-swap', outcome: 'ok', detail: { rbId: p.row.rbId, copyAudio: conv.copyAudio, tagsFrom: origMeta ? 'original' : 'rekordbox' } });
    return { path: target, size, sampleRate: probe.sampleRate, bitDepth: probe.bitDepth || conv.bitDepth, channels: probe.channels, durationSec: probe.durationSec };
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    recordWrite({ op: 'convert', src: p.newFilePath, dest: target, bytes, context: 'lossless-swap', outcome: 'error', error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/** Remove a file this run created (the DB never got to point at it). */
async function removeCreated(file: string, why: string): Promise<void> {
  const bytes = await statBytes(file);
  try {
    await fs.unlink(file);
    recordWrite({ op: 'delete', src: file, bytes, context: 'lossless-swap-cleanup', outcome: 'ok', detail: { why } });
  } catch (err) {
    recordWrite({ op: 'delete', src: file, bytes, context: 'lossless-swap-cleanup', outcome: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

/** Still the plan's world? The download unchanged, the original where it was. */
async function stillAsPlanned(p: PlannedSwap): Promise<string | null> {
  if (Date.now() - p.plannedAt > PLAN_TTL_MS) return 'The plan is old; plan again.';
  const st = await fs.stat(p.newFilePath).catch(() => null);
  if (!st) return `The new file isn't there any more (${path.basename(p.newFilePath)}).`;
  if (st.size !== p.newFile.size || st.mtimeMs !== p.newFile.mtimeMs) return 'The new file changed since the plan; plan again.';
  if (p.originalOnDisk && !(await exists(p.row.FolderPath))) return 'The old file moved since the plan; plan again.';
  return null;
}

type PyApplyResult = {
  items: Array<{ rbId: string; status: 'written' | 'guard_failed' | 'row_missing' | 'refused'; detail: string }>;
  backupPath: string | null;
  rollbackPath: string | null;
};

const PHASES: Record<string, { phase: UpgradeSwapProgress['phase']; message: string }> = {
  snapshot: { phase: 'writing', message: "Backing up Rekordbox's collection…" },
  writing: { phase: 'writing', message: 'Pointing the tracks at their new files…' },
  verifying: { phase: 'verifying', message: 'Checking every change read back correctly…' },
  restoring: { phase: 'verifying', message: 'A check failed — putting the backup back…' },
};

export async function applyUpgradeSwap(rbIds: string[], deps: SwapDeps): Promise<UpgradeSwapResult> {
  if (applyRunning) throw new Error('A swap is already running.');
  applyRunning = true;
  try {
    return await doApply([...new Set(rbIds.map(String))], deps);
  } finally {
    applyRunning = false;
  }
}

async function doApply(rbIds: string[], deps: SwapDeps): Promise<UpgradeSwapResult> {
  const send = (phase: UpgradeSwapProgress['phase'], current: number, total: number, message: string) =>
    deps.onProgress?.({ phase, current, total, message });
  const results = new Map<string, UpgradeSwapResultItem>();
  const resultFor = (p: PlannedSwap | undefined, rbId: string, status: UpgradeSwapResultItem['status'], detail: string): UpgradeSwapResultItem => {
    const r: UpgradeSwapResultItem = {
      rbId, title: p?.item.title ?? '', artist: p?.item.artist ?? '', status, detail,
      cueShiftMs: status === 'swapped' ? (p?.item.cueShiftMs ?? 0) : 0,
      checkBeatgrid: status === 'swapped' ? (p?.item.checkBeatgrid ?? false) : false,
    };
    results.set(rbId, r);
    return r;
  };

  // Only what this process planned as a swap; paths never come from the caller.
  const todo: PlannedSwap[] = [];
  for (const id of rbIds) {
    const p = planCache.get(id);
    if (!p || p.item.action !== 'swap') { resultFor(p, id, 'skipped', 'Not in the current plan as a swap; plan again.'); continue; }
    const stale = await stillAsPlanned(p);
    if (stale) { resultFor(p, id, 'skipped', stale); continue; }
    todo.push(p);
  }

  // 1. Files. Each AIFF lands at its final path; nothing in Rekordbox points
  //    at it yet, so a failure here only costs that one file.
  const written = new Map<string, Written>();
  for (const [i, p] of todo.entries()) {
    send('converting', i, todo.length, `Writing ${p.item.artist} – ${p.item.title}…`);
    try {
      written.set(p.row.rbId, await writeSwapFile(p, deps));
    } catch (err) {
      resultFor(p, p.row.rbId, 'failed', `The new file couldn't be prepared: ${err instanceof Error ? err.message : String(err)}. Nothing was changed.`);
    }
  }
  const ready = todo.filter(p => written.has(p.row.rbId));

  // 2. Rekordbox: one guarded session for all of them.
  let backupPath: string | null = null;
  let rollbackPath: string | null = null;
  if (ready.length) {
    send('writing', 0, ready.length, "Backing up Rekordbox's collection…");
    let py: PyApplyResult | null = null;
    try {
      py = await runSwapScript<PyApplyResult>(deps, ['apply', '--backup-dir', deps.backupDir], {
        input: { items: ready.map(p => buildApplyItem(p, written.get(p.row.rbId)!)) },
        timeoutMs: 10 * 60_000,
        onPhase: (phase) => { const m = PHASES[phase]; if (m) send(m.phase, 0, ready.length, m.message); },
      });
      backupPath = py.backupPath;
      rollbackPath = py.rollbackPath;
    } catch (err) {
      // Nothing points at the new files (the session rolled back, or the backup
      // was put back): remove them and leave everything else as it was.
      const extra = err instanceof SwapScriptError ? err.extra : {};
      backupPath = (extra.backupPath as string) ?? null;
      rollbackPath = (extra.rollbackPath as string) ?? null;
      let msg = err instanceof Error ? err.message : String(err);
      // Name what was seen running, so a stuck helper is easy to spot.
      const seen = Array.isArray(extra.processes) ? (extra.processes as string[]).map(p => path.basename(p.replace(/^\d+\s+/, ''))) : [];
      if (seen.length) msg = `${msg} (still running: ${[...new Set(seen)].join(', ')})`;
      const restoreFailed = err instanceof SwapScriptError && err.code === 'restore-failed';
      for (const p of ready) {
        // A failed restore leaves master.db in doubt: keep the files it may point at.
        if (!restoreFailed) await removeCreated(written.get(p.row.rbId)!.path, `rekordbox write failed: ${msg}`);
        resultFor(p, p.row.rbId, 'failed', restoreFailed ? msg : `${msg} Your tracks are as they were.`);
      }
      log.error('lossless swap: Rekordbox write failed:', err);
    }

    if (py) {
      const status = new Map(py.items.map(s => [s.rbId, s]));
      const swapped: PlannedSwap[] = [];
      for (const p of ready) {
        const s = status.get(p.row.rbId);
        if (s?.status === 'written') { swapped.push(p); continue; }
        await removeCreated(written.get(p.row.rbId)!.path, `not written: ${s?.status ?? 'missing'}`);
        const detail = s?.status === 'guard_failed' ? `${s.detail} Nothing was changed; plan again.`
          : s?.status === 'row_missing' ? 'The track is no longer in Rekordbox. Nothing was changed.'
          : `${s?.detail || 'Rekordbox refused the change.'} Nothing was changed.`;
        resultFor(p, p.row.rbId, s?.status === 'refused' ? 'skipped' : 'failed', detail);
      }

      // 3. Only now, with the DB verified: archive the old files, clear the downloads.
      for (const [i, p] of swapped.entries()) {
        send('archiving', i, swapped.length, `Archiving the old file for ${p.item.artist} – ${p.item.title}…`);
        const w = written.get(p.row.rbId)!;
        const notes = [`Now ${p.item.after.format} at ${w.path}.`];
        if (p.item.cueShiftMs !== 0) {
          notes.push(`Cue points moved ${formatMs(p.item.cueShiftMs)} ${p.item.cueShiftMs < 0 ? 'earlier' : 'later'}; re-analyze the track in Rekordbox to rebuild its beatgrid.`);
        } else if (p.item.checkBeatgrid) {
          notes.push('Check its beatgrid in Rekordbox.');
        }
        if (p.originalOnDisk && !p.originalShared) {
          const archived = await archiveTrackFile(p.row.FolderPath, deps.libraryRoot, path.join(deps.archiveRoot, 'upgraded-originals'));
          notes.push(archived.success ? `The old file is in ${archived.archivePath}.` : `The old file couldn't be archived (${archived.errorMessage}); it's still at ${p.row.FolderPath}.`);
        } else if (p.originalShared) {
          notes.push('The old file stays where it is: another Rekordbox entry uses it.');
        }
        // The download is now in the library; leave no copy in the intake folder
        // for Organize to import as a duplicate. To the Trash, so it's recoverable.
        try {
          await safeDelete(p.newFilePath, { context: 'lossless-swap', detail: { swappedInto: w.path, rbId: p.row.rbId } });
          updateDownloadedTrackPath(p.newFilePath, w.path);
        } catch (err) {
          notes.push(`The download is still at ${p.newFilePath} (${err instanceof Error ? err.message : String(err)}).`);
        }
        resultFor(p, p.row.rbId, 'swapped', notes.join(' '));
        planCache.delete(p.row.rbId);
      }
      invalidateLibraryFileLists();
    }
  }

  const items = rbIds.map(id => results.get(id)!).filter(Boolean);
  const count = (s: UpgradeSwapResultItem['status']) => items.filter(r => r.status === s).length;
  send('done', items.length, items.length, `${count('swapped')} swapped, ${count('skipped')} skipped, ${count('failed')} failed`);
  return { swapped: count('swapped'), skipped: count('skipped'), failed: count('failed'), backupPath, rollbackPath, items };
}

/** Tests only. */
export function _resetSwapState(): void {
  planCache.clear();
  applyRunning = false;
}
