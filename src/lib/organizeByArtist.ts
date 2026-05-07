import fs from 'fs/promises';
import path from 'path';
import { parseFile } from 'music-metadata';
import { AUDIO_EXTENSIONS } from './constants';
import { createScopedLogger } from './logger';
import { safeMove } from './fileUtils';
import type { OrganizeResult, OrganizeConflictFile, OrganizeProgress } from '../types';
export type { OrganizeResult };

const debugLog = createScopedLogger('Organize');

type LogFn = (text: string, stream?: 'stdout' | 'stderr' | 'status') => void;
type ProgressFn = (payload: OrganizeProgress) => void;

// New params for batch organize with pre-scanned tracks
type OrganizeTracksParams = {
  tracks: Array<{ filePath: string; ignored: boolean; isHealthy?: boolean }>;
  rootDir: string;
  log: LogFn;
  onProgress?: ProgressFn;
};

function normalizeArtist(value: string) {
  const first = value.split(/[;\\/,&]+/)[0]?.trim() ?? '';
  const safe = first.replace(/[\\/]/g, '-').trim();
  return safe || 'Unknown Artist';
}

async function getConflictFileInfo(filePath: string): Promise<OrganizeConflictFile> {
  const stat = await fs.stat(filePath);
  let artist = '', title = '', format = '', bitRate: number | null = null, duration: number | null = null;
  try {
    const meta = await parseFile(filePath, { duration: true });
    artist = meta.common.artist || '';
    title = meta.common.title || '';
    format = meta.format.container || path.extname(filePath).replace('.', '').toUpperCase();
    bitRate = meta.format.bitrate ? Math.round(meta.format.bitrate / 1000) : null;
    duration = meta.format.duration ?? null;
  } catch {
    format = path.extname(filePath).replace('.', '').toUpperCase();
  }
  return {
    filePath,
    fileName: path.basename(filePath),
    format,
    bitRate,
    duration,
    sizeBytes: stat.size,
    artist,
    title
  };
}

export async function organizeTracks({ tracks, rootDir, log, onProgress }: OrganizeTracksParams): Promise<OrganizeResult[]> {
  const rootStat = await fs.stat(rootDir);
  if (!rootStat.isDirectory()) {
    throw new Error('Destination must be a directory.');
  }

  const results: OrganizeResult[] = [];
  const total = tracks.length;

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    const current = i + 1;
    const fileName = path.basename(track.filePath);

    onProgress?.({ current, total, filePath: track.filePath, phase: 'processing' });

    const finish = (result: OrganizeResult, status: OrganizeProgress['status']) => {
      results.push(result);
      onProgress?.({
        current,
        total,
        filePath: track.filePath,
        phase: 'done',
        status,
        resultPath: result.resultPath,
        errorMessage: result.errorMessage
      });
    };

    if (track.ignored) {
      finish(
        { filePath: track.filePath, success: true, resultPath: undefined, errorMessage: 'Ignored' },
        'ignored'
      );
      continue;
    }

    // Skip unhealthy tracks by default (isHealthy defaults to true if not provided for backwards compat)
    if (track.isHealthy === false) {
      log(`Skipping unhealthy track: ${fileName}\n`, 'stderr');
      finish(
        { filePath: track.filePath, success: false, errorMessage: 'Skipped: unhealthy track' },
        'skipped'
      );
      continue;
    }

    let artist = '';

    try {
      const metadata = await parseFile(track.filePath, { duration: false });
      artist = metadata.common.artist || metadata.common.artists?.[0] || '';
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Metadata error';
      debugLog.error('Metadata read failed for:', fileName, error);
      log(`Metadata read failed for ${fileName}: ${message}\n`, 'stderr');
      finish(
        { filePath: track.filePath, success: false, errorMessage: `Metadata read failed: ${message}` },
        'error'
      );
      continue;
    }

    if (!artist) {
      log(`No artist found for ${fileName}\n`, 'stderr');
      finish(
        { filePath: track.filePath, success: false, errorMessage: 'No artist found in metadata' },
        'error'
      );
      continue;
    }

    const artistFolder = normalizeArtist(artist);
    const targetDir = path.join(rootDir, artistFolder);

    try {
      await fs.mkdir(targetDir, { recursive: true });
      const targetPath = path.join(targetDir, fileName);

      // Check if a file already exists at the destination
      let existsAtTarget = false;
      try {
        await fs.access(targetPath);
        existsAtTarget = true;
      } catch { /* doesn't exist — good */ }

      if (existsAtTarget) {
        log(`Conflict: '${fileName}' already exists in '${targetDir}'\n`, 'stderr');
        const [incoming, existing] = await Promise.all([
          getConflictFileInfo(track.filePath),
          getConflictFileInfo(targetPath)
        ]);
        finish(
          {
            filePath: track.filePath,
            success: false,
            errorMessage: 'File already exists at destination',
            conflict: { incoming, existing, targetPath }
          },
          'conflict'
        );
        continue;
      }

      log(`Moving '${fileName}' to '${targetDir}'\n`);
      await safeMove(track.filePath, targetPath);

      finish(
        { filePath: track.filePath, success: true, resultPath: targetPath },
        'success'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Move failed';
      debugLog.error('Failed to move file:', fileName, error);
      log(`Failed to move ${fileName}: ${message}\n`, 'stderr');
      finish(
        { filePath: track.filePath, success: false, errorMessage: message },
        'error'
      );
    }
  }

  log('Done organizing!\n', 'status');
  return results;
}
