import fs from 'fs/promises';
import path from 'path';
import { parseFile } from 'music-metadata';
import { walkAudioDir } from './fileUtils';
import { makeTrackKey } from './stringUtils';

const CONCURRENCY = 8;

export type CatalogEntry = {
  title: string;
  artist: string;
  album: string;
  genre: string;
  duration: number | null;
};

type ProgressFn = (current: number, total: number, message: string) => void;

type LogFn = (text: string, stream?: 'stdout' | 'stderr' | 'status') => void;

async function extractMetadata(filePath: string): Promise<CatalogEntry | null> {
  try {
    // duration:false still reads it from the header (Xing/VBRI, or a CBR
    // estimate); `true` would scan every frame of every MP3.
    const metadata = await parseFile(filePath, { duration: false, skipCovers: true });
    const artist = metadata.common.artist || metadata.common.artists?.[0] || '';
    const title = metadata.common.title || '';

    if (!artist && !title) return null;

    return {
      title: title || path.basename(filePath, path.extname(filePath)),
      artist: artist || 'Unknown Artist',
      album: metadata.common.album || '',
      genre: metadata.common.genre?.[0] || '',
      duration: metadata.format.duration ? Math.round(metadata.format.duration) : null,
    };
  } catch {
    return null;
  }
}

export async function exportCatalog(
  libraryRoot: string,
  outputPath: string,
  log: LogFn,
  onProgress?: ProgressFn,
  preScannedFiles?: string[],
  signal?: AbortSignal
): Promise<{ total: number; exported: number; skipped: number }> {
  const stat = await fs.stat(libraryRoot);
  if (!stat.isDirectory()) {
    throw new Error('Library root must be a directory.');
  }

  // Use pre-scanned files from job queue, or discover them
  let files: string[];
  if (preScannedFiles && preScannedFiles.length > 0) {
    files = preScannedFiles;
    log(`Using ${files.length} pre-scanned files`, 'stdout');
  } else {
    log('Discovering audio files...', 'status');
    files = await walkAudioDir(libraryRoot, {
      signal,
      onProgress: (count) => onProgress?.(count, 0, `Found ${count} audio files...`),
    });
    log(`Found ${files.length} audio files`, 'stdout');
  }

  log('Scanning metadata...', 'status');
  const entries: CatalogEntry[] = [];
  let processed = 0;
  let skipped = 0;

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    if (signal?.aborted) throw new Error('Cancelled');
    const batch = files.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(extractMetadata));

    for (const result of batchResults) {
      processed++;
      if (result) {
        entries.push(result);
      } else {
        skipped++;
      }
    }

    const percent = Math.round((processed / files.length) * 100);
    onProgress?.(processed, files.length, `Scanning: ${percent}% (${processed}/${files.length})`);
  }

  // Deduplicate by artist + title (keep first occurrence)
  const seen = new Set<string>();
  const deduplicated: CatalogEntry[] = [];
  for (const entry of entries) {
    const key = makeTrackKey(entry.artist, entry.title);
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(entry);
    }
  }

  const dupeCount = entries.length - deduplicated.length;
  if (dupeCount > 0) {
    log(`Removed ${dupeCount} duplicate entries`, 'stdout');
  }

  // Sort by artist, then title
  deduplicated.sort((a, b) => {
    const artistCmp = a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' });
    return artistCmp !== 0 ? artistCmp : a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  });

  log('Writing catalog JSON...', 'status');
  await fs.writeFile(outputPath, JSON.stringify(deduplicated, null, 2), 'utf8');

  log(`Exported ${deduplicated.length} tracks to ${path.basename(outputPath)}`, 'stdout');

  return {
    total: files.length,
    exported: deduplicated.length,
    skipped,
  };
}
