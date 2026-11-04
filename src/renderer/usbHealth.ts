import type { VolumeInfo, UsbHealthResult, LibraryHealthTrack } from './shared';
import type { JobProgress } from '../types';
import { showToast, escapeHtml, getErrorMessage, plural } from './shared';
import { type SortKey, getFilteredTracks, sortTracks, createTrackRow } from './healthTrackTable';
import { type PioneerDevice, PIONEER_DEVICES, containerLabel, countFormats, categoryLabel } from './pioneerDevices';

// File types that can appear as rows in "Which players can read it"
const KNOWN_FORMATS = ['WAVE', 'AIFF', 'MPEG', 'MP4', 'FLAC', 'OGG'] as const;

// ========== DOM ==========

const volumeList = document.getElementById('usb-volume-list') as HTMLDivElement;
const refreshBtn = document.getElementById('usb-refresh-volumes') as HTMLButtonElement;
const selectFolderBtn = document.getElementById('usb-select-folder') as HTMLButtonElement;
const scanBtn = document.getElementById('usb-scan-btn') as HTMLButtonElement;

const progressSection = document.getElementById('usb-progress-section') as HTMLElement;
const progressBar = document.getElementById('usb-progress-bar') as HTMLDivElement;
const progressMessage = document.getElementById('usb-progress-message') as HTMLElement;
const progressCount = document.getElementById('usb-progress-count') as HTMLSpanElement;

const resultsWrap = document.getElementById('usb-results') as HTMLDivElement;
const driveOverviewEl = document.getElementById('usb-drive-overview') as HTMLDivElement;
const statGridEl = document.getElementById('usb-kpi-grid') as HTMLDivElement;
const matrixWrap = document.getElementById('usb-matrix-wrap') as HTMLDivElement;
const compatSummaryEl = document.getElementById('usb-compat-summary') as HTMLSpanElement;
const checklistEl = document.getElementById('usb-checklist') as HTMLDivElement;
const checklistTitleEl = document.getElementById('usb-checklist-title') as HTMLElement | null;
const checklistDescEl = document.getElementById('usb-checklist-desc') as HTMLElement | null;
const formatBreakdownEl = document.getElementById('usb-format-breakdown') as HTMLDivElement;
const formatHintEl = document.getElementById('usb-format-hint') as HTMLElement | null;

const tableSection = document.getElementById('usb-table-section') as HTMLDetailsElement | null;
const tracksHintEl = document.getElementById('usb-tracks-hint');
const tableBody = document.getElementById('usb-table-body') as HTMLTableSectionElement;
const tableEl = document.getElementById('usb-data-table') as HTMLTableElement;
const tableContainer = tableEl?.closest('.table-container') as HTMLElement | null;
const tableEmpty = document.getElementById('usb-table-empty') as HTMLElement;
const trackCountEl = document.getElementById('usb-track-count') as HTMLElement;
const filterTabs = document.querySelectorAll<HTMLButtonElement>('.usb-filter-tab');

// ========== State ==========

let usbResult: UsbHealthResult | null = null;
let selectedVolumePath: string | null = null;
/** True when the selection is a folder from "Check a folder instead", not a drive. */
let selectedIsFolder = false;
/** Name of the picked stick or folder, for the "Check <name>" button. */
let selectedName: string | null = null;
/** Path of the drive or folder the results on screen belong to. */
let resultPath: string | null = null;
let scanRunning = false;

// Track table: problems sort to the top so they're the first thing on screen.
type TableFilter = 'all' | 'errors' | 'warnings';
let tableFilter: TableFilter = 'all';
let sortKey: SortKey = 'status';
let sortDir: 'asc' | 'desc' = 'desc';

// Progress for the check this page started. job-progress carries no context
// key, so the job id is latched from the first event whose file sits under
// the drive being checked; later events must match that id.
let scanVolumePath: string | null = null;
let scanJobId: string | null = null;

// ========== Icons (24×24, stroke 2, round caps) ==========

const svg = (body: string, cls = '') =>
  `<svg${cls ? ` class="${cls}"` : ''} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const CHECK_ICON = svg('<polyline points="20 6 9 17 4 12"/>');
const X_ICON = svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>');
const WARN_ICON = svg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>');
const STICK_BODY = '<rect x="7" y="9" width="10" height="13" rx="2"/><path d="M9 9V3h6v6"/><line x1="11" y1="5.5" x2="11" y2="6.5"/><line x1="13" y1="5.5" x2="13" y2="6.5"/>';
const FOLDER_BODY = '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>';
const ALERT_BODY = '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>';
const REFRESH_BODY = '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>';

// ========== Formatting helpers ==========

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function baseName(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

/** "is" / "are" for a count. */
const isAre = (n: number) => (n === 1 ? 'is' : 'are');

// ========== Drive format, in plain words ==========
// diskutil reports names like "MS-DOS (FAT32)", "ExFAT", "Mac OS Extended
// (Journaled)", "APFS" and "Windows NT File System (NTFS)". Pioneer players
// read FAT32/FAT16 everywhere and Mac OS Extended on most models; none read
// APFS or NTFS. This page reads the device list in pioneerDevices.ts, so the
// pill on a drive and the player table agree.

type DriveFormatKey = 'FAT32' | 'FAT16' | 'exFAT' | 'HFS+' | 'APFS' | 'NTFS' | 'other';
type DriveFormat = { key: DriveFormatKey; label: string; short: string };

function driveFormat(fileSystem: string | null | undefined): DriveFormat {
  const fs = fileSystem || '';
  if (/apfs/i.test(fs)) return { key: 'APFS', label: 'APFS (a Mac format)', short: 'APFS' };
  if (/hfs|mac os extended/i.test(fs)) return { key: 'HFS+', label: 'Mac OS Extended', short: 'Mac OS Extended' };
  if (/exfat/i.test(fs)) return { key: 'exFAT', label: 'exFAT', short: 'exFAT' };
  if (/fat\s*16/i.test(fs)) return { key: 'FAT16', label: 'FAT16', short: 'FAT16' };
  if (/fat/i.test(fs)) return { key: 'FAT32', label: 'FAT32', short: 'FAT32' };
  if (/ntfs/i.test(fs)) return { key: 'NTFS', label: 'NTFS (a Windows format)', short: 'NTFS' };
  return { key: 'other', label: fs ? fs : 'a format Track Lab doesn\'t recognise', short: fs || 'unknown format' };
}

function deviceReadsDrive(device: PioneerDevice, fmt: DriveFormat): boolean {
  if (fmt.key === 'APFS' || fmt.key === 'NTFS' || fmt.key === 'other') return false;
  return device.supportedFS.includes(fmt.key);
}

type Tone = 'ok' | 'warn' | 'danger';
type DriveReadability = { tone: Tone; text: string; hint: string; readers: number; total: number; fmt: DriveFormat };

const REFORMAT_ADVICE = 'Copy your music off the stick, reformat it as MS-DOS (FAT) in Disk Utility, then export your playlists to it again from Rekordbox. Reformatting erases everything on the stick.';

function driveReadability(fileSystem: string | null | undefined): DriveReadability {
  const fmt = driveFormat(fileSystem);
  const total = PIONEER_DEVICES.length;
  const readers = PIONEER_DEVICES.filter((d) => deviceReadsDrive(d, fmt)).length;
  if (readers === total) {
    return { tone: 'ok', text: 'Works on Pioneer players', hint: `This stick uses ${fmt.label}, which every Pioneer player can read.`, readers, total, fmt };
  }
  if (readers > 0) {
    return {
      tone: 'warn',
      text: `Some Pioneer players can't read this drive (${fmt.short})`,
      hint: `This stick uses ${fmt.label}. Only ${readers} of ${total} Pioneer players can read it. FAT32 (called MS-DOS (FAT) on a Mac) works on all of them.`,
      readers, total, fmt,
    };
  }
  return {
    tone: 'danger',
    text: `Pioneer players can't read this drive (${fmt.short})`,
    hint: `This stick uses ${fmt.label}. Pioneer players need FAT32, called MS-DOS (FAT) in the Mac's Disk Utility.`,
    readers, total, fmt,
  };
}

// ========== Drive list ==========

function setScanButtonLabel() {
  const showingThis = !!usbResult && resultPath !== null && resultPath === selectedVolumePath;
  const named = selectedName && selectedName.length <= 24 ? `Check ${selectedName}` : 'Check this USB';
  scanBtn.textContent = showingThis ? 'Check again' : selectedIsFolder ? 'Check this folder' : named;
  scanBtn.dataset.tooltipDisabled = scanRunning ? 'Track Lab is checking it now' : 'Pick a USB stick above first';
}

const volumeTitleEl = document.getElementById('usb-volume-title');
const volumeDescEl = document.getElementById('usb-volume-desc');
function setVolumeHeading(title: string, desc: string) {
  if (volumeTitleEl) volumeTitleEl.textContent = title;
  if (volumeDescEl) volumeDescEl.textContent = desc;
}

function updateScanButton() {
  scanBtn.disabled = scanRunning || !selectedVolumePath;
  setScanButtonLabel();
}

function renderVolumeEmpty() {
  refreshBtn.hidden = true;
  volumeList.innerHTML = `
    <div class="empty-state usb-empty">
      <div class="empty-state-icon">${svg(STICK_BODY)}</div>
      <h4>No USB stick found</h4>
      <p>Plug one in, then press Look again.</p>
      <div class="empty-state-actions"><button type="button" class="btn-secondary" data-usb-action="refresh">${svg(REFRESH_BODY)}Look again</button></div>
    </div>`;
}

function renderVolumeError() {
  refreshBtn.hidden = true;
  volumeList.innerHTML = `
    <div class="empty-state usb-empty">
      <div class="empty-state-icon usb-empty-icon--danger">${svg(ALERT_BODY)}</div>
      <h4>Track Lab couldn't look for USB sticks</h4>
      <p>Press Look again. If it keeps happening, quit and reopen Track Lab.</p>
      <div class="empty-state-actions"><button type="button" class="btn-secondary" data-usb-action="refresh">${svg(REFRESH_BODY)}Look again</button></div>
    </div>`;
}

function driveCardHtml(vol: VolumeInfo): string {
  const r = driveReadability(vol.fileSystem);
  const size = vol.totalBytes > 0
    ? `${formatBytes(vol.freeBytes)} free of ${formatBytes(vol.totalBytes)}`
    : 'Size unknown';
  const selected = selectedVolumePath === vol.path;
  return `
    <button type="button" class="choice-card usb-drive-card${selected ? ' is-selected' : ''}" role="radio" aria-checked="${selected}" data-kind="drive" data-path="${escapeHtml(vol.path)}">
      ${svg(STICK_BODY, 'choice-icon')}
      <strong class="usb-drive-name">${escapeHtml(vol.name)}</strong>
      <span>${escapeHtml(size)}${vol.isLibrary ? ' · your library drive' : ''}</span>
      <span class="status-pill status-pill--${r.tone} usb-drive-verdict" data-tooltip="${escapeHtml(r.hint)}">${escapeHtml(r.text)}</span>
    </button>`;
}

function folderCardHtml(folder: string): string {
  return `
    <div class="usb-single" data-kind="folder" data-path="${escapeHtml(folder)}">
      <span class="usb-single-icon">${svg(FOLDER_BODY)}</span>
      <div class="usb-single-text">
        <strong class="usb-drive-name">${escapeHtml(baseName(folder))}</strong>
        <span class="usb-drive-path" title="${escapeHtml(folder)}">${escapeHtml(folder)}</span>
      </div>
      <span class="status-pill status-pill--info usb-drive-verdict">A folder on your computer</span>
    </div>`;
}

function wireDriveCards() {
  volumeList.querySelectorAll<HTMLButtonElement>('.usb-drive-card').forEach((card) => {
    card.addEventListener('click', () => {
      selectedVolumePath = card.dataset.path ?? null;
      selectedIsFolder = card.dataset.kind === 'folder';
      selectedName = card.querySelector('.usb-drive-name')?.textContent ?? null;
      volumeList.querySelectorAll<HTMLElement>('.usb-drive-card').forEach((c) => {
        const on = c === card;
        c.classList.toggle('is-selected', on);
        c.setAttribute('aria-checked', String(on));
      });
      updateScanButton();
    });
  });
}

/** One stick plugged in: no choosing, just show it. */
function singleDriveHtml(vol: VolumeInfo): string {
  const r = driveReadability(vol.fileSystem);
  const size = vol.totalBytes > 0
    ? `${formatBytes(vol.freeBytes)} free of ${formatBytes(vol.totalBytes)}`
    : 'Size unknown';
  return `
    <div class="usb-single" data-path="${escapeHtml(vol.path)}">
      <span class="usb-single-icon">${svg(STICK_BODY)}</span>
      <div class="usb-single-text">
        <strong class="usb-drive-name">${escapeHtml(vol.name)}</strong>
        <span>${escapeHtml(size)}${vol.isLibrary ? ' · your library drive' : ''}</span>
      </div>
      <span class="status-pill status-pill--${r.tone} usb-drive-verdict" data-tooltip="${escapeHtml(r.hint)}">${escapeHtml(r.text)}</span>
    </div>`;
}

function renderVolumeList(volumes: VolumeInfo[]) {
  selectedIsFolder = false;
  if (volumes.length === 0) {
    selectedVolumePath = null;
    selectedName = null;
    setVolumeHeading('Your USB stick', 'Sticks you plug in show up here.');
    renderVolumeEmpty();
    updateScanButton();
    return;
  }
  refreshBtn.hidden = false;
  if (volumes.length === 1) {
    selectedVolumePath = volumes[0].path;
    selectedName = volumes[0].name;
    setVolumeHeading('Your USB stick', 'Track Lab found this stick. Plugged in the wrong one? Swap it, then press Look again.');
    volumeList.innerHTML = singleDriveHtml(volumes[0]);
    updateScanButton();
    return;
  }
  // Several drives: keep the pick across a Look again, otherwise ask.
  const kept = volumes.find((v) => v.path === selectedVolumePath);
  selectedVolumePath = kept?.path ?? null;
  selectedName = kept?.name ?? null;
  setVolumeHeading('Which stick?', `Track Lab found ${volumes.length} drives. Pick the one you want to check.`);
  volumeList.innerHTML = `<div class="choice-grid usb-drive-grid" role="radiogroup" aria-label="USB sticks">${volumes.map(driveCardHtml).join('')}</div>`;
  wireDriveCards();
  updateScanButton();
}

// ========== Verdict ==========

type Verdict = { tone: Tone; pill: string; headline: string; sentence: string };

function overallVerdict(result: UsbHealthResult): Verdict {
  const { summary } = result;
  const drive = driveReadability(result.volume.fileSystem);
  const alsoTracks = summary.errors > 0 ? ` On top of that, ${plural(summary.errors, 'track')} won't play.` : '';
  if (!isFolderResult(result) && drive.readers === 0) {
    return {
      tone: 'danger', pill: 'Won\'t work',
      headline: 'This drive won\'t work: Pioneer players can\'t read it',
      sentence: `It uses ${drive.fmt.label}, and Pioneer players need FAT32. What to fix below explains how to change it.${alsoTracks}`,
    };
  }
  if (!isFolderResult(result) && drive.readers < drive.total) {
    return {
      tone: 'danger', pill: 'Won\'t work everywhere',
      headline: 'This drive won\'t work on every player',
      sentence: `It uses ${drive.fmt.label}, which only ${drive.readers} of ${drive.total} Pioneer players can read. FAT32 works on all of them.${alsoTracks}`,
    };
  }
  if (summary.total === 0) {
    return {
      tone: 'warn', pill: 'No music',
      headline: 'No music found here',
      sentence: 'Track Lab didn\'t find any audio files. Check you picked the right drive, or export your playlists to it from Rekordbox first.',
    };
  }
  if (summary.errors > 0) {
    const rest = summary.total - summary.errors;
    return {
      tone: 'danger', pill: 'Not ready',
      headline: `${plural(summary.errors, 'track')} won't play on CDJs`,
      sentence: rest > 0
        ? `The other ${plural(rest, 'track')} will. What to fix below says why, and what to do.`
        : 'None of the tracks here will play. What to fix below says why, and what to do.',
    };
  }
  if (summary.warnings > 0) {
    return {
      tone: 'ok', pill: 'Ready',
      headline: 'Ready for your gig',
      sentence: `Every track will play. ${plural(summary.warnings, 'track')} ${isAre(summary.warnings)} worth fixing when you have time.`,
    };
  }
  return {
    tone: 'ok', pill: 'Ready',
    headline: 'Ready for your gig',
    sentence: summary.total === 1
      ? 'The one track here will play on Pioneer CDJs and XDJs.'
      : `All ${plural(summary.total, 'track')} will play on Pioneer CDJs and XDJs.`,
  };
}

/** A folder picked with "Check a folder instead" usually sits on the Mac's own
 *  disk, so its drive format says nothing about the stick it will end up on. */
let resultIsFolder = false;
function isFolderResult(_result: UsbHealthResult): boolean {
  return resultIsFolder;
}

/** The name to show for what was checked: the stick's name, or the folder's. */
function checkedName(result: UsbHealthResult): string {
  return resultIsFolder ? baseName(result.volume.path) : result.volume.name;
}

function renderDriveOverview(result: UsbHealthResult) {
  const { volume, summary } = result;
  const verdict = overallVerdict(result);
  const icon = verdict.tone === 'ok' ? CHECK_ICON : verdict.tone === 'warn' ? WARN_ICON : X_ICON;
  const folder = isFolderResult(result);
  const fmt = driveFormat(volume.fileSystem);
  const usedBytes = Math.max(0, volume.totalBytes - volume.freeBytes);
  const usedPct = volume.totalBytes > 0 ? Math.round((usedBytes / volume.totalBytes) * 100) : 0;
  const storageTone = usedPct > 95 ? 'danger' : usedPct > 85 ? 'warn' : '';

  const driveLine = folder
    ? `<span class="usb-verdict-drive">${svg(FOLDER_BODY)}<strong>${escapeHtml(baseName(volume.path))}</strong> · a folder on your computer</span>`
    : `<span class="usb-verdict-drive">${svg(STICK_BODY)}<strong>${escapeHtml(volume.name)}</strong> · ${escapeHtml(fmt.short)}${volume.totalBytes > 0 ? ` · ${formatBytes(volume.freeBytes)} free of ${formatBytes(volume.totalBytes)}` : ''}</span>`;

  driveOverviewEl.innerHTML = `
    <div class="usb-verdict usb-verdict--${verdict.tone}">
      <span class="usb-verdict-icon">${icon}</span>
      <div class="usb-verdict-body">
        <span class="status-pill status-pill--${verdict.tone}">${escapeHtml(verdict.pill)}</span>
        <h3 class="usb-verdict-headline">${escapeHtml(verdict.headline)}</h3>
        <p class="usb-verdict-sentence">${escapeHtml(verdict.sentence)}</p>
        ${driveLine}
        ${!folder && volume.totalBytes > 0 ? `
        <div class="usb-storage-bar ${storageTone}" role="img" aria-label="${usedPct}% of the stick is used">
          <div class="usb-storage-fill" style="width:${usedPct}%"></div>
        </div>` : ''}
      </div>
    </div>`;

  // Numbers people care about, in plain words. The two problem tiles filter the track list.
  statGridEl.innerHTML = `
    <div class="stat-tile stat-tile--ok">
      <span class="stat-value">${summary.healthy.toLocaleString()}</span>
      <span class="stat-label">Play fine</span>
      <span class="stat-hint">Nothing to do</span>
    </div>
    <button type="button" class="stat-tile${summary.warnings > 0 ? ' stat-tile--warn' : ''}" data-usb-filter="warnings" data-tooltip="Show only these in the track list">
      <span class="stat-value">${summary.warnings.toLocaleString()}</span>
      <span class="stat-label">Worth fixing</span>
      <span class="stat-hint">They play, but could be better</span>
    </button>
    <button type="button" class="stat-tile${summary.errors > 0 ? ' stat-tile--danger' : ''}" data-usb-filter="errors" data-tooltip="Show only these in the track list">
      <span class="stat-value">${summary.errors.toLocaleString()}</span>
      <span class="stat-label">Won't play</span>
      <span class="stat-hint">Fix these before the gig</span>
    </button>
    ${folder || volume.totalBytes <= 0 ? '' : `
    <div class="stat-tile">
      <span class="stat-value">${escapeHtml(formatBytes(volume.freeBytes))}</span>
      <span class="stat-label">Free space</span>
      <span class="stat-hint">of ${escapeHtml(formatBytes(volume.totalBytes))}</span>
    </div>`}
  `;
  statGridEl.querySelectorAll<HTMLButtonElement>('[data-usb-filter]').forEach((tile) => {
    tile.addEventListener('click', () => {
      showTracks(tile.dataset.usbFilter as TableFilter);
    });
  });
}

// ========== Which players can read it ==========

type CellState = 'pass' | 'fail';

function computeMatrix(result: UsbHealthResult) {
  const fmt = driveFormat(result.volume.fileSystem);
  const folder = isFolderResult(result);
  const formatCounts = countFormats(result.tracks);
  const driveFormats = KNOWN_FORMATS.filter((f) => (formatCounts[f] || 0) > 0);

  const rows: Array<{ label: string; type: 'fs' | 'format'; key: string; cells: CellState[]; trackCount?: number }> = [];
  // A folder on the Mac's own disk says nothing about the stick it will end up on.
  if (!folder) {
    rows.push({
      label: `Drive format: ${fmt.short}`,
      type: 'fs',
      key: fmt.key,
      cells: PIONEER_DEVICES.map((d) => (deviceReadsDrive(d, fmt) ? 'pass' : 'fail')),
    });
  }
  for (const f of driveFormats) {
    rows.push({
      label: `${containerLabel(f)} files`,
      type: 'format',
      key: f,
      trackCount: formatCounts[f] || 0,
      cells: PIONEER_DEVICES.map((d) => (d.supportedFormats.has(f) ? 'pass' : 'fail')),
    });
  }

  const verdicts = PIONEER_DEVICES.map((device, col) => {
    const reasons: string[] = [];
    for (const row of rows) {
      if (row.cells[col] !== 'fail') continue;
      reasons.push(row.type === 'fs' ? 'Can\'t read the drive' : `Can't play ${containerLabel(row.key)}`);
    }
    return { device, compatible: reasons.length === 0, reasons };
  });
  return { rows, verdicts };
}

function renderMatrix(result: UsbHealthResult) {
  const { rows, verdicts } = computeMatrix(result);

  const headerCells = PIONEER_DEVICES.map((d, i) => `
    <th class="usb-matrix-col${verdicts[i].compatible ? '' : ' is-fail'}" scope="col">
      <div class="usb-matrix-device-name">${escapeHtml(d.name)}</div>
      <div class="usb-matrix-device-cat">${escapeHtml(categoryLabel(d.category))}</div>
    </th>`).join('');

  const bodyRows = rows.map((row) => {
    const cells = row.cells.map((c, i) => {
      const what = row.type === 'fs' ? 'reads this drive' : `plays ${containerLabel(row.key)}`;
      const label = `${PIONEER_DEVICES[i].name} ${c === 'pass' ? what : what.replace(/^reads/, 'can\'t read').replace(/^plays/, 'can\'t play')}`;
      return `<td class="usb-matrix-cell ${c}" title="${escapeHtml(label)}"><span class="usb-matrix-mark" role="img" aria-label="${c === 'pass' ? 'Yes' : 'No'}">${c === 'pass' ? CHECK_ICON : X_ICON}</span></td>`;
    }).join('');
    const count = row.type === 'format' && row.trackCount ? `<span class="usb-matrix-row-count">${plural(row.trackCount, 'track')}</span>` : '';
    return `<tr><th class="usb-matrix-label" scope="row">${escapeHtml(row.label)}${count}</th>${cells}</tr>`;
  }).join('');

  const verdictRow = verdicts.map((v) => {
    const tone = v.compatible ? 'ok' : 'danger';
    const label = v.compatible ? 'Ready' : v.reasons[0];
    return `<td class="usb-matrix-verdict"><span class="status-pill status-pill--${tone}" title="${escapeHtml(v.reasons.join('. '))}">${escapeHtml(label)}</span></td>`;
  }).join('');

  matrixWrap.innerHTML = `
    <table class="usb-matrix">
      <thead><tr><th class="usb-matrix-corner" scope="col">Player</th>${headerCells}</tr></thead>
      <tbody>
        ${bodyRows}
        <tr class="usb-matrix-row-verdict"><th class="usb-matrix-label" scope="row">Overall</th>${verdictRow}</tr>
      </tbody>
    </table>`;

  const okCount = verdicts.filter((v) => v.compatible).length;
  compatSummaryEl.textContent = okCount === verdicts.length
    ? `Works on all ${verdicts.length} players`
    : `Works on ${okCount} of ${verdicts.length} players`;
}

// ========== What to fix ==========

type FixItem = {
  severity: 'ok' | 'warning' | 'error';
  title: string;
  /** What it means, in plain words. */
  meaning?: string;
  /** What to do about it. */
  todo?: string;
  /** The short "all good" line when nothing's wrong. */
  okLine?: string;
  /** Offer a "Show these tracks" link that opens the track list at this filter. */
  showFilter?: TableFilter;
};

function devicesMissingFormat(fmt: string): PioneerDevice[] {
  return PIONEER_DEVICES.filter((d) => !d.supportedFormats.has(fmt));
}

function buildChecklist(result: UsbHealthResult): FixItem[] {
  const { volume, summary, tracks, volumeIssues } = result;
  const items: FixItem[] = [];
  const folder = isFolderResult(result);

  // Drive format (not meaningful for a folder on the Mac's own disk)
  if (!folder) {
    const drive = driveReadability(volume.fileSystem);
    items.push(drive.tone === 'ok'
      ? { severity: 'ok', title: 'Drive format', okLine: `${drive.fmt.short}, which every Pioneer player can read.` }
      : {
        severity: 'error',
        title: drive.readers === 0 ? 'Pioneer players can\'t read this drive' : 'Some Pioneer players can\'t read this drive',
        meaning: drive.hint,
        todo: REFORMAT_ADVICE,
      });
  }

  // Tracks that won't play at all
  items.push(summary.errors > 0
    ? {
      severity: 'error',
      title: `${plural(summary.errors, 'track')} won't play`,
      meaning: 'Pioneer players can\'t open these files. Show these tracks to see why for each one, and point at a label to see what it means.',
      todo: 'Fix them in your library first (the Library page can convert most of them to AIFF, which sounds the same), then export them to this stick again from Rekordbox.',
      showFilter: 'errors',
    }
    : { severity: 'ok', title: 'Every track opens', okLine: 'No damaged or unplayable files.' });

  // File types older players can't play
  const counts = countFormats(tracks);
  const picky = (['FLAC', 'OGG'] as const).filter((f) => counts[f]);
  if (picky.length > 0) {
    const n = picky.reduce((s, f) => s + (counts[f] || 0), 0);
    const missing = devicesMissingFormat(picky[0]);
    const example = missing.find((d) => d.name === 'XDJ-RX3') ?? missing[0];
    items.push({
      severity: 'warning',
      title: `${plural(n, 'track')} ${isAre(n)} ${picky.map(containerLabel).join(' or ')} ${n === 1 ? 'file' : 'files'}`,
      meaning: `${missing.length} of ${PIONEER_DEVICES.length} Pioneer players${example ? `, like the ${example.name},` : ''} can't play ${picky.map(containerLabel).join(' or ')}.`,
      todo: 'Convert them to AIFF in your library (it sounds the same), then export them to the stick again.',
    });
  } else {
    items.push({ severity: 'ok', title: 'File types', okLine: 'Every file type here plays on Pioneer players.' });
  }

  // Sample rate
  const validRates = new Set([32000, 44100, 48000]);
  const badRate = tracks.filter((t) => t.format.sampleRate != null && !validRates.has(t.format.sampleRate)).length;
  items.push(badRate > 0
    ? {
      severity: 'warning',
      title: `${plural(badRate, 'track')} ${badRate === 1 ? 'uses' : 'use'} an unusual sample rate`,
      meaning: 'The sample rate is how finely the sound was recorded. Pioneer players expect 44.1 or 48 kHz.',
      todo: 'Convert them to AIFF at 44.1 kHz from the Library page, then export them again.',
    }
    : { severity: 'ok', title: 'Sound settings', okLine: 'Every track uses a sample rate Pioneer players accept.' });

  // Free space
  if (!folder) {
    const lowSpace = volume.totalBytes > 0 && (volume.freeBytes / volume.totalBytes) < 0.05;
    items.push(lowSpace
      ? {
        severity: 'warning',
        title: `Only ${formatBytes(volume.freeBytes)} free`,
        meaning: 'Rekordbox needs room on the stick for the waveforms and cue points it saves.',
        todo: 'Remove a few tracks or playlists you won\'t need at this gig.',
      }
      : { severity: 'ok', title: 'Free space', okLine: `${formatBytes(volume.freeBytes)} free.` });
  }

  // Track info
  const noInfo = tracks.filter((t) => !t.artist || !t.title).length;
  items.push(noInfo > 0
    ? {
      severity: 'warning',
      title: `${plural(noInfo, 'track')} ${noInfo === 1 ? 'has' : 'have'} no artist or title`,
      meaning: 'They show up as file names on the player, which makes them hard to find mid-set.',
      todo: 'Add the artist and title in Rekordbox or on the Library page, then export them again.',
    }
    : { severity: 'ok', title: 'Track info', okLine: 'Every track has an artist and a title.' });

  // Anything else the check reported about the drive itself
  for (const vi of volumeIssues) {
    if (vi.code === 'WRONG_FILESYSTEM' || vi.code === 'LOW_FREE_SPACE') continue; // covered above
    if (vi.code === 'NO_FREE_SPACE') {
      items.push({ severity: 'error', title: 'The stick is full', meaning: 'There\'s no room left for Rekordbox to save what it needs.', todo: 'Remove some tracks or playlists, then export again.' });
      continue;
    }
    items.push({ severity: vi.severity === 'error' ? 'error' : 'warning', title: vi.message, meaning: vi.detail });
  }

  const order = { error: 0, warning: 1, ok: 2 } as const;
  return items.sort((a, b) => order[a.severity] - order[b.severity]);
}

const PILL: Record<FixItem['severity'], { tone: Tone; word: string }> = {
  error: { tone: 'danger', word: 'Won\'t play' },
  warning: { tone: 'warn', word: 'Worth fixing' },
  ok: { tone: 'ok', word: 'Ready' },
};

function renderChecklist(result: UsbHealthResult) {
  const items = buildChecklist(result);
  const problems = items.filter((i) => i.severity !== 'ok');
  const passes = items.filter((i) => i.severity === 'ok');

  if (checklistTitleEl) checklistTitleEl.textContent = problems.length > 0 ? 'What to fix' : 'Everything checks out';
  if (checklistDescEl) {
    checklistDescEl.textContent = problems.length > 0
      ? `${plural(problems.length, 'thing')} to look at, most important first.`
      : 'Track Lab checked the drive format, file types, sound settings, free space and track info.';
  }

  const problemHtml = problems.map((item) => {
    const pill = item.title.startsWith('Pioneer players can\'t read') || item.title.startsWith('Some Pioneer players can\'t read')
      ? { tone: 'danger' as Tone, word: 'Won\'t work' }
      : PILL[item.severity];
    return `
      <div class="usb-fix-item is-${item.severity}">
        <span class="usb-fix-icon">${item.severity === 'error' ? X_ICON : WARN_ICON}</span>
        <div class="usb-fix-body">
          <div class="usb-fix-title"><strong>${escapeHtml(item.title)}</strong><span class="status-pill status-pill--${pill.tone}">${pill.word}</span></div>
          ${item.meaning ? `<p class="usb-fix-meaning">${escapeHtml(item.meaning)}</p>` : ''}
          ${item.todo ? `<p class="usb-fix-todo"><strong>What to do:</strong> ${escapeHtml(item.todo)}</p>` : ''}
          ${item.showFilter ? `<button type="button" class="btn-link usb-fix-show" data-usb-show="${item.showFilter}">Show these tracks</button>` : ''}
        </div>
      </div>`;
  }).join('');

  const passHtml = passes.length === 0 ? '' : `
    <div class="usb-pass-list${problems.length > 0 ? ' has-problems' : ''}">
      ${problems.length > 0 ? '<p class="usb-pass-heading">Also checked, and fine</p>' : ''}
      <ul>
        ${passes.map((p) => `<li><span class="usb-pass-icon">${CHECK_ICON}</span><span><strong>${escapeHtml(p.title)}</strong> ${escapeHtml(p.okLine ?? '')}</span></li>`).join('')}
      </ul>
    </div>`;

  checklistEl.innerHTML = problemHtml + passHtml;
  checklistEl.querySelectorAll<HTMLButtonElement>('[data-usb-show]').forEach((b) => {
    b.addEventListener('click', () => showTracks(b.dataset.usbShow as TableFilter));
  });
}

// ========== File types on this stick ==========

function renderFormatBreakdown(result: UsbHealthResult) {
  const tracks = result.tracks;
  const counts = countFormats(tracks);
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total = tracks.length;

  if (entries.length === 0) {
    formatBreakdownEl.innerHTML = '<p class="card-desc">No audio files found.</p>';
    if (formatHintEl) formatHintEl.textContent = 'None';
    return;
  }
  if (formatHintEl) formatHintEl.textContent = entries.slice(0, 3).map(([f]) => containerLabel(f)).join(', ') + (entries.length > 3 ? ' and more' : '');

  const max = entries[0][1];
  formatBreakdownEl.innerHTML = `
    <div class="usb-format-bars">
      ${entries.map(([fmt, count]) => {
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        const w = max > 0 ? Math.round((count / max) * 100) : 0;
        const players = PIONEER_DEVICES.filter((d) => d.supportedFormats.has(fmt)).length;
        const tone = players === PIONEER_DEVICES.length ? 'ok' : players === 0 ? 'danger' : 'warn';
        const note = tone === 'ok' ? 'Plays on every player' : tone === 'danger' ? 'No Pioneer player plays these' : `Plays on ${players} of ${PIONEER_DEVICES.length} players`;
        return `
          <div class="usb-format-row">
            <div class="usb-format-name"><strong>${escapeHtml(containerLabel(fmt))}</strong><span class="usb-format-note is-${tone}">${tone === 'ok' ? CHECK_ICON : WARN_ICON}${escapeHtml(note)}</span></div>
            <div class="usb-format-bar-track"><div class="usb-format-bar-fill is-${tone}" style="width:${w}%"></div></div>
            <span class="usb-format-count">${plural(count, 'track')}<span class="usb-format-pct"> · ${pct}%</span></span>
          </div>`;
      }).join('')}
    </div>`;
}

// ========== Checking ==========

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
    ? (selectedIsFolder ? 'Finding the music in this folder…' : 'Finding the music on your stick…')
    : payload.phase === 'complete'
      ? 'Done'
      : 'Checking each track…';
  progressCount.textContent = payload.total > 0 && payload.phase !== 'discovering'
    ? `${payload.current.toLocaleString()} of ${plural(payload.total, 'track')}`
    : '';
}

async function handleRefreshVolumes() {
  refreshBtn.disabled = true;
  volumeList.innerHTML = '<p class="usb-looking">Looking for USB sticks&hellip;</p>';
  scanBtn.disabled = true;

  try {
    const response = await window.candybar.listVolumes();
    if (!response.success || !response.volumes) {
      showToast('error', 'Couldn\'t look for USB sticks', response.error || 'Track Lab couldn\'t list your drives.');
      renderVolumeError();
      return;
    }
    renderVolumeList(response.volumes);
  } catch (err) {
    showToast('error', 'Couldn\'t look for USB sticks', getErrorMessage(err));
    renderVolumeError();
  } finally {
    refreshBtn.disabled = false;
    updateScanButton();
  }
}

async function handleSelectFolder() {
  const chosen = await window.candybar.selectPath('dir');
  if (!chosen) return;
  selectedVolumePath = chosen;
  selectedIsFolder = true;
  selectedName = baseName(chosen);
  refreshBtn.hidden = false;
  setVolumeHeading('Your folder', 'Track Lab checks the music in this folder. Press Look again to go back to your USB sticks.');
  volumeList.innerHTML = folderCardHtml(chosen);
  updateScanButton();
}

async function handleScan() {
  if (scanRunning || !selectedVolumePath) return;
  scanRunning = true;
  scanVolumePath = selectedVolumePath;
  const scanIsFolder = selectedIsFolder;
  scanJobId = null;
  updateScanButton();
  resultsWrap.style.display = 'none';

  progressSection.style.display = 'block';
  progressBar.style.width = '0%';
  progressMessage.textContent = scanIsFolder ? 'Finding the music in this folder…' : 'Finding the music on your stick…';
  progressCount.textContent = '';
  progressSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const response = await window.candybar.jobEnqueueAndWait(
      'usb-health-scan',
      { volumePath: selectedVolumePath },
      selectedVolumePath
    ) as { jobId: string; success: boolean; result?: UsbHealthResult; error?: string };

    if (!response.success || !response.result) {
      showToast('error', 'Couldn\'t check this USB', response.error || 'Something went wrong while reading it. Check it\'s still plugged in, then try again.');
      return;
    }

    showResult(response.result, scanVolumePath, scanIsFolder);

    const verdict = overallVerdict(response.result);
    const name = checkedName(response.result);
    if (verdict.tone === 'ok') showToast('success', 'Ready for your gig', `${name}: ${verdict.sentence}`);
    else showToast(verdict.tone === 'warn' ? 'warning' : 'error', verdict.headline, 'See What to fix for what to do.');
  } catch (err) {
    showToast('error', 'Couldn\'t check this USB', getErrorMessage(err));
  } finally {
    scanRunning = false;
    scanVolumePath = null;
    scanJobId = null;
    progressSection.style.display = 'none';
    updateScanButton();
  }
}

function showResult(result: UsbHealthResult, path: string | null, isFolder: boolean) {
  usbResult = result;
  resultPath = path;
  resultIsFolder = isFolder;
  tableFilter = 'all';
  syncFilterTabs();
  if (tableSection) tableSection.open = false;
  renderDriveOverview(result);
  renderChecklist(result);
  renderTrackTable();
  renderMatrix(result);
  renderFormatBreakdown(result);
  resultsWrap.style.display = 'block';
  updateScanButton();
  // Bring the verdict into view; it's the answer to "can I go?"
  requestAnimationFrame(() => resultsWrap.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

// ========== Track list ==========

function trackCounts(tracks: LibraryHealthTrack[]) {
  const errors = tracks.filter((t) => t.issues.some((i) => i.severity === 'error')).length;
  const warnings = tracks.filter((t) => !t.issues.some((i) => i.severity === 'error') && t.issues.some((i) => i.severity === 'warning')).length;
  return { all: tracks.length, errors, warnings };
}

function syncFilterTabs() {
  filterTabs.forEach((t) => {
    const on = t.dataset.filter === tableFilter;
    t.classList.toggle('active', on);
    t.setAttribute('aria-pressed', String(on));
  });
}

/** Open "Every track" at a filter and bring it into view. */
function showTracks(filter: TableFilter) {
  setTableFilter(filter);
  if (tableSection) {
    tableSection.open = true;
    tableSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function setTableFilter(next: TableFilter) {
  if (next === tableFilter) return;
  tableFilter = next;
  syncFilterTabs();
  renderTrackTable();
}

const EMPTY_FILTER_TEXT: Record<TableFilter, { title: string; text: string }> = {
  all: { title: 'No music found', text: 'Track Lab didn\'t find any audio files here.' },
  errors: { title: 'Nothing here won\'t play', text: 'Every track opens on Pioneer players.' },
  warnings: { title: 'Nothing to fix here', text: 'No tracks are worth fixing.' },
};

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
    // compact drops the sample-rate, length and date-added cells to match the header.
    frag.appendChild(createTrackRow(track, { isSelected: () => false, onSelected: () => {}, compact: true }));
  }
  tableBody.appendChild(frag);

  const counts = trackCounts(usbResult.tracks);
  for (const key of ['all', 'errors', 'warnings'] as const) {
    const el = document.getElementById(`usb-count-${key}`);
    if (el) el.textContent = counts[key].toLocaleString();
  }
  if (tracksHintEl) {
    tracksHintEl.textContent = counts.errors > 0
      ? `${plural(counts.all, 'track')} · ${counts.errors.toLocaleString()} won't play`
      : plural(counts.all, 'track');
  }
  trackCountEl.textContent = tableFilter === 'all'
    ? `${plural(counts.all, 'track')}, problems first. Click a column name to sort.`
    : `Showing ${rows.length.toLocaleString()} of ${plural(counts.all, 'track')}.`;

  const empty = rows.length === 0;
  if (tableContainer) tableContainer.style.display = empty ? 'none' : '';
  if (tableEmpty) {
    tableEmpty.style.display = empty ? '' : 'none';
    if (empty) {
      const t = EMPTY_FILTER_TEXT[tableFilter];
      tableEmpty.innerHTML = `<div class="empty-state-icon">${CHECK_ICON}</div><h4>${escapeHtml(t.title)}</h4><p>${escapeHtml(t.text)}</p>`;
    }
  }

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
      const next = tab.dataset.filter as TableFilter | undefined;
      if (next) setTableFilter(next);
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
  // "Look again" inside the empty and error states
  volumeList.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-usb-action="refresh"]')) void handleRefreshVolumes();
  });
  window.candybar.onJobProgress(handleJobProgress);
  initTrackTable();
  updateScanButton();

  const page = document.getElementById('page-usb-health');
  if (page) {
    const observer = new MutationObserver(() => {
      // A picked folder stays picked; drives are looked up fresh on each visit.
      if (page.classList.contains('active') && !scanRunning && !selectedIsFolder) {
        void handleRefreshVolumes();
      }
    });
    observer.observe(page, { attributes: true, attributeFilter: ['class'] });
  }
}
