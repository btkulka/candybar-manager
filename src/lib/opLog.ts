// ============================================================
// The operations log: what the app and Claude's tools did, step
// by step, kept where Claude can read it back to answer "what
// happened?" and to pick up where work left off.
//
//   <userData>/logs/ops/YYYY-MM-DD.jsonl       the app
//   <userData>/logs/ops/YYYY-MM-DD.mcp.jsonl   the MCP servers
//
// One event per line; an operation is every event sharing an `op`
// id. Events (`ev`):
//   start     name, source (ui | claude | cli | job | app), args,
//             parent op, pid and process
//   label     the human label the work registered ("Organizing tracks")
//   state     a change of state (a queued job starting)
//   progress  a progress message the UI was sent: at most one a second
//             per channel, and the last one is always kept
//   output    a line the UI's log panel showed
//   log       a logger line written while the operation ran
//   end       outcome (ok | error), ms, a result summary or the error
//
// Arguments and results are summarized (long strings cut, long lists
// sampled) and anything named like a secret is redacted. Like the
// write journal, logging never breaks the work it records. Days older
// than RETAIN_DAYS are pruned on start. src/lib/logQuery.ts reads it.
// ============================================================

import fs from 'fs';
import path from 'path';
import { AsyncLocalStorage } from 'async_hooks';

/** Who asked for the work: Ben in the window, Claude over MCP, a script over
 *  the app's socket, the job queue, or the app itself. */
export type OpSource = 'ui' | 'claude' | 'cli' | 'job' | 'app';
export type OpOutcome = 'ok' | 'error';

export type StartInfo = {
  source?: OpSource;
  args?: unknown;
  /** The operation that started this one; defaults to the one running. */
  parent?: string;
  /** Anything else worth keeping on the start line (the MCP tool, a job id). */
  meta?: Record<string, unknown>;
};

const RETAIN_DAYS = 30;
const PROGRESS_INTERVAL_MS = 1000;
/** Per operation; past these, events are counted instead of written. */
const LIMITS = { output: 20_000, log: 5_000, progress: 2_000 } as const;
/** A quiet operation is only kept when it fails or takes longer than this. */
const SLOW_MS = 3000;
const MAX_LINE_BYTES = 48 * 1024;
const FLUSH_MS = 250;

let dir: string | null = null;
let proc = 'app';
let seq = 0;
let exitHooked = false;
const als = new AsyncLocalStorage<Op>();

/** Start writing to <userDataDir>/logs/ops. Returns the directory. */
export function initOpLog(userDataDir: string, opts: { proc?: 'app' | 'mcp'; retainDays?: number } = {}): string {
  dir = path.join(userDataDir, 'logs', 'ops');
  proc = opts.proc ?? 'app';
  try {
    fs.mkdirSync(dir, { recursive: true });
    pruneOldDays(dir, opts.retainDays ?? RETAIN_DAYS);
  } catch (err) {
    warnOnce(err);
  }
  if (!exitHooked) {
    exitHooked = true;
    process.once('exit', flushOpLogSync);
  }
  return dir;
}

export function getOpLogDir(): string | null {
  return dir;
}

/** For tests: stop writing and forget the directory. */
export function resetOpLog(): void {
  flushOpLogSync();
  dir = null;
}

// ---------- Summaries ----------

/** Keys whose values are never written. Matched at the end of the key, so
 *  spotifyClientSecret, claudeOauthToken and lalalApiKey all count. */
const SECRET_KEY = /(pass(word|wd)?|secrets?|tokens?|cookies?|authori[sz]ation|api[-_]?key|credentials?|bearer)$/i;

export type SummarizeOptions = { maxString?: number; maxItems?: number; maxDepth?: number; maxKeys?: number };

function clip(s: string, max: number): string {
  // Album art and other inline images: the type, not the bytes.
  if (s.startsWith('data:') && s.length > 120) return `${s.slice(0, Math.min(s.indexOf(',') + 1 || 40, 60))}…[${s.length} chars]`;
  return s.length > max ? `${s.slice(0, max)}…(+${s.length - max} chars)` : s;
}

/** A JSON-safe, bounded copy of `value` with secrets redacted. */
export function summarize(value: unknown, opts: SummarizeOptions = {}): unknown {
  const o = { maxString: 600, maxItems: 8, maxDepth: 5, maxKeys: 50, ...opts };
  const ancestors = new Set<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') return clip(v, o.maxString);
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'function' || typeof v === 'symbol') return undefined;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
    if (v instanceof Error) {
      return { error: v.message, name: v.name === 'Error' ? undefined : v.name, stack: v.stack?.split('\n').slice(1, 6).map((s) => s.trim()) };
    }
    if (ArrayBuffer.isView(v)) return `[${v.byteLength} bytes]`;
    if (v instanceof ArrayBuffer) return `[${v.byteLength} bytes]`;
    const obj = v as object;
    if (ancestors.has(obj)) return '[circular]';
    if (obj instanceof Map) return walk(Object.fromEntries(obj), depth);
    if (obj instanceof Set) return walk([...obj], depth);
    ancestors.add(obj);
    try {
      if (Array.isArray(obj)) {
        if (depth >= o.maxDepth) return `[${obj.length} items]`;
        const head = obj.slice(0, o.maxItems).map((x) => walk(x, depth + 1));
        if (obj.length > o.maxItems) head.push(`…${obj.length - o.maxItems} more (${obj.length} total)`);
        return head;
      }
      const keys = Object.keys(obj);
      if (depth >= o.maxDepth) return `{${keys.length} keys}`;
      const out: Record<string, unknown> = {};
      for (const [i, k] of keys.entries()) {
        if (i >= o.maxKeys) {
          out['…'] = `${keys.length - o.maxKeys} more keys`;
          break;
        }
        const x = (obj as Record<string, unknown>)[k];
        out[k] = SECRET_KEY.test(k) && x !== null && x !== undefined && x !== '' ? '[redacted]' : walk(x, depth + 1);
      }
      return out;
    } finally {
      ancestors.delete(obj);
    }
  };
  return walk(value, 0);
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

// ---------- Writing ----------

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayFile(d: Date): string {
  return `${localDay(d)}${proc === 'app' ? '' : `.${proc}`}.jsonl`;
}

let queued = new Map<string, string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<void> = Promise.resolve();
let warned = false;

function warnOnce(err: unknown): void {
  if (warned) return;
  warned = true;
  // Not through the logger: it mirrors into operations, which would loop.
  try { process.stderr.write(`[opLog] writing the operations log failed (further failures suppressed): ${errorText(err)}\n`); } catch { /* nowhere to say it */ }
}

function stringify(event: Record<string, unknown>): string {
  let line = JSON.stringify(event);
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  // Too big even summarized: summarize harder, then give up on the detail.
  line = JSON.stringify(summarize(event, { maxString: 200, maxItems: 3, maxDepth: 3, maxKeys: 20 }));
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  return JSON.stringify({ ts: event.ts, op: event.op, ev: event.ev, truncated: true, preview: line.slice(0, 4000) });
}

function write(event: Record<string, unknown>): void {
  if (!dir) return;
  const now = new Date();
  let line: string;
  try {
    line = stringify({ ts: now.toISOString(), ...event });
  } catch (err) {
    warnOnce(err);
    return;
  }
  const file = path.join(dir, dayFile(now));
  queued.set(file, (queued.get(file) ?? '') + line + '\n');
  if (!flushTimer) {
    flushTimer = setTimeout(flushQueued, FLUSH_MS);
    flushTimer.unref?.();
  }
}

function takeQueued(): Map<string, string> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const batch = queued;
  queued = new Map();
  return batch;
}

function flushQueued(): void {
  const batch = takeQueued();
  if (batch.size === 0) return;
  chain = chain
    .then(async () => {
      for (const [file, text] of batch) await fs.promises.appendFile(file, text, 'utf8');
    })
    .catch(warnOnce);
}

/** Wait for everything logged so far to reach the disk. */
export async function flushOpLog(): Promise<void> {
  flushQueued();
  await chain;
}

/** Write what's queued right now (process exit, a crash). */
export function flushOpLogSync(): void {
  const batch = takeQueued();
  for (const [file, text] of batch) {
    try { fs.appendFileSync(file, text, 'utf8'); } catch (err) { warnOnce(err); }
  }
}

function pruneOldDays(logDir: string, retainDays: number): void {
  const cutoff = localDay(new Date(Date.now() - retainDays * 86_400_000));
  for (const name of fs.readdirSync(logDir)) {
    const m = /^(\d{4}-\d{2}-\d{2})(\.[\w-]+)?\.jsonl$/.exec(name);
    if (m && m[1] < cutoff) fs.rmSync(path.join(logDir, name), { force: true });
  }
}

// ---------- Operations ----------

type Kind = keyof typeof LIMITS;

export class Op {
  readonly id: string;
  readonly name: string;
  readonly source: OpSource;
  readonly parent?: string;
  private readonly startedAt = Date.now();
  private ended = false;
  private readonly counts: Record<Kind, number> = { output: 0, log: 0, progress: 0 };
  private readonly dropped: Record<Kind, number> = { output: 0, log: 0, progress: 0 };
  private readonly lastProgress = new Map<string, { at: number; pending?: unknown; hasPending: boolean }>();
  /** A quiet operation holds its events until it proves worth keeping. */
  private held: Record<string, unknown>[] | null;

  constructor(name: string, info: StartInfo, quiet: boolean) {
    this.id = `${proc}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
    this.name = name;
    const running = als.getStore();
    this.source = info.source ?? running?.source ?? 'app';
    this.parent = info.parent ?? running?.id;
    this.held = quiet ? [] : null;
    this.emit({
      ev: 'start', name, source: this.source,
      args: info.args === undefined ? undefined : summarize(info.args),
      parent: this.parent, ...(info.meta ? { meta: summarize(info.meta) } : {}),
      proc, pid: process.pid,
    });
  }

  private emit(e: Record<string, unknown>): void {
    const event = { op: this.id, ...e };
    if (this.held) {
      if (this.held.length < 500) this.held.push(event);
    } else {
      write(event);
    }
  }

  private admit(kind: Kind): boolean {
    if (this.ended) return false;
    if (this.counts[kind] >= LIMITS[kind]) {
      this.dropped[kind]++;
      return false;
    }
    this.counts[kind]++;
    return true;
  }

  label(text: string): void {
    if (!this.ended) this.emit({ ev: 'label', label: text });
  }

  state(state: string, detail?: unknown): void {
    if (!this.ended) this.emit({ ev: 'state', state, ...(detail === undefined ? {} : { detail: summarize(detail) }) });
  }

  output(text: string, stream = 'stdout'): void {
    if (this.admit('output')) this.emit({ ev: 'output', stream, text: clip(String(text).replace(/\n+$/, ''), 4000) });
  }

  log(level: string, scope: string | undefined, text: string): void {
    if (this.admit('log')) this.emit({ ev: 'log', level, ...(scope ? { scope } : {}), text: clip(text, 4000) });
  }

  progress(channel: string, data: unknown): void {
    if (this.ended) return;
    const now = Date.now();
    const last = this.lastProgress.get(channel);
    if (last && now - last.at < PROGRESS_INTERVAL_MS) {
      last.pending = data;
      last.hasPending = true;
      return;
    }
    this.lastProgress.set(channel, { at: now, hasPending: false });
    this.writeProgress(channel, data);
  }

  private writeProgress(channel: string, data: unknown): void {
    if (this.admit('progress')) {
      this.emit({ ev: 'progress', channel, data: summarize(data, { maxString: 300, maxItems: 4, maxDepth: 3, maxKeys: 20 }) });
    }
  }

  end(outcome: OpOutcome, done: { result?: unknown; error?: unknown } = {}): void {
    if (this.ended) return;
    // The last word on each progress channel is the useful one.
    for (const [channel, last] of this.lastProgress) {
      if (last.hasPending) this.writeProgress(channel, last.pending);
    }
    this.ended = true;
    const ms = Date.now() - this.startedAt;
    if (this.held) {
      const held = this.held;
      this.held = null;
      if (outcome === 'ok' && ms < SLOW_MS) return;
      for (const e of held) write(e);
    }
    const dropped = Object.values(this.dropped).some(Boolean) ? { ...this.dropped } : undefined;
    this.emit({
      ev: 'end', outcome, ms,
      ...(done.result === undefined ? {} : { result: summarize(done.result) }),
      ...(done.error === undefined ? {} : { error: errorText(done.error) }),
      ...(dropped ? { dropped } : {}),
    });
  }
}

/** Begin an operation. Call end() on it, or use withOp(). */
export function startOp(name: string, info: StartInfo = {}, opts: { quiet?: boolean } = {}): Op {
  return new Op(name, info, !!opts.quiet);
}

/** The operation whose work is running right now, if any. */
export function currentOp(): Op | undefined {
  return als.getStore();
}

/** Run `fn` with `op` as the current operation (logs and progress inside it
 *  are attributed to it). */
export function runInOp<T>(op: Op, fn: () => T): T {
  return als.run(op, fn);
}

/** Many handlers report failure as `{ success: false, error }` instead of
 *  throwing; count those as errors. */
function defaultFailure(result: unknown): string | null {
  if (result && typeof result === 'object' && (result as { success?: unknown }).success === false) {
    const err = (result as { error?: unknown }).error;
    return err ? errorText(err) : 'success: false';
  }
  return null;
}

export type WithOpOptions<T> = {
  /** Keep only when it fails or is slow (frequent reads, polling). */
  quiet?: boolean;
  /** Decide whether a returned result is a failure; the message, or null. */
  failure?: (result: T) => string | null;
};

/** Run `fn` as an operation: start, attribute everything inside it, end. */
export async function withOp<T>(name: string, info: StartInfo, fn: (op: Op) => T | Promise<T>, opts: WithOpOptions<T> = {}): Promise<T> {
  const op = startOp(name, info, opts);
  try {
    const result = await als.run(op, () => fn(op));
    let failed: string | null = null;
    try { failed = (opts.failure ?? defaultFailure)(result); } catch { /* a bad check isn't a failed operation */ }
    op.end(failed ? 'error' : 'ok', failed ? { result, error: failed } : { result });
    return result;
  } catch (err) {
    op.end('error', { error: err });
    throw err;
  }
}

/** A one-line operation: something that happened rather than work that ran
 *  (the app starting, a renderer crashing). */
export function recordEvent(name: string, info: StartInfo & { outcome?: OpOutcome; error?: unknown } = {}): void {
  const op = startOp(name, info);
  op.end(info.outcome ?? (info.error === undefined ? 'ok' : 'error'), info.error === undefined ? {} : { error: info.error });
}
