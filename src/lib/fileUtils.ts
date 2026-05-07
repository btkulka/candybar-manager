import fs from 'fs/promises';
import path from 'path';
import { AUDIO_EXTENSIONS } from './constants';
import { createScopedLogger } from './logger';

const log = createScopedLogger('FileUtils');

// ExFAT on macOS occasionally returns ENOENT on rename into a freshly created
// directory because the new dir entry hasn't been flushed to the FAT yet.
async function tryRename(source: string, destination: string): Promise<void> {
  try {
    await fs.rename(source, destination);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await new Promise(resolve => setTimeout(resolve, 100));
    await fs.rename(source, destination);
  }
}

/**
 * Move a file, handling cross-filesystem (EXDEV) moves via copy+delete.
 * Treats "source missing, destination present" as a successful no-op so a
 * double-triggered move doesn't surface as an error.
 * Logs a warning if the delete-after-copy step fails (leaving a duplicate).
 */
export async function safeMove(source: string, destination: string): Promise<void> {
  try {
    await tryRename(source, destination);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      try {
        await fs.access(destination);
        log.debug(`Source missing but destination exists; treating as already moved: ${destination}`);
        return;
      } catch { /* fall through */ }
      throw err;
    }
    if (code !== 'EXDEV') throw err;
    await fs.copyFile(source, destination);
    try {
      await fs.unlink(source);
    } catch (unlinkErr) {
      log.warn(`Failed to remove source after cross-filesystem copy: ${source}`, unlinkErr);
      throw unlinkErr;
    }
  }
}

export type WalkDirOptions = {
  skipHidden?: boolean;
  onProgress?: (count: number) => void;
};

/**
 * Recursively walk a directory and return all audio file paths.
 * Uses an iterative stack to avoid deep recursion.
 */
export async function walkAudioDir(
  root: string,
  options: WalkDirOptions = {}
): Promise<string[]> {
  const { skipHidden = true, onProgress } = options;
  log.debug('Walking audio directory:', root);
  const files: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (skipHidden && entry.name.startsWith('.')) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (AUDIO_EXTENSIONS.has(ext)) {
          files.push(fullPath);
          if (onProgress && files.length % 100 === 0) {
            onProgress(files.length);
          }
        }
      }
    }
  }

  log.debug('Walk complete:', files.length, 'audio files found');
  return files;
}

/**
 * Decode common HTML entities in a string.
 */
export function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
