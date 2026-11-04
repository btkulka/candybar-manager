import type { JobInfo, JobType } from '../types';

// Job type → display label
// Job type → what's happening, in words (the tray shows it while it runs)
const JOB_LABELS: Record<JobType, string> = {
  'library-scan': 'Reading your library',
  'library-check': 'Checking what you own',
  'library-health': 'Checking your library',
  'album-art-scan': 'Looking for cover art',
  'catalog-export': 'Exporting your track list',
  'organize-tracks': 'Sorting new music',
  'usb-health-scan': 'Checking a USB stick',
  'claude-ask': 'Claude is answering',
  'claude-sourcing-review': 'Claude is reviewing matches',
  'claude-track-tags': 'Claude is looking up tags',
  'claude-soundcloud': 'Getting SoundCloud downloads',
  'claude-store-finder': 'Claude is finding store matches'
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
  let running = false;
  for (const job of visibleJobs.values()) {
    const div = document.createElement('div');
    div.className = `activity-job activity-job--${job.status}`;
    div.textContent = jobText(job);
    jobsContainerEl.appendChild(div);
    if (job.status === 'running' || job.status === 'queued') running = true;
  }
  if (trayEl) {
    trayEl.hidden = visibleJobs.size === 0;
    // The record only spins while something is actually working.
    trayEl.classList.toggle('is-busy', running);
  }
}

/** "Checking your library" while it runs; once it ends, say how it ended. */
function jobText(job: JobInfo): string {
  const label = JOB_LABELS[job.type] ?? job.type;
  if (job.status === 'completed') return `${label} — done`;
  if (job.status === 'failed') return `${label} — didn't finish`;
  if (job.status === 'cancelled') return `${label} — stopped`;
  return label;
}
