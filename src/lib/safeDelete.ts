// ============================================================
// Recoverable deletes: user files only ever go to a Trash.
//  1. The OS Trash via an injected handler (main.ts passes
//     shell.trashItem).
//  2. If that fails or isn't registered (MCP server, tests): a
//     manual move into the Trash — the volume's .Trashes/<uid> for
//     files on an external drive, else ~/.Trash — under a unique name.
//  3. If both fail, throw. Nothing is unlinked unless the caller
//     passes `permanent: true`, which is reserved for this app's own
//     scratch files and Finder junk (.DS_Store, ._ AppleDouble).
// Every outcome is recorded in the write journal.
//
// The lib layer is shared with the non-Electron MCP server, so it
// cannot import electron's `shell` directly — main.ts injects the
// trash handler at startup via setTrashHandler(), mirroring the
// initWriteJournal() pattern.
// ============================================================

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { recordWrite, statBytes } from './writeJournal';
import { createScopedLogger } from './logger';
import { invalidateLibraryFileLists } from './jobQueue/sharedResultStore';

const log = createScopedLogger('SafeDelete');

type TrashHandler = (filePath: string) => Promise<void>;

let trashHandler: TrashHandler | null = null;

/** Register the OS-Trash handler (Electron main passes shell.trashItem). */
export function setTrashHandler(fn: TrashHandler): void {
  trashHandler = fn;
}

export function hasTrashHandler(): boolean {
  return trashHandler !== null;
}

export type SafeDeleteOptions = {
  /** Feature that triggered the delete (journal context, e.g. 'duplicate-resolve'). */
  context?: string;
  /** Extra structured detail for the journal entry. */
  detail?: Record<string, unknown>;
  /** Target may be a directory tree (only matters for `permanent` deletes). */
  recursive?: boolean;
  /** Skip the Trash and unlink. ONLY for this app's own temp/scratch files and
   *  Finder junk — never for anything the user owns. */
  permanent?: boolean;
};

export type SafeDeleteResult = {
  /** 'os-trash' = handler; 'manual-trash' = moved into a Trash folder ourselves. */
  method: 'os-trash' | 'manual-trash' | 'permanent';
  /** Where the item now lives, for manual-trash moves. */
  trashPath?: string;
};

let manualTrashOverride: string | null = null;

/** Send manual-trash moves to this folder instead of the real Trash (tests). */
export function setManualTrashDir(dir: string | null): void {
  manualTrashOverride = dir;
}

/** Trash folders to try for a manual move, nearest first. */
function manualTrashDirs(filePath: string): string[] {
  if (manualTrashOverride) return [manualTrashOverride];
  const dirs: string[] = [];
  if (process.platform === 'darwin') {
    // Same-volume Trash keeps it a cheap rename and doesn't fill the boot disk.
    const m = path.resolve(filePath).match(/^\/Volumes\/[^/]+/);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (m && uid !== null) dirs.push(path.join(m[0], '.Trashes', String(uid)));
    dirs.push(path.join(os.homedir(), '.Trash'));
  } else if (process.platform === 'linux') {
    dirs.push(path.join(os.homedir(), '.local', 'share', 'Trash', 'files'));
  }
  return dirs;
}

/** Unique name inside a Trash folder, Finder-style ("Track 14.03.22.aif"). */
async function uniqueTrashPath(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 0; ; i++) {
    const exists = await fs.lstat(candidate).then(() => true, () => false);
    if (!exists) return candidate;
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '.');
    candidate = path.join(dir, `${base} ${stamp}${i ? `-${i}` : ''}${ext}`);
  }
}

/** Copy a file or directory tree into `dest`, then remove the source (cross-volume). */
async function copyThenRemove(src: string, dest: string): Promise<void> {
  const stat = await fs.lstat(src);
  if (stat.isDirectory()) {
    await fs.cp(src, dest, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  } else {
    await fs.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
    const copied = await fs.stat(dest);
    if (copied.size !== stat.size) {
      await fs.unlink(dest).catch(() => {});
      throw new Error(`copy to Trash incomplete (${copied.size} of ${stat.size} bytes)`);
    }
  }
  await fs.rm(src, { recursive: true });
}

/** Move into the first Trash folder that works. Throws if none do. */
async function moveToTrashManually(filePath: string): Promise<string> {
  const dirs = manualTrashDirs(filePath);
  if (dirs.length === 0) throw new Error(`no Trash folder available on ${process.platform}`);
  let lastErr: unknown = null;
  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
      const dest = await uniqueTrashPath(dir, path.basename(filePath));
      try {
        await fs.rename(filePath, dest);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        await copyThenRemove(filePath, dest);
      }
      return dest;
    } catch (err) {
      lastErr = err;
      log.warn(`Manual trash into ${dir} failed for ${filePath}:`, err);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Delete a file (or directory tree) by moving it to the Trash: the OS Trash
 * via the registered handler, else a manual move into a Trash folder. Never
 * unlinks user files — if no Trash works it throws. `permanent: true` is for
 * app scratch files only. Always journaled. Throws on failure so callers can surface it.
 */
export async function safeDelete(filePath: string, options: SafeDeleteOptions = {}): Promise<SafeDeleteResult> {
  const { context, detail, recursive, permanent } = options;
  const bytes = await statBytes(filePath);
  const fail = (err: unknown, extra: Record<string, unknown>): never => {
    recordWrite({
      op: 'delete', src: filePath, bytes, context, outcome: 'error',
      error: err instanceof Error ? err.message : String(err), detail: { ...extra, ...detail },
    });
    throw err;
  };

  if (permanent) {
    try {
      if (recursive) await fs.rm(filePath, { recursive: true });
      else await fs.unlink(filePath);
    } catch (err) {
      return fail(err, { trashed: false, permanent: true });
    }
    recordWrite({ op: 'delete', src: filePath, bytes, context, outcome: 'ok', detail: { trashed: false, permanent: true, ...detail } });
    invalidateLibraryFileLists();
    return { method: 'permanent' };
  }

  let handlerError: string | undefined;
  if (trashHandler) {
    try {
      await trashHandler(filePath); // shell.trashItem handles files and directories
      recordWrite({ op: 'delete', src: filePath, bytes, context, outcome: 'ok', detail: { trashed: true, ...detail } });
      invalidateLibraryFileLists();
      return { method: 'os-trash' };
    } catch (err) {
      // Trash can fail (unsupported volume, permissions). Move it into a Trash
      // folder ourselves rather than ever deleting it outright.
      handlerError = err instanceof Error ? err.message : String(err);
      log.warn(`OS Trash failed, moving to a Trash folder manually: ${filePath}`, err);
    }
  }

  let trashPath: string;
  try {
    trashPath = await moveToTrashManually(filePath);
  } catch (err) {
    return fail(err, { trashed: false, handlerError });
  }
  recordWrite({
    op: 'delete', src: filePath, dest: trashPath, bytes, context, outcome: 'ok',
    detail: { trashed: true, manualTrash: true, handlerError, ...detail },
  });
  invalidateLibraryFileLists();
  return { method: 'manual-trash', trashPath };
}
