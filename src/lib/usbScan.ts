/**
 * USB/volume scanner for Restore Library.
 * Indexes audio files on mounted external volumes and matches missing tracks via:
 *   1) Exact path rewrite  (original Rekordbox path -> mounted volume)
 *   2) Tag-based exact match (normalized artist + title from audio tags) — requires readTags.
 *   3) Fuzzy artist folder + title token match as a fallback.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import fuzzball from 'fuzzball';
import { parseFile } from 'music-metadata';
import { makeTagKey, normalizeForComparison } from './stringUtils';
import { createScopedLogger } from './logger';
import type { RekordboxTrack } from './rekordboxXml';

const log = createScopedLogger('UsbScan');
const AUDIO_EXT_RE = /\.(aiff?|wav|mp3|flac|m4a)$/i;

export type UsbVolume = {
  name: string;
  /** Absolute mount path, e.g. /Volumes/NHI 2-0 BAK */
  mountPath: string;
  /** Child path to start scan from (e.g. /Contents) when the volume has an obvious root. */
  scanRoot: string;
};

export type UsbMatch = {
  rekordboxTrack: RekordboxTrack;
  sourcePath: string;
  /** How the match was made. */
  method: 'exact_path' | 'tag_exact' | 'fuzzy';
  /** Fuzzy-only diagnostic scores. */
  folderScore?: number;
  fileScore?: number;
};

export type BuildIndexOptions = {
  /** Read audio tags (artist/title) during index build to enable tag_exact matching. Slower. */
  readTags?: boolean;
  /** Max concurrent metadata reads when readTags is true. */
  concurrency?: number;
  /** Optional progress callback during tag read. */
  onProgress?: (done: number, total: number) => void;
};

/** Detect mounted volumes that aren't the system disk. */
export async function listExternalVolumes(): Promise<UsbVolume[]> {
  const EXCLUDE = new Set(['Macintosh HD', 'com.apple.TimeMachine.localsnapshots']);
  const results: UsbVolume[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = await fsp.readdir('/Volumes', { withFileTypes: true });
  } catch { return []; }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (EXCLUDE.has(e.name)) continue;
    const mountPath = path.join('/Volumes', e.name);
    // Prefer a Rekordbox "Contents" folder when present (e.g. USB exports from Rekordbox).
    let scanRoot = mountPath;
    try {
      const contents = path.join(mountPath, 'Contents');
      const stat = await fsp.stat(contents);
      if (stat.isDirectory()) scanRoot = contents;
    } catch { /* no Contents subdir; scan the root */ }
    results.push({ name: e.name, mountPath, scanRoot });
  }
  return results;
}

async function walkAudio(dir: string, out: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 8) return out;
  let entries: fs.Dirent[] = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walkAudio(p, out, depth + 1);
    else if (AUDIO_EXT_RE.test(e.name)) out.push(p);
  }
  return out;
}

export type UsbIndex = {
  volume: UsbVolume;
  files: string[];
  byArtistFolder: Map<string, string[]>;
  /** Present only when built with readTags: true. Maps normalized (artist|title) -> file paths. */
  byTagKey?: Map<string, string[]>;
};

/** Build an index over the volume's audio files for fast matching. */
export async function buildUsbIndex(
  volume: UsbVolume,
  options: BuildIndexOptions = {},
): Promise<UsbIndex> {
  log.info(`Indexing ${volume.mountPath}${options.readTags ? ' (with tag read)' : ''}`);
  const files = await walkAudio(volume.scanRoot);
  const byArtistFolder = new Map<string, string[]>();
  const rootLen = volume.scanRoot.length + 1;
  for (const f of files) {
    const rel = f.slice(rootLen);
    const folder = rel.split('/')[0] || '';
    if (!byArtistFolder.has(folder)) byArtistFolder.set(folder, []);
    byArtistFolder.get(folder)!.push(f);
  }

  let byTagKey: Map<string, string[]> | undefined;
  if (options.readTags) {
    byTagKey = await buildTagIndex(files, options);
    log.info(`  ${volume.name}: ${files.length} files, ${byArtistFolder.size} folders, ${byTagKey.size} tag keys`);
  } else {
    log.info(`  ${volume.name}: ${files.length} audio files, ${byArtistFolder.size} artist folders`);
  }
  return { volume, files, byArtistFolder, byTagKey };
}

async function buildTagIndex(
  files: string[],
  options: BuildIndexOptions,
): Promise<Map<string, string[]>> {
  const concurrency = Math.max(1, options.concurrency ?? 12);
  const byTagKey = new Map<string, string[]>();
  let idx = 0;
  let done = 0;
  const total = files.length;
  const worker = async () => {
    while (idx < total) {
      const i = idx++;
      const filePath = files[i];
      try {
        const m = await parseFile(filePath, { duration: false, skipCovers: true });
        const artist = m.common.artist || m.common.artists?.[0] || '';
        const title = m.common.title || '';
        if (artist && title) {
          const key = makeTagKey(artist, title);
          if (key !== '|') {
            const bucket = byTagKey.get(key);
            if (bucket) bucket.push(filePath);
            else byTagKey.set(key, [filePath]);
          }
        }
      } catch { /* ignore unreadable files */ }
      done++;
      if (options.onProgress && (done % 50 === 0 || done === total)) {
        options.onProgress(done, total);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return byTagKey;
}

function fuzzScore(a: string, b: string): number {
  const aN = normalizeForComparison(a);
  const bN = normalizeForComparison(b);
  if (!aN || !bN) return 0;
  return Math.max(fuzzball.ratio(aN, bN), fuzzball.token_set_ratio(aN, bN)) / 100;
}

/**
 * Match a Rekordbox track against one indexed USB.
 *
 * - Strategy 1: rewrite the original Rekordbox Location so the prefix matches the USB scan root.
 *   The common Rekordbox pattern is `/Volumes/<old>/Music/<artist>/<album>/<file>` — we strip
 *   everything up to and including `/Music/` (or an equivalent root marker) and join to scanRoot.
 * - Strategy 2: artist-folder match (fuzz >= 0.75) then per-file title-token match within that
 *   folder, requiring at least 40% of title tokens present AND a combined score >= 0.55.
 */
export function matchAgainstUsbIndex(track: RekordboxTrack, index: UsbIndex): UsbMatch | null {
  // Strategy 1 — exact path rewrite.
  const orig = track.origPath || '';
  if (orig) {
    // Strip everything up to and including the first "/Music/" segment.
    const musicIdx = orig.toLowerCase().indexOf('/music/');
    if (musicIdx >= 0) {
      const rewritten = path.join(index.volume.scanRoot, orig.slice(musicIdx + '/music/'.length));
      if (fs.existsSync(rewritten)) {
        return { rekordboxTrack: track, sourcePath: rewritten, method: 'exact_path' };
      }
    }
  }

  // Strategy 2 — tag_exact. Requires both sides to have non-empty artist + title:
  // ambiguous matches (e.g. tagless-file-to-tagless-XML) are left for the caller's review.
  if (index.byTagKey && track.artist && track.title) {
    const key = makeTagKey(track.artist, track.title);
    if (key !== '|') {
      const hits = index.byTagKey.get(key);
      // Only auto-accept a unique hit. Multiple hits => ambiguous; fall through.
      if (hits && hits.length === 1) {
        return { rekordboxTrack: track, sourcePath: hits[0], method: 'tag_exact' };
      }
    }
  }

  // Strategy 3 — fuzzy artist folder + title token.
  const firstArtist = (track.artist || '').split(/[,&]/)[0].trim();
  if (!firstArtist) return null;
  const titleTokens = normalizeForComparison(track.title).split(' ').filter(Boolean);
  if (titleTokens.length === 0) return null;

  let bestFolder: string | null = null;
  let bestFolderScore = 0;
  for (const folder of index.byArtistFolder.keys()) {
    const s = fuzzScore(firstArtist, folder);
    if (s > bestFolderScore) { bestFolderScore = s; bestFolder = folder; }
  }
  if (!bestFolder || bestFolderScore < 0.75) return null;

  const candidates = index.byArtistFolder.get(bestFolder) || [];
  let bestFile: string | null = null;
  let bestFileScore = 0;
  let bestHits = 0;
  for (const f of candidates) {
    const fname = path.basename(f);
    const nFile = normalizeForComparison(fname);
    const hitRatio = titleTokens.filter(w => nFile.includes(w)).length / titleTokens.length;
    if (hitRatio === 0) continue; // require at least one title token in filename
    const s = fuzzScore(track.title, fname) * 0.6 + hitRatio * 0.4;
    if (s > bestFileScore) { bestFileScore = s; bestFile = f; bestHits = hitRatio; }
  }
  if (!bestFile || bestFileScore < 0.55 || bestHits < 0.4) return null;

  return {
    rekordboxTrack: track,
    sourcePath: bestFile,
    method: 'fuzzy',
    folderScore: +bestFolderScore.toFixed(3),
    fileScore: +bestFileScore.toFixed(3),
  };
}
