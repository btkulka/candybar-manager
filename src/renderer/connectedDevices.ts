import type { VolumeInfo, UsbHealthResult, LibraryHealthTrack, ContextMenuItem } from './shared';
import { showToast, escapeHtml, getErrorMessage, icons, showContextMenu, openTagEditor } from './shared';
import { confirmAction, confirmMoveToTrash } from './confirmDialog';
import type { JobProgress } from '../types';
import {
  type PioneerDevice, PIONEER_DEVICES,
  containerLabel, countFormats, categoryLabel, deviceReadsFS,
} from './pioneerDevices';
import {
  type SortKey,
  issueDescriptions,
  getFilteredTracks, sortTracks, createTrackRow, updateScanProgress
} from './healthTrackTable';

// ========== Types ==========

type VolumeEntry = {
  volume: VolumeInfo;
  result: UsbHealthResult | null;
  scanning: boolean;
  error: string | null;
};

type ChecklistItem = {
  label: string;
  passed: boolean;
  severity: 'ok' | 'warning' | 'error';
  detail: string;
};

// ========== State ==========

const knownVolumes = new Map<string, VolumeEntry>();
let pollIntervalId: ReturnType<typeof setInterval> | null = null;
let scanQueue: string[] = [];
let scanningActive = false;

/** Per-volume set of checked track file paths for multi-select */
const checkedByVolume = new Map<string, Set<string>>();

function getCheckedSet(volumePath: string): Set<string> {
  let s = checkedByVolume.get(volumePath);
  if (!s) { s = new Set(); checkedByVolume.set(volumePath, s); }
  return s;
}

// ========== DOM ==========

const section = document.getElementById('connected-devices-section') as HTMLElement;
const volumeListEl = document.getElementById('cd-volume-list') as HTMLDivElement;
const statusEl = document.getElementById('cd-status') as HTMLSpanElement;
const refreshBtn = document.getElementById('cd-refresh') as HTMLButtonElement;

// Path of the volume currently being USB-scanned (for attributing job-progress events)
let activeScanPath: string | null = null;
// job-progress carries no context key, and the USB page runs the same job type.
// Latch the job id from the first event whose file sits under this drive.
let activeScanJobId: string | null = null;
let jobProgressListenerRegistered = false;

function isUnderPath(file: unknown, root: string): boolean {
  if (typeof file !== 'string') return false;
  const base = root.replace(/\/+$/, '');
  return file === base || file.startsWith(`${base}/`);
}

function handleJobProgress(progress: JobProgress) {
  if (progress.jobType !== 'usb-health-scan' || !activeScanPath) return;
  if (activeScanJobId === null) {
    if (!isUnderPath(progress.detail, activeScanPath)) return;
    activeScanJobId = progress.jobId;
  } else if (progress.jobId !== activeScanJobId) {
    return;
  }
  const card = volumeListEl.querySelector(`[data-volume-path="${CSS.escape(activeScanPath)}"]`);
  const summaryEl = card?.querySelector('.cd-volume-summary');
  if (!summaryEl) return;
  const total = progress.total ?? 0;
  const current = progress.current ?? 0;
  const detail = typeof progress.detail === 'string' ? progress.detail.split('/').pop() : '';
  summaryEl.textContent = detail
    ? `Checking ${current.toLocaleString()} of ${total.toLocaleString()}: ${detail}`
    : `Checking ${current.toLocaleString()} of ${total.toLocaleString()}\u2026`;
}

// ========== Helpers ==========

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

/** The drive's state as a word: status pill class + label. */
function drivePill(state: 'unchecked' | 'checking' | 'ok' | 'warning' | 'error' | 'failed' | 'library'): string {
  const map = {
    unchecked: ['status-pill--info', 'Not checked yet'],
    checking: ['status-pill--info', 'Checking\u2026'],
    ok: ['status-pill--ok', 'Ready to play'],
    warning: ['status-pill--warn', 'Needs a fix'],
    error: ['status-pill--danger', 'Won\u2019t play everywhere'],
    failed: ['status-pill--danger', 'Couldn\u2019t check'],
    library: ['status-pill--accent', 'Your library'],
  } as const;
  const [cls, label] = map[state];
  return `<span class="status-pill ${cls} cd-pill">${label}</span>`;
}

function overallSeverity(entry: VolumeEntry): 'ok' | 'warning' | 'error' {
  if (!entry.result) return 'ok';
  const { summary, volumeIssues, volume } = entry.result;
  if (!volume.isCompatible || summary.errors > 0 || volumeIssues.some(i => i.severity === 'error'))
    return 'error';
  if (summary.warnings > 0 || volumeIssues.some(i => i.severity === 'warning'))
    return 'warning';
  return 'ok';
}

/** Format container badge color class */
function containerColorClass(container: string): string {
  if (container === 'FLAC' || container === 'OGG') return 'cd-fmt-warn';
  return 'cd-fmt-ok';
}

/** Compute total duration */
function totalDuration(tracks: LibraryHealthTrack[]): number {
  let sum = 0;
  for (const t of tracks) {
    if (t.format.duration && t.format.duration > 0) sum += t.format.duration;
  }
  return sum;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ========== Health Checklist ==========

function computeChecklist(result: UsbHealthResult): ChecklistItem[] {
  const { volume, summary, tracks, volumeIssues } = result;
  const items: ChecklistItem[] = [];
  const total = summary.total;

  // 1. File system
  items.push({
    label: 'Drive format',
    passed: volume.isCompatible,
    severity: volume.isCompatible ? 'ok' : 'error',
    detail: volume.isCompatible
      ? 'FAT32, which every Pioneer player reads'
      : `${volume.fileSystem || 'Unknown'}, which most Pioneer players can\u2019t read. Reformat it as FAT32 (this erases it).`,
  });

  // 2. Audio formats
  const formatCounts = countFormats(tracks);
  const incompatibleFormats = Object.keys(formatCounts).filter(f => f === 'FLAC' || f === 'OGG');
  const incompatibleCount = incompatibleFormats.reduce((s, f) => s + (formatCounts[f] || 0), 0);
  items.push({
    label: 'File types',
    passed: incompatibleCount === 0,
    severity: incompatibleCount === 0 ? 'ok' : 'warning',
    detail: incompatibleCount === 0
      ? 'Every track is a file type CDJs play (WAV, AIFF, MP3 or AAC)'
      : `${incompatibleCount.toLocaleString()} track${incompatibleCount > 1 ? 's are' : ' is'} a file type most CDJs can\u2019t play (${incompatibleFormats.map(containerLabel).join(', ')})`,
  });

  // 3. Sample rates
  const validRates = new Set([32000, 44100, 48000]);
  const badRateTracks = tracks.filter(t => t.format.sampleRate != null && !validRates.has(t.format.sampleRate));
  items.push({
    label: 'Sample rates',
    passed: badRateTracks.length === 0,
    severity: badRateTracks.length === 0 ? 'ok' : 'warning',
    detail: badRateTracks.length === 0
      ? 'Every track is saved at a rate CDJs play (32, 44.1 or 48 kHz)'
      : `${badRateTracks.length.toLocaleString()} track${badRateTracks.length > 1 ? 's are' : ' is'} saved at an unusual sample rate CDJs won\u2019t play`,
  });

  // 4. No errors (corrupt/unreadable)
  items.push({
    label: 'Will it play',
    passed: summary.errors === 0,
    severity: summary.errors === 0 ? 'ok' : 'error',
    detail: summary.errors === 0
      ? 'Nothing that would stop a track loading'
      : `${summary.errors.toLocaleString()} track${summary.errors > 1 ? 's' : ''} may not play on CDJs`,
  });

  // 5. Free space
  const lowSpace = volume.totalBytes > 0 && (volume.freeBytes / volume.totalBytes) < 0.05;
  items.push({
    label: 'Free space',
    passed: !lowSpace,
    severity: lowSpace ? 'warning' : 'ok',
    detail: lowSpace
      ? `Only ${formatBytes(volume.freeBytes)} free (${Math.round((volume.freeBytes / volume.totalBytes) * 100)}%)`
      : `${formatBytes(volume.freeBytes)} free`,
  });

  // 6. Metadata completeness
  const missingMeta = tracks.filter(t => !t.artist || !t.title || t.artist === 'Unknown Artist');
  items.push({
    label: 'Track info',
    passed: missingMeta.length === 0,
    severity: missingMeta.length === 0 ? 'ok' : 'warning',
    detail: missingMeta.length === 0
      ? 'Every track has an artist and title'
      : `${missingMeta.length.toLocaleString()} track${missingMeta.length > 1 ? 's are' : ' is'} missing an artist or title`,
  });

  return items;
}

// ========== Controller Compatibility ==========

type ControllerCompat = {
  controller: PioneerDevice;
  fsCompatible: boolean;
  formatIssues: string[]; // list of incompatible format names found on the drive
  compatible: boolean;
};

function computeControllerCompat(result: UsbHealthResult): ControllerCompat[] {
  const formatCounts = countFormats(result.tracks);
  const driveFormats = new Set(Object.keys(formatCounts));

  return PIONEER_DEVICES.map(ctrl => {
    const fsCompatible = deviceReadsFS(ctrl, result.volume.fileSystem || '');
    const formatIssues: string[] = [];
    for (const fmt of driveFormats) {
      if (fmt !== 'UNKNOWN' && !ctrl.supportedFormats.has(fmt)) {
        formatIssues.push(containerLabel(fmt));
      }
    }
    return {
      controller: ctrl,
      fsCompatible,
      formatIssues,
      compatible: fsCompatible && formatIssues.length === 0,
    };
  });
}

// ========== SVG Icons ==========

const USB_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><circle cx="12" cy="14" r="3"/><line x1="12" y1="17" x2="12" y2="19"/></svg>`;

const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

const X_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

const CHEVRON_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>`;

const WARN_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

// ========== Rendering ==========

function renderVolumeCard(path: string): HTMLDivElement {
  const entry = knownVolumes.get(path);
  if (!entry) return document.createElement('div');

  const card = document.createElement('div');
  card.className = 'cd-volume';
  card.dataset.volumePath = path;

  const vol = entry.volume;
  // The drive's format only shows when it's a problem; the details list it either way.
  const fsBadge = vol.isCompatible
    ? ''
    : `<span class="status-pill status-pill--warn cd-fs-pill" data-tooltip="${escapeHtml(`This drive is formatted as ${vol.fileSystem || 'an unknown format'}. Some Pioneer players only read FAT32.`)}">Some CDJs can\u2019t read it</span>`;
  const hideBtn = vol.isLibrary
    ? ''
    : `<button class="btn-ghost btn-sm cd-hide" data-tooltip="Stop showing this drive here. Nothing on it is changed.">Hide</button>`;
  const rescanBtn = vol.isLibrary
    ? ''
    : `<button class="btn-secondary btn-sm cd-rescan" data-tooltip="Read every track on this drive to see if it plays on CDJs. Nothing on it is changed.">Check this drive</button>`;
  const collapseIcon = vol.isLibrary
    ? ''
    : `<button type="button" class="btn-icon cd-collapse-icon" aria-expanded="false" aria-label="Show details for ${escapeHtml(vol.name)}" data-tooltip="Show details">${CHEVRON_ICON}</button>`;

  card.innerHTML = `
    <div class="cd-volume-header">
      <div class="cd-volume-info">
        <span class="cd-usb-icon">${USB_ICON}</span>
        <div class="cd-volume-text">
          <span class="cd-volume-name">${escapeHtml(vol.name)}</span>
          <span class="cd-volume-summary"></span>
        </div>
        <span class="cd-pill-slot">${drivePill(vol.isLibrary ? 'library' : 'unchecked')}</span>
        ${fsBadge}
      </div>
      <div class="cd-volume-actions">
        ${hideBtn}
        ${rescanBtn}
        ${collapseIcon}
      </div>
    </div>
    <div class="cd-volume-body" style="display:none;">
      <div class="cd-volume-issues"></div>
      <div class="cd-scan-placeholder">
        <div class="cd-scan-shimmer"></div>
        <span class="cd-scan-placeholder-text">Not checked yet. Click Check this drive to read its tracks. Nothing on it is changed.</span>
      </div>
      <div class="cd-results-wrap" style="display:none;">
        <div class="cd-storage-bar-wrap"></div>
        <div class="cd-kpi-grid"></div>
        <div class="cd-section-label">What Track Lab checked</div>
        <div class="cd-checklist"></div>
        <div class="cd-format-breakdown"></div>
        <div class="cd-section-label">Which players can read it</div>
        <div class="cd-controller-grid"></div>
        <div class="cd-track-issues-header" style="display:none;"></div>
        <div class="cd-track-table-wrap">
          <table class="data-table cd-data-table">
            <thead>
              <tr>
                <th class="col-checkbox"><input type="checkbox" class="header-checkbox" aria-label="Select every track" title="Select every track. Right-click a selected track for actions on all of them."></th>
                <th class="col-status">Status</th>
                <th class="col-artist">Artist</th>
                <th class="col-title">Title</th>
                <th class="col-format">File type</th>
                <th class="col-bitrate">Quality</th>
                <th class="col-issues">Problems</th>
                <th class="col-row-actions"><span class="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  // Collapse/expand — disabled for the library volume (no scan body to show)
  if (!vol.isLibrary) {
    const header = card.querySelector('.cd-volume-header') as HTMLElement;
    const body = card.querySelector('.cd-volume-body') as HTMLElement;
    const collapseIconEl = card.querySelector('.cd-collapse-icon') as HTMLButtonElement;
    // The whole header toggles for the mouse; the arrow is the keyboard control.
    header.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.cd-rescan')) return;
      if ((e.target as HTMLElement).closest('.cd-hide')) return;
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? 'block' : 'none';
      collapseIconEl.setAttribute('aria-expanded', String(collapsed));
      collapseIconEl.setAttribute('aria-label', `${collapsed ? 'Hide' : 'Show'} details for ${vol.name}`);
      card.classList.toggle('cd-volume-expanded', collapsed);
    });
  } else {
    // Library card is status-only — hide the expand body entirely
    const body = card.querySelector('.cd-volume-body') as HTMLElement;
    if (body) body.style.display = 'none';
    const summaryEl = card.querySelector('.cd-volume-summary') as HTMLElement;
    if (summaryEl) summaryEl.textContent = 'Your library is on this drive. It\u2019s checked above.';
  }

  // Re-scan button
  card.querySelector('.cd-rescan')?.addEventListener('click', () => {
    const existing = knownVolumes.get(path);
    if (existing && !existing.scanning) {
      existing.result = null;
      existing.error = null;
      enqueueScan(path);
    }
  });

  // Hide button — excludes this volume name from the Devices panel
  card.querySelector('.cd-hide')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const res = await window.candybar.excludeVolume(vol.name);
    if (res.success) {
      knownVolumes.delete(path);
      card.remove();
      if (knownVolumes.size === 0) section.style.display = 'none';
    } else {
      showToast('error', 'Couldn\u2019t hide that drive', 'Try again in a moment.');
    }
  });

  return card;
}

function updateVolumeCardState(path: string) {
  const entry = knownVolumes.get(path);
  const card = volumeListEl.querySelector(`[data-volume-path="${CSS.escape(path)}"]`) as HTMLElement | null;
  if (!entry || !card) return;

  const summaryEl = card.querySelector('.cd-volume-summary') as HTMLElement;
  const pillSlot = card.querySelector('.cd-pill-slot') as HTMLElement;
  const rescanEl = card.querySelector('.cd-rescan') as HTMLButtonElement | null;
  const issuesEl = card.querySelector('.cd-volume-issues') as HTMLElement;
  const kpiEl = card.querySelector('.cd-kpi-grid') as HTMLElement;
  const storageEl = card.querySelector('.cd-storage-bar-wrap') as HTMLElement;
  const checklistEl = card.querySelector('.cd-checklist') as HTMLElement;
  const formatEl = card.querySelector('.cd-format-breakdown') as HTMLElement;
  const controllerEl = card.querySelector('.cd-controller-grid') as HTMLElement;
  const tbody = card.querySelector('tbody') as HTMLTableSectionElement;
  const tableWrap = card.querySelector('.cd-track-table-wrap') as HTMLElement;
  const trackIssuesHeader = card.querySelector('.cd-track-issues-header') as HTMLElement;
  const resultsWrap = card.querySelector('.cd-results-wrap') as HTMLElement;
  const placeholder = card.querySelector('.cd-scan-placeholder') as HTMLElement;

  if (rescanEl) {
    rescanEl.disabled = entry.scanning;
    rescanEl.textContent = entry.scanning ? 'Checking\u2026' : entry.result ? 'Check again' : 'Check this drive';
  }

  if (entry.scanning) {
    summaryEl.textContent = 'Reading its tracks\u2026';
    summaryEl.className = 'cd-volume-summary cd-scanning';
    if (pillSlot) pillSlot.innerHTML = drivePill('checking');
    placeholder.style.display = 'flex';
    resultsWrap.style.display = 'none';
    return;
  }

  if (entry.error) {
    summaryEl.textContent = `Couldn\u2019t check this drive: ${entry.error}`;
    summaryEl.className = 'cd-volume-summary cd-error';
    if (pillSlot) pillSlot.innerHTML = drivePill('failed');
    placeholder.style.display = 'none';
    resultsWrap.style.display = 'none';
    return;
  }

  if (!entry.result) {
    const v = entry.volume;
    summaryEl.textContent = v.totalBytes > 0 ? `${formatBytes(v.freeBytes)} free of ${formatBytes(v.totalBytes)}` : '';
    summaryEl.className = 'cd-volume-summary';
    placeholder.style.display = 'flex';
    resultsWrap.style.display = 'none';
    return;
  }

  placeholder.style.display = 'none';
  resultsWrap.style.display = 'block';

  const { summary, volumeIssues, volume, tracks } = entry.result;
  const sev = overallSeverity(entry);

  if (pillSlot) pillSlot.innerHTML = drivePill(sev);

  // Summary sentence
  const t = (n: number) => `${n.toLocaleString()} track${n === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (summary.errors > 0) parts.push(`${summary.errors.toLocaleString()} may not play`);
  if (summary.warnings > 0) parts.push(`${summary.warnings.toLocaleString()} could use a fix`);
  summaryEl.textContent = summary.total === 0
    ? 'No music on this drive'
    : parts.length === 0
      ? `${t(summary.total)}, all ready to play`
      : `${t(summary.total)}: ${parts.join(', ')}`;
  summaryEl.className = `cd-volume-summary cd-${sev}`;

  // Volume-level issues
  if (volumeIssues.length > 0) {
    issuesEl.innerHTML = volumeIssues.map(issue => `
      <div class="cd-issue ${issue.severity}">
        ${escapeHtml(issue.message)}
      </div>
    `).join('');
  } else {
    issuesEl.innerHTML = '';
  }

  // Storage bar
  const usedBytes = volume.totalBytes - volume.freeBytes;
  const usedPct = volume.totalBytes > 0 ? Math.round((usedBytes / volume.totalBytes) * 100) : 0;
  const storageClass = usedPct > 95 ? 'cd-storage-danger' : usedPct > 80 ? 'cd-storage-warn' : '';
  storageEl.innerHTML = `
    <div class="cd-storage-bar ${storageClass}">
      <div class="cd-storage-fill" style="width: ${usedPct}%"></div>
    </div>
    <div class="cd-storage-labels">
      <span>${formatBytes(usedBytes)} used</span>
      <span>${formatBytes(volume.freeBytes)} free of ${formatBytes(volume.totalBytes)}</span>
    </div>
  `;

  // KPI grid
  const total = summary.total;
  const healthyPct = total > 0 ? Math.round((summary.healthy / total) * 100) : 0;
  const dur = totalDuration(tracks);

  kpiEl.innerHTML = `
    <div class="cd-kpi-card">
      <div class="cd-kpi-value">${summary.total.toLocaleString()}</div>
      <div class="cd-kpi-label">Tracks</div>
    </div>
    <div class="cd-kpi-card cd-kpi-accent">
      <div class="cd-kpi-value">${healthyPct}<span class="cd-kpi-unit">%</span></div>
      <div class="cd-kpi-label">Ready to play</div>
      <div class="cd-kpi-bar"><div class="cd-kpi-bar-fill" style="width:${healthyPct}%"></div></div>
    </div>
    <div class="cd-kpi-card ${summary.errors > 0 ? 'cd-kpi-danger' : ''}">
      <div class="cd-kpi-value">${summary.errors.toLocaleString()}</div>
      <div class="cd-kpi-label">Won\u2019t play on CDJs</div>
    </div>
    <div class="cd-kpi-card ${summary.warnings > 0 ? 'cd-kpi-warning' : ''}">
      <div class="cd-kpi-value">${summary.warnings.toLocaleString()}</div>
      <div class="cd-kpi-label">Need a fix</div>
    </div>
    <div class="cd-kpi-card">
      <div class="cd-kpi-value">${dur > 0 ? formatDuration(dur) : '\u2014'}</div>
      <div class="cd-kpi-label">Total length</div>
    </div>
  `;

  // Format breakdown
  const formatCounts = countFormats(tracks);
  const sortedFormats = Object.entries(formatCounts).sort((a, b) => b[1] - a[1]);
  if (sortedFormats.length > 0) {
    const maxCount = sortedFormats[0][1];
    formatEl.innerHTML = `
      <div class="cd-section-label">File types on this drive</div>
      <div class="cd-format-bars">
        ${sortedFormats.map(([fmt, count]) => {
          const pct = total > 0 ? Math.round((count / total) * 100) : 0;
          const barW = maxCount > 0 ? Math.round((count / maxCount) * 100) : 0;
          const colorClass = containerColorClass(fmt);
          return `
            <div class="cd-format-row">
              <span class="cd-format-name ${colorClass}">${escapeHtml(containerLabel(fmt))}</span>
              <div class="cd-format-bar-track">
                <div class="cd-format-bar-fill ${colorClass}" style="width:${barW}%"></div>
              </div>
              <span class="cd-format-count">${count} <span class="cd-format-pct">(${pct}%)</span></span>
            </div>`;
        }).join('')}
      </div>
    `;
  } else {
    formatEl.innerHTML = '';
  }

  // Health checklist
  const checklist = computeChecklist(entry.result);
  checklistEl.innerHTML = checklist.map(item => {
    const icon = item.passed ? (item.severity === 'ok' ? CHECK_ICON : WARN_ICON) : X_ICON;
    const cls = item.passed ? (item.severity === 'ok' ? 'cd-check-pass' : 'cd-check-warn') : 'cd-check-fail';
    return `
      <div class="cd-check-item ${cls}">
        <span class="cd-check-icon">${icon}</span>
        <span class="cd-check-label">${escapeHtml(item.label)}</span>
        <span class="cd-check-detail">${escapeHtml(item.detail)}</span>
      </div>`;
  }).join('');

  // Controller compatibility grid
  const compats = computeControllerCompat(entry.result);
  const compatCount = compats.filter(c => c.compatible).length;
  controllerEl.innerHTML = `
    <div class="cd-compat-summary">
      Plays on <strong>${compatCount}</strong> of <strong>${compats.length}</strong> Pioneer players
    </div>
    <div class="cd-compat-cards">
      ${compats.map(c => {
        const cls = c.compatible ? 'cd-compat-yes' : 'cd-compat-no';
        const badge = c.compatible
          ? `<span class="cd-compat-badge cd-compat-badge-yes">${CHECK_ICON} Plays</span>`
          : `<span class="cd-compat-badge cd-compat-badge-no">${X_ICON} ${!c.fsCompatible ? 'Can\u2019t read the drive' : `Can\u2019t play ${escapeHtml(c.formatIssues.join(', '))}`}</span>`;
        const image = c.controller.imageUrl
          ? `<img src="${escapeHtml(c.controller.imageUrl)}" alt="${escapeHtml(c.controller.name)}" class="cd-compat-img" loading="lazy" />`
          : '';
        return `
          <div class="cd-compat-card ${cls}">
            <div class="cd-compat-img-wrap">
              ${image}
              <div class="cd-compat-img-fallback" style="display:${image ? 'none' : 'flex'}">${escapeHtml(c.controller.name)}</div>
            </div>
            <div class="cd-compat-info">
              <div class="cd-compat-name">${escapeHtml(c.controller.name)}</div>
              <div class="cd-compat-cat">${categoryLabel(c.controller.category)}</div>
              ${badge}
            </div>
          </div>`;
      }).join('')}
    </div>
  `;
  // Listeners, not inline onerror: the page CSP (script-src 'self') blocks inline handlers.
  controllerEl.querySelectorAll<HTMLImageElement>('img.cd-compat-img').forEach((img) => {
    img.addEventListener('error', () => {
      img.style.display = 'none';
      const fallback = img.nextElementSibling as HTMLElement | null;
      if (fallback) fallback.style.display = 'flex';
    }, { once: true });
  });

  // Track table (only tracks with issues)
  const issuesTracks = entry.result.tracks.filter(t => !t.isHealthy);
  const checked = getCheckedSet(path);

  // Prune checked set: remove paths no longer in the issue list
  const issuePathSet = new Set(issuesTracks.map(t => t.filePath));
  for (const fp of checked) {
    if (!issuePathSet.has(fp)) checked.delete(fp);
  }

  if (issuesTracks.length > 0) {
    trackIssuesHeader.style.display = 'block';
    trackIssuesHeader.innerHTML = `<div class="cd-section-label">Tracks with problems <span class="cd-count-badge">${issuesTracks.length.toLocaleString()}</span></div>`;
    const sorted = sortTracks(issuesTracks, 'status', 'desc');
    tbody.innerHTML = '';
    const frag = document.createDocumentFragment();
    sorted.forEach(track => {
      frag.appendChild(createTrackRow(track, {
        compact: true,
        isSelected: () => false,
        onSelected: () => {},
        onAction: (action, t) => handleUsbTrackAction(action, t, path),
        isChecked: (fp) => checked.has(fp),
        onCheckToggle: (t, e) => {
          e.stopPropagation();
          if (checked.has(t.filePath)) checked.delete(t.filePath);
          else checked.add(t.filePath);
          // Update header checkbox
          const hdrCb = card.querySelector('.header-checkbox') as HTMLInputElement | null;
          if (hdrCb) hdrCb.checked = checked.size === issuesTracks.length && issuesTracks.length > 0;
        },
        getCheckedTracks: () => issuesTracks.filter(t => checked.has(t.filePath)),
        onContextMenuMulti: (tracks, e) => showMultiContextMenu(tracks, path, e),
      }));
    });
    tbody.appendChild(frag);
    tableWrap.style.display = 'block';

    // Wire header checkbox
    const headerCheckbox = card.querySelector('.header-checkbox') as HTMLInputElement | null;
    if (headerCheckbox) {
      headerCheckbox.checked = checked.size === issuesTracks.length && issuesTracks.length > 0;
      headerCheckbox.onchange = () => {
        if (headerCheckbox.checked) {
          issuesTracks.forEach(t => checked.add(t.filePath));
        } else {
          checked.clear();
        }
        // Re-sync row checkboxes
        tbody.querySelectorAll('.row-checkbox').forEach(cb => {
          const row = cb.closest('tr') as HTMLElement;
          (cb as HTMLInputElement).checked = checked.has(row?.dataset.filePath || '');
        });
      };
    }
  } else {
    trackIssuesHeader.style.display = 'none';
    tbody.innerHTML = '';
    tableWrap.style.display = 'none';
    checked.clear();
  }
}

// ========== Track removal ==========

function removeTrackFromUsbResult(volumePath: string, track: LibraryHealthTrack) {
  removeTracksFromUsbResult(volumePath, new Set([track.filePath]));
}

function removeTracksFromUsbResult(volumePath: string, filePaths: Set<string>) {
  const entry = knownVolumes.get(volumePath);
  if (!entry?.result || filePaths.size === 0) return;

  entry.result.tracks = entry.result.tracks.filter(t => !filePaths.has(t.filePath));

  // Recalculate summary
  const summary = entry.result.summary;
  summary.total = entry.result.tracks.length;
  summary.healthy = 0;
  summary.warnings = 0;
  summary.errors = 0;
  summary.byIssueCode = {};
  for (const t of entry.result.tracks) {
    const hasError = t.issues.some(i => i.severity === 'error');
    const hasWarning = t.issues.some(i => i.severity === 'warning');
    if (t.issues.length === 0) summary.healthy++;
    else if (hasError) summary.errors++;
    else if (hasWarning) summary.warnings++;
    for (const issue of t.issues) {
      summary.byIssueCode[issue.code] = (summary.byIssueCode[issue.code] || 0) + 1;
    }
  }

  updateVolumeCardState(volumePath);
}

// ========== Multi-select context menu & bulk actions ==========

function showMultiContextMenu(tracks: LibraryHealthTrack[], volumePath: string, e: MouseEvent) {
  const n = tracks.length;
  const convertible = tracks.filter(t => {
    const c = t.format.container?.toUpperCase() || '';
    return c !== 'AIFF' && c !== 'AIFF-C' && t.format.lossless !== false;
  });
  const archivable = tracks; // all tracks can be archived
  const deletable = tracks;  // all tracks can be deleted

  const items: ContextMenuItem[] = [];

  if (convertible.length > 0) {
    items.push({
      label: `Make AIFF copies of ${convertible.length.toLocaleString()}`,
      icon: icons.wrench,
      hint: 'Asks first. Saves CDJ-ready AIFF copies next to the originals, which stay where they are.',
      action: () => bulkConvertToAiff(convertible, volumePath),
    });
  }

  items.push({
    label: `Move ${n.toLocaleString()} to archive folder`,
    icon: icons.archive,
    hint: 'Moves them off this drive into your archive folder. Nothing is deleted.',
    action: () => bulkArchive(archivable, volumePath),
  });

  items.push({
    label: `Move ${n.toLocaleString()} to Trash\u2026`,
    icon: icons.trash,
    danger: true,
    hint: 'Asks first. You can put them back from the Trash.',
    action: () => bulkDelete(deletable, volumePath),
  });

  showContextMenu(e.clientX, e.clientY, items);
}

// Volumes with a bulk action in flight, so a second one can't interleave.
const bulkBusy = new Set<string>();

/** The scan result no longer matches the drive (files were added), so read it again. */
function rescanVolume(volumePath: string) {
  const entry = knownVolumes.get(volumePath);
  if (!entry || entry.scanning) return;
  entry.result = null;
  entry.error = null;
  enqueueScan(volumePath);
}

async function bulkConvertToAiff(tracks: LibraryHealthTrack[], volumePath: string) {
  if (tracks.length === 0 || bulkBusy.has(volumePath)) return;
  const n = tracks.length;
  const confirmed = await confirmAction({
    title: `Make AIFF copies of ${n} track${n > 1 ? 's' : ''} on this drive?`,
    message: 'Each AIFF is written next to its original, so the drive needs room for both.',
    details: [
      { label: 'Writes', value: `${n} new file${n > 1 ? 's' : ''} to this drive` },
      { label: 'Kept', value: 'The originals, untouched' },
    ],
    safetyNote: 'Nothing is deleted. Re-export the playlist from Rekordbox afterwards so the players see the AIFF copies.',
    confirmLabel: `Make ${n} AIFF cop${n > 1 ? 'ies' : 'y'}`,
    tone: 'info',
  });
  if (!confirmed) return;

  bulkBusy.add(volumePath);
  let ok = 0;
  let fail = 0;
  try {
    for (const track of tracks) {
      try {
        const result = await window.candybar.fixTrackFile(track.filePath, false);
        if (result.success) {
          getCheckedSet(volumePath).delete(track.filePath);
          ok++;
        } else { fail++; }
      } catch { fail++; }
    }
  } finally {
    bulkBusy.delete(volumePath);
  }
  if (ok > 0) {
    showToast('success', 'AIFF copies made', `${ok} AIFF cop${ok > 1 ? 'ies' : 'y'} made. Checking the drive again\u2026`);
    rescanVolume(volumePath);
  }
  if (fail > 0) showToast('error', 'Some copies weren\u2019t made', `${fail} track${fail > 1 ? 's' : ''} couldn\u2019t be copied. The originals are unchanged.`);
}

async function bulkArchive(tracks: LibraryHealthTrack[], volumePath: string) {
  if (tracks.length === 0 || bulkBusy.has(volumePath)) return;
  const confirmed = await confirmAction({
    title: `Move ${tracks.length} track${tracks.length > 1 ? 's' : ''} to your archive folder?`,
    message: 'They will be moved off this drive and into your archive folder.',
    safetyNote: 'Nothing is deleted. You can move them back from the archive folder any time.',
    confirmLabel: 'Move to archive folder',
    tone: 'info',
  });
  if (!confirmed) return;

  const { ok, failed, firstError } = await runBulk(tracks, volumePath, async (t) => {
    const result = await window.candybar.archiveTrackFile(t.filePath);
    return { ok: result.success, error: result.errorMessage };
  });
  if (ok > 0) showToast('success', 'Moved to your archive folder', `${ok} track${ok > 1 ? 's' : ''} moved off the drive. Nothing was deleted.`);
  if (failed > 0) showToast('error', 'Some tracks weren\u2019t moved', `${failed} track${failed > 1 ? 's' : ''} stayed on the drive.${firstError ? ` ${firstError}` : ''}`);
}

async function bulkDelete(tracks: LibraryHealthTrack[], volumePath: string) {
  if (tracks.length === 0 || bulkBusy.has(volumePath)) return;
  const confirmed = await confirmMoveToTrash(tracks, {
    message: 'They will be removed from this drive.',
  });
  if (!confirmed) return;

  const { ok, failed, firstError } = await runBulk(tracks, volumePath, async (t) => {
    const result = await window.candybar.deleteTrackFile(t.filePath);
    return { ok: result.success, error: result.error };
  });
  if (ok > 0) showToast('success', 'Moved to Trash', `${ok} track${ok > 1 ? 's are' : ' is'} in the Trash if you need ${ok > 1 ? 'them' : 'it'} back.`);
  if (failed > 0) showToast('error', 'Not moved to Trash', `${failed} track${failed > 1 ? 's' : ''} stayed on the drive.${firstError ? ` ${firstError}` : ''}`);
}

/** Run a file action over the tracks one at a time, then drop the ones that
 *  left the drive from the card in a single re-render. */
async function runBulk(
  tracks: LibraryHealthTrack[],
  volumePath: string,
  action: (t: LibraryHealthTrack) => Promise<{ ok: boolean; error?: string }>,
): Promise<{ ok: number; failed: number; firstError: string | null }> {
  bulkBusy.add(volumePath);
  const gone = new Set<string>();
  let failed = 0;
  let firstError: string | null = null;
  try {
    for (const track of tracks) {
      try {
        const res = await action(track);
        if (res.ok) gone.add(track.filePath);
        else { failed++; firstError ??= res.error ?? null; }
      } catch (err) {
        failed++;
        firstError ??= getErrorMessage(err);
      }
    }
  } finally {
    bulkBusy.delete(volumePath);
  }
  for (const fp of gone) getCheckedSet(volumePath).delete(fp);
  removeTracksFromUsbResult(volumePath, gone);
  return { ok: gone.size, failed, firstError };
}

async function handleUsbTrackAction(
  action: 'fix' | 'reencode' | 'edit' | 'archive' | 'delete',
  track: LibraryHealthTrack,
  volumePath: string
) {
  if (action === 'delete') {
    const confirmed = await confirmMoveToTrash([track], {
      message: 'It will be removed from this drive.',
    });
    if (!confirmed) return;
    try {
      const result = await window.candybar.deleteTrackFile(track.filePath);
      if (result.success) {
        showToast('success', 'Moved to Trash', `${track.fileName} is in the Trash if you need it back.`);
        removeTrackFromUsbResult(volumePath, track);
      } else {
        showToast('error', 'Not moved to Trash', result.error || 'The file is still on the drive.');
      }
    } catch (err) {
      showToast('error', 'Couldn\u2019t move it to the Trash', getErrorMessage(err));
    }
  } else if (action === 'archive') {
    try {
      const result = await window.candybar.archiveTrackFile(track.filePath);
      if (result.success) {
        showToast('success', 'Moved to your archive folder', `${track.fileName} is off the drive. Nothing was deleted.`);
        removeTrackFromUsbResult(volumePath, track);
      } else {
        showToast('error', 'Couldn\u2019t move it to the archive folder', result.errorMessage || 'The file is still on the drive.');
      }
    } catch (err) {
      showToast('error', 'Couldn\u2019t move it to the archive folder', getErrorMessage(err));
    }
  } else if (action === 'fix') {
    try {
      const result = await window.candybar.fixTrackFile(track.filePath, false);
      if (result.success) {
        // The original stays on the drive next to the new AIFF, so re-read it.
        showToast('success', 'AIFF copy made', `${track.fileName} now has an AIFF copy next to it. Checking the drive again…`);
        rescanVolume(volumePath);
      } else {
        showToast('error', 'Couldn\u2019t make the copy', result.errorMessage || 'It stopped without saying why. The original is unchanged.');
      }
    } catch (err) {
      showToast('error', 'Couldn\u2019t make the copy', getErrorMessage(err));
    }
  } else if (action === 'reencode') {
    try {
      const result = await window.candybar.reencodeTrackFile(track.filePath, false);
      if (result.success) {
        showToast('success', '320 kbps copy made', `${track.fileName} now has a 320 kbps copy next to it. Checking the drive again…`);
        rescanVolume(volumePath);
      } else {
        showToast('error', 'Couldn\u2019t re-save the MP3', result.errorMessage || 'It stopped without saying why. The original is unchanged.');
      }
    } catch (err) {
      showToast('error', 'Couldn\u2019t re-save the MP3', getErrorMessage(err));
    }
  } else if (action === 'edit') {
    openTagEditor({ ...track, bpm: track.bpm != null ? String(track.bpm) : undefined }, (updated) => {
      const entry = knownVolumes.get(volumePath);
      const target = entry?.result?.tracks.find(t => t.filePath === updated.filePath);
      if (!target) return;
      target.title = updated.title;
      target.artist = updated.artist;
      target.album = updated.album;
      target.genre = updated.genre;
      target.hasAlbumArt = !!updated.albumArt;
      updateVolumeCardState(volumePath);
    });
  }
}

// ========== Volume detection ==========

async function detectVolumes() {
  try {
    const response = await window.candybar.listVolumes();
    if (!response.success || !response.volumes) return;

    const currentPaths = new Set(response.volumes.map(v => v.path));

    // Remove departed volumes
    for (const path of knownVolumes.keys()) {
      if (!currentPaths.has(path)) {
        knownVolumes.delete(path);
        const card = volumeListEl.querySelector(`[data-volume-path="${CSS.escape(path)}"]`);
        if (card) card.remove();
      }
    }

    // Add new volumes. We do NOT auto-scan on mount — scanning an entire
    // device touches every file, and users reported it running unexpectedly.
    // The volume card has a Re-scan button for explicit, opt-in scans.
    for (const vol of response.volumes) {
      if (!knownVolumes.has(vol.path)) {
        knownVolumes.set(vol.path, { volume: vol, result: null, scanning: false, error: null });
        const card = renderVolumeCard(vol.path);
        volumeListEl.appendChild(card);
        if (!vol.isLibrary) updateVolumeCardState(vol.path);
      }
    }

    // Update visibility
    section.style.display = knownVolumes.size > 0 ? 'block' : 'none';
    statusEl.textContent = knownVolumes.size > 1 ? `${knownVolumes.size} drives` : '';
  } catch {
    // Silent — will retry on next poll
  }
}

// ========== Sequential scan queue ==========

function enqueueScan(path: string) {
  if (!scanQueue.includes(path)) {
    scanQueue.push(path);
  }
  void processQueue();
}

async function processQueue() {
  if (scanningActive || scanQueue.length === 0) return;
  scanningActive = true;

  while (scanQueue.length > 0) {
    const path = scanQueue.shift()!;
    const entry = knownVolumes.get(path);
    if (!entry) continue;

    entry.scanning = true;
    entry.error = null;
    updateVolumeCardState(path);

    activeScanPath = path;
    activeScanJobId = null;
    if (!jobProgressListenerRegistered) {
      jobProgressListenerRegistered = true;
      window.candybar.onJobProgress(handleJobProgress);
    }

    try {
      const response = await window.candybar.jobEnqueueAndWait(
        'usb-health-scan',
        { volumePath: path },
        path
      ) as { jobId: string; success: boolean; result?: UsbHealthResult; error?: string };

      if (response.success && response.result) {
        entry.result = response.result;
      } else {
        entry.error = response.error || 'the check stopped without saying why';
      }
    } catch (err) {
      entry.error = getErrorMessage(err, 'the check stopped without saying why');
    } finally {
      entry.scanning = false;
      activeScanPath = null;
      activeScanJobId = null;
      updateVolumeCardState(path);
    }
  }

  scanningActive = false;
}

// ========== Polling ==========

function startPolling() {
  void detectVolumes();
  if (!pollIntervalId) {
    pollIntervalId = setInterval(() => void detectVolumes(), 15_000);
  }
}

function stopPolling() {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
}

// ========== Init ==========

export function initConnectedDevices() {
  if (!section || !volumeListEl) return;

  refreshBtn?.addEventListener('click', () => void detectVolumes());

  // Watch for Health tab becoming active/inactive
  const page = document.getElementById('page-library');
  if (page) {
    const observer = new MutationObserver(() => {
      if (page.classList.contains('active')) {
        startPolling();
      } else {
        stopPolling();
      }
    });
    observer.observe(page, { attributes: true, attributeFilter: ['class'] });

    // If already active on init
    if (page.classList.contains('active')) {
      startPolling();
    }
  }
}
