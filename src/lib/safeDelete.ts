// ============================================================
// Recoverable deletes: prefer the OS Trash (via an injected
// handler from the Electron main process) so a deleted file can
// be recovered, falling back to a permanent unlink when no trash
// handler is registered (MCP server, unit tests). Every delete is
// recorded in the write journal.
//
// The lib layer is shared with the non-Electron MCP server, so it
// cannot import electron's `shell` directly — main.ts injects the
// trash handler at startup via setTrashHandler(), mirroring the
// initWriteJournal() pattern.
// ============================================================

import fs from 'fs/promises';
import { recordWrite, statBytes } from './writeJournal';
import { createScopedLogger } from './logger';

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
  /** Target may be a directory tree; permanent-delete fallback uses recursive rm. */
  recursive?: boolean;
};

/**
 * Delete a file (or directory tree when `recursive`), preferring the OS Trash
 * (recoverable) when a trash handler is registered. Falls back to a permanent
 * unlink/rm otherwise. Always journaled. Throws on failure so callers can surface it.
 */
export async function safeDelete(filePath: string, options: SafeDeleteOptions = {}): Promise<void> {
  const { context, detail, recursive } = options;
  const bytes = await statBytes(filePath);

  if (trashHandler) {
    try {
      await trashHandler(filePath); // shell.trashItem handles files and directories
      recordWrite({ op: 'delete', src: filePath, bytes, context, outcome: 'ok', detail: { trashed: true, ...detail } });
      return;
    } catch (err) {
      // Trash can fail (unsupported volume, permissions) — fall back to a permanent
      // delete so the operation still completes, but recovery is no longer possible.
      log.warn(`Trash failed, falling back to permanent delete: ${filePath}`, err);
    }
  }

  try {
    if (recursive) await fs.rm(filePath, { recursive: true, force: true });
    else await fs.unlink(filePath);
    recordWrite({ op: 'delete', src: filePath, bytes, context, outcome: 'ok', detail: { trashed: false, ...detail } });
  } catch (err) {
    recordWrite({
      op: 'delete', src: filePath, bytes, context, outcome: 'error',
      error: err instanceof Error ? err.message : String(err), detail: { trashed: false, ...detail },
    });
    throw err;
  }
}
