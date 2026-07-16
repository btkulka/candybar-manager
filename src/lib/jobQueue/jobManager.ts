import { EventEmitter } from 'events';
import { createScopedLogger } from '../logger';
import {
  JobId,
  JobType,
  JobStatus,
  JobInfo,
  JobProgress,
  JobRecord,
  JobDefinition,
  JobContext,
  SharedResultKey,
  SharedResultMap,
} from './types';
import { SharedResultStore } from './sharedResultStore';

const log = createScopedLogger('JobManager');

// Safety-net timeout for jobs that don't declare their own `timeoutMs`, so one
// stuck job can't block the (single-slot) queue forever. Generous enough not to
// abort a legitimate large-library scan; a definition can set timeoutMs: 0 to opt out.
const DEFAULT_JOB_TIMEOUT_MS = 45 * 60 * 1000;

export class JobManager extends EventEmitter {
  private jobs = new Map<JobId, JobRecord>();
  private definitions = new Map<JobType, JobDefinition>();
  private queue: JobId[] = [];
  private running = new Set<JobId>();
  private sharedStore = new SharedResultStore();
  private maxConcurrent: number;

  constructor(maxConcurrent = 1) {
    super();
    this.maxConcurrent = maxConcurrent;
  }

  register<TParams, TResult>(def: JobDefinition<TParams, TResult>): void {
    this.definitions.set(def.type, def as JobDefinition);
  }

  enqueue<TResult = unknown>(
    type: JobType,
    params: unknown,
    contextKey: string
  ): { jobId: JobId; promise: Promise<TResult> } {
    const jobId: JobId = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    let resolveJob!: (value: TResult) => void;
    let rejectJob!: (reason: Error) => void;
    const promise = new Promise<TResult>((res, rej) => {
      resolveJob = res;
      rejectJob = rej;
    });

    const record: JobRecord = {
      id: jobId,
      type,
      status: 'queued',
      params,
      contextKey,
      result: null,
      error: null,
      progress: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      abortController: new AbortController(),
      promise: promise as Promise<unknown>,
      resolve: resolveJob as (v: unknown) => void,
      reject: rejectJob,
    };

    this.jobs.set(jobId, record);
    this.queue.push(jobId);
    this.emit('job-queued', this.toJobInfo(record));
    this.tick();

    return { jobId, promise };
  }

  cancel(jobId: JobId): boolean {
    const record = this.jobs.get(jobId);
    if (!record) return false;
    record.abortController.abort();
    if (record.status === 'queued') {
      this.queue = this.queue.filter(id => id !== jobId);
      record.status = 'cancelled';
      record.completedAt = Date.now();
      // Settle the enqueue() promise — otherwise any IPC handler awaiting it
      // hangs until the app restarts (a running job settles via runJob's catch).
      record.reject(new Error('Job cancelled'));
      this.emit('job-cancelled', this.toJobInfo(record));
    }
    return true;
  }

  getJob(jobId: JobId): JobInfo | null {
    const record = this.jobs.get(jobId);
    return record ? this.toJobInfo(record) : null;
  }

  getAllJobs(): JobInfo[] {
    return Array.from(this.jobs.values()).map(r => this.toJobInfo(r));
  }

  getSharedResult<K extends SharedResultKey>(key: K, contextKey: string): SharedResultMap[K] | null {
    return this.sharedStore.get(key, contextKey);
  }

  private tick(): void {
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const jobId = this.queue.shift()!;
      const record = this.jobs.get(jobId);
      if (!record) continue;
      this.runJob(record);
    }
  }

  private async runJob(record: JobRecord): Promise<void> {
    const def = this.definitions.get(record.type);
    if (!def) {
      record.status = 'failed';
      record.error = `No definition registered for job type: ${record.type}`;
      record.completedAt = Date.now();
      record.reject(new Error(record.error));
      this.emit('job-failed', this.toJobInfo(record));
      return;
    }

    record.status = 'running';
    record.startedAt = Date.now();
    this.running.add(record.id);
    this.emit('job-started', this.toJobInfo(record));

    const ctx: JobContext = {
      params: record.params,
      signal: record.abortController.signal,
      progress: (update) => {
        const progress: JobProgress = {
          jobId: record.id,
          jobType: record.type,
          ...update,
        };
        record.progress = progress;
        this.emit('job-progress', progress);
      },
      getSharedResult: <K extends SharedResultKey>(key: K) => this.sharedStore.get(key, record.contextKey),
      log: (text, stream = 'stdout') => {
        log.debug(`[${record.type}] ${text}`);
        this.emit('job-log', { jobId: record.id, text, stream });
      },
    };

    // A definition can opt out of the safety-net timeout with timeoutMs: 0.
    const effectiveTimeout = def.timeoutMs === undefined ? DEFAULT_JOB_TIMEOUT_MS : def.timeoutMs;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    if (effectiveTimeout && effectiveTimeout > 0) {
      timeout = setTimeout(() => {
        log.warn(`Job ${record.type} (${record.id}) exceeded ${effectiveTimeout}ms — aborting`);
        record.abortController.abort();
      }, effectiveTimeout);
    }

    try {
      const result = await def.run(ctx);
      if (timeout) clearTimeout(timeout);

      if (def.producesSharedResult) {
        this.sharedStore.set(
          def.producesSharedResult,
          record.contextKey,
          result as SharedResultMap[typeof def.producesSharedResult]
        );
      }

      record.status = 'completed';
      record.result = result;
      record.completedAt = Date.now();
      record.resolve(result);
      this.emit('job-completed', this.toJobInfo(record));
    } catch (err) {
      if (timeout) clearTimeout(timeout);
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Job ${record.type} (${record.id}) failed:`, message);
      record.status = record.abortController.signal.aborted ? 'cancelled' : 'failed';
      record.error = message;
      record.completedAt = Date.now();
      record.reject(err instanceof Error ? err : new Error(message));
      this.emit(record.status === 'cancelled' ? 'job-cancelled' : 'job-failed', this.toJobInfo(record));
    } finally {
      this.running.delete(record.id);
      this.pruneCompletedJobs();
      this.tick();
    }
  }

  // Cap retained settled jobs so the jobs Map (which holds full results for the
  // process lifetime) can't grow without bound. Running/queued jobs are kept.
  private static readonly MAX_RETAINED_JOBS = 200;
  private pruneCompletedJobs(): void {
    const settled = Array.from(this.jobs.values())
      .filter(r => r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled')
      .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
    const excess = settled.length - JobManager.MAX_RETAINED_JOBS;
    for (let i = 0; i < excess; i++) this.jobs.delete(settled[i].id);
  }

  private toJobInfo(record: JobRecord): JobInfo {
    return {
      id: record.id,
      type: record.type,
      status: record.status as JobStatus,
      progress: record.progress,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      error: record.error,
    };
  }
}
