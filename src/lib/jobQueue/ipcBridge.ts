import { BrowserWindow } from 'electron';
import { createScopedLogger } from '../logger';
import { JobManager } from './jobManager';
import { JobInfo, JobProgress } from './types';
import { libraryScanJob } from './jobs/libraryScan';
import { libraryCheckJob } from './jobs/libraryCheck';
import { libraryHealthJob } from './jobs/libraryHealth';
import { albumArtScanJob } from './jobs/albumArtScan';
import { catalogExportJob } from './jobs/catalogExport';
import { usbHealthScanJob } from './jobs/usbHealthScan';
import { claudeJobs, type ClaudeJobDeps } from './jobs/claude';

const log = createScopedLogger('JobBridge');

let manager: JobManager | null = null;

export function initJobQueue(claudeDeps?: ClaudeJobDeps): void {
  manager = new JobManager(1);

  manager.register(libraryScanJob);
  manager.register(libraryCheckJob);
  manager.register(libraryHealthJob);
  manager.register(albumArtScanJob);
  manager.register(catalogExportJob);
  manager.register(usbHealthScanJob);
  // Each Claude job has its own lane, so a long SoundCloud run doesn't hold up
  // a tag lookup, and none of them hold up a library scan.
  if (claudeDeps) for (const def of claudeJobs(claudeDeps)) manager.register(def);

  // Forward job events to all renderer windows
  const broadcast = (channel: string, payload: unknown) => {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    });
  };

  manager.on('job-queued', (info: JobInfo) => broadcast('job-update', info));
  manager.on('job-started', (info: JobInfo) => broadcast('job-update', info));
  manager.on('job-completed', (info: JobInfo) => broadcast('job-update', info));
  manager.on('job-failed', (info: JobInfo) => broadcast('job-update', info));
  manager.on('job-cancelled', (info: JobInfo) => broadcast('job-update', info));
  manager.on('job-progress', (progress: JobProgress) => broadcast('job-progress', progress));
  manager.on('job-log', (entry: { jobId: string; text: string; stream: string }) => broadcast('job-log', entry));

  // Listing and cancelling jobs are the `job-list` / `job-cancel` handlers in main.ts.

  log.info('Job queue initialized');
}

export function getJobManager(): JobManager {
  if (!manager) throw new Error('Job queue not initialized. Call initJobQueue() first.');
  return manager;
}

