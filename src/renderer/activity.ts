import type { JobInfo, JobProgress, JobType } from '../types';
import { icons, setActiveTab } from './shared';
import { playFile } from './player';

// Job type → display label
const JOB_LABELS: Record<JobType, string> = {
  'library-scan': 'Scanning Library',
  'library-check': 'Missing Track Check',
  'library-health': 'Library Health',
  'album-art-scan': 'Album Art Scan',
  'catalog-export': 'Catalog Export',
  'organize-tracks': 'Organize',
  'usb-health-scan': 'USB Health Scan'
};

// Job type → page to navigate to (null = no navigation)
const JOB_PAGE_MAP: Record<JobType, string | null> = {
  'library-scan': null,
  'library-check': 'check',
  'library-health': 'library',
  'album-art-scan': 'polish',
  'catalog-export': null,
  'organize-tracks': 'organize',
  'usb-health-scan': 'usb-health'
};

// Track visible jobs and their removal timers
const visibleJobs = new Map<string, JobInfo>();
const removalTimers = new Map<string, ReturnType<typeof setTimeout>>();

let trayEl: HTMLElement;
let jobsContainerEl: HTMLElement;
// ========== Conversion Tasks ==========

type ConversionStatus = 'pending' | 'completed' | 'failed';

interface ConversionTask {
  id: string;
  fileName: string;
  type: 'aiff' | 'mp3';
  status: ConversionStatus;
  outputPath?: string;
}

const conversionTasks = new Map<string, ConversionTask>();
let conversionIdCounter = 0;

export function addConversionTask(fileName: string, type: 'aiff' | 'mp3'): string {
  const id = `conv-${++conversionIdCounter}`;
  conversionTasks.set(id, { id, fileName, type, status: 'pending' });
  return id;
}

export function updateConversionTask(id: string, status: 'completed' | 'failed', outputPath?: string): void {
  const task = conversionTasks.get(id);
  if (!task) return;
  task.status = status;
  if (outputPath) task.outputPath = outputPath;
}

// ========== Download Tasks ==========

export function addDownloadTask(count: number): void {
  // Registered; no-op for now (UI updated via progress listeners)
  void count;
}

export function updateDownloadProgress(payload: { current: number; total: number; message: string }): void {
  void payload;
}

export function completeDownloadTask(downloaded: number, failed: number): void {
  void downloaded;
  void failed;
}

// ========== Init ==========

export function initActivity(): void {
  trayEl = document.getElementById('activity-tray') as HTMLElement;
  jobsContainerEl = document.getElementById('activity-jobs') as HTMLElement;

  window.candybar.onJobUpdate?.((job: JobInfo) => {
    visibleJobs.set(job.id, job);
    renderJobs();

    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      const timer = setTimeout(() => {
        visibleJobs.delete(job.id);
        removalTimers.delete(job.id);
        renderJobs();
      }, 5000);
      removalTimers.set(job.id, timer);
    }
  });
}

function renderJobs(): void {
  if (!jobsContainerEl) return;
  jobsContainerEl.innerHTML = '';
  for (const job of visibleJobs.values()) {
    const div = document.createElement('div');
    div.className = `activity-job activity-job--${job.status}`;
    div.textContent = JOB_LABELS[job.type] ?? job.type;
    jobsContainerEl.appendChild(div);
  }
  if (trayEl) trayEl.hidden = visibleJobs.size === 0;
}
