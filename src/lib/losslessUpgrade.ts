/**
 * Lossless upgrades: which entries in a Rekordbox playlist are held lossy (or
 * only as a streaming link), whether a lossless copy is already somewhere in
 * the collection, and which ones are worth a store search.
 *
 * Pure — the Rekordbox read (rekordboxPlaylists.ts), the Spotify lookup and
 * the store search are wired together in main.ts.
 */

import type { LosslessUpgradeRow, UpgradeFormatClass } from '../types';
import type { SpotifyTrack } from './spotify';
import { ownedVersionSatisfies } from './storeMatching';

/** One DjmdContent row as read_rekordbox_playlists.py emits it. */
export type RekordboxEntry = {
  rbId: string;
  artist: string;
  title: string;
  album: string;
  /** A file path, or a streaming URI such as `spotify:track:<id>`. */
  filePath: string;
  fileType: number | null;
  /** kbps; 0 when Rekordbox doesn't know. */
  bitRate: number;
  sampleRate: number;
  bitDepth: number;
  /** Seconds. */
  length: number;
};

// DjmdContent.FileType codes seen in the live collection (2026-11-02):
// 1 MP3, 4 M4A, 5 FLAC, 11 WAV, 12 AIFF, 25 a streaming entry with no file.
const FILE_TYPE_NAMES: Record<number, string> = { 1: 'MP3', 4: 'M4A', 5: 'FLAC', 11: 'WAV', 12: 'AIFF' };
const STREAMING_FILE_TYPE = 25;

const LOSSLESS_EXTS: Record<string, string> = { flac: 'FLAC', wav: 'WAV', aif: 'AIFF', aiff: 'AIFF' };
const LOSSY_EXTS: Record<string, string> = { mp3: 'MP3', aac: 'AAC', ogg: 'OGG', oga: 'OGG', opus: 'OPUS', wma: 'WMA', mp2: 'MP2' };
const M4A_EXTS = new Set(['m4a', 'mp4']);

/** An M4A is AAC or ALAC and only the bit rate tells them apart: AAC tops out
 *  at 320 kbps, 16/44.1 ALAC runs ~700–1000. */
const ALAC_MIN_KBPS = 500;

const SERVICE_NAMES: Record<string, string> = {
  spotify: 'Spotify', soundcloud: 'SoundCloud', tidal: 'TIDAL', beatport: 'Beatport', beatsource: 'Beatsource',
};

/** Rekordbox encrypts the title/artist of some streaming entries ("$A7:v1:…"). */
function isEncrypted(s: string): boolean {
  return s.startsWith('$A7:');
}

/** The service and ID behind a streaming FolderPath (`spotify:track:<id>`,
 *  `soundcloud:tracks:<id>`), or null for a file path. */
export function streamingUri(filePath: string): { service: string; id: string | null } | null {
  const m = /^([a-z][a-z0-9]+):(.*)$/i.exec(filePath.trim());
  if (!m || m[1].toLowerCase() === 'file') return null;
  const id = /^tracks?:([A-Za-z0-9]+)$/i.exec(m[2]);
  return { service: m[1].toLowerCase(), id: id ? id[1] : null };
}

function extOf(filePath: string): string {
  const base = filePath.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** "16/44.1", or '' when Rekordbox didn't record it. */
function resolutionLabel(e: RekordboxEntry): string {
  if (!e.bitDepth || !e.sampleRate) return '';
  return `${e.bitDepth}/${e.sampleRate / 1000}`;
}

function withDetail(name: string, detail: string | number): string {
  return detail ? `${name} ${detail}` : name;
}

/** Lossless, lossy, streaming or unknown — plus the short label the UI shows. */
export function classifyEntry(e: RekordboxEntry): { format: UpgradeFormatClass; label: string } {
  const stream = streamingUri(e.filePath);
  if (stream || e.fileType === STREAMING_FILE_TYPE) {
    const service = stream?.service ?? '';
    const name = SERVICE_NAMES[service] ?? (service ? service[0].toUpperCase() + service.slice(1) : 'Streaming');
    return { format: 'streaming', label: `${name} stream` };
  }

  const ext = extOf(e.filePath);
  if (LOSSLESS_EXTS[ext] || e.fileType === 5 || e.fileType === 11 || e.fileType === 12) {
    const name = LOSSLESS_EXTS[ext] ?? FILE_TYPE_NAMES[e.fileType!];
    return { format: 'lossless', label: withDetail(name, resolutionLabel(e)) };
  }
  if (M4A_EXTS.has(ext) || e.fileType === 4) {
    if (e.bitRate >= ALAC_MIN_KBPS) return { format: 'lossless', label: withDetail('ALAC', resolutionLabel(e)) };
    if (e.bitRate > 0) return { format: 'lossy', label: `AAC ${e.bitRate}` };
    return { format: 'unknown', label: 'M4A' };
  }
  if (LOSSY_EXTS[ext] || e.fileType === 1) {
    return { format: 'lossy', label: withDetail(LOSSY_EXTS[ext] ?? 'MP3', e.bitRate) };
  }
  return { format: 'unknown', label: ext ? ext.toUpperCase() : 'Unknown format' };
}

/** A playlist entry as an upgrade row: classified, but not yet resolved or searched. */
export function toUpgradeRow(e: RekordboxEntry): LosslessUpgradeRow {
  const { format, label } = classifyEntry(e);
  const encrypted = isEncrypted(e.title) || isEncrypted(e.artist);
  const row: LosslessUpgradeRow = {
    rbId: e.rbId,
    artist: encrypted ? '' : e.artist,
    title: encrypted ? '' : e.title,
    album: isEncrypted(e.album) ? '' : e.album,
    filePath: e.filePath,
    format,
    formatLabel: label,
    duration: e.length || undefined,
  };
  if (encrypted && streamingUri(e.filePath)?.service !== 'spotify') {
    row.note = 'Rekordbox stores this streaming title encrypted, so it can\'t be searched';
  }
  return row;
}

/** The Spotify track ID behind a streaming row, when its title still needs reading. */
export function spotifyIdToResolve(row: LosslessUpgradeRow): string | null {
  if (row.format !== 'streaming' || (row.artist && row.title)) return null;
  const stream = streamingUri(row.filePath);
  return stream?.service === 'spotify' ? stream.id : null;
}

/** Fill a streaming row's artist/title from its Spotify track. */
export function applySpotifyTrack(row: LosslessUpgradeRow, track: SpotifyTrack): void {
  row.artist = track.artists.join(', ');
  row.title = track.name;
  row.album = row.album || track.album;
  row.duration = row.duration ?? Math.round(track.duration_ms / 1000);
  delete row.note;
}

/** Version-preserving artist|title key: case, accents and punctuation fold
 *  away, but every word stays, so "Track (Extended Mix)" never stands in for
 *  the radio edit. Letters in any script count — an a-z-only key (makeTagKey)
 *  turns every Japanese or Cyrillic title into the same empty string. Null
 *  when either side has nothing left to compare. */
export function copyKey(artist: string, title: string): string | null {
  const a = fold(artist);
  const t = fold(title);
  return a && t ? `${a}|${t}` : null;
}

/** Case, accents and punctuation off; letters and digits in any script kept. */
function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// The tags that name a VERSION ("(Extended Mix)", "- Radio Edit", "(feat. X)").
// Only those come off a title for the loose comparison: a bracket that names a
// different song ("Home (Nobody Is Not Loved)") stays put.
const VERSION_WORDS = 'feat|ft|featuring|remix|edit|mix|version|original|extended|radio|club|instrumental|dub|vip|bootleg|remaster';
const VERSION_BRACKET_RE = new RegExp(`\\s*[\\(\\[][^\\)\\]]*\\b(${VERSION_WORDS})\\b[^\\)\\]]*[\\)\\]]`, 'gi');
const VERSION_DASH_RE = new RegExp(`\\s+[-–—]\\s+.*\\b(${VERSION_WORDS})\\b.*$`, 'gi');
const FEAT_RE = /\b(feat\.?|ft\.?|featuring)\s.*?(?=\s*[-–—\(\[]|$)/gi;

/** The title with its version tags taken off, as a copyKey-style string. */
function baseTitleKey(title: string): string | null {
  return fold(title.replace(VERSION_BRACKET_RE, '').replace(VERSION_DASH_RE, '').replace(FEAT_RE, '')) || null;
}

/** Each credited name, folded: "A & B", "A, B", "A and B" and "A feat. B"
 *  all read as {a, b}. */
function artistNames(artist: string): Set<string> {
  return new Set(artist
    .split(/\s*(?:,|&|\+|;|\/|\bx\b|\band\b|\bvs\.?|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b)\s*/i)
    .map(fold)
    .filter(Boolean));
}

/** Same credits, one listing perhaps longer ("Disclosure" vs "Disclosure, Sam Smith"). */
function sameArtists(a: string, b: string): boolean {
  const x = artistNames(a);
  const y = artistNames(b);
  if (x.size === 0 || y.size === 0) return false;
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  return [...small].every(n => big.has(n));
}

type IndexedCopy = { rbId: string; filePath: string; formatLabel: string; artist: string; title: string };

/** Lossless entries in the collection: by exact copyKey, and by artist-less
 *  base title for the version-aware second look. */
export type LosslessIndex = { exact: Map<string, IndexedCopy[]>; byBaseTitle: Map<string, IndexedCopy[]> };

export function buildLosslessIndex(collection: RekordboxEntry[]): LosslessIndex {
  const index: LosslessIndex = { exact: new Map(), byBaseTitle: new Map() };
  const push = (map: Map<string, IndexedCopy[]>, key: string, c: IndexedCopy) => {
    const list = map.get(key) ?? [];
    list.push(c);
    map.set(key, list);
  };
  for (const e of collection) {
    if (isEncrypted(e.title)) continue;
    const key = copyKey(e.artist, e.title);
    if (!key) continue;
    const { format, label } = classifyEntry(e);
    if (format !== 'lossless') continue;
    const copy = { rbId: e.rbId, filePath: e.filePath, formatLabel: label, artist: e.artist, title: e.title };
    push(index.exact, key, copy);
    const base = baseTitleKey(e.title);
    if (base) push(index.byBaseTitle, base, copy);
  }
  return index;
}

/**
 * A lossless entry of the same track elsewhere in the collection, if any. The
 * exact key first; then the same base title by the same credits, where the
 * owned copy's version satisfies the row's (ownedVersionSatisfies) — so
 * "Track" by "A & B" finds "Track (Original Mix)" by "A, B", while a remix,
 * a radio edit or a live take is never offered as the original.
 */
export function findLosslessCopy(row: LosslessUpgradeRow, index: LosslessIndex): LosslessUpgradeRow['losslessCopy'] {
  const strip = (c: IndexedCopy) => ({ rbId: c.rbId, filePath: c.filePath, formatLabel: c.formatLabel });
  const key = copyKey(row.artist, row.title);
  if (!key) return undefined;
  const exact = index.exact.get(key)?.find(c => c.rbId !== row.rbId);
  if (exact) return strip(exact);

  const base = baseTitleKey(row.title);
  const loose = base ? index.byBaseTitle.get(base)?.find(c =>
    c.rbId !== row.rbId
    && sameArtists(row.artist, c.artist)
    && ownedVersionSatisfies(row.title, c.title)
  ) : undefined;
  return loose ? strip(loose) : undefined;
}

/** Held lossy or streaming, no lossless copy owned, and something to search by. */
export function needsStoreSearch(row: LosslessUpgradeRow): boolean {
  return (row.format === 'lossy' || row.format === 'streaming')
    && !row.losslessCopy
    && !!row.artist && !!row.title;
}
