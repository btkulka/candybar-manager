// ============================================================
// Reading the logs back: the operations log (opLog.ts), the
// app's text logs and the write journal. Plain fs, no Electron,
// so the MCP server answers from them even while the app is
// closed (or after it crashed).
// ============================================================

import fs from 'fs';
import path from 'path';

export type OpEvent = { ts: string; op: string; ev: string; [key: string]: unknown };

export type OpStatus = 'ok' | 'error' | 'running' | 'interrupted';

export type OpSummary = {
  id: string;
  name: string;
  label?: string;
  source?: string;
  proc?: string;
  parent?: string;
  startedAt?: string;
  endedAt?: string;
  ms?: number;
  status: OpStatus;
  error?: string;
  args?: unknown;
  result?: unknown;
  /** How many of each event it has; warn/error count its log lines at those levels. */
  counts: { progress: number; output: number; log: number; warn: number; error: number };
  /** The last progress message or output line, for work still running. */
  last?: string;
};

export type OpQuery = {
  since?: string | Date;
  until?: string | Date;
  /** Substring of the operation's name or label (case-insensitive). */
  name?: string;
  source?: string;
  status?: OpStatus;
  /** Substring anywhere in the operation's events: args, output, errors. */
  search?: string;
  /** Only operations started by this one. */
  parent?: string;
  limit?: number;
};

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})(?:\.([\w-]+))?\.jsonl$/;
const DAY_MS = 86_400_000;

function toDate(v: string | Date | undefined, fallback: Date): Date {
  if (v === undefined || v === '') return fallback;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The day files covering [since, until], oldest first. */
function dayFiles(dir: string, since: Date, until: Date): string[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const from = localDay(since);
  const to = localDay(until);
  return names
    .filter((n) => {
      const m = DAY_FILE.exec(n);
      return m && m[1] >= from && m[1] <= to;
    })
    .sort()
    .map((n) => path.join(dir, n));
}

function readLines(file: string): string[] {
  try { return fs.readFileSync(file, 'utf8').split('\n'); } catch { return []; }
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

type Grouped = { events: OpEvent[]; raw: string[] };

function readGrouped(dir: string, since: Date, until: Date): Map<string, Grouped> {
  const ops = new Map<string, Grouped>();
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();
  for (const file of dayFiles(dir, since, until)) {
    for (const line of readLines(file)) {
      if (!line) continue;
      let e: OpEvent;
      try { e = JSON.parse(line); } catch { continue; }
      if (!e || typeof e.op !== 'string') continue;
      let g = ops.get(e.op);
      if (!g) {
        // An operation counts as in range by when it started.
        if (e.ev === 'start' && (e.ts < sinceIso || e.ts > untilIso)) continue;
        if (e.ev !== 'start') continue; // its start fell before the range
        g = { events: [], raw: [] };
        ops.set(e.op, g);
      }
      g.events.push(e);
      g.raw.push(line);
    }
  }
  return ops;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function summarizeOp(events: OpEvent[]): OpSummary {
  const start = events.find((e) => e.ev === 'start');
  const end = events.find((e) => e.ev === 'end');
  const counts = { progress: 0, output: 0, log: 0, warn: 0, error: 0 };
  let label: string | undefined;
  let last: string | undefined;
  for (const e of events) {
    if (e.ev === 'progress') {
      counts.progress++;
      const d = e.data as { message?: unknown; currentTrack?: unknown } | string | undefined;
      last = typeof d === 'string' ? d : str(d?.message) ?? str(d?.currentTrack) ?? last;
    } else if (e.ev === 'output') {
      counts.output++;
      last = str(e.text) ?? last;
    } else if (e.ev === 'log') {
      counts.log++;
      if (e.level === 'warn') counts.warn++;
      if (e.level === 'error') counts.error++;
    } else if (e.ev === 'label') {
      label = str(e.label);
    }
  }
  const id = (start ?? events[0])?.op ?? '';
  let status: OpStatus;
  if (end) status = end.outcome === 'error' ? 'error' : 'ok';
  else status = pidAlive(start?.pid) ? 'running' : 'interrupted';
  return {
    id,
    name: str(start?.name) ?? '?',
    ...(label ? { label } : {}),
    source: str(start?.source),
    proc: str(start?.proc),
    ...(start?.parent ? { parent: str(start.parent) } : {}),
    startedAt: start?.ts,
    ...(end ? { endedAt: end.ts, ms: typeof end.ms === 'number' ? end.ms : undefined } : {}),
    status,
    ...(end?.error ? { error: str(end.error) } : {}),
    ...(start?.args !== undefined ? { args: start.args } : {}),
    ...(end?.result !== undefined ? { result: end.result } : {}),
    counts,
    ...(status === 'running' && last ? { last } : {}),
  };
}

/** Operations matching `q`, newest first. Defaults to the last 7 days, 50 operations. */
export function listOps(dir: string, q: OpQuery = {}): OpSummary[] {
  const until = toDate(q.until, new Date(Date.now() + DAY_MS));
  const since = toDate(q.since, new Date(Date.now() - 7 * DAY_MS));
  const name = q.name?.toLowerCase();
  const search = q.search?.toLowerCase();
  const out: OpSummary[] = [];
  for (const g of readGrouped(dir, since, until).values()) {
    const s = summarizeOp(g.events);
    if (q.source && s.source !== q.source) continue;
    if (q.status && s.status !== q.status) continue;
    if (q.parent && s.parent !== q.parent) continue;
    if (name && !s.name.toLowerCase().includes(name) && !s.label?.toLowerCase().includes(name)) continue;
    if (search && !g.raw.some((line) => line.toLowerCase().includes(search))) continue;
    out.push(s);
  }
  // Same millisecond: the later sequence number started later.
  out.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '') || opSeq(b.id) - opSeq(a.id));
  return out.slice(0, q.limit ?? 50);
}

function opSeq(id: string): number {
  return parseInt(id.split('-')[2] ?? '', 36) || 0;
}

/** When an operation started, from its id (`<proc>-<base36 ms>-<seq>`). */
function opStartTime(id: string): Date | null {
  const ms = parseInt(id.split('-')[1] ?? '', 36);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}

/** One operation: its summary, every event, and the operations it started. */
export function getOp(
  dir: string,
  id: string,
  opts: { events?: string[]; limit?: number } = {}
): { summary: OpSummary; events: OpEvent[]; omitted: number; children: OpSummary[] } | null {
  const started = opStartTime(id);
  const since = started ? new Date(started.getTime() - 60_000) : new Date(Date.now() - 30 * DAY_MS);
  const ops = readGrouped(dir, since, new Date(Date.now() + DAY_MS));
  const g = ops.get(id);
  if (!g) return null;
  const children: OpSummary[] = [];
  for (const [otherId, other] of ops) {
    if (otherId !== id && other.events[0]?.parent === id) children.push(summarizeOp(other.events));
  }
  // Operations another process started from this one (Claude's tool → the app).
  if (!children.length) {
    for (const other of ops.values()) {
      if (other.events[0]?.parent === id) children.push(summarizeOp(other.events));
    }
  }
  let events = opts.events?.length ? g.events.filter((e) => opts.events!.includes(e.ev)) : g.events;
  const limit = opts.limit ?? 500;
  let omitted = 0;
  if (events.length > limit) {
    // Keep the beginning and the end: how it started and how it finished.
    omitted = events.length - limit;
    events = [...events.slice(0, Math.ceil(limit / 2)), ...events.slice(events.length - Math.floor(limit / 2))];
  }
  return { summary: summarizeOp(g.events), events, omitted, children };
}

// ---------- Text logs (electron-log files) ----------

const ENTRY_START = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\.(\d{3})\] \[(\w+)\]/;
const LEVELS = ['error', 'warn', 'info', 'verbose', 'debug', 'silly'];

export type AppLogQuery = {
  /** At this level or more severe. */
  level?: 'error' | 'warn' | 'info' | 'debug';
  search?: string;
  since?: string | Date;
  /** How many entries, newest last (default 100). */
  lines?: number;
};

/** `<name>.log` and its archives (`<name>-<stamp>.log`), oldest first. */
export function textLogFiles(logsDir: string, name: string): string[] {
  let names: string[];
  try { names = fs.readdirSync(logsDir); } catch { return []; }
  const archives = names.filter((n) => n.startsWith(`${name}-`) && n.endsWith('.log')).sort();
  return [...archives, ...(names.includes(`${name}.log`) ? [`${name}.log`] : [])].map((n) => path.join(logsDir, n));
}

/** The last entries of a text log matching `q`. An entry is a line starting
 *  with a timestamp plus the lines after it (stack traces). */
export function readTextLog(files: string[], q: AppLogQuery = {}): string[] {
  const want = q.lines ?? 100;
  const maxLevel = q.level ? LEVELS.indexOf(q.level) : LEVELS.length;
  const search = q.search?.toLowerCase();
  const since = q.since ? toDate(q.since, new Date(0)) : null;
  const picked: string[] = [];
  // Newest file first, stopping once there are enough.
  for (const file of [...files].reverse()) {
    const entries: string[] = [];
    let cur: string[] | null = null;
    for (const line of readLines(file)) {
      if (ENTRY_START.test(line)) {
        if (cur) entries.push(cur.join('\n'));
        cur = [line];
      } else if (cur && line) {
        cur.push(line);
      }
    }
    if (cur) entries.push(cur.join('\n'));
    const matching = entries.filter((entry) => {
      const m = ENTRY_START.exec(entry)!;
      const lvl = LEVELS.indexOf(m[4]);
      if (lvl > maxLevel) return false;
      if (since && new Date(`${m[1]}T${m[2]}.${m[3]}`) < since) return false;
      return !search || entry.toLowerCase().includes(search);
    });
    picked.unshift(...matching);
    if (picked.length >= want) break;
  }
  return picked.slice(-want);
}

// ---------- Write journal ----------

export type JournalQuery = { since?: string | Date; op?: string; outcome?: 'ok' | 'error'; search?: string; limit?: number };

/** Write-journal entries (writeJournal.ts) matching `q`, newest first. */
export function queryWriteJournal(journalDir: string, q: JournalQuery = {}): Record<string, unknown>[] {
  let names: string[];
  try { names = fs.readdirSync(journalDir).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort().reverse(); } catch { return []; }
  const since = q.since ? toDate(q.since, new Date(0)) : null;
  const sinceMonth = since ? `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, '0')}` : null;
  const search = q.search?.toLowerCase();
  const limit = q.limit ?? 100;
  const out: Record<string, unknown>[] = [];
  for (const name of names) {
    if (sinceMonth && name.slice(0, 7) < sinceMonth) break;
    const lines = readLines(path.join(journalDir, name)).reverse();
    for (const line of lines) {
      if (!line) continue;
      if (search && !line.toLowerCase().includes(search)) continue;
      let e: Record<string, unknown>;
      try { e = JSON.parse(line); } catch { continue; }
      if (since && String(e.ts) < since.toISOString()) continue;
      if (q.op && e.op !== q.op) continue;
      if (q.outcome && e.outcome !== q.outcome) continue;
      out.push(e);
      if (out.length >= limit) return out;
    }
  }
  return out;
}
