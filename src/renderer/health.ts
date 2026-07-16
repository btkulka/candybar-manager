import type { SuggestedAction, HealthIssue, LibraryHealthTrack, DuplicateTrackInfo, DuplicatePair, LibraryHealthResult, ConversionResult } from './shared';
import { showToast, setStatus, escapeHtml, icons, formatDuration, showContextMenu } from './shared';

// ========== DOM Elements ==========

const runHealthScanBtn = document.getElementById('run-health-scan') as HTMLButtonElement;
const healthProgressSection = document.getElementById('health-progress-section') as HTMLElement;
const healthProgressMessage = document.getElementById('health-progress-message') as HTMLSpanElement;
const healthProgressBar = document.getElementById('health-progress-bar') as HTMLDivElement;
const healthProgressCount = document.getElementById('health-progress-count') as HTMLSpanElement;
const healthDashboard = document.getElementById('health-dashboard') as HTMLElement;
const scanTimestamp = document.getElementById('scan-timestamp') as HTMLSpanElement;
const kpiTotal = document.getElementById('kpi-total') as HTMLDivElement;
const kpiHealthy = document.getElementById('kpi-healthy') as HTMLDivElement;
const kpiHealthyPct = document.getElementById('kpi-healthy-pct') as HTMLDivElement;
const kpiWarnings = document.getElementById('kpi-warnings') as HTMLDivElement;
const kpiWarningsPct = document.getElementById('kpi-warnings-pct') as HTMLDivElement;
const kpiErrors = document.getElementById('kpi-errors') as HTMLDivElement;
const kpiErrorsPct = document.getElementById('kpi-errors-pct') as HTMLDivElement;
const issueBreakdown = document.getElementById('issue-breakdown') as HTMLDivElement;
const issueList = document.getElementById('issue-list') as HTMLDivElement;
const unhealthyTracksSection = document.getElementById('unhealthy-tracks-section') as HTMLElement;
const unhealthyTrackList = document.getElementById('unhealthy-track-list') as HTMLDivElement;
const unhealthyCount = document.getElementById('unhealthy-count') as HTMLSpanElement;
const healthFilterTabs = document.querySelectorAll('.filter-tab');
const activeIssueFilter = document.getElementById('active-issue-filter') as HTMLDivElement;
const filterCodeLabel = document.getElementById('filter-code-label') as HTMLSpanElement;
const clearIssueFilterBtn = document.getElementById('clear-issue-filter') as HTMLButtonElement;

// Duplicates section
const duplicatesSection = document.getElementById('duplicates-section') as HTMLElement;
const duplicatesList = document.getElementById('duplicates-list') as HTMLDivElement;
const duplicatesCount = document.getElementById('duplicates-count') as HTMLSpanElement;

// Delete modal
const deleteModal = document.getElementById('delete-modal') as HTMLDivElement;
const deleteModalClose = document.getElementById('delete-modal-close') as HTMLButtonElement;
const deleteModalCancel = document.getElementById('delete-modal-cancel') as HTMLButtonElement;
const deleteModalConfirm = document.getElementById('delete-modal-confirm') as HTMLButtonElement;
const deleteFileName = document.getElementById('delete-file-name') as HTMLSpanElement;
const deleteFilePath = document.getElementById('delete-file-path') as HTMLSpanElement;

// Fix modal
const fixModal = document.getElementById('fix-modal') as HTMLDivElement;
const fixModalClose = document.getElementById('fix-modal-close') as HTMLButtonElement;
const fixModalCancel = document.getElementById('fix-modal-cancel') as HTMLButtonElement;
const fixModalConfirm = document.getElementById('fix-modal-confirm') as HTMLButtonElement;
const fixFileName = document.getElementById('fix-file-name') as HTMLSpanElement;
const fixIssuesList = document.getElementById('fix-issues-list') as HTMLDivElement;
const fixDeleteOriginal = document.getElementById('fix-delete-original') as HTMLInputElement;

// ========== State ==========

let healthResult: LibraryHealthResult | null = null;
let healthFilter: 'all' | 'errors' | 'warnings' = 'all';
let pendingFixTrack: LibraryHealthTrack | null = null;
let pendingReencodeTrack: LibraryHealthTrack | null = null;
let pendingDeleteTrack: LibraryHealthTrack | null = null;
let activeHealthScanId: string | null = null;

/** Sync current health state to main process so it survives HMR reloads */
function syncHealthState() {
  if (healthResult) {
    window.candybar.updateHealthResult(healthResult);
  }
}
let activeIssueCode: string | null = null;

// ========== Constants ==========

const issueDescriptions: Record<string, string> = {
  FILE_NOT_FOUND: 'File not found',
  UNKNOWN_CONTAINER: 'Unknown format',
  UNSUPPORTED_FORMAT: 'Unsupported format',
  INVALID_SAMPLE_RATE: 'Invalid sample rate',
  LOW_SAMPLE_RATE: 'Low sample rate',
  INVALID_BIT_DEPTH: 'Invalid bit depth',
  BIT_DEPTH_32: '32-bit audio',
  LOW_BITRATE: 'Low bitrate',
  HIGH_BITRATE: 'High bitrate',
  LOSSY_FORMAT: 'Lossy format',
  MULTICHANNEL: 'Multichannel audio',
  NON_PCM_CODEC: 'Non-PCM codec',
  WAV_METADATA_WARNING: 'WAV metadata issue',
  LONG_DURATION: 'Very long track',
  SHORT_DURATION: 'Very short track',
  PARSE_ERROR: 'Metadata parse error',
  MISSING_ALBUM_ART: 'Missing album art',
  BROKEN_AUDIO: 'Broken audio (static)'
};

const issueSeverities: Record<string, 'error' | 'warning'> = {
  FILE_NOT_FOUND: 'error',
  UNKNOWN_CONTAINER: 'error',
  UNSUPPORTED_FORMAT: 'error',
  INVALID_SAMPLE_RATE: 'error',
  LOW_SAMPLE_RATE: 'error',
  INVALID_BIT_DEPTH: 'error',
  BIT_DEPTH_32: 'error',
  MULTICHANNEL: 'error',
  NON_PCM_CODEC: 'error',
  PARSE_ERROR: 'error',
  BROKEN_AUDIO: 'error',
  LOW_BITRATE: 'warning',
  HIGH_BITRATE: 'warning',
  LOSSY_FORMAT: 'warning',
  WAV_METADATA_WARNING: 'warning',
  LONG_DURATION: 'warning',
  SHORT_DURATION: 'warning',
  MISSING_ALBUM_ART: 'warning'
};

// ========== Rendering ==========

function formatHealthFormatInfo(format: LibraryHealthTrack['format']): string {
  const parts: string[] = [];
  if (format.container) parts.push(format.container);
  if (format.bitDepth) parts.push(`${format.bitDepth}-bit`);
  if (format.sampleRate) parts.push(`${(format.sampleRate / 1000).toFixed(1)}kHz`);
  if (format.bitRate && !format.lossless) parts.push(`${format.bitRate}kbps`);
  return parts.join(' / ');
}

function getPrimarySuggestedAction(issues: HealthIssue[]): SuggestedAction {
  const actions = issues.map((i) => i.suggestedAction);
  if (actions.includes('convert_aiff')) return 'convert_aiff';
  if (actions.includes('reencode_mp3')) return 'reencode_mp3';
  if (actions.includes('archive')) return 'archive';
  if (actions.includes('delete')) return 'delete';
  return 'none';
}

function createHealthTrackElement(track: LibraryHealthTrack): HTMLElement {
  const el = document.createElement('div');
  el.className = 'health-track-item';

  const hasError = track.issues.some((i) => i.severity === 'error');
  const hasWarning = track.issues.some((i) => i.severity === 'warning');

  if (hasError) el.classList.add('has-error');
  else if (hasWarning) el.classList.add('has-warning');

  const iconClass = hasError ? 'error' : 'warning';
  const icon = hasError ? icons.healthError : icons.healthWarning;

  const formatInfo = formatHealthFormatInfo(track.format);

  const suggestedAction = getPrimarySuggestedAction(track.issues);
  const canConvertAiff = track.issues.some((i) => i.suggestedAction === 'convert_aiff');
  const canReencode = track.issues.some((i) => i.suggestedAction === 'reencode_mp3');

  const issuesHtml = track.issues
    .map(
      (i) =>
        `<div class="health-issue ${i.severity}">
          <span class="health-issue-code">${i.code}</span>
          <span class="health-issue-message">${escapeHtml(i.message)}</span>
          ${i.detail ? `<span class="health-issue-detail">${escapeHtml(i.detail)}</span>` : ''}
        </div>`
    )
    .join('');

  const relativePath = healthResult
    ? track.filePath.replace(healthResult.libraryRoot, '').replace(/^\//, '')
    : track.filePath;

  let primaryBtn = '';
  if (canConvertAiff) {
    primaryBtn = `<button class="btn-icon health-action-fix suggested" data-tooltip="Convert to AIFF (Recommended)">${icons.wrench}</button>`;
  } else if (canReencode) {
    primaryBtn = `<button class="btn-icon health-action-reencode suggested" data-tooltip="Re-encode to 320kbps (Recommended)">${icons.wrench}</button>`;
  }

  const archiveClass = suggestedAction === 'archive' ? 'suggested' : '';

  const actionsHtml = `
    <div class="health-track-actions">
      ${primaryBtn}
      <button class="btn-icon health-action-archive ${archiveClass}" data-tooltip="Archive track">${icons.archive}</button>
      <button class="btn-icon health-action-delete" data-tooltip="Delete track">${icons.trash}</button>
    </div>
  `;

  el.innerHTML = `
    <div class="health-track-icon ${iconClass}">${icon}</div>
    <div class="health-track-info">
      <div class="health-track-name">${escapeHtml(track.fileName)}</div>
      <div class="health-track-path">${escapeHtml(relativePath)}</div>
      ${formatInfo ? `<div class="health-track-format">${escapeHtml(formatInfo)}</div>` : ''}
      <div class="health-track-issues">${issuesHtml}</div>
    </div>
    ${actionsHtml}
  `;

  // Wire up action buttons
  const fixBtn = el.querySelector('.health-action-fix');
  const reencodeBtn = el.querySelector('.health-action-reencode');
  const archiveBtn = el.querySelector('.health-action-archive');
  const deleteBtn = el.querySelector('.health-action-delete');

  if (fixBtn) {
    fixBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showFixModal(track);
    });
  }

  if (reencodeBtn) {
    reencodeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showReencodeModal(track);
    });
  }

  archiveBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    handleArchiveTrack(track, el);
  });

  deleteBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    showDeleteModal(track);
  });

  // Context menu
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const items = [
      ...(canConvertAiff ? [{
        label: 'Convert to AIFF',
        icon: icons.wrench,
        action: () => showFixModal(track)
      }] : []),
      ...(canReencode ? [{
        label: 'Re-encode to 320kbps',
        icon: icons.wrench,
        action: () => showReencodeModal(track)
      }] : []),
      {
        label: 'Archive track',
        icon: icons.archive,
        action: () => handleArchiveTrack(track, el)
      },
      {
        label: 'Delete track',
        icon: icons.trash,
        action: () => showDeleteModal(track)
      }
    ];
    showContextMenu(e.clientX, e.clientY, items);
  });

  return el;
}

function renderHealthDashboard(result: LibraryHealthResult) {
  const { summary } = result;

  kpiTotal.textContent = summary.total.toLocaleString();
  kpiHealthy.textContent = summary.healthy.toLocaleString();
  kpiWarnings.textContent = summary.warnings.toLocaleString();
  kpiErrors.textContent = summary.errors.toLocaleString();

  if (summary.total > 0) {
    kpiHealthyPct.textContent = `${Math.round((summary.healthy / summary.total) * 100)}%`;
    kpiWarningsPct.textContent = `${Math.round((summary.warnings / summary.total) * 100)}%`;
    kpiErrorsPct.textContent = `${Math.round((summary.errors / summary.total) * 100)}%`;
  } else {
    kpiHealthyPct.textContent = '0%';
    kpiWarningsPct.textContent = '0%';
    kpiErrorsPct.textContent = '0%';
  }

  const date = new Date(result.scannedAt);
  scanTimestamp.textContent = `Scanned ${date.toLocaleDateString()} at ${date.toLocaleTimeString()}`;

  const issueCodes = Object.entries(summary.byIssueCode)
    .sort((a, b) => b[1] - a[1]);

  if (issueCodes.length > 0) {
    issueBreakdown.style.display = 'block';
    issueList.innerHTML = issueCodes
      .map(([code, count]) => {
        const severity = issueSeverities[code] || 'warning';
        const description = issueDescriptions[code] || code;
        const activeClass = activeIssueCode === code ? ' active' : '';
        return `
          <div class="issue-row ${severity}${activeClass}" data-issue-code="${code}">
            <div class="issue-info">
              <span class="issue-code-badge">${code}</span>
              <span class="issue-description">${description}</span>
            </div>
            <span class="issue-count">${count}</span>
          </div>
        `;
      })
      .join('');

    // Attach click listeners to issue rows for per-code filtering
    issueList.querySelectorAll('.issue-row').forEach((row) => {
      row.addEventListener('click', () => {
        const code = (row as HTMLElement).dataset.issueCode || null;
        if (activeIssueCode === code) {
          activeIssueCode = null;
        } else {
          activeIssueCode = code;
        }
        updateIssueCodeFilterUI();
        renderUnhealthyTracks();
        // Update active state on rows
        issueList.querySelectorAll('.issue-row').forEach((r) => {
          r.classList.toggle('active', (r as HTMLElement).dataset.issueCode === activeIssueCode);
        });
      });
    });
  } else {
    issueBreakdown.style.display = 'none';
  }

  healthDashboard.style.display = 'block';
}

function updateIssueCodeFilterUI() {
  if (activeIssueCode) {
    const description = issueDescriptions[activeIssueCode] || activeIssueCode;
    filterCodeLabel.textContent = description;
    activeIssueFilter.style.display = '';
  } else {
    activeIssueFilter.style.display = 'none';
  }
}

function renderUnhealthyTracks() {
  if (!healthResult) return;

  let filteredTracks = healthResult.tracks.filter((t) => !t.isHealthy || t.issues.length > 0);

  if (healthFilter === 'errors') {
    filteredTracks = filteredTracks.filter((t) => t.issues.some((i) => i.severity === 'error'));
  } else if (healthFilter === 'warnings') {
    filteredTracks = filteredTracks.filter(
      (t) => t.issues.some((i) => i.severity === 'warning') && !t.issues.some((i) => i.severity === 'error')
    );
  }

  // Apply per-issue-code filter
  if (activeIssueCode) {
    filteredTracks = filteredTracks.filter((t) => t.issues.some((i) => i.code === activeIssueCode));
  }

  unhealthyCount.textContent = `${filteredTracks.length} tracks`;

  unhealthyTrackList.innerHTML = '';
  filteredTracks.forEach((track) => {
    unhealthyTrackList.appendChild(createHealthTrackElement(track));
  });

  const totalUnhealthy = healthResult.tracks.filter((t) => !t.isHealthy || t.issues.length > 0).length;
  unhealthyTracksSection.style.display = totalUnhealthy > 0 ? 'block' : 'none';
}

function removeDuplicatePair(pair: DuplicatePair) {
  if (!healthResult) return;
  healthResult.duplicates = healthResult.duplicates.filter(d => d !== pair);
  renderDuplicates();
  syncHealthState();
}

async function keepTrack(pair: DuplicatePair, keep: 'track1' | 'track2') {
  const toDelete = keep === 'track1' ? pair.track2 : pair.track1;
  const toKeep = keep === 'track1' ? pair.track1 : pair.track2;

  // Confirm before a destructive delete — show exactly which file goes to Trash.
  const confirmed = window.confirm(
    `Resolve duplicate — move one file to Trash?\n\n` +
    `KEEP:   ${toKeep.filePath}\n` +
    `DELETE: ${toDelete.filePath}\n\n` +
    `The deleted file is moved to the macOS Trash (recoverable).`
  );
  if (!confirmed) return;

  try {
    const result = await window.candybar.deleteTrackFile(toDelete.filePath);
    if (result.success) {
      showToast('success', 'Duplicate Resolved', `Kept "${toKeep.fileName}", moved "${toDelete.fileName}" to Trash.`);
      removeDuplicatePair(pair);
      // Keep the health model in sync so KPIs/lists don't retain the deleted file.
      if (healthResult) {
        healthResult.tracks = healthResult.tracks.filter((t) => t.filePath !== toDelete.filePath);
        syncHealthState();
      }
    } else {
      showToast('error', 'Delete Failed', result.error || 'Unknown error deleting file.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    showToast('error', 'Delete Failed', message);
  }
}

function renderTagCompleteness(track: DuplicateTrackInfo): string {
  const pct = Math.round(track.tagCompleteness * 100);
  const level = pct >= 80 ? 'high' : pct >= 50 ? 'med' : 'low';
  return `<span class="tag-completeness tag-${level}" title="ID3 tag completeness: ${pct}%">${pct}%</span>`;
}

function renderDuplicateTrackHtml(track: DuplicateTrackInfo, trackKey: string): string {
  const tagDetails: string[] = [];
  if (track.album) tagDetails.push(`Album: ${escapeHtml(track.album)}`);
  if (track.year) tagDetails.push(`Year: ${track.year}`);
  if (track.genre) tagDetails.push(`Genre: ${escapeHtml(track.genre)}`);
  const tagLine = tagDetails.length > 0 ? tagDetails.join(' / ') : '';

  return `
    <div class="duplicate-track" data-track="${trackKey}">
      <div class="duplicate-art-container" title="${track.hasAlbumArt ? 'Has embedded album art' : 'No album art'}">
        <div class="duplicate-art-placeholder">${icons.albumPlaceholder}</div>
      </div>
      <div class="duplicate-track-info">
        <div class="duplicate-track-title">${escapeHtml(track.artist)} - ${escapeHtml(track.title)}</div>
        <div class="duplicate-track-meta">
          <span class="duplicate-format">${track.format}</span>
          ${track.bitRate ? `<span class="duplicate-bitrate">${track.bitRate}kbps</span>` : ''}
          <span class="duplicate-duration">${formatDuration(track.duration ?? undefined)}</span>
          ${renderTagCompleteness(track)}
          ${track.hasAlbumArt ? '<span class="duplicate-has-art" title="Has embedded album art">Art</span>' : '<span class="duplicate-no-art" title="No album art">No Art</span>'}
        </div>
        ${tagLine ? `<div class="duplicate-track-tags">${tagLine}</div>` : ''}
        <div class="duplicate-track-path" title="${escapeHtml(track.filePath)}">${escapeHtml(track.fileName)}</div>
      </div>
      <div class="duplicate-track-actions">
        <button class="btn-sm duplicate-keep" data-tooltip="Keep this file, delete the other">Keep</button>
        <button class="btn-icon duplicate-delete" data-tooltip="Delete this file">${icons.trash}</button>
      </div>
    </div>`;
}

async function loadDuplicateAlbumArt(el: HTMLElement, track: DuplicateTrackInfo, trackKey: string) {
  if (!track.hasAlbumArt) return;
  const section = el.querySelector(`[data-track="${trackKey}"]`);
  if (!section) return;
  const container = section.querySelector('.duplicate-art-container') as HTMLElement;
  if (!container) return;

  try {
    const dataUrl = await window.candybar.getTrackAlbumArt(track.filePath);
    if (dataUrl) {
      const img = document.createElement('img');
      img.className = 'duplicate-art-img';
      img.src = dataUrl;
      img.alt = 'Album art';
      container.innerHTML = '';
      container.appendChild(img);
    }
  } catch {
    // Keep placeholder on failure
  }
}

function createDuplicatePairElement(pair: DuplicatePair): HTMLElement {
  const el = document.createElement('div');
  el.className = 'duplicate-pair';

  const similarityPct = Math.round(pair.similarity * 100);

  el.innerHTML = `
    <div class="duplicate-header">
      <span class="duplicate-similarity">${similarityPct}% match</span>
      <span class="duplicate-reason">${escapeHtml(pair.reason)}</span>
      <div class="duplicate-header-actions">
        <button class="btn-icon duplicate-dismiss" data-tooltip="Dismiss this pair (keep both files)">
          ${icons.ignore}
        </button>
      </div>
    </div>
    <div class="duplicate-tracks">
      ${renderDuplicateTrackHtml(pair.track1, 'track1')}
      <div class="duplicate-vs">vs</div>
      ${renderDuplicateTrackHtml(pair.track2, 'track2')}
    </div>
  `;

  // Lazy-load album art
  loadDuplicateAlbumArt(el, pair.track1, 'track1');
  loadDuplicateAlbumArt(el, pair.track2, 'track2');

  // Wire up actions
  const track1Section = el.querySelector('[data-track="track1"]') as HTMLElement;
  const track2Section = el.querySelector('[data-track="track2"]') as HTMLElement;
  const dismissBtn = el.querySelector('.duplicate-dismiss') as HTMLButtonElement;

  // Keep track1 = delete track2
  track1Section.querySelector('.duplicate-keep')!.addEventListener('click', (e) => {
    e.stopPropagation();
    keepTrack(pair, 'track1');
  });
  // Delete track1 = keep track2
  track1Section.querySelector('.duplicate-delete')!.addEventListener('click', (e) => {
    e.stopPropagation();
    keepTrack(pair, 'track2');
  });
  // Keep track2 = delete track1
  track2Section.querySelector('.duplicate-keep')!.addEventListener('click', (e) => {
    e.stopPropagation();
    keepTrack(pair, 'track2');
  });
  // Delete track2 = keep track1
  track2Section.querySelector('.duplicate-delete')!.addEventListener('click', (e) => {
    e.stopPropagation();
    keepTrack(pair, 'track1');
  });

  // Dismiss
  dismissBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeDuplicatePair(pair);
  });

  // Context menu
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      {
        label: `Keep "${pair.track1.fileName}"`,
        icon: icons.success,
        action: () => keepTrack(pair, 'track1')
      },
      {
        label: `Keep "${pair.track2.fileName}"`,
        icon: icons.success,
        action: () => keepTrack(pair, 'track2')
      },
      { label: '', separator: true },
      {
        label: 'Dismiss (keep both)',
        icon: icons.ignore,
        action: () => removeDuplicatePair(pair)
      }
    ]);
  });

  return el;
}

function renderDuplicates() {
  if (!healthResult) return;

  const duplicates = healthResult.duplicates || [];

  duplicatesCount.textContent = `${duplicates.length} pair${duplicates.length !== 1 ? 's' : ''}`;

  duplicatesList.innerHTML = '';
  duplicates.forEach((pair) => {
    duplicatesList.appendChild(createDuplicatePairElement(pair));
  });

  duplicatesSection.style.display = duplicates.length > 0 ? 'block' : 'none';
}

// ========== Health Scan Progress ==========

function updateHealthProgress(progress: { id: string; phase: string; current: number; total: number }) {
  if (activeHealthScanId !== null && progress.id !== activeHealthScanId) return;
  if (activeHealthScanId === null) {
    activeHealthScanId = progress.id;
  }

  if (progress.total > 0) {
    const percent = Math.round((progress.current / progress.total) * 100);
    healthProgressBar.style.width = `${percent}%`;
    healthProgressCount.textContent = `${progress.current.toLocaleString()} / ${progress.total.toLocaleString()}`;
  } else {
    healthProgressBar.style.width = '0%';
    healthProgressCount.textContent = progress.phase === 'discovering'
      ? `${progress.current.toLocaleString()} found`
      : '';
  }

  switch (progress.phase) {
    case 'discovering':
      healthProgressMessage.textContent = `Discovering audio files... ${progress.current.toLocaleString()} found`;
      break;
    case 'scanning':
      healthProgressMessage.textContent = `Scanning metadata... ${Math.round((progress.current / Math.max(progress.total, 1)) * 100)}%`;
      break;
    case 'duplicates':
      healthProgressMessage.textContent = 'Checking for duplicates...';
      break;
    case 'complete':
      healthProgressMessage.textContent = 'Scan complete';
      break;
  }
}

// ========== Health Scan ==========

async function handleHealthScan() {
  setStatus('Scanning...');
  runHealthScanBtn.disabled = true;
  activeHealthScanId = null;
  activeIssueCode = null;
  updateIssueCodeFilterUI();

  // Show progress, hide results
  healthProgressSection.style.display = 'block';
  healthProgressBar.style.width = '0%';
  healthProgressMessage.textContent = 'Starting...';
  healthProgressCount.textContent = '';
  healthDashboard.style.display = 'none';
  unhealthyTracksSection.style.display = 'none';
  duplicatesSection.style.display = 'none';

  try {
    const response = await window.candybar.scanLibraryHealth();
    healthResult = response.result!;

    renderHealthDashboard(healthResult);
    renderUnhealthyTracks();
    renderDuplicates();

    const { summary } = healthResult;
    if (summary.errors === 0 && summary.warnings === 0) {
      showToast('success', 'All Tracks Healthy', `${summary.total} tracks scanned, all compatible with XDJ-RX3.`);
    } else {
      showToast(
        summary.errors > 0 ? 'warning' : 'info',
        'Scan Complete',
        `${summary.errors} errors, ${summary.warnings} warnings found in ${summary.total} tracks.`
      );
    }

    setStatus('Done');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    showToast('error', 'Scan Failed', message);
    setStatus('Error');
  } finally {
    runHealthScanBtn.disabled = false;
    activeHealthScanId = null;
    healthProgressSection.style.display = 'none';
  }
}

// ========== Track Actions ==========

function showFixModal(track: LibraryHealthTrack) {
  // Exactly one pending action may be set — the shared modal's confirm handler
  // dispatches on pendingReencodeTrack, so a stale value would run the wrong action.
  pendingReencodeTrack = null;
  pendingFixTrack = track;

  fixFileName.textContent = track.fileName;

  const fixableIssues = track.issues.filter((i) => i.suggestedAction === 'convert_aiff');
  fixIssuesList.innerHTML = fixableIssues
    .map((i) => `<div class="fix-issue"><strong>${i.code}:</strong> ${escapeHtml(i.message)}</div>`)
    .join('');

  fixDeleteOriginal.checked = true;
  fixModal.style.display = 'flex';
}

function hideFixModal() {
  fixModal.style.display = 'none';
  // Clear BOTH pending actions — the fix and reencode flows share this modal.
  pendingFixTrack = null;
  pendingReencodeTrack = null;
}

async function handleFixConfirm() {
  if (!pendingFixTrack) return;

  const track = pendingFixTrack;
  const deleteOriginal = fixDeleteOriginal.checked;

  hideFixModal();
  showToast('info', 'Converting...', `Converting ${track.fileName} to AIFF`);

  try {
    const result = await window.candybar.fixTrackFile(track.filePath, deleteOriginal);

    if (result.success) {
      showToast('success', 'Conversion Complete', `${track.fileName} converted to AIFF successfully.`);
      await handleHealthScan();
    } else {
      showToast('error', 'Conversion Failed', result.errorMessage || 'Unknown error during conversion.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    showToast('error', 'Conversion Failed', message);
  }
}

function showReencodeModal(track: LibraryHealthTrack) {
  pendingFixTrack = null;
  pendingReencodeTrack = track;

  fixFileName.textContent = track.fileName;

  const reencodeIssues = track.issues.filter((i) => i.suggestedAction === 'reencode_mp3');
  fixIssuesList.innerHTML = reencodeIssues
    .map((i) => `<div class="fix-issue"><strong>${i.code}:</strong> ${escapeHtml(i.message)}</div>`)
    .join('');

  fixDeleteOriginal.checked = true;
  fixModal.style.display = 'flex';
}

async function handleReencodeConfirm() {
  if (!pendingReencodeTrack) return;

  const track = pendingReencodeTrack;
  const deleteOriginal = fixDeleteOriginal.checked;

  hideFixModal();
  pendingReencodeTrack = null;
  showToast('info', 'Re-encoding...', `Re-encoding ${track.fileName} to 320kbps MP3`);

  try {
    const result = await window.candybar.reencodeTrackFile(track.filePath, deleteOriginal);

    if (result.success) {
      showToast('success', 'Re-encode Complete', `${track.fileName} re-encoded to 320kbps successfully.`);
      await handleHealthScan();
    } else {
      showToast('error', 'Re-encode Failed', result.errorMessage || 'Unknown error during re-encoding.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    showToast('error', 'Re-encode Failed', message);
  }
}

function showDeleteModal(track: LibraryHealthTrack) {
  pendingDeleteTrack = track;

  deleteFileName.textContent = track.fileName;
  deleteFilePath.textContent = track.filePath;

  deleteModal.style.display = 'flex';
}

function hideDeleteModal() {
  deleteModal.style.display = 'none';
  pendingDeleteTrack = null;
}

async function handleDeleteConfirm() {
  if (!pendingDeleteTrack) return;

  const track = pendingDeleteTrack;
  hideDeleteModal();

  try {
    const result = await window.candybar.deleteTrackFile(track.filePath);

    if (result.success) {
      showToast('success', 'Track Deleted', `${track.fileName} has been deleted.`);
      await handleHealthScan();
    } else {
      showToast('error', 'Delete Failed', result.error || 'Unknown error deleting file.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    showToast('error', 'Delete Failed', message);
  }
}

async function handleArchiveTrack(track: LibraryHealthTrack, el: HTMLElement) {
  const buttons = el.querySelectorAll('button');
  buttons.forEach((btn) => (btn.disabled = true));

  try {
    const result = await window.candybar.archiveTrackFile(track.filePath);

    if (result.success) {
      showToast('success', 'Track Archived', `${track.fileName} moved to archive.`);
      el.classList.add('archived');
      setTimeout(() => {
        el.remove();
        if (healthResult) {
          healthResult.tracks = healthResult.tracks.filter(t => t.filePath !== track.filePath);
          const remaining = unhealthyTrackList.children.length;
          unhealthyCount.textContent = `${remaining} tracks`;
          syncHealthState();
        }
      }, 300);
    } else {
      showToast('error', 'Archive Failed', result.errorMessage || 'Unknown error archiving file.');
      buttons.forEach((btn) => (btn.disabled = false));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    showToast('error', 'Archive Failed', message);
    buttons.forEach((btn) => (btn.disabled = false));
  }
}

// ========== Init ==========

export function restoreHealthResults(result: LibraryHealthResult, filter?: string) {
  healthResult = result;
  healthFilter = (filter as 'all' | 'errors' | 'warnings') || 'all';

  renderHealthDashboard(result);
  renderUnhealthyTracks();
  renderDuplicates();

  // Update filter tab active state
  healthFilterTabs.forEach((tab) => {
    const tabFilter = (tab as HTMLButtonElement).dataset.filter;
    tab.classList.toggle('active', tabFilter === healthFilter);
  });
}

export function initHealth() {
  runHealthScanBtn.addEventListener('click', handleHealthScan);
  window.candybar.onHealthScanProgress(updateHealthProgress);

  // Filter tabs
  healthFilterTabs.forEach((tab) => {
    tab.addEventListener('click', async () => {
      const filter = (tab as HTMLButtonElement).dataset.filter as 'all' | 'errors' | 'warnings';
      if (filter) {
        healthFilter = filter;

        healthFilterTabs.forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');

        renderUnhealthyTracks();

        // Persist filter selection
        const config = await window.candybar.getConfig();
        config.healthTabFilter = filter;
        await window.candybar.setConfig(config);
      }
    });
  });

  // Clear issue code filter
  clearIssueFilterBtn.addEventListener('click', () => {
    activeIssueCode = null;
    updateIssueCodeFilterUI();
    renderUnhealthyTracks();
    issueList.querySelectorAll('.issue-row').forEach((r) => r.classList.remove('active'));
  });

  // Fix modal events
  fixModalClose.addEventListener('click', hideFixModal);
  fixModalCancel.addEventListener('click', hideFixModal);
  fixModalConfirm.addEventListener('click', () => {
    if (pendingReencodeTrack) {
      handleReencodeConfirm();
    } else {
      handleFixConfirm();
    }
  });

  // Delete modal events
  deleteModalClose.addEventListener('click', hideDeleteModal);
  deleteModalCancel.addEventListener('click', hideDeleteModal);
  deleteModalConfirm.addEventListener('click', handleDeleteConfirm);

  // Close modals on overlay click
  fixModal.addEventListener('click', (e) => {
    if (e.target === fixModal) hideFixModal();
  });
  deleteModal.addEventListener('click', (e) => {
    if (e.target === deleteModal) hideDeleteModal();
  });
}
