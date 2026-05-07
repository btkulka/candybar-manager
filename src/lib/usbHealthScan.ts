import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { createScopedLogger } from './logger';
import { walkAudioDir } from './fileUtils';
import { checkTrackHealth, summarizeHealth } from './trackHealthCheck';
import type { VolumeInfo, UsbVolumeIssue, UsbHealthResult, UsbHealthProgress, LibraryHealthTrack } from '../types';

const execFileAsync = promisify(execFile);
const log = createScopedLogger('UsbHealth');

const FREE_SPACE_WARN_BYTES = 500 * 1024 * 1024; // 500 MB
const PIONEER_MAX_FOLDER_DEPTH = 8;

// ========== plist parsing ==========

function parsePlistValue(xml: string, key: string): string | null {
  const m = xml.match(new RegExp(`<key>${key}</key>\\s*<(?:string|integer)>([^<]+)<`, 's'));
  return m ? m[1].trim() : null;
}

// ========== Volume info ==========

export async function getVolumeInfo(volumePath: string): Promise<VolumeInfo | null> {
  try {
    const { stdout } = await execFileAsync('diskutil', ['info', '-plist', volumePath]);

    const fsName =
      parsePlistValue(stdout, 'FilesystemName') ??
      parsePlistValue(stdout, 'FileSystemPersonality') ??
      '';
    const totalBytes = parseInt(parsePlistValue(stdout, 'TotalSize') ?? '0', 10);
    const freeBytes = parseInt(parsePlistValue(stdout, 'FreeSpace') ?? parsePlistValue(stdout, 'AvailableSpace') ?? '0', 10);
    const deviceId = parsePlistValue(stdout, 'DeviceIdentifier') ?? '';
    const volName = parsePlistValue(stdout, 'VolumeName') ?? path.basename(volumePath);

    return {
      name: volName,
      path: volumePath,
      fileSystem: fsName,
      totalBytes,
      freeBytes,
      isCompatible: fsName.toUpperCase().includes('FAT32'),
      deviceNode: deviceId ? `/dev/${deviceId}` : ''
    };
  } catch (err) {
    log.warn(`diskutil info failed for ${volumePath}:`, err);
    return null;
  }
}

// ========== Volume listing ==========

/** Returns all /Volumes/ entries that are not hidden and not in the excluded list.
 * The library volume (containing libraryRoot) is returned with isLibrary = true. */
export async function listUsbVolumes(
  libraryRoot: string,
  excludedVolumes: string[] = []
): Promise<VolumeInfo[]> {
  let libraryVolumeName: string | null = null;
  if (libraryRoot.startsWith('/Volumes/')) {
    const relativePart = libraryRoot.slice('/Volumes/'.length);
    libraryVolumeName = relativePart.split('/')[0] || null;
  }
  const exclude = new Set(excludedVolumes);

  let entries: string[];
  try {
    entries = await fs.promises.readdir('/Volumes');
  } catch (err) {
    log.warn('Could not read /Volumes:', err);
    return [];
  }

  const candidates = entries.filter((name) => {
    if (name.startsWith('.')) return false;
    if (exclude.has(name)) return false;
    return true;
  });

  const settled = await Promise.allSettled(
    candidates.map(async (name) => {
      const info = await getVolumeInfo(`/Volumes/${name}`);
      if (info && libraryVolumeName && name === libraryVolumeName) {
        info.isLibrary = true;
      }
      return info;
    })
  );

  const results: VolumeInfo[] = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === 'fulfilled' && s.value) {
      results.push(s.value);
    } else if (s.status === 'rejected') {
      log.warn(`Failed to read volume info for /Volumes/${candidates[i]}:`, s.reason);
    }
  }
  return results;
}

// ========== Volume issue checks ==========

export function checkVolumeIssues(volume: VolumeInfo): UsbVolumeIssue[] {
  const issues: UsbVolumeIssue[] = [];

  if (!volume.isCompatible) {
    issues.push({
      code: 'WRONG_FILESYSTEM',
      severity: 'error',
      message: `Filesystem "${volume.fileSystem || 'Unknown'}" is not supported`,
      detail: 'Pioneer XDJ-RX3 requires FAT32. Reformat the drive using Disk Utility (MS-DOS FAT) or use a different USB drive.'
    });
  }

  if (volume.freeBytes === 0 && volume.totalBytes > 0) {
    issues.push({
      code: 'NO_FREE_SPACE',
      severity: 'error',
      message: 'No free space remaining on volume',
      detail: 'The drive is completely full. Remove files to free up space.'
    });
  } else if (volume.freeBytes > 0 && volume.freeBytes < FREE_SPACE_WARN_BYTES) {
    const freeMB = Math.round(volume.freeBytes / (1024 * 1024));
    issues.push({
      code: 'LOW_FREE_SPACE',
      severity: 'warning',
      message: `Low free space: ${freeMB} MB remaining`,
      detail: 'Less than 500 MB free. Consider removing files to avoid issues when adding new tracks.'
    });
  }

  return issues;
}

// ========== Full USB scan ==========

export async function scanUsbHealth(
  volumePath: string,
  onProgress?: (p: Omit<UsbHealthProgress, 'id'>) => void
): Promise<UsbHealthResult> {
  // Step 1: Get volume info (use a basic fallback if diskutil fails)
  let volume = await getVolumeInfo(volumePath);
  if (!volume) {
    // Fallback: create a minimal VolumeInfo for paths not under /Volumes/
    volume = {
      name: path.basename(volumePath),
      path: volumePath,
      fileSystem: 'Unknown',
      totalBytes: 0,
      freeBytes: 0,
      isCompatible: false,
      deviceNode: ''
    };
  }

  const volumeIssues = checkVolumeIssues(volume);

  // Step 2: Discover audio files
  onProgress?.({ phase: 'discovering', current: 0, total: 0 });
  const audioFiles = await walkAudioDir(volumePath);
  const total = audioFiles.length;

  // Step 3: Per-track health check
  const tracks: LibraryHealthTrack[] = [];

  for (let i = 0; i < audioFiles.length; i++) {
    const filePath = audioFiles[i];

    const health = await checkTrackHealth(filePath);

    // USB-specific: path depth check
    const relPath = filePath.slice(volumePath.length).replace(/^\//, '');
    const depth = relPath.split('/').length - 1; // subtract 1 for the filename itself
    if (depth > PIONEER_MAX_FOLDER_DEPTH) {
      health.issues.push({
        code: 'PATH_TOO_DEEP',
        severity: 'warning',
        message: `Folder depth ${depth} exceeds Pioneer's ${PIONEER_MAX_FOLDER_DEPTH}-level limit`,
        detail: `Move this file closer to the root of the USB drive. Current path: ${relPath}`,
        suggestedAction: 'none'
      });
      // Re-evaluate isHealthy after adding the new issue
      health.isHealthy = !health.issues.some((iss) => iss.severity === 'error');
    }

    tracks.push(health as LibraryHealthTrack);
    onProgress?.({ phase: 'scanning', current: i + 1, total, currentFile: filePath });
  }

  const summary = summarizeHealth(tracks as Parameters<typeof summarizeHealth>[0]);
  onProgress?.({ phase: 'complete', current: total, total });

  return {
    volume,
    volumeIssues,
    tracks,
    summary,
    scannedAt: Date.now()
  };
}
