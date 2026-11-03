import type { TrackInfo, OrganizeResult, OrganizeConflictFile, OrganizeState, OrganizeProgress, ScanProgress } from './shared';
import type { OrganizeConflict } from '../types';
import { showToast, setStatus, escapeHtml, getValue, setValue, icons, actionHints, showContextMenu, openTagEditor, formatDuration, getErrorMessage, convertTrackWithRepair } from './shared';
import { confirmAction, confirmMoveToTrash } from './confirmDialog';
import { addConversionTask, updateConversionTask } from './activity';
import { playFile } from './player';
import { pushFloatingConsole } from './settings';
import { autoRefreshLibrary } from './library';

// ========== DOM Elements ==========

const scanTracksBtn = document.getElementById('scan-tracks') as HTMLButtonElement;
const runOrganize = document.getElementById('run-organize') as HTMLButtonElement;
const saveOrganize = document.getElementById('save-organize') as HTMLButtonElement;
const toggleDevToolsBtn = document.getElementById('toggle-devtools') as HTMLButtonElement;
const trackListSection = document.getElementById('track-list-section') as HTMLElement;
const trackListEl = document.getElementById('track-list') as HTMLDivElement;
const trackCountEl = document.getElementById('track-count') as HTMLSpanElement;
const clearTracksBtn = document.getElementById('clear-tracks') as HTMLButtonElement;
const missingArtistWarning = document.getElementById('missing-artist-warning') as HTMLDivElement;
const ignoreAllMissingBtn = document.getElementById('ignore-all-missing') as HTMLButtonElement;
const organizeFilterTabs = document.querySelectorAll<HTMLButtonElement>('[data-organize-filter]');

// Conflict elements
const conflictsSection = document.getElementById('organize-conflicts-section') as HTMLElement;
const conflictsList = document.getElementById('organize-conflicts-list') as HTMLDivElement;
const conflictsCount = document.getElementById('organize-conflicts-count') as HTMLSpanElement;

// Scan progress elements
const scanProgressEl = document.getElementById('scan-progress') as HTMLDivElement;
const scanProgressLabel = document.getElementById('scan-progress-label') as HTMLSpanElement;
const scanProgressCounts = document.getElementById('scan-progress-counts') as HTMLSpanElement;
const scanProgressBarFill = document.getElementById('scan-progress-bar-fill') as HTMLDivElement;
const scanProgressCurrent = document.getElementById('scan-progress-current') as HTMLDivElement;

// Progress elements
const progressEl = document.getElementById('organize-progress') as HTMLDivElement;
const progressLabel = document.getElementById('organize-progress-label') as HTMLSpanElement;
const progressCounts = document.getElementById('organize-progress-counts') as HTMLSpanElement;
const progressBarFill = document.getElementById('organize-progress-bar-fill') as HTMLDivElement;
const progressCurrent = document.getElementById('organize-progress-current') as HTMLDivElement;
const progressSuccessEl = document.getElementById('organize-progress-success') as HTMLSpanElement;
const progressConflictEl = document.getElementById('organize-progress-conflict') as HTMLSpanElement;
const progressErrorEl = document.getElementById('organize-progress-error') as HTMLSpanElement;
const progressSkippedEl = document.getElementById('organize-progress-skipped') as HTMLSpanElement;

// ========== State ==========

type OrganizeFilter = 'all' | 'warnings' | 'ready' | 'successful';

let tracks: TrackInfo[] = [];
let conflicts: OrganizeConflict[] = [];
let organizeRunCounters: ProgressCounters | null = null;
let organizeFilter: OrganizeFilter = 'all';
// Set once the user triggers a scan or otherwise modifies the organize state.
// Startup restoreOrganizeState races with fast user action — without this
// guard, a late cache restore can clobber freshly-scanned tracks.
let userHasModifiedState = false;
// Scan → autopopulate → rescan. Organize and Clear stay locked until it ends:
// autopopulate is still writing tags into these files, and the rescan replaces
// the list.
let scanPipelineRunning = false;

function syncOrganizeState() {
  window.candybar.updateOrganizeState({ tracks, conflicts });
}

// ========== Track List Functions ==========

function getTrackStatusClass(track: TrackInfo): string {
  if (track.status === 'success') return 'success';
  if (track.status === 'error') return 'error';
  if (!track.hasArtist && !track.ignored) return 'missing-artist';
  return 'pending';
}

function getTrackStatusIcon(track: TrackInfo): string {
  if (track.status === 'success') return icons.success;
  if (track.status === 'error') return icons.error;
  if (!track.hasArtist && !track.ignored) return icons.missingArtist;
  return icons.pending;
}

function getHealthStatusClass(track: TrackInfo): string {
  if (!track.health) return 'unknown';
  if (track.health.isHealthy && track.health.issues.length === 0) return 'healthy';
  if (track.health.isHealthy) return 'warning';
  return 'unhealthy';
}

function getHealthIcon(track: TrackInfo): string {
  if (!track.health) return icons.pending;
  if (track.health.isHealthy && track.health.issues.length === 0) return icons.healthOk;
  if (track.health.isHealthy) return icons.healthWarning;
  return icons.healthError;
}

function getHealthTooltip(track: TrackInfo): string {
  if (!track.health) return 'Health status unknown';
  if (track.health.isHealthy && track.health.issues.length === 0) {
    return 'XDJ-RX3 compatible';
  }

  const issues = track.health.issues.map((i) => `${i.message}`).join('\n');
  return issues || 'Unknown issue';
}

function formatFormatInfo(track: TrackInfo): string {
  if (!track.health?.format) return '';
  const f = track.health.format;
  const parts: string[] = [];

  if (f.container) parts.push(f.container);
  if (f.bitDepth) parts.push(`${f.bitDepth}-bit`);
  if (f.sampleRate) parts.push(`${(f.sampleRate / 1000).toFixed(1)}kHz`);
  if (f.bitRate && !f.lossless) parts.push(`${f.bitRate}kbps`);

  return parts.join(' / ');
}

function createTrackElement(track: TrackInfo): HTMLElement {
  const el = document.createElement('div');
  el.className = 'track-item';
  el.dataset.trackId = track.id;

  if (track.ignored) el.classList.add('ignored');
  if (track.status === 'success') el.classList.add('success');
  if (track.status === 'error') el.classList.add('has-error');

  const healthClass = getHealthStatusClass(track);
  if (healthClass === 'unhealthy') el.classList.add('health-error');
  if (healthClass === 'warning') el.classList.add('health-warning');

  const statusClass = getTrackStatusClass(track);
  const statusIcon = getTrackStatusIcon(track);
  const healthIcon = getHealthIcon(track);
  const healthTooltip = getHealthTooltip(track);

  const albumArtHtml = track.albumArt
    ? `<img src="${track.albumArt}" alt="Album art" />`
    : icons.albumPlaceholder;

  let resultHtml = '';
  if (track.status === 'success' && track.resultPath) {
    resultHtml = `<div class="track-result success">Moved to: ${escapeHtml(track.resultPath)}</div>`;
  } else if (track.status === 'error' && track.errorMessage) {
    resultHtml = `<div class="track-result error">${escapeHtml(track.errorMessage)}</div>`;
  } else if (track.ignored) {
    resultHtml = `<div class="track-result">Ignored</div>`;
  }

  let healthHtml = '';
  if (track.health && track.health.issues.length > 0) {
    const issueItems = track.health.issues
      .map(
        (i) =>
          `<div class="health-issue ${i.severity}">
            <span class="health-issue-code">${i.code}</span>
            <span class="health-issue-message">${escapeHtml(i.message)}</span>
            ${i.detail ? `<span class="health-issue-detail">${escapeHtml(i.detail)}</span>` : ''}
          </div>`
      )
      .join('');
    healthHtml = `<div class="track-health-issues">${issueItems}</div>`;
  }

  const formatInfo = formatFormatInfo(track);
  const formatHtml = formatInfo
    ? `<div class="track-format">${escapeHtml(formatInfo)}</div>`
    : '';

  el.innerHTML = `
    <div class="track-status ${statusClass}">${statusIcon}</div>
    <div class="track-health ${healthClass}" title="${escapeHtml(healthTooltip)}">${healthIcon}</div>
    <div class="track-art">${albumArtHtml}</div>
    <div class="track-info">
      <div class="track-title">${escapeHtml(track.title)}</div>
      <div class="track-meta">
        <span class="track-artist ${!track.hasArtist ? 'missing' : ''}">${
          track.hasArtist ? escapeHtml(track.artist) : 'Missing artist'
        }</span>
        ${formatHtml}
      </div>
      ${healthHtml}
      ${resultHtml}
    </div>
    <div class="track-actions">
      <button class="btn-icon preview-btn" aria-label="Play preview" data-tooltip="${escapeHtml(actionHints.play)}">
        <svg class="icon-play" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        <svg class="icon-stop" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
      </button>
      ${
        !track.health?.isHealthy
          ? `<button class="btn-icon convert-btn" aria-label="Convert to AIFF" data-tooltip="${escapeHtml(actionHints.convertAiff)}">${icons.convert}</button>`
          : ''
      }
      <button class="btn-icon edit-btn" aria-label="Edit tags" data-tooltip="${escapeHtml(actionHints.editTags)}">${icons.edit}</button>
      <button class="btn-icon ignore-btn ${track.ignored ? 'active' : ''}" aria-label="${track.ignored ? 'Include track' : 'Ignore track'}" aria-pressed="${track.ignored}" data-tooltip="${escapeHtml(track.ignored ? actionHints.include : actionHints.ignore)}">
        ${track.ignored ? icons.include : icons.ignore}
      </button>
      <button class="btn-icon archive-btn" aria-label="Archive track" data-tooltip="${escapeHtml(actionHints.archive)}">${icons.archive}</button>
      <button class="btn-icon delete-btn" aria-label="Move to Trash" data-tooltip="${escapeHtml(actionHints.trash)}">${icons.trash}</button>
    </div>
  `;

  const previewBtn = el.querySelector('.preview-btn') as HTMLButtonElement;
  previewBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    playFile(track.filePath, track.title);
  });

  const convertBtn = el.querySelector('.convert-btn') as HTMLButtonElement | null;
  if (convertBtn) {
    convertBtn.addEventListener('click', () => handleConvertTrack(track));
  }

  const editBtn = el.querySelector('.edit-btn') as HTMLButtonElement;
  editBtn.addEventListener('click', () => openTagEditor(track, updateTrackInList));

  const ignoreBtn = el.querySelector('.ignore-btn') as HTMLButtonElement;
  ignoreBtn.addEventListener('click', () => toggleIgnore(track.id));

  const archiveBtn = el.querySelector('.archive-btn') as HTMLButtonElement;
  archiveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void handleArchiveTrack(track);
  });

  const deleteBtn = el.querySelector('.delete-btn') as HTMLButtonElement;
  deleteBtn.addEventListener('click', () => trashTrack(track));

  // Context menu
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const items = [
      {
        label: 'Convert to AIFF',
        icon: icons.convert,
        hint: actionHints.convertAiff,
        action: () => handleConvertTrack(track)
      },
      {
        label: 'Edit tags',
        icon: icons.edit,
        hint: actionHints.editTags,
        action: () => openTagEditor(track, updateTrackInList)
      },
      {
        label: track.ignored ? 'Include track' : 'Ignore track',
        icon: track.ignored ? icons.include : icons.ignore,
        hint: track.ignored ? actionHints.include : actionHints.ignore,
        action: () => toggleIgnore(track.id)
      },
      { separator: true },
      {
        label: 'Archive track',
        icon: icons.archive,
        hint: actionHints.archive,
        action: () => handleArchiveTrack(track)
      },
      {
        label: 'Move to Trash…',
        icon: icons.trash,
        danger: true,
        hint: actionHints.trash,
        action: () => trashTrack(track)
      }
    ];
    showContextMenu(e.clientX, e.clientY, items);
  });

  return el;
}

function trackMatchesFilter(track: TrackInfo): boolean {
  if (organizeFilter === 'warnings') {
    return getHealthStatusClass(track) === 'warning';
  }
  if (organizeFilter === 'ready') {
    // Pending, not ignored, has artist, and clean health (no issues).
    return (
      track.status === 'pending' &&
      !track.ignored &&
      track.hasArtist &&
      getHealthStatusClass(track) === 'healthy'
    );
  }
  if (organizeFilter === 'successful') {
    return track.status === 'success';
  }
  return true;
}

function renderTrackList() {
  trackListEl.innerHTML = '';
  tracks.filter(trackMatchesFilter).forEach((track) => {
    trackListEl.appendChild(createTrackElement(track));
  });
  updateTrackCount();
  updateRunButton();
}

function replaceTrackElement(track: TrackInfo) {
  const existing = trackListEl.querySelector(`[data-track-id="${track.id}"]`) as HTMLElement | null;
  if (!existing) return;
  const fresh = createTrackElement(track);
  existing.replaceWith(fresh);
}

function markTrackProcessing(filePath: string) {
  trackListEl.querySelectorAll('.track-item.organize-processing').forEach((el) => {
    el.classList.remove('organize-processing');
  });
  const track = tracks.find((t) => t.filePath === filePath);
  if (!track) return;
  const el = trackListEl.querySelector(`[data-track-id="${track.id}"]`) as HTMLElement | null;
  if (!el) return;
  el.classList.add('organize-processing');
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearTrackProcessing() {
  trackListEl.querySelectorAll('.track-item.organize-processing').forEach((el) => {
    el.classList.remove('organize-processing');
  });
}

function showScanProgress() {
  scanProgressEl.style.display = 'block';
  scanProgressLabel.textContent = 'Preparing source folder…';
  scanProgressCounts.textContent = '';
  scanProgressBarFill.style.width = '0%';
  scanProgressCurrent.textContent = '';
}

function updateScanProgress(payload: ScanProgress) {
  if (payload.phase === 'flattening') {
    scanProgressLabel.textContent = 'Flattening folders…';
    scanProgressCounts.textContent = '';
    scanProgressBarFill.style.width = '0%';
    scanProgressCurrent.textContent = '';
    return;
  }

  if (payload.phase === 'scanning') {
    const pct = payload.total === 0 ? 0 : Math.round((payload.current / payload.total) * 100);
    scanProgressLabel.textContent = 'Scanning tracks…';
    scanProgressCounts.textContent = `${payload.current} / ${payload.total}`;
    scanProgressBarFill.style.width = `${pct}%`;
    if (payload.filePath) {
      const fileName = payload.filePath.split('/').pop() || payload.filePath;
      scanProgressCurrent.textContent = fileName;
    }
    return;
  }

  if (payload.phase === 'done') {
    scanProgressBarFill.style.width = '100%';
    scanProgressCounts.textContent = `${payload.total} / ${payload.total}`;
    scanProgressLabel.textContent = 'Scan complete';
    scanProgressCurrent.textContent = '';
  }
}

function hideScanProgress() {
  scanProgressEl.style.display = 'none';
}

type ProgressCounters = { success: number; conflict: number; error: number; skipped: number };

function resetProgressUi(total: number) {
  progressEl.style.display = 'block';
  progressEl.classList.remove('done');
  progressLabel.textContent = 'Organizing…';
  progressCounts.textContent = `0 / ${total}`;
  progressBarFill.style.width = '0%';
  progressCurrent.textContent = '';
  progressSuccessEl.textContent = '0';
  progressConflictEl.textContent = '0';
  progressErrorEl.textContent = '0';
  progressSkippedEl.textContent = '0';
}

function updateProgressUi(payload: OrganizeProgress, counters: ProgressCounters) {
  const pct = payload.total === 0 ? 0 : Math.round((payload.current / payload.total) * 100);
  progressCounts.textContent = `${payload.current} / ${payload.total}`;
  progressBarFill.style.width = `${pct}%`;

  if (payload.phase === 'processing') {
    const fileName = payload.filePath.split('/').pop() || payload.filePath;
    progressCurrent.textContent = `Processing: ${fileName}`;
  }

  progressSuccessEl.textContent = String(counters.success);
  progressConflictEl.textContent = String(counters.conflict);
  progressErrorEl.textContent = String(counters.error);
  progressSkippedEl.textContent = String(counters.skipped);
}

function finishProgressUi(counters: ProgressCounters) {
  progressEl.classList.add('done');
  progressLabel.textContent = 'Organize complete';
  progressCurrent.textContent = `${counters.success} moved · ${counters.conflict} conflicts · ${counters.error} failed · ${counters.skipped} skipped`;
  clearTrackProcessing();
}

function updateTrackCount() {
  const total = tracks.length;
  const ignored = tracks.filter((t) => t.ignored).length;
  const toProcess = total - ignored;
  if (organizeFilter === 'all') {
    trackCountEl.textContent = `${toProcess} of ${total} tracks`;
  } else {
    const shown = tracks.filter(trackMatchesFilter).length;
    trackCountEl.textContent = `${shown} of ${total} tracks`;
  }
}

/** Rescanned list, keeping the user's Ignore choices and finished statuses. */
function mergeRescan(fresh: TrackInfo[]): TrackInfo[] {
  const previous = new Map(tracks.map((t) => [t.filePath, t]));
  return fresh.map((t) => {
    const old = previous.get(t.filePath);
    return old ? { ...t, ignored: old.ignored, status: old.status, resultPath: old.resultPath, errorMessage: old.errorMessage } : t;
  });
}

function updateRunButton() {
  clearTracksBtn.disabled = scanPipelineRunning;
  if (scanPipelineRunning) {
    runOrganize.disabled = true;
    runOrganize.dataset.tooltipDisabled = 'Still reading and filling in tags. This unlocks when the scan finishes.';
    return;
  }
  runOrganize.dataset.tooltipDisabled = 'Scan a folder first, or include at least one track';

  // On the Ready tab, scope the action to just the ready tracks — blocking
  // warnings/missing-artist tracks elsewhere shouldn't prevent organizing these.
  if (organizeFilter === 'ready') {
    const readyCount = tracks.filter(trackMatchesFilter).length;
    runOrganize.disabled = readyCount === 0;
    missingArtistWarning.style.display = 'none';
    return;
  }

  const hasBlockingTracks = tracks.some((t) => !t.hasArtist && !t.ignored);
  const hasTracksToProcess = tracks.some((t) => !t.ignored && t.status === 'pending');

  runOrganize.disabled = hasBlockingTracks || !hasTracksToProcess;

  if (hasBlockingTracks) {
    const count = tracks.filter((t) => !t.hasArtist && !t.ignored).length;
    (document.getElementById('missing-artist-text') as HTMLSpanElement).textContent =
      `${count} track${count > 1 ? 's are' : ' is'} missing artist tags. Edit them or ignore to proceed.`;
    missingArtistWarning.style.display = 'flex';
  } else {
    missingArtistWarning.style.display = 'none';
  }
}

function toggleIgnore(trackId: string) {
  const track = tracks.find((t) => t.id === trackId);
  if (!track) return;

  track.ignored = !track.ignored;
  renderTrackList();
  syncOrganizeState();
}

// ========== Delete Track ==========

async function trashTrack(track: TrackInfo) {
  if (!(await confirmMoveToTrash([track]))) return;
  userHasModifiedState = true;
  try {
    const result = await window.candybar.deleteTrackFile(track.filePath);
    if (result.success) {
      showToast('success', 'Moved to Trash', `${track.fileName} is in the Trash if you need it back.`);
      tracks = tracks.filter((t) => t.id !== track.id);
      renderTrackList();
      syncOrganizeState();
    } else {
      // Trash-only: when the Trash refuses (e.g. some USB formats) the file stays put.
      showToast('error', 'Not moved to Trash', result.error || 'The file is still where it was.');
    }
  } catch (err) {
    showToast('error', 'Not moved to Trash', getErrorMessage(err));
  }
}

async function handleArchiveTrack(track: TrackInfo) {
  userHasModifiedState = true;
  try {
    const result = await window.candybar.archiveTrackFile(track.filePath);
    if (result.success) {
      showToast('success', 'Track Archived', `${track.fileName} moved to archive.`);
      tracks = tracks.filter((t) => t.id !== track.id);
      renderTrackList();
      syncOrganizeState();
    } else {
      showToast('error', 'Archive Failed', result.errorMessage || 'Unknown error archiving file.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    showToast('error', 'Archive Failed', message);
  }
}

function updateTrackInList(updatedTrack: TrackInfo) {
  const index = tracks.findIndex((t) => t.filePath === updatedTrack.filePath);
  if (index !== -1) {
    updatedTrack.ignored = tracks[index].ignored;
    updatedTrack.status = tracks[index].status;
    tracks[index] = updatedTrack;
    renderTrackList();
    syncOrganizeState();
  }
}

// ========== Track Conversion ==========

async function handleConvertTrack(track: TrackInfo) {
  setStatus('Converting...');
  const taskId = addConversionTask(track.fileName, 'aiff');

  try {
    const result = await convertTrackWithRepair(track.filePath, track.fileName);

    if (result.success && result.outputPath) {
      updateConversionTask(taskId, 'completed', result.outputPath);

      const source = getValue('organize-source');
      if (source) {
        tracks = mergeRescan(await window.candybar.scanTracks(source));
        renderTrackList();
        syncOrganizeState();
      }
    } else {
      updateConversionTask(taskId, 'failed');
      showToast('error', 'Conversion Failed', result.errorMessage || 'Unknown error');
    }
  } catch (err) {
    updateConversionTask(taskId, 'failed');
    const message = err instanceof Error ? err.message : 'Unknown error';
    showToast('error', 'Conversion Failed', message);
  } finally {
    setStatus('Idle');
  }
}

// ========== Scan Tracks ==========

async function autopopulateTracks(tracksToPopulate: TrackInfo[]) {
  if (tracksToPopulate.length === 0) return;

  setStatus(`Autopopulating metadata (0/${tracksToPopulate.length})...`);

  const progressHandler = (payload: { current: number; total: number; filePath: string }) => {
    setStatus(`Autopopulating metadata (${payload.current}/${payload.total})...`);
  };
  const offAutopopulate = window.candybar.onAutopopulateProgress(progressHandler);

  try {
    const input = tracksToPopulate.map((t) => ({
      filePath: t.filePath,
      title: t.title,
      artist: t.artist,
      album: t.album,
      year: t.year,
      genre: t.genre,
      label: t.label,
      key: t.key,
      bpm: t.bpm,
      remixer: t.remixer,
      hasAlbumArt: !!t.albumArt
    }));

    // Organize tracks can be re-scanned repeatedly — don't skip previously
    // autopopulated files.
    const results = await window.candybar.autopopulateTracks(input, true);
    const updatedCount = results.filter((r) => r.updated).length;

    if (updatedCount > 0) {
      showToast('success', 'Metadata Updated', `Autopopulated tags for ${updatedCount} track${updatedCount !== 1 ? 's' : ''}.`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    showToast('error', 'Autopopulate Failed', message);
  } finally {
    offAutopopulate();
  }
}

async function handleScanTracks() {
  const source = getValue('organize-source');
  if (!source) {
    showToast('error', 'Missing Source', 'Please provide a source bin path.');
    return;
  }

  userHasModifiedState = true;
  setStatus('Scanning...');
  scanTracksBtn.disabled = true;
  scanPipelineRunning = true;
  updateRunButton();
  showScanProgress();
  const offScanProgress = window.candybar.onScanProgress(updateScanProgress);

  try {
    tracks = await window.candybar.scanTracks(source);

    if (tracks.length === 0) {
      showToast('warning', 'No Tracks Found', 'The source folder contains no audio files.');
      trackListSection.style.display = 'none';
    } else {
      trackListSection.style.display = 'block';
      renderTrackList();
      pushFloatingConsole(`Scan complete: found ${tracks.length} track${tracks.length > 1 ? 's' : ''}`);
      syncOrganizeState();
      await autopopulateTracks(tracks);
      // Re-scan so UI reflects any tags written by autopopulate.
      tracks = mergeRescan(await window.candybar.scanTracks(source));
      renderTrackList();
      // All tracks have been through the analysis queue — refresh library tags
      // so the Library tab picks up any writes autopopulate made.
      void autoRefreshLibrary({ silent: true });
    }

    syncOrganizeState();
    setStatus('Idle');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    showToast('error', 'Scan Failed', message);
    setStatus('Error');
  } finally {
    offScanProgress();
    hideScanProgress();
    scanTracksBtn.disabled = false;
    scanPipelineRunning = false;
    updateRunButton();
  }
}

// ========== Config ==========

async function saveOrganizeConfig() {
  try {
    await window.candybar.updateConfig({ organizeSourceDir: getValue('organize-source') });
    showToast('success', 'Defaults Saved');
  } catch (err) {
    showToast('error', 'Save Failed', getErrorMessage(err));
  }
}

// ========== Conflicts ==========

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderConflictFileCard(file: OrganizeConflictFile, label: string): string {
  const parts: string[] = [];
  if (file.format) parts.push(file.format);
  if (file.bitRate) parts.push(`${file.bitRate}kbps`);
  parts.push(formatDuration(file.duration));
  parts.push(formatFileSize(file.sizeBytes));

  return `
    <div class="conflict-file-card">
      <div class="conflict-file-label">${escapeHtml(label)}</div>
      <div class="conflict-file-name" title="${escapeHtml(file.filePath)}">${escapeHtml(file.fileName)}</div>
      <div class="conflict-file-meta">${escapeHtml(file.artist)} — ${escapeHtml(file.title)}</div>
      <div class="conflict-file-details">${parts.join(' · ')}</div>
    </div>
  `;
}

function renderConflicts() {
  conflictsList.innerHTML = '';

  if (conflicts.length === 0) {
    conflictsSection.style.display = 'none';
    return;
  }

  conflictsSection.style.display = 'block';
  conflictsCount.textContent = `${conflicts.length} conflict${conflicts.length !== 1 ? 's' : ''}`;

  for (let i = 0; i < conflicts.length; i++) {
    const conflict = conflicts[i];
    const el = document.createElement('div');
    el.className = 'conflict-pair';
    el.innerHTML = `
      <div class="conflict-pair-header">
        <span class="conflict-pair-title">${escapeHtml(conflict.incoming.artist)} — ${escapeHtml(conflict.incoming.title)}</span>
      </div>
      <div class="conflict-pair-files">
        ${renderConflictFileCard(conflict.incoming, 'Incoming')}
        <div class="conflict-vs">vs</div>
        ${renderConflictFileCard(conflict.existing, 'In Library')}
      </div>
      <div class="conflict-actions">
        <button class="btn-secondary btn-sm keep-incoming-btn" data-tooltip="Replace the library copy with the incoming file">Keep Incoming</button>
        <button class="btn-secondary btn-sm keep-existing-btn" data-tooltip="Keep the library copy and skip the incoming file">Keep In Library</button>
      </div>
    `;

    el.querySelector('.keep-incoming-btn')!.addEventListener('click', () => void resolveConflict(conflict, 'incoming', el));
    el.querySelector('.keep-existing-btn')!.addEventListener('click', () => void resolveConflict(conflict, 'existing', el));

    conflictsList.appendChild(el);
  }
}

async function resolveConflict(conflict: OrganizeConflict, keep: 'incoming' | 'existing', el: HTMLElement) {
  // Both buttons lock while the files move, so a double-click can't run it twice.
  const buttons = el.querySelectorAll<HTMLButtonElement>('.conflict-actions button');
  buttons.forEach((b) => { b.disabled = true; });

  try {
    const result = await window.candybar.organizeResolveConflict(
      conflict.incoming.filePath,
      conflict.existing.filePath,
      conflict.targetPath,
      keep
    );
    if (result.success) {
      const keptFile = keep === 'incoming' ? conflict.incoming.fileName : conflict.existing.fileName;
      showToast('success', 'Conflict Resolved', `Kept "${keptFile}"`);
      conflicts = conflicts.filter((c) => c !== conflict);
      renderConflicts();
      syncOrganizeState();
      return;
    }
    showToast('error', 'Resolution Failed', result.error || 'Unknown error');
  } catch (err) {
    showToast('error', 'Resolution Failed', getErrorMessage(err));
  }
  buttons.forEach((b) => { b.disabled = false; });
}

// ========== Run Organize ==========

function handleOrganizeProgress(payload: OrganizeProgress) {
  if (!organizeRunCounters) return;

  if (payload.phase === 'processing') {
    markTrackProcessing(payload.filePath);
    updateProgressUi(payload, organizeRunCounters);
    return;
  }

  if (payload.phase === 'done') {
    const track = tracks.find((t) => t.filePath === payload.filePath);
    if (track) {
      if (payload.status === 'success') {
        track.status = 'success';
        track.resultPath = payload.resultPath;
        organizeRunCounters.success++;
      } else if (payload.status === 'conflict') {
        track.status = 'error';
        track.errorMessage = 'Conflict: file already exists at destination';
        organizeRunCounters.conflict++;
      } else if (payload.status === 'error') {
        track.status = 'error';
        track.errorMessage = payload.errorMessage;
        organizeRunCounters.error++;
      } else if (payload.status === 'skipped') {
        track.status = 'error';
        track.errorMessage = payload.errorMessage;
        organizeRunCounters.skipped++;
      }
      // 'ignored' — leave status as-is
      replaceTrackElement(track);
    }
    updateProgressUi(payload, organizeRunCounters);
  }
}

async function runOrganizeHandler() {
  const readyOnly = organizeFilter === 'ready';
  const tracksToOrganize = readyOnly
    ? tracks.filter(trackMatchesFilter)
    : tracks.filter((t) => !t.ignored && t.status === 'pending');
  if (tracksToOrganize.length === 0) {
    showToast('warning', 'No Tracks', 'No tracks to organize.');
    return;
  }

  // organizeTracks skips unhealthy files, so count only what will really move.
  const movable = tracksToOrganize.filter((t) => t.health?.isHealthy !== false).length;
  if (movable === 0) {
    showToast('warning', 'Nothing to move', 'Every track here has a problem to fix first. The Warnings tab shows what\'s wrong.');
    return;
  }
  const held = tracksToOrganize.length - movable;
  const ignoredCount = readyOnly ? 0 : tracks.filter((t) => t.ignored && t.status === 'pending').length;
  // Locked from the first click so a double-click can't open two confirms.
  runOrganize.disabled = true;
  const libraryRoot = await window.candybar.getLibraryRoot();
  const confirmed = await confirmAction({
    title: `Move ${movable} track${movable === 1 ? '' : 's'} into your library?`,
    message: 'Each track goes into a folder named after its artist.',
    details: [
      { label: 'From', value: getValue('organize-source') || 'Source folder' },
      { label: 'Into', value: libraryRoot || 'Your library folder' },
      ...(held > 0 ? [{ label: 'Left in place', value: `${held} with problems to fix first` }] : []),
      ...(ignoredCount > 0 ? [{ label: 'Ignored', value: `${ignoredCount} you chose to skip` }] : []),
    ],
    safetyNote: 'Nothing gets overwritten. If a track is already in your library, you choose which copy to keep.',
    confirmLabel: `Move ${movable} track${movable === 1 ? '' : 's'}`,
    tone: 'info',
  });
  if (!confirmed) { updateRunButton(); return; }

  // A rescan mid-run would swap the list out from under the progress events.
  scanTracksBtn.disabled = true;

  setStatus('Organizing...');
  organizeRunCounters = { success: 0, conflict: 0, error: 0, skipped: 0 };
  resetProgressUi(tracksToOrganize.length);

  try {
    const scopedPaths = readyOnly ? new Set(tracksToOrganize.map((t) => t.filePath)) : null;
    const trackData = tracks.map((t) => ({
      filePath: t.filePath,
      ignored: scopedPaths ? !scopedPaths.has(t.filePath) : t.ignored,
      isHealthy: t.health?.isHealthy ?? true
    }));

    const results = await window.candybar.organizeTracks(trackData);

    // Rebuild conflicts from full result set (progress events don't carry conflict details).
    conflicts = [];
    results.forEach((result) => {
      if (result.conflict) conflicts.push(result.conflict);
    });

    renderConflicts();
    syncOrganizeState();
    updateTrackCount();
    updateRunButton();

    const counters = organizeRunCounters;
    finishProgressUi(counters);

    if (counters.conflict > 0) {
      showToast(
        'warning',
        'Organization Complete',
        `Moved ${counters.success}, ${counters.conflict} conflict${counters.conflict !== 1 ? 's' : ''} to resolve${counters.error > 0 ? `, ${counters.error} failed` : ''}.`
      );
    } else if (counters.error === 0) {
      showToast('success', 'Organization Complete', `Successfully moved ${counters.success} tracks.`);
    } else {
      showToast('warning', 'Organization Complete', `Moved ${counters.success}, ${counters.error} failed.`);
    }

    setStatus('Done');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    showToast('error', 'Organization Failed', message);
    setStatus('Error');
    clearTrackProcessing();
    progressEl.style.display = 'none';
  } finally {
    organizeRunCounters = null;
    scanTracksBtn.disabled = false;
    updateRunButton();
  }
}

// ========== Restore ==========

export function restoreOrganizeState(state: OrganizeState) {
  // If the user already kicked off a scan (or other mutation), skip — we'd
  // be overwriting fresh data with the stale DB snapshot that this restore
  // was built from.
  if (userHasModifiedState) return;

  tracks = state.tracks;
  conflicts = state.conflicts;

  if (tracks.length > 0) {
    trackListSection.style.display = 'block';
    renderTrackList();
  }

  if (conflicts.length > 0) {
    renderConflicts();
  }
}

// ========== Init ==========

export function initOrganize() {
  scanTracksBtn.addEventListener('click', handleScanTracks);

  organizeFilterTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const filter = tab.dataset.organizeFilter as OrganizeFilter | undefined;
      if (!filter || filter === organizeFilter) return;
      organizeFilter = filter;
      organizeFilterTabs.forEach((t) => t.classList.toggle('active', t === tab));
      renderTrackList();
    });
  });

  ignoreAllMissingBtn.addEventListener('click', () => {
    let count = 0;
    for (const track of tracks) {
      if (!track.hasArtist && !track.ignored) {
        track.ignored = true;
        count++;
      }
    }
    if (count === 0) return;
    renderTrackList();
    syncOrganizeState();
    showToast('success', 'Tracks Ignored', `Ignored ${count} track${count !== 1 ? 's' : ''} missing artist tags.`);
  });

  clearTracksBtn.addEventListener('click', () => {
    tracks = [];
    conflicts = [];
    trackListEl.innerHTML = '';
    trackListSection.style.display = 'none';
    conflictsSection.style.display = 'none';
    progressEl.style.display = 'none';
    syncOrganizeState();
  });

  // Wire progress listener once; `handleOrganizeProgress` consults module state
  // to only act during an active run.
  window.candybar.onOrganizeProgress?.(handleOrganizeProgress);

  runOrganize.addEventListener('click', runOrganizeHandler);

  saveOrganize.addEventListener('click', saveOrganizeConfig);

  toggleDevToolsBtn.addEventListener('click', async () => {
    toggleDevToolsBtn.classList.add('loading');
    toggleDevToolsBtn.disabled = true;
    try {
      await window.candybar.toggleDevTools();
    } finally {
      setTimeout(() => {
        toggleDevToolsBtn.classList.remove('loading');
        toggleDevToolsBtn.disabled = false;
      }, 300);
    }
  });
}
