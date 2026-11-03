import fs from 'fs/promises';
import path from 'path';
import { AUDIO_EXTENSIONS } from './constants';
import { createScopedLogger } from './logger';
import { recordWrite, statBytes, type WriteJournalEntry } from './writeJournal';
import { updateDownloadedTrackPath } from './db';
import { invalidateLibraryFileLists } from './jobQueue/sharedResultStore';

const log = createScopedLogger('FileUtils');

/**
 * In-flight scratch files written next to real tracks by this app: converter
 * temps (`X.converting-<ts>-<id>.aif`), tag-write temps (`X_tagtmp.aiff`), move
 * partials (`.X.partial-<ts>`). They carry audio extensions, so every walker
 * must skip them or a half-written file gets scanned, organized or matched.
 */
export function isTransientAudioName(name: string): boolean {
  return /\.converting-\d+-[a-z0-9]+\.[^.]+$/i.test(name)
    || /_tagtmp\.[^.]+$/i.test(name)
    || /\.partial-\d+$/i.test(name);
}

/** Bookkeeping after any successful move: keep download records pointing at the
 *  file, and drop cached file lists that still list the old path. */
function afterMove(source: string, destination: string): void {
  updateDownloadedTrackPath(source, destination);
  invalidateLibraryFileLists();
}

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
    afterMove(source, destination);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      try {
        await fs.access(destination);
        log.debug(`Source missing but destination exists; treating as already moved: ${destination}`);
        journal('ok', { detail: { noop: 'already-moved' } });
        afterMove(source, destination);
        return;
      } catch { /* fall through */ }
      journal('error', { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    if (code !== 'EXDEV') {
      journal('error', { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    // Cross-filesystem: copy to a hidden partial beside the destination, verify
    // the size, then rename it into place. A failed or short copy never leaves a
    // file at `destination` that a retry (or archive's "already archived" check)
    // could mistake for a finished move, and the source is untouched until the
    // copy is proven complete.
    const partial = path.join(path.dirname(destination), `.${path.basename(destination)}.partial-${Date.now()}`);
    try {
      await fs.copyFile(source, partial);
      const [srcStat, partStat] = await Promise.all([fs.stat(source), fs.stat(partial)]);
      if (srcStat.size !== partStat.size) {
        throw new Error(`copy incomplete (${partStat.size} of ${srcStat.size} bytes)`);
      }
      await fs.rename(partial, destination);
    } catch (copyErr) {
      await fs.unlink(partial).catch(() => {});
      journal('error', {
        error: `cross-filesystem copy failed: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`,
        detail: { mode: 'copy+delete', sourceUntouched: true },
      });
      throw copyErr;
    }
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
    afterMove(source, destination);
  }
}

export type WalkDirOptions = {
  skipHidden?: boolean;
  onProgress?: (count: number) => void;
  /** Stop with an 'Cancelled' error once aborted (checked per directory). */
  signal?: AbortSignal;
  /** Don't descend more than this many levels below `root` (0 = root only). */
  maxDepth?: number;
  /** Collects directories that couldn't be read, so callers can avoid treating
   *  their (unlisted) contents as deleted. */
  failedDirs?: string[];
};

/**
 * Recursively walk a directory and return all audio file paths.
 * Uses an iterative stack to avoid deep recursion. This is the one walker every
 * scan should use: it resolves DT_UNKNOWN dirents and skips this app's temp files.
 */
export async function walkAudioDir(
  root: string,
  options: WalkDirOptions = {}
): Promise<string[]> {
  const { skipHidden = true, onProgress, signal, maxDepth = Infinity, failedDirs } = options;
  log.debug('Walking audio directory:', root);
  const files: string[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];

  while (stack.length > 0) {
    if (signal?.aborted) throw new Error('Cancelled');
    const { dir, depth } = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // One unreadable subdir (permissions, transient I/O) must not abort the
      // whole scan — skip it and keep walking.
      log.warn(`Skipping unreadable directory: ${dir}`, err);
      failedDirs?.push(dir);
      continue;
    }

    for (const entry of entries) {
      if (skipHidden && entry.name.startsWith('.')) continue;
      if (isTransientAudioName(entry.name)) continue;

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
        if (depth < maxDepth) stack.push({ dir: fullPath, depth: depth + 1 });
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

/** True when `filePath` sits inside any of `dirs` (used to keep rows under unreadable dirs). */
export function isPathUnder(filePath: string, dirs: string[]): boolean {
  return dirs.some(d => filePath === d || filePath.startsWith(d.endsWith(path.sep) ? d : d + path.sep));
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
