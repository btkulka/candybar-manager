/**
 * Shared rendering utilities for health track tables.
 * Used by both library.ts (Library Health) and usbHealth.ts (USB Health).
 */

import type { SuggestedAction, HealthIssue, LibraryHealthTrack, HealthSummary } from './shared';
import { escapeHtml, icons, formatDuration, showContextMenu } from './shared';

// ========== Types ==========

export type SortKey = 'status' | 'artist' | 'title' | 'format' | 'sampleRate' | 'bitRate' | 'duration' | 'dateAdded';

export interface TrackRowHandlers {
  onSelected: (track: LibraryHealthTrack) => void;
  isSelected: (filePath: string) => boolean;
  /** When undefined, action buttons and context menu are not rendered (read-only mode). */
  onAction?: (action: 'fix' | 'reencode' | 'edit' | 'archive' | 'delete', track: LibraryHealthTrack) => void;
  /** Multi-select support. When provided, a checkbox column is rendered. */
  isChecked?: (filePath: string) => boolean;
  onCheckToggle?: (track: LibraryHealthTrack, e: MouseEvent) => void;
  onContextMenuMulti?: (tracks: LibraryHealthTrack[], e: MouseEvent) => void;
  getCheckedTracks?: () => LibraryHealthTrack[];
}

export interface FilterOpts {
  showAllTracks: boolean;
  severityFilter: 'all' | 'errors' | 'warnings';
  activeIssueCode: string | null;
}

export interface ProgressElements {
  bar: HTMLElement;
  message: HTMLElement;
  count: HTMLElement;
}

export interface KpiElements {
  total: HTMLElement;
  healthy: HTMLElement;
  healthyPct: HTMLElement;
  warnings: HTMLElement;
  warningsPct: HTMLElement;
  errors: HTMLElement;
  errorsPct: HTMLElement;
  timestamp: HTMLElement;
  /** Container div for the issue breakdown section. Set null to skip. */
  issueBreakdown: HTMLElement | null;
  /** The list element inside issueBreakdown where rows are rendered. Set null to skip. */
  issueList: HTMLElement | null;
}

// ========== Constants ==========

export const issueDescriptions: Record<string, string> = {
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
  MISSING_TAGS: 'Missing core tags',
  SPARSE_TAGS: 'Incomplete metadata',
  PATH_TOO_DEEP: 'Path too deep',
  BROKEN_AUDIO: 'Broken audio (static)'
};

export const issueTooltips: Record<string, string> = {
  FILE_NOT_FOUND: 'The file no longer exists on disk.\nFix: Delete the entry from the library.',
  UNKNOWN_CONTAINER: 'The audio container format could not be identified.\nFix: Archive and replace with a known format.',
  UNSUPPORTED_FORMAT: 'This format (e.g. FLAC, OGG) is not supported by the XDJ-RX3.\nFix: Convert to AIFF for lossless playback.',
  INVALID_SAMPLE_RATE: 'The sample rate is not compatible with the XDJ-RX3 (requires 32/44.1/48 kHz).\nFix: Convert to AIFF at 44.1 kHz.',
  LOW_SAMPLE_RATE: 'The sample rate is below 32 kHz, which may cause playback issues.\nFix: Convert to AIFF at 44.1 kHz.',
  INVALID_BIT_DEPTH: 'The bit depth is not 16-bit or 24-bit as required by the XDJ-RX3.\nFix: Convert to AIFF at 24-bit.',
  BIT_DEPTH_32: '32-bit float audio is not supported by the XDJ-RX3.\nFix: Convert to 24-bit AIFF.',
  LOW_BITRATE: 'MP3 bitrate is below 320kbps, which may sound audibly worse.\nFix: Re-encode to 320kbps or replace with a higher-quality source.',
  HIGH_BITRATE: 'MP3 bitrate exceeds 320kbps, which is non-standard.\nFix: Re-encode to 320kbps CBR.',
  LOSSY_FORMAT: 'This is a lossy format (MP3/AAC). Lossless is preferred for DJing.\nFix: Archive and replace with a lossless source.',
  MULTICHANNEL: 'Audio has more than 2 channels. The XDJ-RX3 expects stereo.\nFix: Convert to stereo AIFF.',
  NON_PCM_CODEC: 'WAV/AIFF file uses a non-PCM codec (e.g. compressed).\nFix: Convert to standard PCM AIFF.',
  WAV_METADATA_WARNING: 'WAV files can cause E-8305 errors on Pioneer gear due to metadata handling.\nFix: Convert to AIFF to avoid issues.',
  LONG_DURATION: 'Track is unusually long (e.g. a DJ mix or recording error).\nNo automated fix — review manually.',
  SHORT_DURATION: 'Track is very short and may be an incomplete file or snippet.\nFix: Archive if not needed.',
  PARSE_ERROR: 'The file metadata could not be read — the file may be corrupt.\nFix: Archive and replace with a working copy.',
  MISSING_ALBUM_ART: 'No album artwork is embedded in the file.\nUse the inspector to search and apply cover art.',
  MISSING_TAGS: 'Core tags (title or artist) are missing.\nFix: Populate tags from Spotify/SoundCloud.',
  SPARSE_TAGS: 'Some metadata fields (album, year, genre) are empty.\nFix: Populate tags from Spotify/SoundCloud.',
  PATH_TOO_DEEP: 'The file path is deeply nested and may cause issues on some devices.\nNo automated fix — move to a shallower folder.',
  BROKEN_AUDIO: 'The audio samples are stored in the wrong byte order — the file plays back as static. Caused by an earlier buggy WAV→AIFF tag write.\nFix: Re-import from the original WAV/FLAC source.'
};

export const issueSeverities: Record<string, 'error' | 'warning'> = {
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
  LOW_BITRATE: 'warning',
  HIGH_BITRATE: 'warning',
  LOSSY_FORMAT: 'warning',
  WAV_METADATA_WARNING: 'warning',
  LONG_DURATION: 'warning',
  SHORT_DURATION: 'warning',
  MISSING_ALBUM_ART: 'warning',
  MISSING_TAGS: 'warning',
  SPARSE_TAGS: 'warning',
  PATH_TOO_DEEP: 'warning',
  BROKEN_AUDIO: 'error'
};

// ========== Pure Helpers ==========

export function formatHealthFormatInfo(format: LibraryHealthTrack['format']): string {
  const parts: string[] = [];
  if (format.container) parts.push(format.container);
  if (format.bitDepth) parts.push(`${format.bitDepth}-bit`);
  if (format.sampleRate) parts.push(`${(format.sampleRate / 1000).toFixed(1)}kHz`);
  if (format.bitRate && !format.lossless) parts.push(`${format.bitRate}kbps`);
  return parts.join(' / ');
}

export function getPrimarySuggestedAction(issues: HealthIssue[]): SuggestedAction {
  const actions = issues.map((i) => i.suggestedAction);
  if (actions.includes('convert_aiff')) return 'convert_aiff';
  if (actions.includes('reencode_mp3')) return 'reencode_mp3';
  if (actions.includes('populate_tags')) return 'populate_tags';
  if (actions.includes('archive')) return 'archive';
  if (actions.includes('delete')) return 'delete';
  return 'none';
}

export function getTrackStatusWeight(track: LibraryHealthTrack): number {
  if (track.issues.some((i) => i.severity === 'error')) return 2;
  if (track.issues.some((i) => i.severity === 'warning')) return 1;
  return 0;
}

export function formatBitRateCell(format: LibraryHealthTrack['format']): string {
  if (format.lossless && format.bitDepth) return `${format.bitDepth}-bit`;
  if (format.bitRate) return `${format.bitRate} kbps`;
  return '\u2014';
}

export function formatSampleRateCell(sampleRate: number | null): string {
  if (!sampleRate) return '\u2014';
  return `${(sampleRate / 1000).toFixed(1)} kHz`;
}

export function formatDateAdded(dateAdded: number | null): string {
  if (!dateAdded) return '\u2014';
  const d = new Date(dateAdded);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const year = String(d.getFullYear()).slice(2);
  return `${month}/${day}/${year}`;
}

export function getFilteredTracks(
  tracks: LibraryHealthTrack[],
  opts: FilterOpts
): LibraryHealthTrack[] {
  let result = tracks;

  if (!opts.showAllTracks) {
    result = result.filter((t) => !t.isHealthy || t.issues.length > 0);
  }

  if (opts.severityFilter === 'errors') {
    result = result.filter((t) => t.issues.some((i) => i.severity === 'error'));
  } else if (opts.severityFilter === 'warnings') {
    result = result.filter(
      (t) => t.issues.some((i) => i.severity === 'warning') && !t.issues.some((i) => i.severity === 'error')
    );
  }

  if (opts.activeIssueCode) {
    result = result.filter((t) => t.issues.some((i) => i.code === opts.activeIssueCode));
  }

  return result;
}

export function sortTracks(
  tracks: LibraryHealthTrack[],
  key: SortKey,
  dir: 'asc' | 'desc'
): LibraryHealthTrack[] {
  const sorted = [...tracks];
  const d = dir === 'asc' ? 1 : -1;

  sorted.sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case 'status':
        cmp = getTrackStatusWeight(a) - getTrackStatusWeight(b);
        break;
      case 'artist':
        cmp = (a.artist || '').localeCompare(b.artist || '');
        break;
      case 'title':
        cmp = (a.title || a.fileName).localeCompare(b.title || b.fileName);
        break;
      case 'format':
        cmp = (a.format.container || '').localeCompare(b.format.container || '');
        break;
      case 'sampleRate':
        cmp = (a.format.sampleRate || 0) - (b.format.sampleRate || 0);
        break;
      case 'bitRate':
        cmp = (a.format.bitRate || a.format.bitDepth || 0) - (b.format.bitRate || b.format.bitDepth || 0);
        break;
      case 'duration':
        cmp = (a.format.duration || 0) - (b.format.duration || 0);
        break;
      case 'dateAdded':
        cmp = (a.dateAdded || 0) - (b.dateAdded || 0);
        break;
    }
    return cmp * d;
  });

  return sorted;
}

// ========== KPI Dashboard ==========

export function renderKpiDashboard(
  summary: HealthSummary,
  scannedAt: number,
  elements: KpiElements,
  onIssueCodeSelected?: (code: string | null) => void
): void {
  elements.total.textContent = summary.total.toLocaleString();
  elements.healthy.textContent = summary.healthy.toLocaleString();
  elements.warnings.textContent = summary.warnings.toLocaleString();
  elements.errors.textContent = summary.errors.toLocaleString();

  if (summary.total > 0) {
    elements.healthyPct.textContent = `${Math.round((summary.healthy / summary.total) * 100)}%`;
    elements.warningsPct.textContent = `${Math.round((summary.warnings / summary.total) * 100)}%`;
    elements.errorsPct.textContent = `${Math.round((summary.errors / summary.total) * 100)}%`;
  } else {
    elements.healthyPct.textContent = '0%';
    elements.warningsPct.textContent = '0%';
    elements.errorsPct.textContent = '0%';
  }

  const date = new Date(scannedAt);
  elements.timestamp.textContent = `Scanned ${date.toLocaleDateString()} at ${date.toLocaleTimeString()}`;

  if (elements.issueBreakdown && elements.issueList) {
    const issueCodes = Object.entries(summary.byIssueCode).sort((a, b) => b[1] - a[1]);
    if (issueCodes.length > 0) {
      elements.issueBreakdown.style.display = 'block';
      elements.issueList.innerHTML = issueCodes
        .map(([code, count]) => {
          const severity = issueSeverities[code] || 'warning';
          const description = issueDescriptions[code] || code;
          const tooltip = issueTooltips[code] || '';
          return `
            <div class="issue-row ${severity}" data-issue-code="${code}" title="${escapeHtml(tooltip)}">
              <div class="issue-info">
                <span class="issue-code-badge">${code}</span>
                <span class="issue-description">${description}</span>
              </div>
              <span class="issue-count">${count}</span>
            </div>
          `;
        })
        .join('');

      if (onIssueCodeSelected) {
        elements.issueList.querySelectorAll('.issue-row').forEach((row) => {
          row.addEventListener('click', () => {
            const code = (row as HTMLElement).dataset.issueCode || null;
            onIssueCodeSelected(code);
          });
        });
      }
    } else {
      elements.issueBreakdown.style.display = 'none';
    }
  }
}

/** Update the active issue code highlight in an already-rendered issue list. */
export function updateIssueListHighlight(issueList: HTMLElement, activeIssueCode: string | null): void {
  issueList.querySelectorAll('.issue-row').forEach((r) => {
    r.classList.toggle('active', (r as HTMLElement).dataset.issueCode === activeIssueCode);
  });
}

// ========== Progress Bar ==========

export function updateScanProgress(
  elements: ProgressElements,
  progress: { phase: string; current: number; total: number; currentFile?: string }
): void {
  if (progress.total > 0) {
    const percent = Math.round((progress.current / progress.total) * 100);
    elements.bar.style.width = `${percent}%`;
    elements.count.textContent = `${progress.current.toLocaleString()} / ${progress.total.toLocaleString()}`;
  } else {
    elements.bar.style.width = '0%';
    elements.count.textContent = progress.phase === 'discovering'
      ? `${progress.current.toLocaleString()} found`
      : '';
  }

  switch (progress.phase) {
    case 'discovering':
      elements.message.textContent = `Discovering audio files... ${progress.current.toLocaleString()} found`;
      break;
    case 'scanning':
      elements.message.textContent = `Scanning metadata... ${Math.round((progress.current / Math.max(progress.total, 1)) * 100)}%`;
      break;
    case 'duplicates':
      elements.message.textContent = 'Checking for duplicates...';
      break;
    case 'complete':
      elements.message.textContent = 'Scan complete';
      break;
    default:
      elements.message.textContent = progress.phase;
  }
}

// ========== Track Row ==========

export function createTrackRow(
  track: LibraryHealthTrack,
  handlers: TrackRowHandlers
): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = 'dt-row';
  tr.dataset.filePath = track.filePath;

  if (handlers.isSelected(track.filePath)) {
    tr.classList.add('selected');
  }

  const hasError = track.issues.some((i) => i.severity === 'error');
  const hasWarning = track.issues.some((i) => i.severity === 'warning');

  if (hasError) tr.classList.add('has-error');
  else if (hasWarning) tr.classList.add('has-warning');

  const iconClass = track.isHealthy && track.issues.length === 0
    ? 'ok'
    : hasError ? 'error' : 'warning';
  const icon = iconClass === 'ok'
    ? icons.healthOk
    : hasError ? icons.healthError : icons.healthWarning;

  const issueBadges = track.issues
    .map((i) => `<span class="issue-badge ${i.severity}" title="${escapeHtml(issueTooltips[i.code] || i.message)}">${issueDescriptions[i.code] || i.code}</span>`)
    .join('');

  const artIndicator = track.hasAlbumArt
    ? ''
    : '<span class="issue-badge warning" title="Missing album art">No Art</span>';

  const showCheckbox = !!handlers.isChecked;
  const showActions = !!handlers.onAction;
  tr.innerHTML = `
    ${showCheckbox ? `<td class="col-checkbox"><input type="checkbox" class="row-checkbox" ${handlers.isChecked!(track.filePath) ? 'checked' : ''}></td>` : ''}
    <td class="col-status"><span class="dt-status-icon ${iconClass}">${icon}</span></td>
    <td class="col-artist" title="${escapeHtml(track.artist || 'Unknown Artist')}">${escapeHtml(track.artist || 'Unknown Artist')}</td>
    <td class="col-title" title="${escapeHtml(track.title || track.fileName)}">${escapeHtml(track.title || track.fileName)}</td>
    <td class="col-format"><span class="dt-format-badge">${escapeHtml(track.format.container || '?')}</span></td>
    <td class="col-sample-rate">${formatSampleRateCell(track.format.sampleRate)}</td>
    <td class="col-bitrate">${formatBitRateCell(track.format)}</td>
    <td class="col-duration">${track.format.duration ? formatDuration(track.format.duration) : '\u2014'}</td>
    <td class="col-date-added">${formatDateAdded(track.dateAdded)}</td>
    <td class="col-issues">${issueBadges}${artIndicator}</td>
    ${showActions ? '<td class="col-row-actions"></td>' : ''}
  `;

  // Wire checkbox
  if (showCheckbox && handlers.onCheckToggle) {
    const checkbox = tr.querySelector('.row-checkbox') as HTMLInputElement;
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onCheckToggle!(track, e);
    });
  }

  if (handlers.onAction) {
    const actionsCell = tr.querySelector('.col-row-actions') as HTMLTableCellElement;
    const suggestedAction = getPrimarySuggestedAction(track.issues);

    if (suggestedAction === 'convert_aiff') {
      const btn = document.createElement('button');
      btn.className = 'btn-icon row-action-btn';
      btn.setAttribute('data-tooltip', 'Convert to AIFF');
      btn.innerHTML = icons.wrench;
      btn.addEventListener('click', (e) => { e.stopPropagation(); handlers.onAction!('fix', track); });
      actionsCell.appendChild(btn);
    } else if (suggestedAction === 'reencode_mp3') {
      const btn = document.createElement('button');
      btn.className = 'btn-icon row-action-btn';
      btn.setAttribute('data-tooltip', 'Re-encode to 320 kbps');
      btn.innerHTML = icons.wrench;
      btn.addEventListener('click', (e) => { e.stopPropagation(); handlers.onAction!('reencode', track); });
      actionsCell.appendChild(btn);
    }

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-icon row-action-btn';
    editBtn.setAttribute('data-tooltip', 'Edit tags');
    editBtn.innerHTML = icons.edit;
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); handlers.onAction!('edit', track); });
    actionsCell.appendChild(editBtn);

    const archiveBtn = document.createElement('button');
    archiveBtn.className = 'btn-icon row-action-btn row-action-danger';
    archiveBtn.setAttribute('data-tooltip', 'Archive track');
    archiveBtn.innerHTML = icons.archive;
    archiveBtn.addEventListener('click', (e) => { e.stopPropagation(); handlers.onAction!('archive', track); });
    actionsCell.appendChild(archiveBtn);

    // Context menu (only when actions are enabled)
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();

      // If multi-select is active and this track is checked, delegate to multi handler
      if (handlers.onContextMenuMulti && handlers.isChecked && handlers.getCheckedTracks) {
        const checkedTracks = handlers.getCheckedTracks();
        if (checkedTracks.length > 1 && handlers.isChecked(track.filePath)) {
          handlers.onContextMenuMulti(checkedTracks, e);
          return;
        }
      }

      const container = track.format.container?.toUpperCase() || '';
      const isAiff = container === 'AIFF' || container === 'AIFF-C';
      const isLossy = track.format.lossless === false;
      const isMp3 = container === 'MPEG' || track.filePath.toLowerCase().endsWith('.mp3');
      const items = [
        ...(!isAiff && !isLossy ? [{ label: 'Convert to AIFF', icon: icons.wrench, action: () => handlers.onAction!('fix', track) }] : []),
        ...(isMp3 ? [{ label: 'Re-encode to 320kbps', icon: icons.wrench, action: () => handlers.onAction!('reencode', track) }] : []),
        { label: 'Edit tags', icon: icons.edit, action: () => handlers.onAction!('edit', track) },
        { label: 'Archive track', icon: icons.archive, action: () => handlers.onAction!('archive', track) },
        { label: 'Delete track', icon: icons.trash, action: () => handlers.onAction!('delete', track) }
      ];
      showContextMenu(e.clientX, e.clientY, items);
    });
  }

  tr.addEventListener('click', () => handlers.onSelected(track));

  return tr;
}
