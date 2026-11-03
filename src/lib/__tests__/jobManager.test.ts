import { describe, it, expect, vi, afterEach } from 'vitest';
import { JobManager } from '../jobQueue/jobManager';
import { SharedResultStore, invalidateLibraryFileLists } from '../jobQueue/sharedResultStore';
import type { JobContext, JobDefinition, JobType } from '../jobQueue/types';

function def(type: JobType, run: (ctx: JobContext) => Promise<unknown>, timeoutMs?: number): JobDefinition {
  return { type, dependencies: [], run, timeoutMs };
}

/** A job that never checks its signal and never finishes on its own. */
const stuck = (onCtx?: (ctx: JobContext) => void) => (ctx: JobContext) => {
  onCtx?.(ctx);
  return new Promise<never>(() => {});
};

afterEach(() => { vi.useRealTimers(); });

describe('JobManager', () => {
  it('settles a running job on cancel even when the job ignores its signal', async () => {
    const jm = new JobManager(1);
    jm.register(def('library-health', stuck()));
    const { jobId, promise } = jm.enqueue('library-health', {}, 'root');
    expect(jm.getJob(jobId)?.status).toBe('running');

    expect(jm.cancel(jobId)).toBe(true);
    await expect(promise).rejects.toThrow(/cancelled/i);
    expect(jm.getJob(jobId)?.status).toBe('cancelled');
  });

  it('frees the single slot after a cancel so the next job runs', async () => {
    const jm = new JobManager(1);
    jm.register(def('library-health', stuck()));
    jm.register(def('album-art-scan', async () => 'next-ran'));
    const first = jm.enqueue('library-health', {}, 'root');
    const second = jm.enqueue('album-art-scan', {}, 'root');
    expect(jm.getJob(second.jobId)?.status).toBe('queued');
    jm.cancel(first.jobId);
    await first.promise.catch(() => {});
    await expect(second.promise).resolves.toBe('next-ran');
  });

  it('fails (not "cancelled") and frees the slot when the timeout fires on a stuck job', async () => {
    vi.useFakeTimers();
    const jm = new JobManager(1);
    jm.register(def('library-check', stuck(), 1000));
    const { jobId, promise } = jm.enqueue('library-check', {}, 'root');
    const settled = promise.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(1001);
    const err = await settled;
    expect(String(err)).toMatch(/timed out/i);
    expect(jm.getJob(jobId)?.status).toBe('failed');
  });

  it('drops progress and log events from a job after it has settled', async () => {
    const jm = new JobManager(1);
    let captured: JobContext | null = null;
    jm.register(def('catalog-export', stuck((ctx) => { captured = ctx; })));
    const events: string[] = [];
    jm.on('job-progress', () => events.push('progress'));
    jm.on('job-log', () => events.push('log'));
    const { jobId, promise } = jm.enqueue('catalog-export', {}, 'root');
    await Promise.resolve(); // let run() start
    await Promise.resolve();
    captured!.progress({ phase: 'x', current: 1, total: 2, message: 'live' });
    expect(events).toEqual(['progress']);
    jm.cancel(jobId);
    await promise.catch(() => {});
    captured!.progress({ phase: 'x', current: 2, total: 2, message: 'late' });
    captured!.log('late log');
    expect(events).toEqual(['progress']);
  });

  it('passes the abort signal to the job and resolves its result without retaining it', async () => {
    const jm = new JobManager(1);
    let sawSignal = false;
    jm.register(def('usb-health-scan', async (ctx) => { sawSignal = ctx.signal instanceof AbortSignal; return { big: true }; }));
    const { jobId, promise } = jm.enqueue('usb-health-scan', {}, 'root');
    await expect(promise).resolves.toEqual({ big: true });
    expect(sawSignal).toBe(true);
    expect(jm.getJob(jobId)?.status).toBe('completed');
  });
});

describe('SharedResultStore invalidation', () => {
  it('drops cached file lists once a lib file operation bumps the generation', () => {
    const store = new SharedResultStore();
    store.set('library-file-list', 'root', { libraryRoot: 'root', files: ['/a.aif'], discoveredAt: 1 });
    expect(store.get('library-file-list', 'root')?.files).toEqual(['/a.aif']);
    invalidateLibraryFileLists();
    expect(store.get('library-file-list', 'root')).toBeNull();
  });
});
