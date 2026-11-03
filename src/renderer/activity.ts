import type { JobInfo, JobType } from '../types';

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

// ========== Init ==========

export function initActivity(): void {
  trayEl = document.getElementById('activity-tray') as HTMLElement;
  jobsContainerEl = document.getElementById('activity-jobs') as HTMLElement;

  window.candybar.onJobUpdate?.((job: JobInfo) => {
    visibleJobs.set(job.id, job);
    renderJobs();

    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      // A repeated final update restarts the countdown instead of stacking timers.
      clearTimeout(removalTimers.get(job.id));
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
