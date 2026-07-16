import fs from 'fs/promises';
import path from 'path';
import { AUDIO_EXTENSIONS } from './constants';
import { createScopedLogger } from './logger';
import { recordWrite, statBytes, type WriteJournalEntry } from './writeJournal';

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
 * Every outcome is recorded in the write journal; `context` labels which
 * feature triggered the move (e.g. 'organize', 'archive').
 */
export async function safeMove(
  source: string,
  destination: string,
  context?: string,
  options?: { overwrite?: boolean },
): Promise<void> {
  const bytes = await statBytes(source);
  const journal = (outcome: 'ok' | 'error', extra: Partial<WriteJournalEntry> = {}) =>
    recordWrite({ op: 'move', src: source, dest: destination, bytes, context, outcome, ...extra });

  // Refuse to silently overwrite a DIFFERENT existing file at the destination.
  // (rename/copyFile would clobber it.) The "source missing, dest present"
  // already-moved case is intentionally left to the ENOENT handler below.
  if (!options?.overwrite) {
    const destStat = await fs.stat(destination).catch(() => null);
    if (destStat) {
      const srcStat = await fs.stat(source).catch(() => null);
      const sameFile = srcStat && destStat.ino === srcStat.ino && destStat.dev === srcStat.dev;
      if (srcStat && !sameFile) {
        const err = new Error(`destination already exists: ${destination}`) as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        journal('error', { error: err.message, detail: { conflict: true } });
        throw err;
      }
    }
  }

  try {
    await tryRename(source, destination);
    journal('ok');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      try {
        await fs.access(destination);
        log.debug(`Source missing but destination exists; treating as already moved: ${destination}`);
        journal('ok', { detail: { noop: 'already-moved' } });
        return;
      } catch { /* fall through */ }
      journal('error', { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    if (code !== 'EXDEV') {
      journal('error', { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    await fs.copyFile(source, destination);
    try {
      await fs.unlink(source);
    } catch (unlinkErr) {
      log.warn(`Failed to remove source after cross-filesystem copy: ${source}`, unlinkErr);
      // The copy landed but the source remains — a duplicate now exists.
      journal('error', {
        error: `copied but failed to remove source: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`,
        detail: { mode: 'copy+delete', duplicateLeftAtSource: true },
      });
      throw unlinkErr;
    }
    journal('ok', { detail: { mode: 'copy+delete' } });
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
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // One unreadable subdir (permissions, transient I/O) must not abort the
      // whole scan — skip it and keep walking.
      log.warn(`Skipping unreadable directory: ${dir}`, err);
      continue;
    }

    for (const entry of entries) {
      if (skipHidden && entry.name.startsWith('.')) continue;

      const fullPath = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      // Some filesystems (certain network/exFAT mounts) return DT_UNKNOWN dirents
      // where both isDirectory() and isFile() are false — stat to resolve rather
      // than silently dropping the entry.
      if (!isDir && !isFile && !entry.isSymbolicLink()) {
        try {
          const s = await fs.stat(fullPath);
          isDir = s.isDirectory();
          isFile = s.isFile();
        } catch { continue; }
      }

      if (isDir) {
        stack.push(fullPath);
      } else if (isFile) {
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
