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

/**
 * Folder name for an artist tag. Only unambiguous multi-artist separators split
 * (';' and feat./ft./featuring): '&', ',' and '/' belong to names like
 * "Above & Beyond", "Earth, Wind & Fire" and "AC/DC". The result is NFC, free
 * of characters exFAT/Windows reject, has no leading dots (a hidden folder would
 * vanish from scans) or trailing dots/spaces, and stays well under 255 chars.
 */
export function normalizeArtist(value: string): string {
  const first = value.normalize('NFC')
    .split(/\s*;\s*|\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0] ?? '';
  const safe = first
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '')
    .slice(0, 200)
    .trim();
  return safe || 'Unknown Artist';
}

/** Case- and Unicode-form-insensitive key, so "Dj Koze" reuses "DJ Koze" and an
 *  NFD "Beyoncé" reuses the NFC folder instead of creating a twin. */
function folderKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
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

  // Existing artist folders by folded name, so new tracks join the folder that's
  // already there whatever its case or Unicode form.
  const existingFolders = new Map<string, string>();
  for (const entry of await fs.readdir(rootDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) existingFolders.set(folderKey(entry.name), entry.name);
  }

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

    const wanted = normalizeArtist(artist);
    const artistFolder = existingFolders.get(folderKey(wanted)) ?? wanted;
    existingFolders.set(folderKey(artistFolder), artistFolder);
    const targetDir = path.join(rootDir, artistFolder);

    try {
      await fs.mkdir(targetDir, { recursive: true });
      const targetPath = path.join(targetDir, fileName);

      // Check if a file already exists at the destination
      const targetStat = await fs.stat(targetPath).catch(() => null);
      if (targetStat) {
        // The "existing" file may be this very file (already organized, or the
        // same path in another case/Unicode form). That's not a conflict: a
        // conflict prompt here would offer to delete the only copy.
        const srcStat = await fs.stat(track.filePath).catch(() => null);
        if (srcStat && srcStat.ino === targetStat.ino && srcStat.dev === targetStat.dev) {
          log(`Already organized: '${fileName}'\n`);
          finish({ filePath: track.filePath, success: true, resultPath: track.filePath }, 'success');
          continue;
        }
      }

      if (targetStat) {
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
      await safeMove(track.filePath, targetPath, 'organize');

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
