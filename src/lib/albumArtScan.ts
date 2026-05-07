import fs from 'fs';
import path from 'path';
import { parseFile } from 'music-metadata';
import { walkAudioDir } from './fileUtils';
import { createScopedLogger } from './logger';

const log = createScopedLogger('AlbumArtScan');
import type { AlbumArtMissingTrack, AlbumArtScanProgress } from '../types';
export type { AlbumArtMissingTrack, AlbumArtScanProgress };

export async function scanMissingAlbumArt(
  libraryRoot: string,
  onProgress?: (progress: AlbumArtScanProgress) => void,
  preScannedFiles?: string[]
): Promise<AlbumArtMissingTrack[]> {
  if (!fs.existsSync(libraryRoot)) {
    throw new Error(`Library directory not found: ${libraryRoot}`);
  }

  const stat = await fs.promises.stat(libraryRoot);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${libraryRoot}`);
  }

  // Use pre-scanned files from job queue, or discover them
  let audioFiles: string[];
  if (preScannedFiles) {
    audioFiles = preScannedFiles;
  } else {
    onProgress?.({ phase: 'discovering', current: 0, total: 0 });
    audioFiles = await walkAudioDir(libraryRoot);
  }
  const missingTracks: AlbumArtMissingTrack[] = [];
  const total = audioFiles.length;

  if (total === 0) {
    onProgress?.({ phase: 'complete', current: 0, total: 0 });
    return missingTracks;
  }

  for (let i = 0; i < audioFiles.length; i += 1) {
    const filePath = audioFiles[i];
    try {
      const metadata = await parseFile(filePath, { duration: false });
      const title = metadata.common.title || '';
      const artist = metadata.common.artist || metadata.common.artists?.[0] || '';

      if (!title || !artist) continue;

      const hasArt = (metadata.common.picture?.length ?? 0) > 0;
      if (hasArt) continue;

      missingTracks.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        filePath,
        fileName: path.basename(filePath),
        title,
        artist,
        album: metadata.common.album || '',
        year: metadata.common.year?.toString() || '',
        genre: metadata.common.genre?.[0] || ''
      });
    } catch (err) {
      log.warn(`Metadata read failed for ${path.basename(filePath)}:`, err);
    }

    onProgress?.({
      phase: 'scanning',
      current: i + 1,
      total,
      filePath
    });
  }

  onProgress?.({ phase: 'complete', current: total, total });
  return missingTracks;
}
