// ============================================================
// Append-only journal of destructive write operations (moves,
// deletes, conversions, tag rewrites, XML rewrites) so file
// history can be traced for recovery.
//
// Format: one JSON object per line (JSONL), rotated monthly:
//   <userData>/write-journal/YYYY-MM.jsonl
//
// The journal must never break the operation it records — every
// append is fire-and-forget and failures are logged once, not
// thrown. When uninitialized (unit tests, tooling) recording is
// a no-op.
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import { createScopedLogger } from './logger';

const log = createScopedLogger('WriteJournal');

export type WriteJournalOp =
  | 'move'          // file relocated (organize, archive, migrate, flatten)
  | 'delete'        // file or directory removed
  | 'convert'       // new file produced from an original (ffmpeg)
  | 'tag-write'     // file rewritten in place with new tags (may change extension)
  | 'header-repair' // in-place AIFC compressionType byte patch
  | 'xml-rewrite';  // Rekordbox collection XML modified

export type WriteJournalEntry = {
  op: WriteJournalOp;
  /** Path the operation read from / acted on. */
  src: string;
  /** Path the operation produced, when different from src. */
  dest?: string;
  /** Size in bytes of src before the operation, when known. */
  bytes?: number;
  /** Which feature triggered the write (e.g. 'organize', 'archive'). */
  context?: string;
  outcome: 'ok' | 'error';
  error?: string;
  detail?: Record<string, unknown>;
};

let journalDir: string | null = null;
let warnedAppendFailure = false;

export function initWriteJournal(userDataDir: string): void {
  journalDir = path.join(userDataDir, 'write-journal');
  log.info('Write journal directory:', journalDir);
}

export function getWriteJournalDir(): string | null {
  return journalDir;
}

// Serialize appends so concurrent operations can't interleave partial lines.
let appendChain: Promise<void> = Promise.resolve();

/**
 * Record a write operation. Fire-and-forget: appends are serialized in the
 * background and never throw into the caller.
 */
export function recordWrite(entry: WriteJournalEntry): void {
  if (!journalDir) return;
  const dir = journalDir;
  const now = new Date();
  const line = JSON.stringify({ ts: now.toISOString(), ...entry }) + '\n';
  const file = path.join(dir, `${now.toISOString().slice(0, 7)}.jsonl`);
  appendChain = appendChain
    .then(async () => {
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(file, line, 'utf8');
    })
    .catch((err) => {
      if (!warnedAppendFailure) {
        warnedAppendFailure = true;
        log.warn('Write journal append failed (further failures suppressed):', err);
      }
    });
}

/** Wait for all pending journal appends to land (tests, shutdown). */
export function flushWriteJournal(): Promise<void> {
  return appendChain.then(() => undefined);
}

/** Size of a file in bytes for journal entries; undefined if unreadable. */
export async function statBytes(filePath: string): Promise<number | undefined> {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return undefined;
  }
}
