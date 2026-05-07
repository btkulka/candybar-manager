import type { VolumeInfo, UsbHealthResult, UsbHealthProgress, LibraryHealthTrack } from './shared';
import { showToast, escapeHtml, getErrorMessage, icons, showContextMenu } from './shared';
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

type PioneerController = {
  name: string;
  category: 'flagship' | 'all-in-one' | 'media-player';
  imageUrl: string;
  supportedFS: string[];
  supportedFormats: Set<string>; // uppercase container names: 'WAVE', 'AIFF', 'MPEG', 'MP4', 'FLAC'
};

type ChecklistItem = {
  label: string;
  passed: boolean;
  severity: 'ok' | 'warning' | 'error';
  detail: string;
};

// ========== Pioneer Controller Data ==========

const PIONEER_CONTROLLERS: PioneerController[] = [
  {
    name: 'CDJ-3000',
    category: 'flagship',
    imageUrl: 'https://images.microcms-assets.io/assets/3b9e29ce734e49babfedb3f8d1e728e3/cbe27d4bec5f4302be38b9eee163ffa7/96C2FC9D-EBA6-46DC-BA4D-7F8447AE2EEA.jpg',
    supportedFS: ['FAT32', 'FAT16', 'HFS+'],
    supportedFormats: new Set(['WAVE', 'AIFF', 'MPEG', 'MP4', 'FLAC']),
  },
  {
    name: 'CDJ-2000NXS2',
    category: 'flagship',
    imageUrl: 'https://alphatheta.com/product-images/1578/f02df8bc-4f62-437d-acee-a7ed625c8755/cdj-2000nxs2_1.png',
    supportedFS: ['FAT32', 'FAT16', 'HFS+'],
    supportedFormats: new Set(['WAVE', 'AIFF', 'MPEG', 'MP4', 'FLAC']),
  },
  {
    name: 'OPUS-QUAD',
    category: 'all-in-one',
    imageUrl: 'https://product-images.alphatheta.com/139/f6ee44f7-2409-40ea-b78e-643217be9991/opus-quad_1.png',
    supportedFS: ['FAT32', 'FAT16', 'exFAT', 'HFS+'],
    supportedFormats: new Set(['WAVE', 'AIFF', 'MPEG', 'MP4', 'FLAC']),
  },
  {
    name: 'XDJ-RX3',
    category: 'all-in-one',
    imageUrl: 'https://images.microcms-assets.io/assets/3b9e29ce734e49babfedb3f8d1e728e3/808bfb43-0301-49fb-a220-80ddb5aacffc/xdj-rx3_1.png',
    supportedFS: ['FAT32', 'FAT16', 'HFS+'],
    supportedFormats: new Set(['WAVE', 'AIFF', 'MPEG', 'MP4']),
  },
  {
    name: 'XDJ-RX2',
    category: 'all-in-one',
    imageUrl: 'https://product-images.alphatheta.com/1838/cd1cf970-9285-4ddc-98a6-e041c67033d3/xdj-rx2_1.png',
    supportedFS: ['FAT32', 'FAT16', 'HFS+'],
    supportedFormats: new Set(['WAVE', 'AIFF', 'MPEG', 'MP4']),
  },
  {
    name: 'XDJ-XZ',
    category: 'all-in-one',
    imageUrl: 'https://product-images.alphatheta.com/629/595fe353-dd7c-4e60-8091-01f1c306e152/xdj-xz_1.png',
    supportedFS: ['FAT32', 'FAT16', 'HFS+'],
    supportedFormats: new Set(['WAVE', 'AIFF', 'MPEG', 'MP4', 'FLAC']),
  },
  {
    name: 'XDJ-1000MK2',
    category: 'media-player',
    imageUrl: 'https://product-images.alphatheta.com/599/372dee8c-1a1b-419b-9943-a2c9b63f7c6b/xdj-1000mk2_1.png',
    supportedFS: ['FAT32', 'FAT16', 'HFS+'],
    supportedFormats: new Set(['WAVE', 'AIFF', 'MPEG', 'MP4', 'FLAC']),
  },
  {
    name: 'XDJ-700',
    category: 'media-player',
    imageUrl: 'https://images.microcms-assets.io/product-images/392/97116f84-9276-4d07-8ea1-1908bc0ff5f7/xdj-700_1.png',
    supportedFS: ['FAT32', 'FAT16', 'HFS+'],
    supportedFormats: new Set(['WAVE', 'AIFF', 'MPEG', 'MP4']),
  },
  {
    name: 'DDJ-FLX10',
    category: 'media-player',
    imageUrl: 'https://images.microcms-assets.io/assets/3b9e29ce734e49babfedb3f8d1e728e3/87650f9b2b40406784627a3fdaf87d6d/3EAE02FE-9A29-4242-9426-BF1DEA4EB283.jpg',
    supportedFS: ['FAT32', 'FAT16'],
    supportedFormats: new Set(['WAVE', 'AIFF', 'MPEG', 'MP4']),
  },
  {
    name: 'DDJ-REV7',
    category: 'media-player',
    imageUrl: 'https://images.microcms-assets.io/assets/3b9e29ce734e49babfedb3f8d1e728e3/e17d8824-80ed-4a1b-9957-cfc885cc2cef/DDJ-REV7_1.png',
    supportedFS: ['FAT32', 'FAT16', 'HFS+'],
    supportedFormats: new Set(['WAVE', 'AIFF', 'MPEG', 'MP4']),
  },
];

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
let jobProgressListenerRegistered = false;

// ========== Helpers ==========

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function severityIcon(severity: 'error' | 'warning' | 'ok'): string {
  if (severity === 'error') return '<span class="cd-dot cd-dot-error"></span>';
  if (severity === 'warning') return '<span class="cd-dot cd-dot-warning"></span>';
  return '<span class="cd-dot cd-dot-ok"></span>';
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

/** Tally container formats across all tracks */
function countFormats(tracks: LibraryHealthTrack[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of tracks) {
    const fmt = t.format.container || 'Unknown';
    counts[fmt] = (counts[fmt] || 0) + 1;
  }
  return counts;
}

/** Friendly label for container names */
function containerLabel(container: string): string {
  const map: Record<string, string> = {
    'WAVE': 'WAV', 'AIFF': 'AIFF', 'MPEG': 'MP3', 'MP4': 'AAC',
    'FLAC': 'FLAC', 'OGG': 'OGG', 'Unknown': '?',
  };
  return map[container] || container;
}

/** Format container badge color class */
function containerColorClass(container: string): string {
  if (container === 'FLAC' || container === 'OGG') return 'cd-fmt-warn';
  return 'cd-fmt-ok';
}

/** Compute average bitrate across tracks */
function avgBitrate(tracks: LibraryHealthTrack[]): number {
  let sum = 0, count = 0;
  for (const t of tracks) {
    if (t.format.bitRate && t.format.bitRate > 0) {
      sum += t.format.bitRate;
      count++;
    }
  }
  return count > 0 ? Math.round(sum / count) : 0;
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

/** Normalize filesystem string to a canonical name for matching */
function normalizeFS(fs: string): string {
  const upper = fs.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (upper.includes('FAT32') || upper === 'MSDOSFAT32') return 'FAT32';
  if (upper.includes('FAT16') || upper === 'MSDOSFAT16') return 'FAT16';
  if (upper.includes('EXFAT')) return 'exFAT';
  if (upper.includes('HFS') || upper.includes('APFS')) return 'HFS+';
  if (upper.includes('NTFS')) return 'NTFS';
  if (upper.includes('FAT')) return 'FAT32'; // generic FAT → FAT32
  return fs;
}

// ========== Health Checklist ==========

function computeChecklist(result: UsbHealthResult): ChecklistItem[] {
  const { volume, summary, tracks, volumeIssues } = result;
  const items: ChecklistItem[] = [];
  const total = summary.total;

  // 1. File system
  items.push({
    label: 'File System',
    passed: volume.isCompatible,
    severity: volume.isCompatible ? 'ok' : 'error',
    detail: volume.isCompatible
      ? `FAT32 — compatible with all Pioneer DJ gear`
      : `${volume.fileSystem || 'Unknown'} — not supported by most Pioneer gear`,
  });

  // 2. Audio formats
  const formatCounts = countFormats(tracks);
  const incompatibleFormats = Object.keys(formatCounts).filter(f => f === 'FLAC' || f === 'OGG');
  const incompatibleCount = incompatibleFormats.reduce((s, f) => s + (formatCounts[f] || 0), 0);
  items.push({
    label: 'Audio Formats',
    passed: incompatibleCount === 0,
    severity: incompatibleCount === 0 ? 'ok' : 'warning',
    detail: incompatibleCount === 0
      ? 'All tracks in compatible formats (WAV/AIFF/MP3/AAC)'
      : `${incompatibleCount} track${incompatibleCount > 1 ? 's' : ''} in unsupported format (${incompatibleFormats.map(containerLabel).join(', ')})`,
  });

  // 3. Sample rates
  const validRates = new Set([32000, 44100, 48000]);
  const badRateTracks = tracks.filter(t => t.format.sampleRate != null && !validRates.has(t.format.sampleRate));
  items.push({
    label: 'Sample Rates',
    passed: badRateTracks.length === 0,
    severity: badRateTracks.length === 0 ? 'ok' : 'warning',
    detail: badRateTracks.length === 0
      ? 'All tracks at 44.1 or 48 kHz'
      : `${badRateTracks.length} track${badRateTracks.length > 1 ? 's' : ''} with non-standard sample rate`,
  });

  // 4. No errors (corrupt/unreadable)
  items.push({
    label: 'File Integrity',
    passed: summary.errors === 0,
    severity: summary.errors === 0 ? 'ok' : 'error',
    detail: summary.errors === 0
      ? 'No corrupt or unreadable files'
      : `${summary.errors} file${summary.errors > 1 ? 's' : ''} with errors`,
  });

  // 5. Free space
  const lowSpace = volume.totalBytes > 0 && (volume.freeBytes / volume.totalBytes) < 0.05;
  items.push({
    label: 'Free Space',
    passed: !lowSpace,
    severity: lowSpace ? 'warning' : 'ok',
    detail: lowSpace
      ? `Only ${formatBytes(volume.freeBytes)} free (${Math.round((volume.freeBytes / volume.totalBytes) * 100)}%)`
      : `${formatBytes(volume.freeBytes)} available`,
  });

  // 6. Metadata completeness
  const missingMeta = tracks.filter(t => !t.artist || !t.title || t.artist === 'Unknown Artist');
  items.push({
    label: 'Metadata',
    passed: missingMeta.length === 0,
    severity: missingMeta.length === 0 ? 'ok' : 'warning',
    detail: missingMeta.length === 0
      ? 'All tracks have artist and title tags'
      : `${missingMeta.length} track${missingMeta.length > 1 ? 's' : ''} missing metadata`,
  });

  return items;
}

// ========== Controller Compatibility ==========

type ControllerCompat = {
  controller: PioneerController;
  fsCompatible: boolean;
  formatIssues: string[]; // list of incompatible format names found on the drive
  compatible: boolean;
};

function computeControllerCompat(result: UsbHealthResult): ControllerCompat[] {
  const volumeFS = normalizeFS(result.volume.fileSystem || '');
  const formatCounts = countFormats(result.tracks);
  const driveFormats = new Set(Object.keys(formatCounts));

  return PIONEER_CONTROLLERS.map(ctrl => {
    const fsCompatible = ctrl.supportedFS.some(fs => normalizeFS(fs) === volumeFS);
    const formatIssues: string[] = [];
    for (const fmt of driveFormats) {
      if (fmt !== 'Unknown' && !ctrl.supportedFormats.has(fmt)) {
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

const WARN_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

// ========== Rendering ==========

function renderVolumeCard(path: string): HTMLDivElement {
  const entry = knownVolumes.get(path);
  if (!entry) return document.createElement('div');

  const card = document.createElement('div');
  card.className = 'cd-volume';
  card.dataset.volumePath = path;

  const vol = entry.volume;
  const fsBadgeClass = vol.isCompatible ? 'ok' : 'error';
  const fsLabel = vol.isCompatible ? 'FAT32' : escapeHtml(vol.fileSystem || 'Unknown FS');
  const libraryBadge = vol.isLibrary
    ? `<span class="cd-fs-badge ok" title="This volume contains your library root">Library</span>`
    : '';
  const hideBtn = vol.isLibrary
    ? ''
    : `<button class="btn-ghost btn-sm cd-hide" data-tooltip="Hide this device (adds to excluded volumes)">Hide</button>`;
  const rescanBtn = vol.isLibrary
    ? ''
    : `<button class="btn-ghost btn-sm cd-rescan" data-tooltip="Re-scan this volume">Re-scan</button>`;
  const collapseIcon = vol.isLibrary
    ? ''
    : `<span class="cd-collapse-icon">&#x25B8;</span>`;

  card.innerHTML = `
    <div class="cd-volume-header">
      <div class="cd-volume-info">
        <span class="cd-dot cd-dot-ok"></span>
        <span class="cd-usb-icon">${USB_ICON}</span>
        <span class="cd-volume-name">${escapeHtml(vol.name)}</span>
        <span class="cd-fs-badge ${fsBadgeClass}">${fsLabel}</span>
        ${libraryBadge}
        <span class="cd-volume-summary"></span>
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
        <span class="cd-scan-placeholder-text">Waiting for scan…</span>
      </div>
      <div class="cd-results-wrap" style="display:none;">
        <div class="cd-storage-bar-wrap"></div>
        <div class="cd-kpi-grid"></div>
        <div class="cd-section-label">Health Checklist</div>
        <div class="cd-checklist"></div>
        <div class="cd-format-breakdown"></div>
        <div class="cd-section-label">Controller Compatibility</div>
        <div class="cd-controller-grid"></div>
        <div class="cd-track-issues-header" style="display:none;"></div>
        <div class="cd-track-table-wrap">
          <table class="data-table cd-data-table">
            <thead>
              <tr>
                <th class="col-checkbox"><input type="checkbox" class="header-checkbox" title="Select all"></th>
                <th class="col-status">Status</th>
                <th class="col-artist">Artist</th>
                <th class="col-title">Title</th>
                <th class="col-format">Format</th>
                <th class="col-bitrate">Bit Rate</th>
                <th class="col-issues">Issues</th>
                <th class="col-row-actions"></th>
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
    const collapseIconEl = card.querySelector('.cd-collapse-icon') as HTMLElement;
    header.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.cd-rescan')) return;
      if ((e.target as HTMLElement).closest('.cd-hide')) return;
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? 'block' : 'none';
      collapseIconEl.innerHTML = collapsed ? '&#x25BE;' : '&#x25B8;';
      card.classList.toggle('cd-volume-expanded', collapsed);
    });
  } else {
    // Library card is status-only — hide the expand body entirely
    const body = card.querySelector('.cd-volume-body') as HTMLElement;
    if (body) body.style.display = 'none';
    const summaryEl = card.querySelector('.cd-volume-summary') as HTMLElement;
    if (summaryEl) summaryEl.textContent = 'Library volume — scan from the Library tab';
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
    }
  });

  return card;
}

function updateVolumeCardState(path: string) {
  const entry = knownVolumes.get(path);
  const card = volumeListEl.querySelector(`[data-volume-path="${CSS.escape(path)}"]`) as HTMLElement | null;
  if (!entry || !card) return;

  const summaryEl = card.querySelector('.cd-volume-summary') as HTMLElement;
  const dotEl = card.querySelector('.cd-dot') as HTMLElement;
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

  if (entry.scanning) {
    summaryEl.textContent = 'Scanning\u2026';
    summaryEl.className = 'cd-volume-summary cd-scanning';
    dotEl.className = 'cd-dot cd-dot-scanning';
    placeholder.style.display = 'flex';
    resultsWrap.style.display = 'none';
    return;
  }

  if (entry.error) {
    summaryEl.textContent = `Error: ${entry.error}`;
    summaryEl.className = 'cd-volume-summary cd-error';
    dotEl.className = 'cd-dot cd-dot-error';
    placeholder.style.display = 'none';
    resultsWrap.style.display = 'none';
    return;
  }

  if (!entry.result) {
    summaryEl.textContent = 'Pending\u2026';
    summaryEl.className = 'cd-volume-summary';
    placeholder.style.display = 'flex';
    resultsWrap.style.display = 'none';
    return;
  }

  placeholder.style.display = 'none';
  resultsWrap.style.display = 'block';

  const { summary, volumeIssues, volume, tracks } = entry.result;
  const sev = overallSeverity(entry);

  // Update dot
  dotEl.className = `cd-dot cd-dot-${sev}`;

  // Summary text
  const parts: string[] = [`${summary.total} tracks`];
  if (summary.errors > 0) parts.push(`${summary.errors} errors`);
  if (summary.warnings > 0) parts.push(`${summary.warnings} warnings`);
  if (!volume.isCompatible) parts.push('incompatible FS');
  if (summary.errors === 0 && summary.warnings === 0 && volume.isCompatible)
    parts.push('all healthy');
  summaryEl.textContent = parts.join(' · ');
  summaryEl.className = `cd-volume-summary cd-${sev}`;

  // Volume-level issues
  if (volumeIssues.length > 0) {
    issuesEl.innerHTML = volumeIssues.map(issue => `
      <div class="cd-issue ${issue.severity}">
        <strong>${escapeHtml(issue.code)}:</strong> ${escapeHtml(issue.message)}
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
  const avg = avgBitrate(tracks);
  const dur = totalDuration(tracks);

  kpiEl.innerHTML = `
    <div class="cd-kpi-card">
      <div class="cd-kpi-value">${summary.total}</div>
      <div class="cd-kpi-label">Total Tracks</div>
    </div>
    <div class="cd-kpi-card cd-kpi-accent">
      <div class="cd-kpi-value">${healthyPct}<span class="cd-kpi-unit">%</span></div>
      <div class="cd-kpi-label">Healthy</div>
      <div class="cd-kpi-bar"><div class="cd-kpi-bar-fill" style="width:${healthyPct}%"></div></div>
    </div>
    <div class="cd-kpi-card ${summary.errors > 0 ? 'cd-kpi-danger' : ''}">
      <div class="cd-kpi-value">${summary.errors}</div>
      <div class="cd-kpi-label">Errors</div>
    </div>
    <div class="cd-kpi-card ${summary.warnings > 0 ? 'cd-kpi-warning' : ''}">
      <div class="cd-kpi-value">${summary.warnings}</div>
      <div class="cd-kpi-label">Warnings</div>
    </div>
    <div class="cd-kpi-card">
      <div class="cd-kpi-value">${avg > 0 ? Math.round(avg / 1000) : '—'}<span class="cd-kpi-unit">${avg > 0 ? 'kbps' : ''}</span></div>
      <div class="cd-kpi-label">Avg Bitrate</div>
    </div>
    <div class="cd-kpi-card">
      <div class="cd-kpi-value">${dur > 0 ? formatDuration(dur) : '—'}</div>
      <div class="cd-kpi-label">Total Duration</div>
    </div>
  `;

  // Format breakdown
  const formatCounts = countFormats(tracks);
  const sortedFormats = Object.entries(formatCounts).sort((a, b) => b[1] - a[1]);
  if (sortedFormats.length > 0) {
    const maxCount = sortedFormats[0][1];
    formatEl.innerHTML = `
      <div class="cd-section-label">Format Breakdown</div>
      <div class="cd-format-bars">
        ${sortedFormats.map(([fmt, count]) => {
          const pct = total > 0 ? Math.round((count / total) * 100) : 0;
          const barW = maxCount > 0 ? Math.round((count / maxCount) * 100) : 0;
          const colorClass = containerColorClass(fmt);
          return `
            <div class="cd-format-row">
              <span class="cd-format-name ${colorClass}">${containerLabel(fmt)}</span>
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
      Compatible with <strong>${compatCount}</strong> of <strong>${compats.length}</strong> Pioneer DJ devices
    </div>
    <div class="cd-compat-cards">
      ${compats.map(c => {
        const cls = c.compatible ? 'cd-compat-yes' : 'cd-compat-no';
        const badge = c.compatible
          ? `<span class="cd-compat-badge cd-compat-badge-yes">${CHECK_ICON} Ready</span>`
          : `<span class="cd-compat-badge cd-compat-badge-no">${X_ICON} ${!c.fsCompatible ? 'Wrong FS' : c.formatIssues.join(', ')}</span>`;
        const catLabel = c.controller.category === 'flagship' ? 'Club Standard'
          : c.controller.category === 'all-in-one' ? 'All-in-One' : 'Standalone';
        return `
          <div class="cd-compat-card ${cls}">
            <div class="cd-compat-img-wrap">
              <img
                src="${c.controller.imageUrl}"
                alt="${escapeHtml(c.controller.name)}"
                class="cd-compat-img"
                loading="lazy"
                onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"
              />
              <div class="cd-compat-img-fallback" style="display:none">${escapeHtml(c.controller.name)}</div>
            </div>
            <div class="cd-compat-info">
              <div class="cd-compat-name">${escapeHtml(c.controller.name)}</div>
              <div class="cd-compat-cat">${catLabel}</div>
              ${badge}
            </div>
          </div>`;
      }).join('')}
    </div>
  `;

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
    trackIssuesHeader.innerHTML = `<div class="cd-section-label">Tracks with Issues <span class="cd-count-badge">${issuesTracks.length}</span></div>`;
    const sorted = sortTracks(issuesTracks, 'status', 'desc');
    tbody.innerHTML = '';
    const frag = document.createDocumentFragment();
    sorted.forEach(track => {
      frag.appendChild(createTrackRow(track, {
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
  const entry = knownVolumes.get(volumePath);
  if (!entry?.result) return;

  entry.result.tracks = entry.result.tracks.filter(t => t.filePath !== track.filePath);

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

  const items: { label: string; icon: string; action: () => void }[] = [];

  if (convertible.length > 0) {
    items.push({
      label: `Convert ${convertible.length} to AIFF`,
      icon: icons.wrench,
      action: () => bulkConvertToAiff(convertible, volumePath),
    });
  }

  items.push({
    label: `Archive ${n} tracks`,
    icon: icons.archive,
    action: () => bulkArchive(archivable, volumePath),
  });

  items.push({
    label: `Delete ${n} tracks`,
    icon: icons.trash,
    action: () => bulkDelete(deletable, volumePath),
  });

  showContextMenu(e.clientX, e.clientY, items);
}

async function bulkConvertToAiff(tracks: LibraryHealthTrack[], volumePath: string) {
  let ok = 0;
  let fail = 0;
  for (const track of tracks) {
    try {
      const result = await window.candybar.fixTrackFile(track.filePath, false);
      if (result.success) {
        removeTrackFromUsbResult(volumePath, track);
        getCheckedSet(volumePath).delete(track.filePath);
        ok++;
      } else { fail++; }
    } catch { fail++; }
  }
  if (ok > 0) showToast('success', 'Bulk Convert', `${ok} track${ok > 1 ? 's' : ''} converted to AIFF.`);
  if (fail > 0) showToast('error', 'Bulk Convert', `${fail} track${fail > 1 ? 's' : ''} failed to convert.`);
}

async function bulkArchive(tracks: LibraryHealthTrack[], volumePath: string) {
  let ok = 0;
  let fail = 0;
  for (const track of tracks) {
    try {
      const result = await window.candybar.archiveTrackFile(track.filePath);
      if (result.success) {
        removeTrackFromUsbResult(volumePath, track);
        getCheckedSet(volumePath).delete(track.filePath);
        ok++;
      } else { fail++; }
    } catch { fail++; }
  }
  if (ok > 0) showToast('success', 'Bulk Archive', `${ok} track${ok > 1 ? 's' : ''} archived.`);
  if (fail > 0) showToast('error', 'Bulk Archive', `${fail} track${fail > 1 ? 's' : ''} failed to archive.`);
}

async function bulkDelete(tracks: LibraryHealthTrack[], volumePath: string) {
  let ok = 0;
  let fail = 0;
  for (const track of tracks) {
    try {
      const result = await window.candybar.deleteTrackFile(track.filePath);
      if (result.success) {
        removeTrackFromUsbResult(volumePath, track);
        getCheckedSet(volumePath).delete(track.filePath);
        ok++;
      } else { fail++; }
    } catch { fail++; }
  }
  if (ok > 0) showToast('success', 'Bulk Delete', `${ok} track${ok > 1 ? 's' : ''} deleted.`);
  if (fail > 0) showToast('error', 'Bulk Delete', `${fail} track${fail > 1 ? 's' : ''} failed to delete.`);
}

async function handleUsbTrackAction(
  action: 'fix' | 'reencode' | 'edit' | 'archive' | 'delete',
  track: LibraryHealthTrack,
  volumePath: string
) {
  if (action === 'delete') {
    try {
      const result = await window.candybar.deleteTrackFile(track.filePath);
      if (result.success) {
        showToast('success', 'Track Deleted', `${track.fileName} has been deleted.`);
        removeTrackFromUsbResult(volumePath, track);
      } else {
        showToast('error', 'Delete Failed', result.error || 'Unknown error deleting file.');
      }
    } catch (err) {
      showToast('error', 'Delete Failed', getErrorMessage(err));
    }
  } else if (action === 'archive') {
    try {
      const result = await window.candybar.archiveTrackFile(track.filePath);
      if (result.success) {
        showToast('success', 'Track Archived', `${track.fileName} moved to archive.`);
        removeTrackFromUsbResult(volumePath, track);
      } else {
        showToast('error', 'Archive Failed', result.errorMessage || 'Unknown error archiving file.');
      }
    } catch (err) {
      showToast('error', 'Archive Failed', getErrorMessage(err));
    }
  } else if (action === 'fix') {
    try {
      const result = await window.candybar.fixTrackFile(track.filePath, false);
      if (result.success) {
        showToast('success', 'Converted to AIFF', `${track.fileName} has been converted.`);
        removeTrackFromUsbResult(volumePath, track);
      } else {
        showToast('error', 'Conversion Failed', result.errorMessage || 'Unknown error during conversion.');
      }
    } catch (err) {
      showToast('error', 'Conversion Failed', getErrorMessage(err));
    }
  } else if (action === 'reencode') {
    try {
      const result = await window.candybar.reencodeTrackFile(track.filePath, false);
      if (result.success) {
        showToast('success', 'Re-encoded to MP3', `${track.fileName} has been re-encoded at 320kbps.`);
        removeTrackFromUsbResult(volumePath, track);
      } else {
        showToast('error', 'Re-encode Failed', result.errorMessage || 'Unknown error during re-encoding.');
      }
    } catch (err) {
      showToast('error', 'Re-encode Failed', getErrorMessage(err));
    }
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
      }
    }

    // Update visibility
    section.style.display = knownVolumes.size > 0 ? 'block' : 'none';
    statusEl.textContent = knownVolumes.size > 0
      ? `${knownVolumes.size} device${knownVolumes.size > 1 ? 's' : ''}`
      : '';
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
    // Register a single job-progress listener that attributes events by jobType
    if (!jobProgressListenerRegistered) {
      jobProgressListenerRegistered = true;
      window.candybar.onJobProgress((progress: { jobType?: string; current?: number; total?: number; detail?: unknown }) => {
        if (progress.jobType !== 'usb-health-scan' || !activeScanPath) return;
        const card = volumeListEl.querySelector(`[data-volume-path="${CSS.escape(activeScanPath)}"]`);
        const summaryEl = card?.querySelector('.cd-volume-summary');
        if (!summaryEl) return;
        const total = progress.total ?? 0;
        const current = progress.current ?? 0;
        const detail = typeof progress.detail === 'string' ? progress.detail.split('/').pop() : '';
        summaryEl.textContent = detail
          ? `Scanning ${current}/${total}: ${detail}`
          : `Scanning ${current}/${total}…`;
      });
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
        entry.error = response.error || 'Scan failed';
      }
    } catch (err) {
      entry.error = getErrorMessage(err, 'Scan failed');
    } finally {
      entry.scanning = false;
      activeScanPath = null;
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
