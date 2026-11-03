import type { VolumeInfo, UsbHealthResult, LibraryHealthTrack } from './shared';
import type { JobProgress } from '../types';
import { showToast, escapeHtml, getErrorMessage } from './shared';
import { type SortKey, getFilteredTracks, sortTracks, createTrackRow } from './healthTrackTable';
import {
  type PioneerDevice, PIONEER_DEVICES,
  containerLabel, countFormats, categoryLabel, deviceReadsFS, normalizeFS,
} from './pioneerDevices';

// All filesystems and formats that can possibly appear as matrix rows
const KNOWN_FORMATS = ['WAVE', 'AIFF', 'MPEG', 'MP4', 'FLAC', 'OGG'] as const;

// ========== DOM ==========

const volumeList = document.getElementById('usb-volume-list') as HTMLDivElement;
const refreshBtn = document.getElementById('usb-refresh-volumes') as HTMLButtonElement;
const selectFolderBtn = document.getElementById('usb-select-folder') as HTMLButtonElement;
const scanBtn = document.getElementById('usb-scan-btn') as HTMLButtonElement;

const progressSection = document.getElementById('usb-progress-section') as HTMLElement;
const progressBar = document.getElementById('usb-progress-bar') as HTMLDivElement;
const progressMessage = document.getElementById('usb-progress-message') as HTMLSpanElement;
const progressCount = document.getElementById('usb-progress-count') as HTMLSpanElement;

const resultsWrap = document.getElementById('usb-results') as HTMLDivElement;
const driveOverviewEl = document.getElementById('usb-drive-overview') as HTMLDivElement;
const matrixWrap = document.getElementById('usb-matrix-wrap') as HTMLDivElement;
const compatSummaryEl = document.getElementById('usb-compat-summary') as HTMLSpanElement;
const checklistEl = document.getElementById('usb-checklist') as HTMLDivElement;
const formatBreakdownEl = document.getElementById('usb-format-breakdown') as HTMLDivElement;
const kpiRowEl = document.getElementById('usb-kpi-row') as HTMLDivElement;

const tableBody = document.getElementById('usb-table-body') as HTMLTableSectionElement;
const tableEl = document.getElementById('usb-data-table') as HTMLTableElement;
const tableEmpty = document.getElementById('usb-table-empty') as HTMLElement;
const trackCountEl = document.getElementById('usb-track-count') as HTMLSpanElement;
const filterTabs = document.querySelectorAll<HTMLButtonElement>('.usb-filter-tab');

// ========== State ==========

let usbResult: UsbHealthResult | null = null;
let selectedVolumePath: string | null = null;
let scanRunning = false;

// Track table: problems sort to the top so they're the first thing on screen.
let tableFilter: 'all' | 'errors' | 'warnings' = 'all';
let sortKey: SortKey = 'status';
let sortDir: 'asc' | 'desc' = 'desc';

// Progress for the scan this page started. job-progress carries no context
// key, so the job id is latched from the first event whose file sits under
// the drive being scanned; later events must match that id.
let scanVolumePath: string | null = null;
let scanJobId: string | null = null;

// ========== SVG icons ==========

const CHECK_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const X_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
const WARN_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
const DASH_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="6" y1="12" x2="18" y2="12"/></svg>`;

// ========== Formatting helpers ==========

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

// ========== Volume list rendering ==========

function renderVolumeList(volumes: VolumeInfo[]) {
  if (volumes.length === 0) {
    volumeList.innerHTML = '<div class="empty-state">No external volumes found. Connect a USB drive and click Refresh.</div>';
    scanBtn.disabled = true;
    return;
  }

  volumeList.innerHTML = '';
  volumes.forEach((vol) => {
    const row = document.createElement('div');
    row.className = 'usb-volume-row';
    if (selectedVolumePath === vol.path) row.classList.add('selected');
    row.dataset.path = vol.path;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-pressed', String(selectedVolumePath === vol.path));

    const fsBadgeClass = vol.isCompatible ? 'ok' : 'warn';
    const fsFriendly = vol.isCompatible ? 'FAT32' : escapeHtml(vol.fileSystem || 'Unknown');
    const freeLabel = vol.totalBytes > 0
      ? `${formatBytes(vol.freeBytes)} free of ${formatBytes(vol.totalBytes)}`
      : 'Unknown size';

    row.innerHTML = `
      <div class="usb-volume-row-left">
        <svg class="usb-drive-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><circle cx="12" cy="14" r="3"/></svg>
        <div class="usb-volume-row-text">
          <div class="usb-volume-row-name">${escapeHtml(vol.name)}</div>
          <div class="usb-volume-row-meta">${freeLabel}</div>
        </div>
      </div>
      <span class="usb-fs-pill ${fsBadgeClass}" title="${escapeHtml(fileSystemHint(vol.isCompatible))}">${fsFriendly}</span>
    `;

    const select = () => {
      selectedVolumePath = vol.path;
      volumeList.querySelectorAll<HTMLElement>('.usb-volume-row').forEach((r) => {
        const on = r.dataset.path === vol.path;
        r.classList.toggle('selected', on);
        r.setAttribute('aria-pressed', String(on));
      });
      scanBtn.disabled = scanRunning;
    };
    row.addEventListener('click', select);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
    });

    volumeList.appendChild(row);
  });
}

// ========== Drive Overview (hero strip) ==========

const VERDICT_HINTS: Record<'ok' | 'warn' | 'error', string> = {
  ok: 'Every check passed. This drive should play fine.',
  warn: 'It should play, but some tracks are worth fixing. Details are below.',
  error: 'Some tracks won\'t play, or the drive format is wrong. Details are below.',
};

function fileSystemHint(compatible: boolean): string {
  return compatible
    ? 'The drive\'s format. FAT32 is read by every Pioneer player.'
    : 'The drive\'s format. Some Pioneer players only read FAT32. To change it, copy your music off, then reformat as MS-DOS (FAT) in Disk Utility. Reformatting erases the drive.';
}

function renderDriveOverview(result: UsbHealthResult) {
  const { volume, summary } = result;
  const usedBytes = Math.max(0, volume.totalBytes - volume.freeBytes);
  const usedPct = volume.totalBytes > 0 ? Math.round((usedBytes / volume.totalBytes) * 100) : 0;

  const verdict = overallVerdict(result);
  const verdictClass = verdict === 'ok' ? 'ok' : verdict === 'warning' ? 'warn' : 'error';
  const verdictLabel = verdict === 'ok' ? 'Gig Ready' : verdict === 'warning' ? 'Minor Issues' : 'Not Ready';
  const verdictIcon = verdict === 'ok' ? CHECK_ICON : verdict === 'warning' ? WARN_ICON : X_ICON;

  const fsClass = volume.isCompatible ? 'ok' : 'warn';
  const fsLabel = escapeHtml(volume.fileSystem || 'Unknown');

  const storageClass = usedPct > 95 ? 'danger' : usedPct > 85 ? 'warn' : '';

  driveOverviewEl.innerHTML = `
    <div class="usb-drive-hero">
      <div class="usb-drive-hero-icon">
        <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <rect x="4" y="2" width="16" height="20" rx="2"/>
          <line x1="8" y1="6" x2="16" y2="6"/>
          <circle cx="12" cy="14" r="3.5"/>
          <line x1="12" y1="18" x2="12" y2="20"/>
        </svg>
      </div>
      <div class="usb-drive-hero-info">
        <div class="usb-drive-hero-name">${escapeHtml(volume.name)}</div>
        <div class="usb-drive-hero-meta">
          <span class="usb-fs-pill ${fsClass}" title="${escapeHtml(fileSystemHint(volume.isCompatible))}">${fsLabel}</span>
          <span class="usb-drive-hero-stat">${summary.total} tracks</span>
          <span class="usb-drive-hero-stat">${formatBytes(volume.totalBytes)} total</span>
        </div>
      </div>
      <div class="usb-verdict ${verdictClass}" title="${escapeHtml(VERDICT_HINTS[verdictClass])}">
        <span class="usb-verdict-icon">${verdictIcon}</span>
        <span class="usb-verdict-label">${verdictLabel}</span>
      </div>
    </div>
    <div class="usb-storage-block">
      <div class="usb-storage-bar ${storageClass}">
        <div class="usb-storage-fill" style="width:${usedPct}%"></div>
      </div>
      <div class="usb-storage-labels">
        <span>${formatBytes(usedBytes)} used</span>
        <span>${formatBytes(volume.freeBytes)} free (${100 - usedPct}%)</span>
      </div>
    </div>
  `;
}

// ========== Compatibility Matrix ==========

type CellState = 'pass' | 'fail' | 'na'; // na = format not on drive

function computeMatrix(result: UsbHealthResult): {
  rows: Array<{ label: string; type: 'fs' | 'format'; key: string; cells: CellState[]; trackCount?: number }>;
  verdicts: Array<{ device: PioneerDevice; compatible: boolean; reasons: string[] }>;
} {
  const volumeFS = normalizeFS(result.volume.fileSystem || '');
  const formatCounts = countFormats(result.tracks);
  const driveFormats = KNOWN_FORMATS.filter(f => (formatCounts[f] || 0) > 0);

  const rows: Array<{ label: string; type: 'fs' | 'format'; key: string; cells: CellState[]; trackCount?: number }> = [];

  // Filesystem row
  rows.push({
    label: volumeFS || result.volume.fileSystem || 'Unknown',
    type: 'fs',
    key: volumeFS,
    cells: PIONEER_DEVICES.map(d => deviceReadsFS(d, result.volume.fileSystem || '') ? 'pass' : 'fail'),
  });

  // One row per format found on drive
  for (const fmt of driveFormats) {
    rows.push({
      label: containerLabel(fmt),
      type: 'format',
      key: fmt,
      trackCount: formatCounts[fmt] || 0,
      cells: PIONEER_DEVICES.map(d => d.supportedFormats.has(fmt) ? 'pass' : 'fail'),
    });
  }

  // Per-device overall verdict
  const verdicts = PIONEER_DEVICES.map((device, colIdx) => {
    const reasons: string[] = [];
    let compatible = true;
    for (const row of rows) {
      if (row.cells[colIdx] === 'fail') {
        compatible = false;
        if (row.type === 'fs') reasons.push(`Needs ${device.supportedFS[0]}`);
        else reasons.push(`No ${row.label}`);
      }
    }
    return { device, compatible, reasons };
  });

  return { rows, verdicts };
}

function renderMatrix(result: UsbHealthResult) {
  const { rows, verdicts } = computeMatrix(result);

  const headerCells = PIONEER_DEVICES.map((d, i) => {
    const v = verdicts[i];
    const cls = v.compatible ? 'ok' : 'fail';
    return `
      <th class="usb-matrix-col usb-matrix-head-${cls}">
        <div class="usb-matrix-device-name">${escapeHtml(d.name)}</div>
        <div class="usb-matrix-device-cat">${categoryLabel(d.category)}</div>
      </th>
    `;
  }).join('');

  const bodyRows = rows.map(row => {
    const cells = row.cells.map(c => {
      const icon = c === 'pass' ? CHECK_ICON : c === 'fail' ? X_ICON : DASH_ICON;
      const cls = c === 'pass' ? 'pass' : c === 'fail' ? 'fail' : 'na';
      return `<td class="usb-matrix-cell ${cls}">${icon}</td>`;
    }).join('');
    const labelExtra = row.type === 'format' && row.trackCount
      ? `<span class="usb-matrix-row-count">${row.trackCount}</span>`
      : '';
    return `
      <tr class="usb-matrix-row usb-matrix-row-${row.type}">
        <th class="usb-matrix-label">${escapeHtml(row.label)}${labelExtra}</th>
        ${cells}
      </tr>
    `;
  }).join('');

  const verdictRow = verdicts.map(v => {
    const cls = v.compatible ? 'ok' : 'fail';
    const label = v.compatible ? 'Ready' : (v.reasons[0] || 'Unsupported');
    const icon = v.compatible ? CHECK_ICON : X_ICON;
    return `<td class="usb-matrix-verdict ${cls}"><span class="usb-verdict-pill ${cls}">${icon}${escapeHtml(label)}</span></td>`;
  }).join('');

  matrixWrap.innerHTML = `
    <table class="usb-matrix">
      <thead>
        <tr>
          <th class="usb-matrix-corner">Requirement</th>
          ${headerCells}
        </tr>
      </thead>
      <tbody>
        ${bodyRows}
        <tr class="usb-matrix-row-verdict">
          <th class="usb-matrix-label">Overall</th>
          ${verdictRow}
        </tr>
      </tbody>
    </table>
  `;

  // Summary
  const okCount = verdicts.filter(v => v.compatible).length;
  compatSummaryEl.innerHTML = `Compatible with <strong>${okCount}</strong> of <strong>${verdicts.length}</strong> devices`;
}

// ========== Health Checklist ==========

type ChecklistItem = {
  label: string;
  severity: 'ok' | 'warning' | 'error';
  detail: string;
};

function buildChecklist(result: UsbHealthResult): ChecklistItem[] {
  const { volume, summary, tracks, volumeIssues } = result;
  const items: ChecklistItem[] = [];

  // Filesystem
  items.push({
    label: 'File System',
    severity: volume.isCompatible ? 'ok' : 'error',
    detail: volume.isCompatible
      ? 'FAT32 — compatible with all Pioneer DJ gear'
      : `${volume.fileSystem || 'Unknown'} — limited device support`,
  });

  // Audio formats
  const formatCounts = countFormats(tracks);
  const legacyUnsupported = ['FLAC', 'OGG'].filter(f => formatCounts[f]);
  const legacyCount = legacyUnsupported.reduce((s, f) => s + (formatCounts[f] || 0), 0);
  items.push({
    label: 'Audio Formats',
    severity: legacyCount === 0 ? 'ok' : 'warning',
    detail: legacyCount === 0
      ? 'All tracks in universally supported formats'
      : `${legacyCount} track${legacyCount > 1 ? 's' : ''} in ${legacyUnsupported.join('/')} — not supported by older gear`,
  });

  // Sample rates
  const validRates = new Set([32000, 44100, 48000]);
  const badRateCount = tracks.filter(t => t.format.sampleRate != null && !validRates.has(t.format.sampleRate)).length;
  items.push({
    label: 'Sample Rates',
    severity: badRateCount === 0 ? 'ok' : 'warning',
    detail: badRateCount === 0
      ? 'All tracks at 32/44.1/48 kHz'
      : `${badRateCount} track${badRateCount > 1 ? 's' : ''} with non-standard sample rate`,
  });

  // File integrity
  items.push({
    label: 'File Integrity',
    severity: summary.errors === 0 ? 'ok' : 'error',
    detail: summary.errors === 0
      ? 'No corrupt or unreadable files'
      : `${summary.errors} file${summary.errors > 1 ? 's' : ''} with errors`,
  });

  // Free space
  const lowSpace = volume.totalBytes > 0 && (volume.freeBytes / volume.totalBytes) < 0.05;
  items.push({
    label: 'Free Space',
    severity: lowSpace ? 'warning' : 'ok',
    detail: lowSpace
      ? `Only ${formatBytes(volume.freeBytes)} free — may struggle with analysis files`
      : `${formatBytes(volume.freeBytes)} available`,
  });

  // Metadata
  const missingMetaCount = tracks.filter(t => !t.artist || !t.title).length;
  items.push({
    label: 'Metadata',
    severity: missingMetaCount === 0 ? 'ok' : 'warning',
    detail: missingMetaCount === 0
      ? 'All tracks have artist + title tags'
      : `${missingMetaCount} track${missingMetaCount > 1 ? 's' : ''} missing tags`,
  });

  // Merge any additional volume-level issues the scanner reported
  for (const vi of volumeIssues) {
    if (vi.code === 'WRONG_FILESYSTEM' || vi.code === 'LOW_FREE_SPACE') continue; // already covered
    items.push({
      label: vi.code,
      severity: vi.severity === 'error' ? 'error' : 'warning',
      detail: vi.message,
    });
  }

  return items;
}

function renderChecklist(result: UsbHealthResult) {
  const items = buildChecklist(result);
  checklistEl.innerHTML = items.map(item => {
    const icon = item.severity === 'ok' ? CHECK_ICON : item.severity === 'warning' ? WARN_ICON : X_ICON;
    return `
      <div class="usb-check-item ${item.severity}">
        <span class="usb-check-icon">${icon}</span>
        <div class="usb-check-body">
          <div class="usb-check-label">${escapeHtml(item.label)}</div>
          <div class="usb-check-detail">${escapeHtml(item.detail)}</div>
        </div>
      </div>
    `;
  }).join('');
}

// ========== Format Breakdown + KPIs ==========

function renderFormatBreakdown(result: UsbHealthResult) {
  const tracks = result.tracks;
  const counts = countFormats(tracks);
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total = tracks.length;

  if (entries.length === 0) {
    formatBreakdownEl.innerHTML = '<div class="empty-state">No audio files found.</div>';
    kpiRowEl.innerHTML = '';
    return;
  }

  const max = entries[0][1];
  formatBreakdownEl.innerHTML = `
    <div class="usb-format-bars">
      ${entries.map(([fmt, count]) => {
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        const w = max > 0 ? Math.round((count / max) * 100) : 0;
        const legacy = fmt === 'FLAC' || fmt === 'OGG';
        const cls = legacy ? 'warn' : 'ok';
        return `
          <div class="usb-format-row">
            <span class="usb-format-name ${cls}">${containerLabel(fmt)}</span>
            <div class="usb-format-bar-track">
              <div class="usb-format-bar-fill ${cls}" style="width:${w}%"></div>
            </div>
            <span class="usb-format-count">${count}<span class="usb-format-pct"> · ${pct}%</span></span>
          </div>`;
      }).join('')}
    </div>
  `;

  // KPI row: healthy / warnings / errors
  const { summary } = result;
  const healthyPct = total > 0 ? Math.round((summary.healthy / total) * 100) : 0;
  kpiRowEl.innerHTML = `
    <div class="usb-mini-kpi ok">
      <div class="usb-mini-kpi-value">${healthyPct}%</div>
      <div class="usb-mini-kpi-label">Healthy</div>
    </div>
    <div class="usb-mini-kpi ${summary.warnings > 0 ? 'warn' : ''}">
      <div class="usb-mini-kpi-value">${summary.warnings}</div>
      <div class="usb-mini-kpi-label">Warnings</div>
    </div>
    <div class="usb-mini-kpi ${summary.errors > 0 ? 'error' : ''}">
      <div class="usb-mini-kpi-value">${summary.errors}</div>
      <div class="usb-mini-kpi-label">Errors</div>
    </div>
  `;
}

// ========== Overall verdict ==========

function overallVerdict(result: UsbHealthResult): 'ok' | 'warning' | 'error' {
  const { summary, volume } = result;
  if (!volume.isCompatible || summary.errors > 0) return 'error';
  if (summary.warnings > 0) return 'warning';
  return 'ok';
}

// ========== Scan handlers ==========

function isUnderPath(file: unknown, root: string): boolean {
  if (typeof file !== 'string') return false;
  const base = root.replace(/\/+$/, '');
  return file === base || file.startsWith(`${base}/`);
}

function handleJobProgress(payload: JobProgress) {
  if (payload.jobType !== 'usb-health-scan' || !scanRunning || !scanVolumePath) return;
  if (scanJobId === null) {
    if (!isUnderPath(payload.detail, scanVolumePath)) return;
    scanJobId = payload.jobId;
  } else if (payload.jobId !== scanJobId) {
    return;
  }
  const pct = payload.total > 0 ? Math.round((payload.current / payload.total) * 100) : 0;
  progressBar.style.width = `${pct}%`;
  progressMessage.textContent = payload.phase === 'discovering'
    ? 'Discovering audio files…'
    : payload.phase === 'complete'
      ? 'Complete'
      : `Analyzing tracks…`;
  if (payload.total > 0) {
    progressCount.textContent = `${payload.current} / ${payload.total}`;
  }
}

async function handleRefreshVolumes() {
  refreshBtn.disabled = true;
  volumeList.innerHTML = '<div class="empty-state">Scanning for volumes&hellip;</div>';
  scanBtn.disabled = true;
  selectedVolumePath = null;

  try {
    const response = await window.candybar.listVolumes();
    if (!response.success || !response.volumes) {
      showToast('error', 'Volume scan failed', response.error || 'Could not list volumes');
      volumeList.innerHTML = '<div class="empty-state">Failed to scan for volumes.</div>';
      return;
    }
    renderVolumeList(response.volumes);
  } catch (err) {
    showToast('error', 'Volume scan failed', getErrorMessage(err));
    volumeList.innerHTML = '<div class="empty-state">Failed to scan for volumes.</div>';
  } finally {
    refreshBtn.disabled = false;
  }
}

async function handleSelectFolder() {
  const chosen = await window.candybar.selectPath('dir');
  if (!chosen) return;
  selectedVolumePath = chosen;
  volumeList.innerHTML = `
    <div class="usb-volume-row selected" data-path="${escapeHtml(chosen)}" aria-current="true">
      <div class="usb-volume-row-left">
        <svg class="usb-drive-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h18v13H3z"/><path d="M8 7V4h8v3"/></svg>
        <div class="usb-volume-row-text">
          <div class="usb-volume-row-name">${escapeHtml(chosen)}</div>
          <div class="usb-volume-row-meta">Custom folder</div>
        </div>
      </div>
      <span class="usb-fs-pill warn">Custom</span>
    </div>
  `;
  scanBtn.disabled = false;
}

async function handleScan() {
  if (scanRunning || !selectedVolumePath) return;
  scanRunning = true;
  scanVolumePath = selectedVolumePath;
  scanJobId = null;
  scanBtn.disabled = true;
  resultsWrap.style.display = 'none';

  progressSection.style.display = 'block';
  progressBar.style.width = '0%';
  progressMessage.textContent = 'Finding audio files…';
  progressCount.textContent = '';

  try {
    const response = await window.candybar.jobEnqueueAndWait(
      'usb-health-scan',
      { volumePath: selectedVolumePath },
      selectedVolumePath
    ) as { jobId: string; success: boolean; result?: UsbHealthResult; error?: string };

    if (!response.success || !response.result) {
      showToast('error', 'Scan Failed', response.error || 'Unknown error during scan.');
      return;
    }

    usbResult = response.result;
    renderDriveOverview(usbResult);
    renderMatrix(usbResult);
    renderChecklist(usbResult);
    renderFormatBreakdown(usbResult);
    renderTrackTable();
    resultsWrap.style.display = 'block';

    const verdict = overallVerdict(usbResult);
    if (verdict === 'ok') {
      showToast('success', 'Gig Ready', `${usbResult.summary.total} tracks analyzed — drive is ready to go.`);
    } else if (verdict === 'warning') {
      showToast('warning', 'Minor Issues', `${usbResult.summary.warnings} warnings in ${usbResult.summary.total} tracks.`);
    } else {
      showToast('error', 'Not Ready', `${usbResult.summary.errors} errors or incompatible filesystem.`);
    }
  } catch (err) {
    showToast('error', 'Scan Failed', getErrorMessage(err));
  } finally {
    scanRunning = false;
    scanVolumePath = null;
    scanJobId = null;
    scanBtn.disabled = !selectedVolumePath;
    progressSection.style.display = 'none';
  }
}

// ========== Track table ==========

function renderTrackTable() {
  if (!usbResult || !tableBody) return;
  const filtered = getFilteredTracks(usbResult.tracks, {
    showAllTracks: tableFilter === 'all',
    severityFilter: tableFilter,
    activeIssueCode: null,
  });
  const rows = sortTracks(filtered, sortKey, sortDir);

  tableBody.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const track of rows) {
    // Read-only: fixes happen in the Library page, where the files are indexed.
    frag.appendChild(createTrackRow(track, { isSelected: () => false, onSelected: () => {} }));
  }
  tableBody.appendChild(frag);

  const total = usbResult.tracks.length;
  trackCountEl.textContent = tableFilter === 'all'
    ? `${total} track${total === 1 ? '' : 's'}`
    : `${rows.length} of ${total} tracks`;
  if (tableEmpty) tableEmpty.style.display = rows.length === 0 ? '' : 'none';

  tableEl?.querySelectorAll<HTMLElement>('th[data-sort]').forEach((th) => {
    const active = th.dataset.sort === sortKey;
    th.classList.toggle('sorted', active);
    th.setAttribute('aria-sort', active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
    const indicator = th.querySelector('.sort-indicator');
    if (indicator) {
      indicator.textContent = active ? '▲' : '';
      indicator.classList.toggle('desc', active && sortDir === 'desc');
    }
  });
}

function initTrackTable() {
  filterTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const next = tab.dataset.filter as typeof tableFilter | undefined;
      if (!next || next === tableFilter) return;
      tableFilter = next;
      filterTabs.forEach((t) => {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-pressed', String(t === tab));
      });
      renderTrackTable();
    });
  });
  tableEl?.querySelectorAll<HTMLElement>('th[data-sort]').forEach((th) => {
    th.tabIndex = 0;
    const sortBy = () => {
      const key = th.dataset.sort as SortKey;
      if (key === sortKey) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else { sortKey = key; sortDir = key === 'status' ? 'desc' : 'asc'; }
      renderTrackTable();
    };
    th.addEventListener('click', sortBy);
    th.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortBy(); }
    });
  });
}

// ========== Init ==========

export function initUsbHealth() {
  refreshBtn.addEventListener('click', () => void handleRefreshVolumes());
  selectFolderBtn.addEventListener('click', () => void handleSelectFolder());
  scanBtn.addEventListener('click', () => void handleScan());
  window.candybar.onJobProgress(handleJobProgress);
  initTrackTable();

  const page = document.getElementById('page-usb-health');
  if (page) {
    const observer = new MutationObserver(() => {
      if (page.classList.contains('active') && !scanRunning) {
        void handleRefreshVolumes();
      }
    });
    observer.observe(page, { attributes: true, attributeFilter: ['class'] });
  }
}
