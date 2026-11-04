/**
 * Shared rendering utilities for health track tables.
 * Used by both library.ts (Library Health) and usbHealth.ts (USB Health).
 */

import type { SuggestedAction, HealthIssue, LibraryHealthTrack } from './shared';
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
  /** Drop the sample-rate, duration and date-added cells (narrow tables). The
   *  table's <thead> must leave out the same columns. */
  compact?: boolean;
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

// ========== Constants ==========
// Display text only. The issue codes (keys) are what the scanner, the DB and
// the dismissed-issue table store, so they never change; only what people
// read does. One plain name per problem, one sentence on why it matters and
// one on what fixes it, shared by the Library, the USB page and the menus.

export const issueDescriptions: Record<string, string> = {
  FILE_NOT_FOUND: 'File is missing',
  UNKNOWN_CONTAINER: 'Unrecognized file type',
  UNSUPPORTED_FORMAT: 'File type CDJs can\'t play',
  INVALID_SAMPLE_RATE: 'Unusual sample rate',
  LOW_SAMPLE_RATE: 'Sample rate too low',
  INVALID_BIT_DEPTH: 'Unusual bit depth',
  BIT_DEPTH_32: '32-bit file',
  LOW_BITRATE: 'Very low quality MP3',
  HIGH_BITRATE: 'MP3 above 320 kbps',
  LOSSY_FORMAT: 'Lower quality (MP3/AAC)',
  MULTICHANNEL: 'Surround sound, not stereo',
  NON_PCM_CODEC: 'Unusual WAV or AIFF',
  WAV_METADATA_WARNING: 'WAV that may show an error',
  LONG_DURATION: 'Very long (over 2 hours)',
  SHORT_DURATION: 'Very short (under 10 seconds)',
  PARSE_ERROR: 'Can\'t read this file',
  MISSING_ALBUM_ART: 'No cover art',
  MISSING_TAGS: 'Missing artist or title',
  SPARSE_TAGS: 'Missing album, year or genre',
  PATH_TOO_DEEP: 'Too many folders deep',
  BROKEN_AUDIO: 'Damaged audio (plays as static)'
};

/** Why the problem matters, in one sentence. Matches the scanner's real rules
 *  (src/lib/trackHealthCheck.ts): 32/44.1/48 kHz, 16/24-bit, MP3 32-320 kbps,
 *  under 10 seconds, over 2 hours, fewer than 3 of artist/title/album/year/genre. */
export const issueWhy: Record<string, string> = {
  FILE_NOT_FOUND: 'The file isn\'t where your library expects it. It may have been moved, renamed or deleted.',
  UNKNOWN_CONTAINER: 'Track Lab can\'t tell what kind of audio file this is, so CDJs may not open it.',
  UNSUPPORTED_FORMAT: 'Most CDJs and XDJs can\'t open this file type (like FLAC, OGG or ALAC).',
  INVALID_SAMPLE_RATE: 'CDJs only play files saved at 32, 44.1 or 48 kHz.',
  LOW_SAMPLE_RATE: 'It was saved at under 32 kHz, which CDJs won\'t play.',
  INVALID_BIT_DEPTH: 'CDJs only play 16-bit and 24-bit files.',
  BIT_DEPTH_32: 'CDJs can\'t play 32-bit files, which often come straight out of music software.',
  LOW_BITRATE: 'This MP3 is so compressed it will sound noticeably worse on a big system.',
  HIGH_BITRATE: 'Some CDJs refuse MP3s above the standard 320 kbps.',
  LOSSY_FORMAT: 'Some detail was thrown away to make the file smaller, and it can show on a club system.',
  MULTICHANNEL: 'CDJs expect stereo files with two channels.',
  NON_PCM_CODEC: 'It\'s stored in a compressed form that CDJs may not read.',
  WAV_METADATA_WARNING: 'Extra info inside some WAV files makes Pioneer players show error E-8305.',
  LONG_DURATION: 'It may be a whole DJ mix, or a recording that didn\'t stop.',
  SHORT_DURATION: 'It may be a sample, or a download that didn\'t finish.',
  PARSE_ERROR: 'Track Lab couldn\'t read the file\'s details, so it may be damaged.',
  MISSING_ALBUM_ART: 'Tracks without a cover are harder to spot in Rekordbox and on CDJ screens.',
  MISSING_TAGS: 'The track is hard to find, and Sort new music can\'t tell which artist folder it goes in.',
  SPARSE_TAGS: 'Two or more of album, year and genre are empty, so the track is harder to sort and search.',
  PATH_TOO_DEEP: 'It\'s buried in so many folders that some players can\'t open it.',
  BROKEN_AUDIO: 'An older version of Track Lab scrambled the audio while saving track info.'
};

/** What fixes it, in one sentence. */
export const issueFixHint: Record<string, string> = {
  FILE_NOT_FOUND: 'Put the file back, or remove the track from your library.',
  UNKNOWN_CONTAINER: 'Move it to your archive folder and get a fresh copy.',
  UNSUPPORTED_FORMAT: 'Make an AIFF copy that plays everywhere. It sounds the same.',
  INVALID_SAMPLE_RATE: 'Make a 44.1 kHz copy that CDJs can play.',
  LOW_SAMPLE_RATE: 'Make a 44.1 kHz copy that CDJs can play.',
  INVALID_BIT_DEPTH: 'Make a 24-bit AIFF copy. You won\'t hear a difference.',
  BIT_DEPTH_32: 'Make a 24-bit AIFF copy. You won\'t hear a difference.',
  LOW_BITRATE: 'Buy a better copy. Re-saving it can\'t bring back lost detail.',
  HIGH_BITRATE: 'Re-save it as a standard 320 kbps MP3.',
  LOSSY_FORMAT: 'Buy a full-quality copy (WAV, AIFF or FLAC) when you can.',
  MULTICHANNEL: 'Make a stereo AIFF copy.',
  NON_PCM_CODEC: 'Make a standard AIFF copy. It sounds the same.',
  WAV_METADATA_WARNING: 'Make an AIFF copy if your CDJ shows an error.',
  LONG_DURATION: 'There\'s no automatic fix. Have a listen and decide.',
  SHORT_DURATION: 'Move it to your archive folder if you don\'t need it.',
  PARSE_ERROR: 'Move it to your archive folder and get a fresh copy.',
  MISSING_ALBUM_ART: 'Track Lab can search online for a cover and add it.',
  MISSING_TAGS: 'Track Lab can look it up online and fill in what\'s missing.',
  SPARSE_TAGS: 'Track Lab can look it up online and fill in what\'s missing.',
  PATH_TOO_DEEP: 'Move it to a folder nearer the top of your library.',
  BROKEN_AUDIO: 'Add it again from the original WAV or FLAC, or buy a fresh copy.'
};

/** Why + fix, for title attributes and tooltips that hold a short paragraph. */
export const issueTooltips: Record<string, string> = Object.fromEntries(
  Object.keys(issueDescriptions).map((code) => [code, `${issueWhy[code]}\n${issueFixHint[code]}`])
);

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

/** One label and one plain explanation per track action, shared by the
 *  Library rows, inspector, fix flow, right-click menus and the USB page. */
export const trackActions = {
  play: { label: 'Play', hint: 'Listen to it in the player at the top of the window.' },
  convertAiff: { label: 'Make a CDJ-ready copy', hint: 'Save a full-quality AIFF copy that every CDJ and XDJ plays. It sounds the same as the original.' },
  reencodeMp3: { label: 'Re-save as 320 kbps MP3', hint: 'Save a standard 320 kbps MP3 that Pioneer players accept. It fixes playback, not sound quality.' },
  populateTags: { label: 'Fill in track info', hint: 'Look the track up online and fill in any empty artist, title, album, year or genre. What you already have is kept.' },
  searchArt: { label: 'Add cover art', hint: 'Search online for this track\'s cover and pick one. Nothing is saved until you choose.' },
  editTags: { label: 'Edit track info', hint: 'Change the artist, title, key, tempo and cover saved inside the file.' },
  archive: { label: 'Move to archive folder', hint: 'Move it out of your library into your archive folder. Nothing is deleted.' },
  trash: { label: 'Move to Trash\u2026', hint: 'Move it to the Trash. You\'re asked first, and you can put it back from Finder.' },
  dismiss: { label: 'Ignore', hint: 'Stop flagging this problem on this track. You can bring it back from the track details.' },
  restore: { label: 'Flag again', hint: 'Start flagging this problem on this track again.' },
} as const;

// ========== Pure Helpers ==========

/** The file type people recognise: WAV, AIFF, MP3, AAC, FLAC… rather than
 *  the parser's container names (WAVE, MPEG, "M4A/isom/iso2"). */
export function fileTypeLabel(format: Pick<LibraryHealthTrack['format'], 'container' | 'codec'>, fileName = ''): string {
  const c = (format.container || '').toUpperCase();
  const codec = (format.codec || '').toUpperCase();
  if (c === 'WAVE' || c === 'WAV') return 'WAV';
  if (c.startsWith('AIFF') || c === 'AIFC') return 'AIFF';
  if (c === 'MPEG' || c === 'MP3') return 'MP3';
  if (c === 'FLAC') return 'FLAC';
  if (c === 'OGG' || c === 'VORBIS') return 'OGG';
  if (/^(M4A|M4B|M4P|MP4|MP41|MP42|ISOM|ISO\d|AVC1|DASH|F4A|3GP|3G2)/.test(c)) {
    if (/ALAC/.test(codec)) return 'ALAC';
    if (/AAC/.test(codec)) return 'AAC';
    return 'M4A';
  }
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toUpperCase() : '';
  if (ext === 'AIF') return 'AIFF';
  if (ext && ext.length <= 4) return ext;
  return c && c.length <= 5 ? c : 'Unknown';
}

/** "44.1 kHz", "96 kHz". */
export function formatKhz(sampleRate: number): string {
  const khz = sampleRate / 1000;
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
}

/** Plain quality words for a file: "Full quality (lossless)" or "Compressed
 *  (lower quality)", plus the numbers behind it. */
export function qualityLabel(format: LibraryHealthTrack['format']): { word: string; numbers: string } {
  const nums: string[] = [];
  if (format.lossless !== false && format.bitDepth) nums.push(`${format.bitDepth}-bit`);
  if (format.lossless === false && format.bitRate) nums.push(`${format.bitRate} kbps`);
  if (format.sampleRate) nums.push(formatKhz(format.sampleRate));
  if (format.channels && format.channels !== 2) nums.push(format.channels === 1 ? 'mono' : `${format.channels} channels`);
  const word = format.lossless === true ? 'Full quality (lossless)'
    : format.lossless === false ? 'Compressed (lower quality)'
    : 'Quality unknown';
  return { word, numbers: nums.join(' · ') };
}

export function formatHealthFormatInfo(format: LibraryHealthTrack['format']): string {
  const { word, numbers } = qualityLabel(format);
  return [fileTypeLabel(format), word, numbers].filter(Boolean).join(' · ');
}

/** 'ready' | 'fix' | 'wontplay' from a track's active (not dismissed) issues. */
export type TrackHealthState = 'ready' | 'fix' | 'wontplay';
export function trackHealthState(issues: HealthIssue[]): TrackHealthState {
  const active = issues.filter((i) => !i.dismissed);
  if (active.length === 0) return 'ready';
  return active.some((i) => (issueSeverities[i.code] ?? i.severity) === 'error') ? 'wontplay' : 'fix';
}

export const healthStateLabels: Record<TrackHealthState, string> = {
  ready: 'Ready to play',
  fix: 'Needs a fix',
  wontplay: 'Won\'t play on CDJs',
};
export const healthStatePill: Record<TrackHealthState, string> = {
  ready: 'status-pill--ok',
  fix: 'status-pill--warn',
  wontplay: 'status-pill--danger',
};

/** One sentence about THIS track's problem, from its own numbers: "This
 *  file is 96 kHz.", "The album and genre are empty." Empty when the issue
 *  name already says it all. */
export function issueSpecifics(code: string, track: LibraryHealthTrack): string {
  const f = track.format;
  const type = fileTypeLabel(f, track.fileName);
  const article = /^[AEIMO]/.test(type) ? 'an' : 'a'; // an AIFF, an MP3, a WAV, a FLAC
  const listOf = (items: string[]) => items.length <= 1 ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  switch (code) {
    case 'INVALID_SAMPLE_RATE':
    case 'LOW_SAMPLE_RATE':
      return f.sampleRate ? `This file is ${formatKhz(f.sampleRate)}.` : '';
    case 'INVALID_BIT_DEPTH':
    case 'BIT_DEPTH_32':
      return f.bitDepth ? `This file is ${f.bitDepth}-bit.` : '';
    case 'LOW_BITRATE':
    case 'HIGH_BITRATE':
      return f.bitRate ? `This MP3 is ${f.bitRate} kbps.` : '';
    case 'LOSSY_FORMAT':
      return `This is ${article} ${type} file${f.bitRate ? ` at ${f.bitRate} kbps` : ''}.`;
    case 'UNSUPPORTED_FORMAT':
      return type !== 'Unknown' ? `This is ${article} ${type} file.` : '';
    case 'MULTICHANNEL':
      return f.channels ? `This file has ${f.channels} channels.` : '';
    case 'LONG_DURATION':
    case 'SHORT_DURATION':
      return f.duration ? `It's ${formatDuration(f.duration)} long.` : '';
    case 'MISSING_TAGS': {
      const missing = [!track.artist?.trim() && 'artist', !track.title?.trim() && 'title'].filter(Boolean) as string[];
      return missing.length ? `The ${listOf(missing)} ${missing.length > 1 ? 'are' : 'is'} empty.` : '';
    }
    case 'SPARSE_TAGS': {
      const missing = [!track.album?.trim() && 'album', !track.year && 'year', !track.genre?.trim() && 'genre'].filter(Boolean) as string[];
      return missing.length ? `The ${listOf(missing)} ${missing.length > 1 ? 'are' : 'is'} empty.` : '';
    }
    default:
      return '';
  }
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

// ========== Progress Bar ==========

export function updateScanProgress(
  elements: ProgressElements,
  progress: { phase: string; current: number; total: number; currentFile?: string }
): void {
  if (progress.total > 0) {
    const percent = Math.round((progress.current / progress.total) * 100);
    elements.bar.style.width = `${percent}%`;
    elements.count.textContent = `${progress.current.toLocaleString()} of ${progress.total.toLocaleString()}`;
  } else {
    elements.bar.style.width = '0%';
    elements.count.textContent = progress.phase === 'discovering'
      ? `${progress.current.toLocaleString()} found`
      : '';
  }

  switch (progress.phase) {
    case 'discovering':
      elements.message.textContent = `Finding your tracks\u2026 ${progress.current.toLocaleString()} found`;
      break;
    case 'scanning':
      elements.message.textContent = `Checking each track\u2026 ${Math.round((progress.current / Math.max(progress.total, 1)) * 100)}%`;
      break;
    case 'duplicates':
      elements.message.textContent = 'Looking for duplicates\u2026';
      break;
    case 'complete':
      elements.message.textContent = 'All checked';
      break;
    default:
      elements.message.textContent = 'Checking\u2026';
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

  // Status is a word with its colour, never a coloured icon alone.
  const state: TrackHealthState = track.isHealthy && track.issues.length === 0
    ? 'ready'
    : hasError ? 'wontplay' : 'fix';
  const stateWord = state === 'ready' ? 'Ready' : state === 'fix' ? 'Needs a fix' : 'Won\u2019t play';

  const pillFor = (sev: string) => sev === 'error' ? 'status-pill--danger' : 'status-pill--warn';
  const issueBadges = track.issues
    .map((i) => `<span class="status-pill ${pillFor(issueSeverities[i.code] ?? i.severity)} issue-pill" data-tooltip="${escapeHtml(issueTooltips[i.code] || i.message)}">${escapeHtml(issueDescriptions[i.code] || i.code)}</span>`)
    .join('');

  // Older scans list missing cover art only through hasAlbumArt.
  const artIndicator = track.hasAlbumArt || track.issues.some((i) => i.code === 'MISSING_ALBUM_ART')
    ? ''
    : `<span class="status-pill status-pill--warn issue-pill" data-tooltip="${escapeHtml(issueTooltips.MISSING_ALBUM_ART)}">No cover art</span>`;

  const showCheckbox = !!handlers.isChecked;
  const showActions = !!handlers.onAction;
  tr.innerHTML = `
    ${showCheckbox ? `<td class="col-checkbox"><input type="checkbox" class="row-checkbox" aria-label="Select ${escapeHtml(track.title || track.fileName)}" ${handlers.isChecked!(track.filePath) ? 'checked' : ''}></td>` : ''}
    <td class="col-status"><span class="status-pill ${healthStatePill[state]} dt-status-pill">${stateWord}</span></td>
    <td class="col-artist" title="${escapeHtml(track.artist || 'Unknown artist')}">${escapeHtml(track.artist || 'Unknown artist')}</td>
    <td class="col-title" title="${escapeHtml(track.title || track.fileName)}">${escapeHtml(track.title || track.fileName)}</td>
    <td class="col-format"><span class="dt-format-badge">${escapeHtml(fileTypeLabel(track.format, track.fileName))}</span></td>
    ${handlers.compact ? '' : `<td class="col-sample-rate">${formatSampleRateCell(track.format.sampleRate)}</td>`}
    <td class="col-bitrate">${formatBitRateCell(track.format)}</td>
    ${handlers.compact ? '' : `<td class="col-duration">${track.format.duration ? formatDuration(track.format.duration) : '\u2014'}</td>`}
    ${handlers.compact ? '' : `<td class="col-date-added">${formatDateAdded(track.dateAdded)}</td>`}
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
      btn.setAttribute('data-tooltip', trackActions.convertAiff.hint);
      btn.setAttribute('aria-label', trackActions.convertAiff.label);
      btn.innerHTML = icons.wrench;
      btn.addEventListener('click', (e) => { e.stopPropagation(); handlers.onAction!('fix', track); });
      actionsCell.appendChild(btn);
    } else if (suggestedAction === 'reencode_mp3') {
      const btn = document.createElement('button');
      btn.className = 'btn-icon row-action-btn';
      btn.setAttribute('data-tooltip', trackActions.reencodeMp3.hint);
      btn.setAttribute('aria-label', trackActions.reencodeMp3.label);
      btn.innerHTML = icons.wrench;
      btn.addEventListener('click', (e) => { e.stopPropagation(); handlers.onAction!('reencode', track); });
      actionsCell.appendChild(btn);
    }

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-icon row-action-btn';
    editBtn.setAttribute('data-tooltip', trackActions.editTags.hint);
    editBtn.setAttribute('aria-label', trackActions.editTags.label);
    editBtn.innerHTML = icons.edit;
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); handlers.onAction!('edit', track); });
    actionsCell.appendChild(editBtn);

    const archiveBtn = document.createElement('button');
    archiveBtn.className = 'btn-icon row-action-btn row-action-danger';
    archiveBtn.setAttribute('data-tooltip', trackActions.archive.hint);
    archiveBtn.setAttribute('aria-label', trackActions.archive.label);
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
        ...(!isAiff && !isLossy ? [{ label: trackActions.convertAiff.label, icon: icons.wrench, hint: trackActions.convertAiff.hint, action: () => handlers.onAction!('fix', track) }] : []),
        ...(isMp3 ? [{ label: trackActions.reencodeMp3.label, icon: icons.wrench, hint: trackActions.reencodeMp3.hint, action: () => handlers.onAction!('reencode', track) }] : []),
        { label: trackActions.editTags.label, icon: icons.edit, hint: trackActions.editTags.hint, action: () => handlers.onAction!('edit', track) },
        { label: trackActions.archive.label, icon: icons.archive, hint: trackActions.archive.hint, action: () => handlers.onAction!('archive', track) },
        { label: trackActions.trash.label, icon: icons.trash, danger: true, hint: trackActions.trash.hint, action: () => handlers.onAction!('delete', track) }
      ];
      showContextMenu(e.clientX, e.clientY, items);
    });
  }

  tr.addEventListener('click', () => handlers.onSelected(track));

  return tr;
}
