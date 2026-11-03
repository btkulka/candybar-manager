import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';
import { createScopedLogger } from './logger';
import { getDatabase } from './db';
import { isPathUnder } from './fileUtils';
import type { LibraryHealthTrack } from '../types';

const log = createScopedLogger('Rekordbox');

export type RekordboxTrack = {
  trackId: string;
  name: string;
  artist: string;
  album: string;
  genre: string;
  label: string;
  year: number | null;
  bpm: number | null;
  tonality: string;
  rating: number;
  dateAdded: string;
  bitRate: number | null;
  sampleRate: number | null;
  totalTime: number | null;
  size: number | null;
  kind: string;
  filePath: string;
  locationUrl: string;
};

export type MissingFile = {
  trackId: string;
  filePath: string;
  artist: string;
  title: string;
  album: string;
};

export type RekordboxImportSummary = {
  libraryRoot: string;
  totalInXml: number;
  inLibraryRoot: number;
  missingOnDisk: number;
  imported: number;
};

/** Decode a rekordbox Location attribute (file://localhost/... or file:///...) to an absolute path. */
export function decodeRekordboxLocation(locationUrl: string): string {
  try {
    const normalized = locationUrl.replace(/^file:\/\/localhost\//i, 'file:///');
    return fileURLToPath(normalized);
  } catch {
    const match = locationUrl.match(/^file:\/\/(?:localhost)?(\/.*)$/i);
    if (!match) return '';
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return '';
    }
  }
}

function parseIntOrNull(s: string | null): number | null {
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function parseFloatOrNull(s: string | null): number | null {
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function attr(el: Element, name: string): string {
  return el.getAttribute(name) ?? '';
}

export async function parseRekordboxXml(xmlPath: string): Promise<RekordboxTrack[]> {
  log.info(`Parsing rekordbox XML: ${xmlPath}`);
  const content = await fs.readFile(xmlPath, 'utf-8');
  const dom = new JSDOM(content, { contentType: 'text/xml' });
  const doc = dom.window.document;
  const nodes = doc.querySelectorAll('COLLECTION > TRACK');
  const tracks: RekordboxTrack[] = [];
  for (const node of Array.from(nodes)) {
    const location = attr(node, 'Location');
    if (!location) continue;
    tracks.push({
      trackId: attr(node, 'TrackID'),
      name: attr(node, 'Name'),
      artist: attr(node, 'Artist'),
      album: attr(node, 'Album'),
      genre: attr(node, 'Genre'),
      label: attr(node, 'Label'),
      year: parseIntOrNull(node.getAttribute('Year')),
      bpm: parseFloatOrNull(node.getAttribute('AverageBpm')),
      tonality: attr(node, 'Tonality'),
      rating: parseIntOrNull(node.getAttribute('Rating')) ?? 0,
      dateAdded: attr(node, 'DateAdded'),
      bitRate: parseIntOrNull(node.getAttribute('BitRate')),
      sampleRate: parseIntOrNull(node.getAttribute('SampleRate')),
      totalTime: parseIntOrNull(node.getAttribute('TotalTime')),
      size: parseIntOrNull(node.getAttribute('Size')),
      kind: attr(node, 'Kind'),
      filePath: decodeRekordboxLocation(location),
      locationUrl: location
    });
  }
  log.info(`Parsed ${tracks.length} tracks`);
  return tracks;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function findMissingFiles(tracks: RekordboxTrack[], libraryRoot?: string): Promise<MissingFile[]> {
  const missing: MissingFile[] = [];
  const scoped = libraryRoot ? tracks.filter(t => isPathUnder(t.filePath, [libraryRoot])) : tracks;
  const results = await Promise.all(
    scoped.map(async t => ({ t, exists: t.filePath ? await fileExists(t.filePath) : false }))
  );
  for (const { t, exists } of results) {
    if (!exists) {
      missing.push({
        trackId: t.trackId,
        filePath: t.filePath,
        artist: t.artist,
        title: t.name,
        album: t.album
      });
    }
  }
  return missing;
}

function inferContainer(kind: string, filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  if (ext) return ext;
  const k = kind.toLowerCase();
  if (k.includes('aiff')) return 'aiff';
  if (k.includes('mp3')) return 'mp3';
  if (k.includes('wav')) return 'wav';
  if (k.includes('flac')) return 'flac';
  if (k.includes('m4a') || k.includes('aac')) return 'm4a';
  return null;
}

function isLossless(container: string | null): boolean | null {
  if (!container) return null;
  const c = container.toLowerCase();
  if (c === 'aiff' || c === 'aif' || c === 'wav' || c === 'flac' || c === 'alac') return true;
  if (c === 'mp3' || c === 'aac' || c === 'm4a' || c === 'ogg') return false;
  return null;
}

function parseDateAdded(dateAdded: string): number | null {
  if (!dateAdded) return null;
  const ms = Date.parse(dateAdded);
  return Number.isFinite(ms) ? ms : null;
}

function toLibraryTrack(t: RekordboxTrack): LibraryHealthTrack {
  const container = inferContainer(t.kind, t.filePath);
  return {
    filePath: t.filePath,
    fileName: path.basename(t.filePath),
    artist: t.artist,
    title: t.name,
    album: t.album,
    year: t.year,
    genre: t.genre,
    hasAlbumArt: false,
    dateAdded: parseDateAdded(t.dateAdded),
    bpm: t.bpm && t.bpm > 0 ? t.bpm : null,
    isHealthy: true,
    issues: [],
    format: {
      container,
      codec: null,
      sampleRate: t.sampleRate,
      bitDepth: null,
      bitRate: t.bitRate,
      channels: null,
      duration: t.totalTime,
      lossless: isLossless(container)
    }
  };
}

/**
 * Upsert rekordbox-derived rows into library_tracks for a given library root.
 * Only tracks whose filePath starts with libraryRoot are imported.
 * Does not touch tracks outside libraryRoot or rows already present (they get their metadata replaced).
 */
export async function importRekordboxToLibrary(
  tracks: RekordboxTrack[],
  libraryRoot: string
): Promise<RekordboxImportSummary> {
  // Separator-aware: "/Music" must not also claim "/Music Old/...".
  const scoped = tracks.filter(t => isPathUnder(t.filePath, [libraryRoot]));
  const existenceChecks = await Promise.all(
    scoped.map(async t => ({ t, exists: await fileExists(t.filePath) }))
  );
  const missing = existenceChecks.filter(x => !x.exists).length;

  const db = getDatabase();
  const upsert = db.prepare(`
    INSERT INTO library_tracks (
      library_root, file_path, file_name, mtime_ms, size_bytes,
      artist, title, album, year, genre,
      has_album_art, is_healthy, date_added,
      container, codec, sample_rate, bit_depth, bit_rate, channels, duration, lossless,
      last_scanned, bpm
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(library_root, file_path) DO UPDATE SET
      file_name = excluded.file_name,
      artist = CASE WHEN library_tracks.artist = '' THEN excluded.artist ELSE library_tracks.artist END,
      title = CASE WHEN library_tracks.title = '' THEN excluded.title ELSE library_tracks.title END,
      album = CASE WHEN library_tracks.album = '' THEN excluded.album ELSE library_tracks.album END,
      year = COALESCE(library_tracks.year, excluded.year),
      genre = CASE WHEN library_tracks.genre = '' THEN excluded.genre ELSE library_tracks.genre END,
      date_added = COALESCE(library_tracks.date_added, excluded.date_added),
      container = COALESCE(library_tracks.container, excluded.container),
      sample_rate = COALESCE(library_tracks.sample_rate, excluded.sample_rate),
      bit_rate = COALESCE(library_tracks.bit_rate, excluded.bit_rate),
      duration = COALESCE(library_tracks.duration, excluded.duration),
      lossless = COALESCE(library_tracks.lossless, excluded.lossless),
      bpm = COALESCE(library_tracks.bpm, excluded.bpm),
      last_scanned = excluded.last_scanned
  `);

  const now = Date.now();
  const tx = db.transaction((rows: LibraryHealthTrack[]) => {
    for (const r of rows) {
      upsert.run(
        libraryRoot,
        r.filePath,
        r.fileName,
        null,
        r.format.duration && r.format.bitRate
          ? Math.round((r.format.bitRate * 1000 * r.format.duration) / 8)
          : null,
        r.artist,
        r.title,
        r.album,
        r.year,
        r.genre,
        r.hasAlbumArt ? 1 : 0,
        r.isHealthy ? 1 : 0,
        r.dateAdded,
        r.format.container,
        r.format.codec,
        r.format.sampleRate,
        r.format.bitDepth,
        r.format.bitRate,
        r.format.channels,
        r.format.duration,
        r.format.lossless === null ? null : (r.format.lossless ? 1 : 0),
        now,
        r.bpm
      );
    }
  });

  const rows = scoped.map(toLibraryTrack);
  tx(rows);

  log.info(`Imported ${rows.length} rekordbox tracks into library_tracks (root=${libraryRoot}, missing=${missing})`);
  return {
    libraryRoot,
    totalInXml: tracks.length,
    inLibraryRoot: scoped.length,
    missingOnDisk: missing,
    imported: rows.length
  };
}
