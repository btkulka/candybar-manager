import type { ClaudeStatus, JobProgress } from '../types';
import { showToast, requestOpenSettings } from './shared';

// Starting and following Claude jobs from the renderer. Jobs run in main on
// the job queue; this enqueues one, streams its log lines, and settles with
// its result.

export type ClaudeJobType = 'claude-ask' | 'claude-sourcing-review' | 'claude-track-tags' | 'claude-soundcloud';
export type JobLogEntry = { jobId: string; text: string; stream: 'stdout' | 'stderr' | 'status' };

// The Claude-specific bridge calls, typed here so the shared Window typing
// doesn't have to change for them.
type ClaudeBridge = {
  jobEnqueue: (type: string, params: unknown, contextKey: string) => Promise<{ jobId: string }>;
  jobWait: (jobId: string) => Promise<{ success: boolean; result?: unknown; error?: string; cancelled?: boolean }>;
  jobCancel: (jobId: string) => Promise<boolean>;
  onJobLog: (callback: (entry: JobLogEntry) => void) => () => void;
  onJobProgress: (callback: (progress: JobProgress) => void) => () => void;
  claudeStatus: () => Promise<ClaudeStatus>;
  claudeOpenLogin: () => Promise<{ opened: boolean; command: string }>;
};

export const claudeBridge = (window as unknown as { candybar: ClaudeBridge }).candybar;

export class ClaudeJobError extends Error {
  constructor(message: string, readonly cancelled: boolean) {
    super(message);
  }
}

export type ClaudeJobHandle<T> = {
  jobId: string;
  result: Promise<T>;
  cancel: () => void;
};

/** Enqueue a Claude job. `onLog` gets its log lines; `onProgress` its status. */
export async function startClaudeJob<T>(
  type: ClaudeJobType,
  params: unknown,
  handlers: { onLog?: (entry: JobLogEntry) => void; onProgress?: (p: JobProgress) => void } = {},
): Promise<ClaudeJobHandle<T>> {
  // Listen before enqueueing: a job can start (and log) before the id comes back.
  let jobId: string | null = null;
  const early: JobLogEntry[] = [];
  const offLog = claudeBridge.onJobLog((entry) => {
    if (jobId === null) early.push(entry);
    else if (entry.jobId === jobId) handlers.onLog?.(entry);
  });
  const offProgress = claudeBridge.onJobProgress((p) => {
    if (p.jobId === jobId) handlers.onProgress?.(p);
  });
  const stop = () => { offLog(); offProgress(); };

  try {
    jobId = (await claudeBridge.jobEnqueue(type, params, 'claude')).jobId;
  } catch (err) {
    stop();
    throw err;
  }
  const id = jobId;
  for (const entry of early) if (entry.jobId === id) handlers.onLog?.(entry);

  const result = claudeBridge.jobWait(id).then((r) => {
    stop();
    if (r.success) return r.result as T;
    throw new ClaudeJobError(r.error || 'The Claude job failed.', !!r.cancelled);
  }, (err) => {
    stop();
    throw err;
  });
  return { jobId: id, result, cancel: () => { void claudeBridge.jobCancel(id); } };
}

// ---------- Sign-in status ----------

let cached: { at: number; status: ClaudeStatus } | null = null;

export async function getClaudeStatus(force = false): Promise<ClaudeStatus> {
  if (!force && cached && Date.now() - cached.at < 60_000) return cached.status;
  const status = await claudeBridge.claudeStatus();
  cached = { at: Date.now(), status };
  window.dispatchEvent(new CustomEvent('claude-status-changed', { detail: status }));
  return status;
}

export type ClaudeStatusView = {
  ready: boolean;
  tone: 'ok' | 'warn' | 'danger';
  label: string;
  detail: string;
};

const PLAN_NAMES: Record<string, string> = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' };

/** What to tell the user about a status, in plain words. */
export function describeClaudeStatus(s: ClaudeStatus): ClaudeStatusView {
  if (!s.installed) {
    return { ready: false, tone: 'danger', label: 'Claude Code not installed', detail: 'Install Claude Code from claude.com/claude-code, then come back and sign in.' };
  }
  if (!s.loggedIn) {
    return { ready: false, tone: 'warn', label: 'Not signed in', detail: 'Sign in to Claude Code with your Claude account. Jobs run on that subscription.' };
  }
  if (!s.subscription) {
    return {
      ready: false, tone: 'warn', label: 'Not using a subscription',
      detail: 'Claude Code is signed in with an API key, which would bill API credits. Sign in with your Claude account instead.',
    };
  }
  const plan = s.subscriptionType ? `${PLAN_NAMES[s.subscriptionType] ?? s.subscriptionType} plan` : 'Claude subscription';
  const who = s.usingAppToken ? 'using the saved token' : s.email ?? '';
  const usage = s.rateLimit?.utilization != null
    ? ` About ${Math.round(s.rateLimit.utilization * 100)}% of this ${s.rateLimit.rateLimitType === 'five_hour' ? '5-hour' : 'week\'s'} limit is used.`
    : '';
  return { ready: true, tone: 'ok', label: `Connected · ${plan}`, detail: `Claude jobs run on your ${plan}${who ? `, ${who}` : ''}.${usage}` };
}

/** True when jobs can run. Otherwise says why and offers Settings → Claude. */
export async function ensureClaudeReady(): Promise<boolean> {
  let status: ClaudeStatus;
  try {
    status = await getClaudeStatus();
  } catch (err) {
    showToast('error', 'Couldn\'t check Claude', err instanceof Error ? err.message : String(err));
    return false;
  }
  const view = describeClaudeStatus(status);
  if (view.ready) return true;
  showToast('warning', view.label, view.detail, 8000, { label: 'Set up Claude', onClick: () => requestOpenSettings('claude') });
  return false;
}
