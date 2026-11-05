// ============================================================
// Library page — the home screen. A health summary (how many tracks are
// ready to play, what needs fixing), then every track in a searchable list
// with a details panel, plus the fixes (convert, fill in track info, cover
// art, archive, Trash) and their dialogs.
// ============================================================

import type {
  LibraryHealthTrack, LibraryHealthResult,
  HealthIssue, SuggestedAction
} from './shared';
import type { ConversionResult } from '../types';
import { addConversionTask, updateConversionTask } from './activity';
import {
  showToast, setStatus, escapeHtml, icons, formatDuration, showContextMenu,
  openTagEditor, getErrorMessage, plural, trapDialogFocus, captureFocusReturn,
  requestOpenSettings, requestOpenSetup,
  checkSpotifyConnection as checkSpotifyConnectionFn,
  signInToSpotifyFlow,
  checkSoundCloudConnection as checkSoundCloudConnectionFn
} from './shared';
import { openSettingsTo } from './settings';
import { openAlbumArtFix } from './albumArtFix';
import { playFile } from './player';
import { confirmAction, confirmMoveToTrash } from './confirmDialog';
import {
  issueDescriptions, issueSeverities, issueWhy, issueFixHint, issueSpecifics,
  trackActions, fileTypeLabel, qualityLabel, trackHealthState, healthStateLabels, healthStatePill,
  type TrackHealthState,
  getPrimarySuggestedAction,
  updateScanProgress as updateScanProgressShared
} from './healthTrackTable';
import { initConnectedDevices } from './connectedDevices';
import {
  expandDrawer, hideDrawer, setDrawerTitle, setDrawerContent,
  getDrawerBody, onDrawerStateChange
} from './rightDrawer';

const esc = escapeHtml;

// ========== Browse Types ==========

interface BrowseTrack {
  id: number;
  filePath: string;
  hasAlbumArt: boolean;
  isHealthy: boolean;
  health: TrackHealthState;
  issues: HealthIssue[];
  title: string;
  artist: string;
  album: string;
  genre: string;
  year: number;
  duration: string;
  /** Friendly file type: WAV, AIFF, MP3, AAC, FLAC… */
  format: string;
  lossless: boolean | null;
  bitrate: number;
  bpm: number | null;
  artHue: number;
}

type Dimension = 'artist' | 'album' | 'genre' | 'format' | 'bpm' | 'year';

/** One "Filter by" dropdown in the filter row. */
interface BrowseColumn {
  dim: Dimension;
  selected: string | null;  // null = any
  collapsed: boolean;
}

// ========== Small inline icons (24×24, stroke 2, round caps) ==========

const svg = (body: string, cls = '') =>
  `<svg${cls ? ` class="${cls}"` : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  warn: svg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  stop: svg('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'),
  ok: svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'),
  note: svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  folder: svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
  drive: svg('<line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/>'),
  search: svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  finder: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
};

// ========== DOM Elements ==========

// Health scan controls
const runLibraryScanBtn = document.getElementById('run-library-scan') as HTMLButtonElement;
const runLibraryScanLabel = runLibraryScanBtn?.querySelector<HTMLElement>('.lib-rescan-label') ?? null;
const libraryProgressSection = document.getElementById('library-progress-section') as HTMLElement;
const libraryProgressMessage = document.getElementById('library-progress-message') as HTMLSpanElement;
const libraryProgressBar = document.getElementById('library-progress-bar') as HTMLDivElement;
const libraryProgressCount = document.getElementById('library-progress-count') as HTMLSpanElement;
const libraryDashboard = document.getElementById('library-dashboard') as HTMLElement;
const scanTimestamp = document.getElementById('scan-timestamp') as HTMLSpanElement;
const kpiTotal = document.getElementById('kpi-total') as HTMLElement;
const kpiSubline = document.getElementById('lib-subline') as HTMLElement | null;
const kpiHealthy = document.getElementById('kpi-healthy') as HTMLButtonElement;
const kpiWarnings = document.getElementById('kpi-warnings') as HTMLButtonElement;
const kpiErrors = document.getElementById('kpi-errors') as HTMLButtonElement;
const issueListEl = document.getElementById('issue-list') as HTMLElement;
const problemsCard = document.getElementById('lib-problems') as HTMLElement | null;
const problemsMoreBtn = document.getElementById('lib-problems-more') as HTMLButtonElement | null;
const filterBar = document.getElementById('lib-filter-bar') as HTMLElement | null;
const filterText = document.getElementById('lib-filter-text') as HTMLElement | null;
const filterClearBtn = document.getElementById('lib-filter-clear') as HTMLButtonElement | null;

// Skeleton
const healthSkeletonSection = document.getElementById('health-skeleton-section') as HTMLElement;

// Inspector
const inspectorPanel = document.getElementById('library-inspector') as HTMLDivElement;
const inspectorClose = document.getElementById('inspector-close') as HTMLButtonElement;
const inspectorArt = document.getElementById('inspector-art') as HTMLDivElement;
const inspectorTitle = document.getElementById('inspector-title') as HTMLDivElement;
const inspectorArtist = document.getElementById('inspector-artist') as HTMLDivElement;
const inspectorStatus = document.getElementById('inspector-status') as HTMLDivElement | null;
const inspectorMeta = document.getElementById('inspector-meta') as HTMLElement;
const inspectorFormat = document.getElementById('inspector-format') as HTMLElement;
const inspectorIssues = document.getElementById('inspector-issues') as HTMLDivElement;
const inspectorActions = document.getElementById('inspector-actions') as HTMLDivElement;

// Fix modal
const fixModal = document.getElementById('fix-modal') as HTMLDivElement;
const fixModalClose = document.getElementById('fix-modal-close') as HTMLButtonElement;
const fixModalCancel = document.getElementById('fix-modal-cancel') as HTMLButtonElement;
const fixModalConfirm = document.getElementById('fix-modal-confirm') as HTMLButtonElement;
const fixFileName = document.getElementById('fix-file-name') as HTMLSpanElement;
const fixIssuesList = document.getElementById('fix-issues-list') as HTMLDivElement;
const fixDeleteOriginal = document.getElementById('fix-delete-original') as HTMLInputElement;
const fixDeleteText = document.getElementById('fix-delete-text') as HTMLElement | null;
const fixModalTitle = document.getElementById('fix-modal-title') as HTMLHeadingElement;
const fixModalDesc = document.getElementById('fix-modal-desc') as HTMLParagraphElement;
const fixModalNote = document.getElementById('fix-modal-note') as HTMLElement | null;

// ========== State ==========

// Health state
let healthResult: LibraryHealthResult | null = null;
let activeIssueCode: string | null = null;
/** The stat tile filter: Ready / Needs a fix / Won't play. Never set at the
 *  same time as an issue filter, so the list always answers one question. */
let activeHealthFilter: TrackHealthState | null = null;
let selectedTrackPath: string | null = null;
let activeLibraryScanId: string | null = null;
let backgroundScanRunning = false;
let pendingAutoRefresh: Promise<LibraryHealthResult | null> | null = null;

let pendingFixTrack: LibraryHealthTrack | null = null;
let pendingReencodeTrack: LibraryHealthTrack | null = null;
let allTracks: BrowseTrack[] = [];
let trackLookup: Map<string, LibraryHealthTrack> = new Map();

let columns: BrowseColumn[] = [];

let splitPanelOpen = false;
let splitDimension: Dimension = 'artist';
let splitSelected: string | null = null;

let activeIssueFilter: string | null = null;
let browseSearchQuery = '';
let lastLoadedLibraryRoot: string | null = null;
/** "What needs fixing" shows the top few kinds of problem until expanded. */
let showAllProblems = false;
const PROBLEMS_SHOWN = 3;

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function hueFromArtist(artist: string): number {
  let hash = 0;
  for (let i = 0; i < artist.length; i++) {
    hash = ((hash << 5) - hash) + artist.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The drive a /Volumes path lives on ("Candy Bar"), or null for an internal folder. */
function driveNameOf(p: string | null): string | null {
  const m = p ? /^\/Volumes\/([^/]+)/.exec(p) : null;
  return m ? m[1] : null;
}

function highlightFixFlowTrack(): void {
  if (!fixFlow) return;
  const targetPath = fixFlow.trackPaths[fixFlow.currentIndex];
  const list = document.getElementById('browse-compact-list');
  if (!list) return;
  list.querySelectorAll('.bv4-row.fix-flow-focus').forEach(r => r.classList.remove('fix-flow-focus'));
  const row = list.querySelector<HTMLElement>(`.bv4-row[data-fp="${CSS.escape(targetPath)}"]`);
  if (row) {
    row.classList.add('fix-flow-focus');
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// Fix Flow state
interface FixFlowState {
  issueCode: string;
  trackPaths: string[];
  currentIndex: number;
  applying: boolean;
  fixedCount: number;
  unsubDrawer: (() => void) | null;
}
let fixFlow: FixFlowState | null = null;
/** A bulk Fill In Tags is running; its button shows progress meanwhile. */
let bulkPopulateRunning = false;

/** Library folder state, for the empty list and the offline banner.
 *  'unset': no folder chosen in Settings. 'offline': the folder (usually an
 *  external drive) isn't there, so the last scan is shown instead. */
let libraryAvailability: 'ok' | 'unset' | 'offline' = 'ok';
let offlineRoot: string | null = null;

// ========== Browse Dimension Helpers ==========

const DIM_LABELS: Record<Dimension, string> = {
  artist: 'Artist', album: 'Album', genre: 'Genre',
  format: 'File type', bpm: 'Tempo', year: 'Year',
};
/** "Any genre", "Any tempo" — the "no filter" choice of each dropdown. */
const DIM_ANY: Record<Dimension, string> = {
  artist: 'Any artist', album: 'Any album', genre: 'Any genre',
  format: 'Any file type', bpm: 'Any tempo', year: 'Any year',
};
const DIM_PLURAL: Record<Dimension, string> = {
  artist: 'Artists', album: 'Albums', genre: 'Genres',
  format: 'File types', bpm: 'Tempos', year: 'Years',
};

function bpmRange(bpm: number | null): string {
  if (bpm === null) return 'No tempo saved';
  const low = Math.floor(bpm / 10) * 10;
  return `${low}–${low + 9} BPM`;
}

function dimValue(t: BrowseTrack, dim: Dimension): string {
  switch (dim) {
    case 'artist': return t.artist || 'Unknown artist';
    case 'album':  return t.album || 'No album';
    case 'genre':  return t.genre || 'No genre';
    case 'format': return t.format;
    case 'bpm':    return bpmRange(t.bpm);
    case 'year':   return t.year ? String(t.year) : 'No year';
  }
}

const FULL_QUALITY_TYPES = new Set(['AIFF', 'WAV', 'FLAC', 'ALAC']);

function formatBadge(t: BrowseTrack): string {
  const full = t.lossless === true || (t.lossless === null && FULL_QUALITY_TYPES.has(t.format));
  const plays = t.health !== 'wontplay';
  const cls = !full ? 'fmt-lossy' : t.format === 'FLAC' || t.format === 'ALAC' ? 'fmt-flac' : 'fmt-lossless';
  const tip = `${t.format}: ${full ? 'full quality (lossless)' : 'compressed, lower quality'}. ${plays ? 'Plays on CDJs.' : 'May not play on CDJs.'}`;
  return `<span class="fmt-badge ${cls}" data-tooltip="${esc(tip)}">${esc(t.format)}</span>`;
}

// ========== Health State Sync ==========

function syncHealthState() {
  if (healthResult) {
    window.candybar.updateHealthResult(healthResult);
  }
}

function recalculateSummary() {
  if (!healthResult) return;
  const tracks = healthResult.tracks;
  const summary = healthResult.summary;
  summary.total = tracks.length;
  summary.healthy = 0;
  summary.warnings = 0;
  summary.errors = 0;
  summary.byIssueCode = {};

  for (const t of tracks) {
    const activeIssues = t.issues.filter(issue => !issue.dismissed);
    const hasError = activeIssues.some(i => (issueSeverities[i.code] ?? i.severity) === 'error');
    if (activeIssues.length === 0) {
      summary.healthy++;
    } else if (hasError) {
      summary.errors++;
    } else {
      summary.warnings++;
    }
    for (const issue of activeIssues) {
      summary.byIssueCode[issue.code] = (summary.byIssueCode[issue.code] || 0) + 1;
    }
  }
}

// Fetch dismissed-issue set for the current library root and annotate
// each issue on healthResult.tracks with a `dismissed` flag. No-op on failure.
async function annotateDismissedIssues(): Promise<void> {
  if (!healthResult) return;
  try {
    const rows = await window.candybar.getDismissedIssues(healthResult.libraryRoot);
    const key = (fp: string, code: string) => `${fp}|${code}`;
    const set = new Set(rows.map(r => key(r.filePath, r.issueCode)));
    for (const t of healthResult.tracks) {
      for (const issue of t.issues) {
        issue.dismissed = set.has(key(t.filePath, issue.code));
      }
    }
  } catch {
    // Non-fatal — treat as "nothing dismissed"
  }
}

// ========== Remove Track ==========

function removeTrackFromHealthResult(track: LibraryHealthTrack) {
  if (!healthResult) return;
  healthResult.tracks = healthResult.tracks.filter(t => t.filePath !== track.filePath);
  recalculateSummary();
  syncHealthState();

  // Rebuild browse view model
  rebuildBrowseTracks();
  renderCompactList();
  renderKpiDashboard(healthResult);

  if (selectedTrackPath === track.filePath) closeInspector();
}

// ========== Art Cache & Lazy Load ==========

const artCache = new Map<string, string | null>();
let artObserver: IntersectionObserver | null = null;

function setupArtLazyLoad(container: HTMLElement): void {
  if (artObserver) artObserver.disconnect();

  // Observe the wrapper div, not the <img>. The <img> starts with
  // style="display:none" (no bounding box), which makes IntersectionObserver
  // think it never intersects — so the load callback never fires.
  artObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const wrap = entry.target as HTMLElement;
      const fp = wrap.dataset.fp!;
      artObserver!.unobserve(wrap);
      const img = wrap.querySelector<HTMLImageElement>('img.bv4-art');
      if (!img) continue;

      if (artCache.has(fp)) {
        const cached = artCache.get(fp);
        wrap.classList.remove('loading');
        if (cached) { img.src = cached; img.style.display = 'block'; }
      } else {
        window.candybar.getTrackAlbumArt(fp).then((dataUrl) => {
          artCache.set(fp, dataUrl);
          wrap.classList.remove('loading');
          if (dataUrl) { img.src = dataUrl; img.style.display = 'block'; }
        }).catch(() => { artCache.set(fp, null); wrap.classList.remove('loading'); });
      }
    }
  }, { rootMargin: '120px' });

  container.querySelectorAll<HTMLElement>('.bv4-art-wrap[data-fp]').forEach(wrap => {
    const fp = wrap.dataset.fp!;
    const img = wrap.querySelector<HTMLImageElement>('img.bv4-art');
    if (!img) return;
    if (artCache.has(fp)) {
      const cached = artCache.get(fp);
      wrap.classList.remove('loading');
      if (cached) { img.src = cached; img.style.display = 'block'; }
    } else {
      artObserver!.observe(wrap);
    }
  });
}

// ========== Build Browse View Model ==========

function rebuildBrowseTracks(): void {
  if (!healthResult) {
    allTracks = [];
    trackLookup = new Map();
    return;
  }

  trackLookup = new Map();
  allTracks = healthResult.tracks.map((t, i) => {
    trackLookup.set(t.filePath, t);
    // Dismissed issues are hidden from the Library's filters, pills, and counts.
    // They remain on the source track (healthResult.tracks[i]) so the inspector
    // can surface them and offer restore.
    const activeIssues = t.issues.filter(issue => !issue.dismissed);
    return {
      id: i + 1,
      filePath: t.filePath,
      hasAlbumArt: t.hasAlbumArt,
      isHealthy: activeIssues.length === 0,
      health: trackHealthState(activeIssues),
      issues: activeIssues,
      title: t.title || t.fileName,
      artist: t.artist,
      album: t.album,
      genre: t.genre,
      year: t.year ?? 0,
      duration: formatDuration(t.format.duration),
      format: fileTypeLabel(t.format, t.fileName),
      lossless: t.format.lossless,
      bitrate: t.format.bitRate ?? 0,
      bpm: typeof t.bpm === 'number' && t.bpm > 0 ? t.bpm : null,
      artHue: hueFromArtist(t.artist || t.fileName),
    } satisfies BrowseTrack;
  });
}

/** The list's filters. `skip` leaves some out, for counts that answer "how
 *  many would this choice show right now?". */
function applyAllFilters(skip: { issue?: boolean; health?: boolean } = {}): BrowseTrack[] {
  let tracks = allTracks.slice();

  // Each "Filter by" dropdown narrows by its chosen value
  for (const col of columns) {
    if (col.selected !== null) {
      tracks = tracks.filter(t => dimValue(t, col.dim) === col.selected);
    }
  }

  // Side list ("Browse by")
  if (splitPanelOpen && splitSelected !== null) {
    tracks = tracks.filter(t => dimValue(t, splitDimension) === splitSelected);
  }

  // Issue type filter. 'all' is a legacy "no filter" sentinel from the
  // Health tab's tab-filter config, not an issue code — treat it as null.
  if (!skip.issue) {
    const rawIssueCode = activeIssueCode ?? activeIssueFilter;
    const effectiveIssueCode = rawIssueCode && rawIssueCode !== 'all' ? rawIssueCode : null;
    if (effectiveIssueCode !== null) {
      tracks = tracks.filter(t => t.issues.some(i => i.code === effectiveIssueCode));
    }
  }

  // Ready / Needs a fix / Won't play
  if (!skip.health && activeHealthFilter) {
    tracks = tracks.filter(t => t.health === activeHealthFilter);
  }

  // Search query filter
  const q = browseSearchQuery.trim().toLowerCase();
  if (q) {
    tracks = tracks.filter(t =>
      t.title.toLowerCase().includes(q) ||
      t.artist.toLowerCase().includes(q) ||
      t.album.toLowerCase().includes(q)
    );
  }

  return tracks;
}

function anyListFilterActive(): boolean {
  return !!browseSearchQuery || columns.some(c => c.selected !== null) || (splitPanelOpen && splitSelected !== null);
}

// ========== Compact List Rendering ==========

function artThumb(t: BrowseTrack): string {
  const cachedSrc = artCache.get(t.filePath);
  const loaded = t.hasAlbumArt && cachedSrc != null;
  const loading = t.hasAlbumArt && !artCache.has(t.filePath);
  const imgAttrs = loaded ? `src="${esc(cachedSrc!)}" style="display:block"` : 'style="display:none"';
  const inner = t.hasAlbumArt ? `<img class="bv4-art" ${imgAttrs} alt="">` : '';
  const dataFp = t.hasAlbumArt ? ` data-fp="${esc(t.filePath)}"` : '';
  // No cover: a quiet tinted tile with a note, so rows without art still read
  // as tracks instead of flat colour squares.
  return `<div class="bv4-art-wrap${loading ? ' loading' : ''}${t.hasAlbumArt ? '' : ' no-art'}"${dataFp} style="--art-hue:${t.artHue}">${ICON.note}${inner}</div>`;
}

/** The row's problem, as a word: the most serious issue's name, "+2" for more. */
function rowStatusHtml(t: BrowseTrack): string {
  if (t.isHealthy) return '';
  const sorted = [...t.issues].sort((a, b) =>
    ((issueSeverities[b.code] ?? b.severity) === 'error' ? 1 : 0) - ((issueSeverities[a.code] ?? a.severity) === 'error' ? 1 : 0));
  const first = sorted[0];
  const label = issueDescriptions[first.code] || first.code;
  const more = sorted.length > 1 ? ` <span class="lib-pill-more">+${sorted.length - 1}</span>` : '';
  const tip = `${healthStateLabels[t.health]}: ${sorted.map(i => issueDescriptions[i.code] || i.code).join(', ')}. Click the track for details and fixes.`;
  return `<span class="status-pill ${healthStatePill[t.health]} lib-row-pill" data-tooltip="${esc(tip)}"><span class="lib-pill-text">${esc(label)}</span>${more}</span>`;
}

function emptyState(icon: string, title: string, body: string, actions = ''): string {
  return `<div class="empty-state lib-empty">
    <div class="empty-state-icon">${icon}</div>
    <h4>${esc(title)}</h4>
    <p>${body}</p>
    ${actions ? `<div class="empty-state-actions">${actions}</div>` : ''}
  </div>`;
}

/** What the list shows when it has no rows: why, and the way out. */
function emptyListHtml(): string {
  if (libraryAvailability === 'unset') {
    return emptyState(ICON.folder, 'Choose your library folder',
      'Pick the folder your music lives in, and Track Lab checks every track in it for anything that could stop it playing on CDJs. Nothing in it is changed.',
      '<button class="btn-primary" data-empty-action="setup">Choose your library folder</button>');
  }
  if (libraryAvailability === 'offline' && !healthResult) {
    const drive = driveNameOf(offlineRoot);
    return emptyState(ICON.drive, drive ? `Plug in “${esc(drive)}”` : 'Track Lab can’t find your library folder',
      drive
        ? `Your library lives on the drive called “${esc(drive)}”, and it isn’t plugged in. Plug it in, then try again.`
        : `Track Lab looked for your music in ${esc(offlineRoot || 'your library folder')} and it isn’t there. If it moved, choose where it is now.`,
      `<button class="btn-primary" data-empty-action="retry">Try again</button>
       <button class="btn-secondary" data-empty-action="settings">Choose a different folder</button>`);
  }
  if (healthResult && healthResult.tracks.length === 0) {
    return emptyState(ICON.note, 'No music in your library folder yet',
      `Track Lab looked in ${esc(healthResult.libraryRoot)} and found no music files. Choose the folder your music is in, or use Sort new music to move downloads here.`,
      '<button class="btn-primary" data-empty-action="setup">Choose your library folder</button>');
  }
  if (!healthResult) {
    return emptyState(ICON.note, 'Checking your library…', 'Your tracks show up here as soon as Track Lab has looked through your library folder.');
  }
  return emptyState(ICON.search, 'No tracks match',
    'Nothing in your library matches what you’ve picked. Try a different search, or show every track again.',
    '<button class="btn-secondary" data-empty-action="clear">Show all tracks</button>');
}

function renderCompactList(): void {
  const list = document.getElementById('browse-compact-list');
  if (!list) return;
  const tracks = applyAllFilters();

  list.innerHTML = tracks.map((t, i) => {
    const selected = selectedTrackPath === t.filePath ? ' selected' : '';
    const artist = t.artist || 'Unknown artist';
    const subtitle = t.album
      ? `${esc(artist)}<span class="bv4-sep">&middot;</span>${esc(t.album)}`
      : esc(artist);
    const bpm = t.bpm === null ? '<span class="lib-none" aria-label="No tempo saved">—</span>' : String(Number.isInteger(t.bpm) ? t.bpm : t.bpm.toFixed(1));
    const statusWord = t.isHealthy ? 'Ready to play' : `${healthStateLabels[t.health]}: ${t.issues.map(x => issueDescriptions[x.code] || x.code).join(', ')}`;
    return `
    <div class="bv4-row lib-row${t.isHealthy ? '' : ` is-${t.health}`}${selected}" data-id="${t.id}" data-fp="${esc(t.filePath)}" role="button" tabindex="0" aria-label="${esc(`${t.title}${t.artist ? ` by ${t.artist}` : ''}. ${statusWord}. Open details`)}">
      <span class="bv4-num">${i + 1}</span>
      ${artThumb(t)}
      <div class="bv4-title-group">
        <span class="bv4-title">${esc(t.title)}</span>
        <span class="bv4-artist">${subtitle}</span>
      </div>
      <div class="lib-row-status">${rowStatusHtml(t)}</div>
      <span class="lib-col-type">${formatBadge(t)}</span>
      <span class="bv4-bpm">${bpm}</span>
      <span class="bv4-dur">${esc(t.duration)}</span>
    </div>`;
  }).join('') || emptyListHtml();

  list.classList.toggle('is-empty', tracks.length === 0);
  list.querySelector<HTMLButtonElement>('[data-empty-action="setup"]')?.addEventListener('click', () => requestOpenSetup('library'));
  list.querySelector<HTMLButtonElement>('[data-empty-action="settings"]')?.addEventListener('click', () => requestOpenSettings('library'));
  list.querySelector<HTMLButtonElement>('[data-empty-action="retry"]')?.addEventListener('click', () => void autoRefreshLibrary());
  list.querySelector<HTMLButtonElement>('[data-empty-action="clear"]')?.addEventListener('click', clearAllFilters);

  // The column header and toolbar only make sense with tracks to show.
  const hasLibrary = !!healthResult && healthResult.tracks.length > 0;
  document.getElementById('page-library')?.classList.toggle('lib-has-tracks', hasLibrary);

  setupArtLazyLoad(list);
  wireCompactListEvents(list);
  renderProblemList();
  renderFilterBar(tracks.length);
}

function wireCompactListEvents(list: HTMLElement): void {
  list.querySelectorAll<HTMLElement>('.bv4-row').forEach(row => {
    const fp = row.dataset.fp;
    if (!fp) return;

    // Click to open inspector
    row.addEventListener('click', (e) => {
      const healthTrack = trackLookup.get(fp);
      if (healthTrack) openInspector(healthTrack);
    });
    // Keyboard: Enter/Space opens the details, like a click.
    row.addEventListener('keydown', (e) => {
      if (e.target !== row || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      const healthTrack = trackLookup.get(fp);
      if (healthTrack) openInspector(healthTrack);
    });

    // Right-click context menu (also the keyboard's menu key / Shift+F10,
    // which fire it with no pointer position: open it at the row instead)
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const healthTrack = trackLookup.get(fp);
      if (!healthTrack) return;
      const rect = row.getBoundingClientRect();
      const fromKeyboard = e.clientX === 0 && e.clientY === 0;
      const menuX = fromKeyboard ? rect.left + 24 : e.clientX;
      const menuY = fromKeyboard ? rect.bottom : e.clientY;

      const container = healthTrack.format.container?.toUpperCase() || '';
      const isAiff = container === 'AIFF' || container === 'AIFF-C';
      const isLossy = healthTrack.format.lossless === false;
      const isMp3 = container === 'MPEG' || healthTrack.filePath.toLowerCase().endsWith('.mp3');

      const activeIssues = healthTrack.issues.filter(i => !i.dismissed);
      const dismissItems = activeIssues.map(issue => ({
        label: `Ignore “${issueDescriptions[issue.code] || issue.code}”`,
        icon: icons.ignore,
        hint: trackActions.dismiss.hint,
        action: () => handleDismissIssue(healthTrack, issue.code)
      }));
      const dismissAllItem = activeIssues.length > 1
        ? [{
            label: 'Ignore every problem on this track',
            icon: icons.ignore,
            hint: 'Stop flagging every problem on this track. You can bring them back from the track details.',
            action: () => handleDismissAllIssues(healthTrack)
          }]
        : [];

      const items = [
        { label: 'Play', icon: icons.play, hint: trackActions.play.hint, action: () => playFile(healthTrack.filePath, healthTrack.fileName) },
        { separator: true, label: '' },
        ...(!isAiff && !isLossy ? [{ label: trackActions.convertAiff.label, icon: icons.wrench, hint: trackActions.convertAiff.hint, action: () => showFixModal(healthTrack) }] : []),
        ...(isMp3 ? [{ label: trackActions.reencodeMp3.label, icon: icons.wrench, hint: trackActions.reencodeMp3.hint, action: () => showReencodeModal(healthTrack) }] : []),
        { label: trackActions.editTags.label, icon: icons.edit, hint: trackActions.editTags.hint, action: () => handleEditTags(healthTrack) },
        ...(dismissItems.length > 0 || dismissAllItem.length > 0 ? [{ separator: true, label: '' }] : []),
        ...dismissItems,
        ...dismissAllItem,
        ...(dismissItems.length > 0 || dismissAllItem.length > 0 ? [{ separator: true, label: '' }] : []),
        { label: trackActions.archive.label, icon: icons.archive, hint: trackActions.archive.hint, action: () => handleArchiveTrack(healthTrack) },
        { label: trackActions.trash.label, icon: icons.trash, danger: true, hint: trackActions.trash.hint, action: () => trashTrack(healthTrack) }
      ];
      showContextMenu(menuX, menuY, items);
    });

  });
}

// ========== "Filter by" dropdowns ==========

function renderColumnStrip(): void {
  const strip = document.getElementById('browse-column-strip');
  const area = document.getElementById('browse-columns-area') as HTMLElement | null;
  if (!strip || !area) return;
  area.hidden = columns.length === 0;

  strip.innerHTML = columns.map((col, i) => {
    // Values come from the tracks the OTHER filters leave, so every choice
    // shows at least one track.
    const others = columns.filter((_, j) => j !== i);
    let pool = allTracks;
    for (const o of others) if (o.selected !== null) pool = pool.filter(t => dimValue(t, o.dim) === o.selected);
    const counts = new Map<string, number>();
    for (const t of pool) { const v = dimValue(t, col.dim); counts.set(v, (counts.get(v) ?? 0) + 1); }
    const values = [...counts.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const opts = values.map(v => `<option value="${esc(v)}"${col.selected === v ? ' selected' : ''}>${esc(v)} (${counts.get(v)!.toLocaleString()})</option>`).join('');
    return `<div class="lib-filter-chip${col.selected !== null ? ' is-set' : ''}">
      <label class="lib-filter-chip-label" for="lib-col-${i}">${DIM_LABELS[col.dim]}</label>
      <select id="lib-col-${i}" data-col="${i}" class="lib-filter-select"><option value="">${DIM_ANY[col.dim]}</option>${opts}</select>
      <button class="btn-icon lib-filter-remove" data-remove="${i}" aria-label="Remove the ${DIM_LABELS[col.dim].toLowerCase()} filter" data-tooltip="Remove this filter">${ICON.x}</button>
    </div>`;
  }).join('');

  strip.querySelectorAll<HTMLSelectElement>('select[data-col]').forEach(sel => {
    sel.addEventListener('change', () => {
      const i = Number(sel.dataset.col);
      columns[i].selected = sel.value === '' ? null : sel.value;
      renderColumnStrip();
      renderCompactList();
      document.getElementById(`lib-col-${i}`)?.focus();
    });
  });
  strip.querySelectorAll<HTMLButtonElement>('button[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      columns.splice(Number(btn.dataset.remove), 1);
      renderColumnStrip();
      renderCompactList();
      (document.getElementById('add-column-select') as HTMLElement | null)?.focus();
    });
  });
  syncAddColumnOptions();
}

/** A dimension already filtered can't be added twice. */
function syncAddColumnOptions(): void {
  const sel = document.getElementById('add-column-select') as HTMLSelectElement | null;
  if (!sel) return;
  sel.querySelectorAll('option').forEach(o => {
    if (!o.value) return;
    o.disabled = columns.some(c => c.dim === o.value);
  });
}

// ========== Side list ("Browse by") ==========

function renderSplitPanel(): void {
  const header = document.getElementById('split-panel-header');
  const ul = document.getElementById('split-list');
  if (!header || !ul) return;

  header.textContent = DIM_PLURAL[splitDimension];

  const counts = new Map<string, number>();
  for (const t of allTracks) { const v = dimValue(t, splitDimension); counts.set(v, (counts.get(v) ?? 0) + 1); }
  const values = unique([...counts.keys()]).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const allLabel = `All ${DIM_PLURAL[splitDimension].toLowerCase()}`;
  ul.innerHTML = [{ v: '', label: allLabel, n: allTracks.length }, ...values.map(v => ({ v, label: v, n: counts.get(v)! }))].map(({ v, label, n }) => {
    const active = v === '' ? splitSelected === null : splitSelected === v;
    return `<li class="bv5-item${active ? ' active' : ''}" data-val="${esc(v)}" role="button" tabindex="0" aria-pressed="${active}"><span class="bv5-item-label">${esc(label)}</span><span class="bv5-item-count">${n.toLocaleString()}</span></li>`;
  }).join('');

  ul.querySelectorAll<HTMLElement>('.bv5-item').forEach(el => {
    const pick = () => {
      splitSelected = el.dataset.val || null;
      renderSplitPanel();
      renderCompactList();
      // Re-rendering replaced the list; keep keyboard focus on the picked item.
      ul.querySelector<HTMLElement>(`.bv5-item[data-val="${CSS.escape(el.dataset.val ?? '')}"]`)?.focus();
    };
    el.addEventListener('click', pick);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
    });
  });
}

function setSplitPanel(open: boolean, dim?: Dimension): void {
  splitPanelOpen = open;
  if (dim) splitDimension = dim;
  splitSelected = null;
  const panel = document.getElementById('split-panel');
  if (panel) panel.hidden = !open;
  const sel = document.getElementById('split-dimension') as HTMLSelectElement | null;
  if (sel) sel.value = open ? splitDimension : '';
  if (open) renderSplitPanel();
  renderCompactList();
}

function addColumn(dim: Dimension): void {
  if (!(dim in DIM_LABELS)) return; // an option this view has no data for
  if (columns.some(c => c.dim === dim)) return;
  columns.push({ dim, selected: null, collapsed: false });
  renderColumnStrip();
  renderCompactList();
  document.getElementById(`lib-col-${columns.length - 1}`)?.focus();
}

/** Back to every track: search, side list, dropdowns and health filters. */
function clearAllFilters(): void {
  if (fixFlow) exitFixFlow();
  guideCodes = null;
  for (const col of columns) col.selected = null;
  columns = [];
  splitSelected = null;
  activeIssueCode = null;
  activeIssueFilter = null;
  activeHealthFilter = null;
  browseSearchQuery = '';
  const searchInput = document.getElementById('browse-search') as HTMLInputElement | null;
  if (searchInput) searchInput.value = '';
  renderColumnStrip();
  if (splitPanelOpen) renderSplitPanel();
  renderCompactList();
  if (healthResult) renderKpiDashboard(healthResult);
}

// ========== Health summary ==========

function renderKpiDashboard(result: LibraryHealthResult): void {
  const { summary } = result;
  const total = summary.total;

  if (total === 0) {
    kpiTotal.textContent = 'No tracks yet';
    if (kpiSubline) kpiSubline.textContent = 'Track Lab found no music in your library folder.';
  } else if (summary.healthy === total) {
    kpiTotal.textContent = total === 1 ? 'Your 1 track is ready to play' : `All ${total.toLocaleString()} tracks are ready to play`;
    if (kpiSubline) kpiSubline.textContent = 'Nothing needs fixing. Nice.';
  } else {
    kpiTotal.textContent = `${summary.healthy.toLocaleString()} of ${plural(total, 'track')} ${summary.healthy === 1 ? 'is' : 'are'} ready to play`;
    const parts: string[] = [];
    if (summary.warnings > 0) parts.push(`${summary.warnings.toLocaleString()} could use a fix`);
    if (summary.errors > 0) parts.push(`${summary.errors.toLocaleString()} may not play on CDJs`);
    if (kpiSubline) kpiSubline.textContent = parts.join(' · ');
  }

  const setTile = (tile: HTMLButtonElement | null, n: number, state: TrackHealthState) => {
    if (!tile) return;
    const value = tile.querySelector('.stat-value');
    if (value) value.textContent = n.toLocaleString();
    const active = activeHealthFilter === state;
    tile.classList.toggle('is-active', active);
    tile.setAttribute('aria-pressed', String(active));
    tile.disabled = n === 0 && !active;
  };
  setTile(kpiHealthy, summary.healthy, 'ready');
  setTile(kpiWarnings, summary.warnings, 'fix');
  setTile(kpiErrors, summary.errors, 'wontplay');
  libraryDashboard.classList.toggle('lib-all-ready', total > 0 && summary.healthy === total);
  libraryDashboard.classList.toggle('lib-no-tracks', total === 0);

  // When it was last checked
  if (result.scannedAt) {
    scanTimestamp.textContent = `Last checked ${formatWhen(result.scannedAt)}`;
  }

  renderProblemList();
  // An empty library has nothing to summarise; the list's empty state says what to do.
  libraryDashboard.style.display = total === 0 ? 'none' : '';
}

function setHealthFilter(state: TrackHealthState): void {
  if (fixFlow) exitFixFlow();
  guideCodes = null;
  activeHealthFilter = activeHealthFilter === state ? null : state;
  activeIssueCode = null;
  activeIssueFilter = null;
  renderCompactList();
  if (healthResult) renderKpiDashboard(healthResult);
}

function setIssueFilter(code: string | null): void {
  if (fixFlow) exitFixFlow();
  activeIssueCode = code;
  activeIssueFilter = null;
  if (code) activeHealthFilter = null;
  renderCompactList();
  if (healthResult) renderKpiDashboard(healthResult);
}

/** The one fix each kind of problem offers from "What needs fixing". */
function problemFix(code: string): { label: string; hint: string } | null {
  if (code === 'MISSING_ALBUM_ART') return { label: 'Add cover art', hint: 'Search online for covers, one track at a time. Nothing is saved until you pick one.' };
  if (code === 'MISSING_TAGS' || code === 'SPARSE_TAGS') return { label: 'Fill in track info', hint: 'Look each track up online and fill in what’s empty. You confirm first, and what you already have is kept.' };
  if (code === 'LOSSY_FORMAT' || code === 'LOW_BITRATE') return { label: 'Upgrade quality', hint: 'Open Upgrade quality, which finds full-quality copies for the tracks in your Rekordbox playlists.' };
  const action = issueActionFor(code);
  if (action === 'convert_aiff' || action === 'reencode_mp3') return { label: 'Fix one by one', hint: 'Go through these tracks one at a time and choose a fix for each. Nothing changes until you do.' };
  return null;
}

/** The suggested action the scanner gives this kind of problem (first match). */
function issueActionFor(code: string): SuggestedAction {
  for (const t of allTracks) {
    const issue = t.issues.find(i => i.code === code);
    if (issue) return issue.suggestedAction;
  }
  return 'none';
}

/** Every kind of problem in the list right now, most serious first (won't
 *  play, then by how many tracks). Counts follow the search, side list and
 *  dropdowns, so each answers "how many tracks would this show right now?". */
function rankedProblems(): Array<[string, number]> {
  const baseList = applyAllFilters({ issue: true, health: true });
  const counts = new Map<string, number>();
  for (const t of baseList) {
    for (const issue of t.issues) counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
  }
  const sevRank = (code: string) => (issueSeverities[code] || 'warning') === 'error' ? 0 : 1;
  return Array.from(counts.entries())
    .filter(([, n]) => n > 0)
    .sort((a, b) => sevRank(a[0]) - sevRank(b[0]) || b[1] - a[1]);
}

// ---- The guided path: one kind of problem at a time ----
// "Fix what needs fixing" walks the ranked kinds in order. Each step narrows
// the list to that kind, says what it means and offers its one fix; nothing
// changes until a fix is chosen. Stepping on, or Done, leaves files alone.

let guideCodes: string[] | null = null;
let guideIndex = 0;

function startGuide(): void {
  const codes = rankedProblems().map(([code]) => code);
  if (codes.length === 0) return;
  guideCodes = codes;
  guideIndex = 0;
  setIssueFilter(codes[0]);
  document.getElementById('lib-guide')?.querySelector<HTMLElement>('.lib-guide-name')?.focus();
}

function guideStep(delta: 1 | -1): void {
  if (!guideCodes) return;
  guideIndex = Math.max(0, Math.min(guideCodes.length, guideIndex + delta));
  setIssueFilter(guideIndex < guideCodes.length ? guideCodes[guideIndex] : null);
}

function stopGuide(): void {
  if (!guideCodes) return;
  guideCodes = null;
  guideIndex = 0;
  setIssueFilter(null);
  document.getElementById('lib-guide-start')?.focus();
}

function renderGuide(counts: Map<string, number>): void {
  const guide = document.getElementById('lib-guide');
  if (!guide || !guideCodes) return;
  const total = guideCodes.length;

  if (guideIndex >= total) {
    guide.innerHTML = `
      <div class="lib-guide-done">
        <span class="lib-guide-done-icon">${ICON.ok}</span>
        <div>
          <h4 class="lib-guide-name" tabindex="-1">You’ve been through every kind of problem</h4>
          <p class="lib-guide-why">Anything you skipped is still listed under What needs fixing. Check again any time to see what’s left.</p>
        </div>
      </div>
      <div class="lib-guide-actions">
        <button class="btn-primary btn-sm" data-guide="stop">Done</button>
        <button class="btn-ghost btn-sm" data-guide="back">Back</button>
      </div>`;
  } else {
    const code = guideCodes[guideIndex];
    const n = counts.get(code) ?? 0;
    const sev = issueSeverities[code] || 'warning';
    const fix = n > 0 ? problemFix(code) : null;
    const pct = Math.round((guideIndex / total) * 100);
    guide.innerHTML = `
      <div class="lib-guide-head">
        <span class="lib-guide-step">Problem ${guideIndex + 1} of ${total}</span>
        <button class="btn-ghost btn-sm" data-guide="stop" data-tooltip="Stop here and show every track again. Nothing changes.">Done</button>
      </div>
      <div class="lib-guide-progress" aria-hidden="true"><div style="width:${pct}%"></div></div>
      <h4 class="lib-guide-name lib-guide-name--${sev}" tabindex="-1">
        <span class="lib-problem-icon">${sev === 'error' ? ICON.stop : ICON.warn}</span>
        <span>${esc(issueDescriptions[code] || code)}</span>
        <span class="status-pill ${n === 0 ? 'status-pill--ok' : sev === 'error' ? 'status-pill--danger' : 'status-pill--warn'}">${n === 0 ? 'All fixed' : plural(n, 'track')}</span>
      </h4>
      <p class="lib-guide-why">${esc(issueWhy[code] || '')}</p>
      ${n > 0 ? `<p class="lib-guide-fixhint"><strong>What to do:</strong> ${esc(issueFixHint[code] || '')}</p>` : ''}
      ${n > 0 && !fix ? '<p class="lib-guide-fixhint">Track Lab can’t fix this one for you. Click a track below to see its details.</p>' : ''}
      <div class="lib-guide-actions">
        ${fix ? `<button class="btn-primary btn-sm lib-guide-fix" data-guide="fix" data-tooltip="${esc(fix.hint)}">${esc(fix.label === 'Fix one by one' ? `Fix ${plural(n, 'track')} one by one` : fix.label)}</button>` : ''}
        <button class="${fix ? 'btn-secondary' : 'btn-primary'} btn-sm" data-guide="next">${guideIndex + 1 < total ? 'Next problem' : 'Finish'}</button>
        <button class="btn-ghost btn-sm" data-guide="back" ${guideIndex === 0 ? 'disabled data-tooltip-disabled="This is the first problem"' : ''}>Back</button>
      </div>
      <p class="card-actions-note lib-guide-note">${ICON.ok}<span>Nothing changes until you choose a fix. Skipping leaves the tracks as they are.</span></p>`;
  }

  guide.querySelectorAll<HTMLButtonElement>('[data-guide]').forEach(btn => {
    btn.addEventListener('click', () => {
      const what = btn.dataset.guide;
      if (what === 'stop') stopGuide();
      else if (what === 'next') guideStep(1);
      else if (what === 'back') guideStep(-1);
      else if (what === 'fix') runProblemFix(guideCodes![guideIndex]);
    });
  });
}

function runProblemFix(code: string): void {
  if (code === 'LOSSY_FORMAT' || code === 'LOW_BITRATE') {
    document.querySelector<HTMLElement>('.nav-link[data-page="upgrade"]')?.click();
    return;
  }
  // Show the tracks the fix works through, then start it.
  if (activeIssueCode !== code) setIssueFilter(code);
  enterFixFlow();
}

/**
 * "What needs fixing": the ranked kinds of problem, each with what it means.
 * A row narrows the list to those tracks; the one main action walks them all
 * in order (the guided path above).
 */
function renderProblemList(): void {
  if (!healthResult || !issueListEl) return;

  const entries = rankedProblems();
  const counts = new Map(entries);
  const guideOn = !!guideCodes;
  const guide = document.getElementById('lib-guide');
  const startBtn = document.getElementById('lib-guide-start') as HTMLButtonElement | null;
  const head = problemsCard?.querySelector<HTMLElement>('.lib-problems-head');

  if (problemsCard) {
    problemsCard.hidden = entries.length === 0 && !activeIssueCode && !guideOn;
    problemsCard.classList.toggle('is-guiding', guideOn);
  }
  if (guide) guide.hidden = !guideOn;
  if (head) head.hidden = guideOn;
  issueListEl.hidden = guideOn;
  if (guideOn) {
    if (problemsMoreBtn) problemsMoreBtn.hidden = true;
    renderGuide(counts);
    return;
  }

  // One main action per view: while the list is narrowed, the filter bar's
  // fix is it, and the guided path steps back to secondary.
  if (startBtn) {
    const narrowed = !!activeIssueCode || !!activeHealthFilter;
    startBtn.className = `${narrowed ? 'btn-secondary' : 'btn-primary'} btn-sm`;
    startBtn.hidden = entries.length === 0;
  }

  // The active one stays visible even when it ranks below the fold.
  const shown = showAllProblems ? entries : entries.filter(([code], i) => i < PROBLEMS_SHOWN || code === activeIssueCode);
  issueListEl.innerHTML = shown.map(([code, count]) => {
    const sev = issueSeverities[code] || 'warning';
    const label = issueDescriptions[code] || code;
    const active = activeIssueCode === code;
    return `<li><button class="lib-problem lib-problem--${sev}${active ? ' is-active' : ''}" data-show="${esc(code)}" aria-pressed="${active}" data-tooltip="${esc(active ? 'Show every track again.' : `Show only the ${plural(count, 'track')} with this problem.`)}">
      <span class="lib-problem-icon">${sev === 'error' ? ICON.stop : ICON.warn}</span>
      <span class="lib-problem-text">
        <span class="lib-problem-name"><strong>${esc(label)}</strong></span>
        <span class="lib-problem-why">${esc(issueWhy[code] || '')}</span>
      </span>
      <span class="lib-problem-count">${count.toLocaleString()}</span>
    </button></li>`;
  }).join('');

  issueListEl.querySelectorAll<HTMLButtonElement>('[data-show]').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = btn.dataset.show!;
      const turningOn = activeIssueCode !== code;
      setIssueFilter(turningOn ? code : null);
      issueListEl.querySelector<HTMLButtonElement>(`[data-show="${CSS.escape(code)}"]`)?.focus({ preventScroll: true });
      // Bring the tracks it's about into view, under the sticky bar (which
      // now says what's shown and offers the fix).
      if (turningOn) scrollToList();
    });
  });

  if (problemsMoreBtn) {
    const hiddenCount = entries.length - PROBLEMS_SHOWN;
    problemsMoreBtn.hidden = hiddenCount <= 0;
    problemsMoreBtn.textContent = showAllProblems
      ? 'Show fewer'
      : `Show all ${entries.length} kinds of problem`;
    problemsMoreBtn.setAttribute('aria-expanded', String(showAllProblems));
  }
}

/**
 * The tracks a fix for `code` acts on: the ones the list shows right now
 * (search, side list and dropdowns applied), with dismissed issues left out.
 * The Fix button's count, the fix flow, bulk Fill In Tags and the cover-art
 * fix all use this, so the number on the button is the number that changes.
 */
function tracksForIssue(code: string): LibraryHealthTrack[] {
  const savedIssueCode = activeIssueCode;
  activeIssueCode = code;
  const visible = applyAllFilters({ health: true });
  activeIssueCode = savedIssueCode;
  return visible
    .filter(t => t.issues.some(i => i.code === code)) // BrowseTrack.issues holds active issues only
    .map(t => trackLookup.get(t.filePath))
    .filter((t): t is LibraryHealthTrack => !!t);
}

// ========== Missing Album Art Entry Point ==========
// Reached through "No cover art" → Add cover art (enterFixFlow).

function launchAlbumArtFix(): void {
  if (!healthResult) return;
  const tracks = tracksForIssue('MISSING_ALBUM_ART');
  if (tracks.length === 0) {
    showToast('info', 'Every track has cover art', 'None of the tracks shown are missing a cover.');
    return;
  }
  openAlbumArtFix({
    tracks,
    onTrackUpdated: (track, params) => {
      track.hasAlbumArt = true;
      track.issues = track.issues.filter(i => i.code !== 'MISSING_ALBUM_ART');
      if (params.album) track.album = params.album;
      if (params.year) track.year = parseInt(params.year, 10) || null;
      if (params.genre) track.genre = params.genre;
      track.isHealthy = track.issues.length === 0;
      artCache.delete(track.filePath);

      recalculateSummary();
      syncHealthState();
      rebuildBrowseTracks();
      renderCompactList();
      if (healthResult) renderKpiDashboard(healthResult);
    },
  });
}

/**
 * The bar above the list while it's narrowed: what it shows, in a sentence,
 * the fix for that problem (the page's main action then) and a way back.
 * #fix-flow-start ships hidden in index.html.
 */
function renderFilterBar(shownCount: number): void {
  const btn = document.getElementById('fix-flow-start') as HTMLButtonElement | null;
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.addEventListener('click', enterFixFlow);
  }
  if (!filterBar || !filterText) return;

  const total = allTracks.length;
  const issueOn = !!activeIssueCode && activeIssueCode !== 'all';
  const narrowed = issueOn || !!activeHealthFilter || anyListFilterActive();
  filterBar.hidden = !narrowed || total === 0;
  if (filterBar.hidden) { if (btn && !bulkPopulateRunning) btn.style.display = 'none'; return; }

  const n = shownCount;
  const tracksWord = plural(n, 'track');
  let sentence: string;
  if (issueOn) {
    const label = issueDescriptions[activeIssueCode!] || activeIssueCode!;
    sentence = `Showing ${tracksWord} with this problem: ${label}`;
  } else if (activeHealthFilter === 'ready') {
    sentence = `Showing ${tracksWord} that ${n === 1 ? 'is' : 'are'} ready to play`;
  } else if (activeHealthFilter === 'fix') {
    sentence = `Showing ${tracksWord} that could use a fix`;
  } else if (activeHealthFilter === 'wontplay') {
    sentence = `Showing ${tracksWord} that may not play on CDJs`;
  } else {
    sentence = `Showing ${n.toLocaleString()} of ${plural(total, 'track')}`;
  }
  if (issueOn && anyListFilterActive()) sentence += ' that match your search and filters';
  filterText.textContent = `${sentence}.`;

  // The fix button for the active problem
  if (!btn || bulkPopulateRunning) return;
  const count = issueOn && healthResult ? tracksForIssue(activeIssueCode!).length : 0;
  const fix = issueOn ? problemFix(activeIssueCode!) : null;
  // While the guided path runs, its card holds the fix button.
  const flowable = !guideCodes && fix && activeIssueCode !== 'LOSSY_FORMAT' && activeIssueCode !== 'LOW_BITRATE';
  btn.style.display = count > 0 && flowable ? '' : 'none';
  if (!(count > 0 && flowable)) return;

  btn.disabled = false;
  const code = activeIssueCode!;
  if (code === 'MISSING_TAGS' || code === 'SPARSE_TAGS') {
    btn.textContent = `Fill in info for ${plural(count, 'track')}`;
    btn.setAttribute('data-tooltip', 'Look each track up online and fill in what’s empty. You confirm first, and what you already have is kept.');
  } else if (code === 'MISSING_ALBUM_ART') {
    btn.textContent = `Add cover art to ${plural(count, 'track')}`;
    btn.setAttribute('data-tooltip', 'Search online for covers, one track at a time. Nothing is saved until you pick one.');
  } else {
    btn.textContent = `Fix ${plural(count, 'track')} one by one`;
    btn.setAttribute('data-tooltip', 'Go through these tracks one at a time and choose a fix for each. Nothing changes until you do.');
  }
}

// ========== Track details (inspector) ==========

function dl(rows: Array<[string, string]>): string {
  return rows.map(([k, v]) => `<div class="inspector-row"><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('');
}

function openInspector(track: LibraryHealthTrack): void {
  selectedTrackPath = track.filePath;
  document.getElementById('page-library')?.classList.add('inspector-open');

  document.querySelectorAll<HTMLElement>('.bv4-row').forEach(row => {
    row.classList.toggle('selected', row.dataset.fp === track.filePath);
  });

  const active = track.issues.filter(i => !i.dismissed);
  const state = trackHealthState(active);
  inspectorTitle.textContent = track.title || track.fileName;
  inspectorArtist.textContent = track.artist || 'Unknown artist';
  if (inspectorStatus) {
    inspectorStatus.innerHTML = `<span class="status-pill ${healthStatePill[state]}">${esc(healthStateLabels[state])}</span>`;
  }
  renderInspectorArt(track);

  // Track info
  const info: Array<[string, string]> = [
    ['Artist', track.artist ? esc(track.artist) : '<span class="lib-none">Empty</span>'],
    ['Title', track.title ? esc(track.title) : '<span class="lib-none">Empty</span>'],
    ['Album', track.album ? esc(track.album) : '<span class="lib-none">Empty</span>'],
    ['Year', track.year ? esc(String(track.year)) : '<span class="lib-none">Empty</span>'],
    ['Genre', track.genre ? esc(track.genre) : '<span class="lib-none">Empty</span>'],
    ['Tempo', track.bpm ? `${esc(String(Math.round(track.bpm * 10) / 10))} BPM` : '<span class="lib-none">Not saved</span>'],
  ];
  inspectorMeta.innerHTML = dl(info);

  // File
  const f = track.format;
  const type = fileTypeLabel(f, track.fileName);
  const q = qualityLabel(f);
  const fileRows: Array<[string, string]> = [
    ['File type', esc(type)],
    ['Quality', `<span class="term" tabindex="0" data-tooltip="${esc(f.lossless === false
      ? 'Compressed files (MP3, AAC) leave out some detail to save space. Full-quality files (WAV, AIFF, FLAC) keep all of it.'
      : 'Full-quality files (WAV, AIFF, FLAC) keep every detail of the recording. The numbers are its bit depth and sample rate.')}">${esc(q.word)}</span>${q.numbers ? `<span class="lib-muted"> · ${esc(q.numbers)}</span>` : ''}`],
    ['Length', f.duration ? esc(formatDuration(f.duration)) : '<span class="lib-none">Unknown</span>'],
  ];
  inspectorFormat.innerHTML = `<dl>${dl(fileRows)}</dl>
    <button class="btn-link inspector-finder" data-tooltip="${esc(track.filePath)}">${ICON.finder}<span>Show in Finder</span></button>`;
  inspectorFormat.querySelector('.inspector-finder')?.addEventListener('click', () => {
    void window.candybar.showInFinder(track.filePath).catch(() => showToast('warning', 'Couldn’t open Finder', 'The file may be on a drive that isn’t plugged in.'));
  });

  // Problems — the most serious first; ignored ones stay, muted, with a way back.
  const ordered = [...track.issues].sort((a, b) =>
    Number(!!a.dismissed) - Number(!!b.dismissed) ||
    ((issueSeverities[a.code] ?? a.severity) === 'error' ? 0 : 1) - ((issueSeverities[b.code] ?? b.severity) === 'error' ? 0 : 1));
  inspectorIssues.innerHTML = ordered.length > 0
    ? `<h4 class="inspector-section-title">${active.length === 0 ? 'Ignored problems' : active.length === 1 ? 'What needs fixing' : `${active.length} things to fix`}</h4>` +
      ordered.map(i => {
        const sev = (issueSeverities[i.code] ?? i.severity) || 'warning';
        const specifics = issueSpecifics(i.code, track);
        const fixBtn = !i.dismissed ? issueFixButton(i, track) : '';
        const tech = [i.message, i.detail].filter(Boolean).join(' — ');
        return `
      <div class="inspector-issue ${sev}${i.dismissed ? ' dismissed' : ''}" data-code="${esc(i.code)}">
        <div class="inspector-issue-head">
          <span class="inspector-issue-icon">${sev === 'error' ? ICON.stop : ICON.warn}</span>
          <span class="inspector-issue-code">${esc(issueDescriptions[i.code] || i.code)}</span>
          ${i.dismissed ? '<span class="inspector-issue-dismissed-badge">Ignored</span>' : ''}
        </div>
        <p class="inspector-issue-msg">${esc([issueWhy[i.code], specifics].filter(Boolean).join(' '))}</p>
        ${!i.dismissed && issueFixHint[i.code] ? `<p class="inspector-issue-fix">${esc(issueFixHint[i.code])}</p>` : ''}
        <div class="inspector-issue-actions">
          ${fixBtn}
          ${i.dismissed
            ? `<button class="btn-ghost btn-sm inspector-issue-restore" data-code="${esc(i.code)}" data-tooltip="${esc(trackActions.restore.hint)}">${trackActions.restore.label}</button>`
            : `<button class="btn-ghost btn-sm inspector-issue-dismiss" data-code="${esc(i.code)}" data-tooltip="${esc(trackActions.dismiss.hint)}">${trackActions.dismiss.label}</button>`}
          ${tech ? `<details class="inspector-tech"><summary>Technical details</summary><p>${esc(tech)}</p></details>` : ''}
        </div>
      </div>`;
      }).join('')
    : `<div class="inspector-no-issues">${ICON.ok}<span>No problems found. This track is ready to play.</span></div>`;

  inspectorIssues.querySelectorAll<HTMLButtonElement>('.inspector-issue-dismiss').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const code = btn.dataset.code;
      if (code) void handleDismissIssue(track, code);
    });
  });
  inspectorIssues.querySelectorAll<HTMLButtonElement>('.inspector-issue-restore').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const code = btn.dataset.code;
      if (code) void handleRestoreIssue(track, code);
    });
  });
  inspectorIssues.querySelectorAll<HTMLButtonElement>('[data-issue-fix]').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.issueFix;
      if (kind === 'convert') showFixModal(track);
      else if (kind === 'reencode') showReencodeModal(track);
      else if (kind === 'populate') void handlePopulateTags(track);
      else if (kind === 'art') handleEditTags(track);
    });
  });

  // Actions for the whole track
  let actionsHtml = `<button class="btn-secondary btn-sm inspector-action-play" data-tooltip="${esc(trackActions.play.hint)}">${icons.play}<span>Play</span></button>`;
  actionsHtml += `<button class="btn-secondary btn-sm inspector-action-edit-tags" data-tooltip="${esc(trackActions.editTags.hint)}">${esc(trackActions.editTags.label)}</button>`;
  actionsHtml += `<details class="inspector-more"><summary class="btn-ghost btn-sm">More</summary><div class="inspector-more-menu">
    <button class="btn-ghost btn-sm inspector-action-archive" data-tooltip="${esc(trackActions.archive.hint)}">${icons.archive}<span>${esc(trackActions.archive.label)}</span></button>
    <button class="btn-ghost btn-sm inspector-action-delete lib-danger-text" data-tooltip="${esc(trackActions.trash.hint)}">${icons.trash}<span>${esc(trackActions.trash.label)}</span></button>
  </div></details>`;
  inspectorActions.innerHTML = actionsHtml;

  // Wire action buttons
  inspectorActions.querySelector('.inspector-action-play')?.addEventListener('click', () => playFile(track.filePath, track.fileName));
  inspectorActions.querySelector('.inspector-action-edit-tags')?.addEventListener('click', () => handleEditTags(track));
  inspectorActions.querySelector('.inspector-action-archive')?.addEventListener('click', () => handleArchiveTrack(track));
  inspectorActions.querySelector('.inspector-action-delete')?.addEventListener('click', () => trashTrack(track));

  inspectorPanel.style.display = 'flex';
}

/** The fix button inside one problem in the details panel, if it has one. */
function issueFixButton(issue: HealthIssue, track: LibraryHealthTrack): string {
  void track;
  switch (issue.code === 'MISSING_ALBUM_ART' ? 'search_art' : issue.suggestedAction) {
    case 'convert_aiff':
      return `<button class="btn-secondary btn-sm inspector-action-fix" data-issue-fix="convert" data-tooltip="${esc(trackActions.convertAiff.hint)}">${esc(trackActions.convertAiff.label)}</button>`;
    case 'reencode_mp3':
      return `<button class="btn-secondary btn-sm inspector-action-reencode" data-issue-fix="reencode" data-tooltip="${esc(trackActions.reencodeMp3.hint)}">${esc(trackActions.reencodeMp3.label)}</button>`;
    case 'populate_tags':
      return `<button class="btn-secondary btn-sm inspector-action-populate-tags" data-issue-fix="populate" data-tooltip="${esc(trackActions.populateTags.hint)}">${esc(trackActions.populateTags.label)}</button>`;
    case 'search_art':
      return `<button class="btn-secondary btn-sm" data-issue-fix="art" data-tooltip="Open the track info editor, where you can search online for a cover or pick an image.">${esc(trackActions.searchArt.label)}</button>`;
    default:
      return '';
  }
}

/** Cover art for the inspector, from the list's cache when it has it. A token
 *  keeps a slow read for the previous track from landing on this one. */
let inspectorArtToken = 0;
function renderInspectorArt(track: LibraryHealthTrack): void {
  const token = ++inspectorArtToken;
  const hue = hueFromArtist(track.artist || track.fileName);
  inspectorArt.style.setProperty('--art-hue', String(hue));
  const show = (src: string | null) => {
    if (token !== inspectorArtToken) return;
    inspectorArt.classList.toggle('no-art', !src);
    inspectorArt.innerHTML = src ? '<img alt="Cover art" />' : ICON.note;
    const img = inspectorArt.querySelector('img');
    if (img && src) img.src = src;
  };
  if (!track.hasAlbumArt) { show(null); return; }
  if (artCache.has(track.filePath)) { show(artCache.get(track.filePath) ?? null); return; }
  inspectorArt.innerHTML = '';
  window.candybar.getTrackAlbumArt(track.filePath)
    .then((dataUrl) => { artCache.set(track.filePath, dataUrl); show(dataUrl); })
    .catch(() => show(null));
}

function closeInspector() {
  selectedTrackPath = null;
  document.getElementById('page-library')?.classList.remove('inspector-open');

  inspectorPanel.style.display = 'none';

  const list = document.getElementById('browse-compact-list');
  if (list) {
    list.querySelectorAll('.bv4-row.selected').forEach((row) => {
      row.classList.remove('selected');
    });
  }
}

// ========== Edit Tags ==========

/** "album, year and genre" from ['album', 'year', 'genre']. */
function listWords(items: string[]): string {
  const words = items.map(w => w.toLowerCase());
  if (words.length <= 1) return words.join('') || 'missing info';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** Drop the cover-art and track-info problems a save has fixed, by the
 *  scanner's own rules (artist + title; at least 3 of the 5 core fields). */
function pruneTagIssues(track: LibraryHealthTrack): void {
  track.issues = track.issues.filter((i) => {
    if (i.code === 'MISSING_ALBUM_ART') return !track.hasAlbumArt;
    if (i.code === 'MISSING_TAGS') return !track.artist || !track.title;
    if (i.code === 'SPARSE_TAGS') {
      const core = [track.artist, track.title, track.album, track.year, track.genre]
        .filter((v) => (typeof v === 'string' ? v.trim() : v != null && v !== 0))
        .length;
      return core < 3;
    }
    return true;
  });
  track.isHealthy = !track.issues.some((i) => i.severity === 'error');
}

function handleEditTags(track: LibraryHealthTrack) {
  // The tag editor's fields are text; the health track keeps BPM as a number.
  openTagEditor({ ...track, bpm: track.bpm != null ? String(track.bpm) : '' }, (updatedTrack) => {
    if (!healthResult) return;
    const idx = healthResult.tracks.findIndex(t => t.filePath === updatedTrack.filePath);
    if (idx !== -1) {
      const bpm = parseFloat(updatedTrack.bpm);
      healthResult.tracks[idx] = {
        ...healthResult.tracks[idx],
        title: updatedTrack.title,
        artist: updatedTrack.artist,
        album: updatedTrack.album,
        year: updatedTrack.year ? parseInt(updatedTrack.year, 10) || null : null,
        genre: updatedTrack.genre,
        bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null,
        hasAlbumArt: !!updatedTrack.albumArt
      };
      // The saved info may have fixed some problems; drop the ones that no
      // longer hold so the pill, counts and summary don't wait for a re-check.
      pruneTagIssues(healthResult.tracks[idx]);
      artCache.delete(updatedTrack.filePath);
      recalculateSummary();
      syncHealthState();
      rebuildBrowseTracks();
      renderCompactList();
      renderKpiDashboard(healthResult);
      if (selectedTrackPath === track.filePath) {
        openInspector(healthResult.tracks[idx]);
      }
    }
  });
}

/** Fill in one track's empty tags. Resolves true when the file was updated. */
async function handlePopulateTags(track: LibraryHealthTrack): Promise<boolean> {
  // Only the inspector's button for THIS track shows progress; a run started
  // from a row's inline button leaves another track's inspector alone.
  const btn = selectedTrackPath === track.filePath
    ? inspectorActions.querySelector<HTMLButtonElement>('.inspector-action-populate-tags')
    : null;
  if (btn) { btn.disabled = true; btn.textContent = 'Looking it up\u2026'; }

  try {
    const [result] = await window.candybar.autopopulateTracks([{
      filePath: track.filePath,
      title: track.title,
      artist: track.artist,
      album: track.album,
      year: track.year != null ? String(track.year) : '',
      genre: track.genre,
      label: '', key: '', bpm: '', remixer: '',
      hasAlbumArt: track.hasAlbumArt
    }], true);

    if (result.error) {
      showToast('error', 'Couldn\u2019t fill in track info', result.error);
      return false;
    }
    if (!result.updated) {
      showToast('warning', 'No sure match found', `Track Lab couldn\u2019t find ${track.title || track.fileName} online with confidence, so nothing was changed. You can edit its info yourself.`);
      return false;
    }

    await refreshTrackAfterPopulate(track);

    showToast('success', 'Track info filled in', `Added the ${listWords(result.fieldsPopulated)} for ${track.title || track.fileName}.`);
    return true;
  } catch (err) {
    const message = getErrorMessage(err);
    showToast('error', 'Couldn\u2019t fill in track info', message);
    return false;
  } finally {
    // A successful refresh rebuilt the inspector; this only matters when it didn't.
    if (btn?.isConnected) { btn.disabled = false; btn.textContent = trackActions.populateTags.label; }
  }
}

// After autopopulate writes to disk, pull the fresh tags for the track and
// update the in-memory health state + re-render affected views. Also prunes
// tag-related health issues whose conditions no longer hold.
async function refreshTrackAfterPopulate(track: LibraryHealthTrack): Promise<void> {
  try {
    const fresh = await window.candybar.getTrackInfo(track.filePath);
    if (!fresh) return;

    track.artist = fresh.artist || track.artist;
    track.title = fresh.title || track.title;
    track.album = fresh.album || track.album;
    track.year = fresh.year ? (parseInt(fresh.year, 10) || null) : track.year;
    track.genre = fresh.genre || track.genre;
    track.hasAlbumArt = !!fresh.albumArt;
    artCache.delete(track.filePath);

    pruneTagIssues(track);

    recalculateSummary();
    syncHealthState();
    rebuildBrowseTracks();
    renderCompactList();
    if (healthResult) renderKpiDashboard(healthResult);
    if (selectedTrackPath === track.filePath) openInspector(track);
  } catch (err) {
    const message = getErrorMessage(err);
    showToast('warning', 'Couldn\u2019t reload the track info', message);
  }
}

// ========== Scan Progress ==========

function updateScanProgress(progress: { id: string; phase: string; current: number; total: number }) {
  if (activeLibraryScanId !== null && progress.id !== activeLibraryScanId) return;
  if (activeLibraryScanId === null) {
    activeLibraryScanId = progress.id;
  }
  updateScanProgressShared(
    { bar: libraryProgressBar, message: libraryProgressMessage, count: libraryProgressCount },
    progress
  );
}

// ========== Scan ==========
// Manual rescan is wired in initLibrary() via runLibraryScanBtn → autoRefreshLibrary.

// ========== Track Actions ==========

/** Fill the fix dialog for one track. `inPlace`: the converter re-saves the
 *  file under the same name (an AIFF going to AIFF, an MP3 to MP3), so the
 *  old version always goes to the Trash and the tick box doesn't apply. */
function fillFixModal(opts: {
  track: LibraryHealthTrack;
  title: string;
  desc: string;
  confirm: string;
  issues: HealthIssue[];
  fallback: string;
  inPlace: boolean;
}): void {
  const { track } = opts;
  fixFileName.textContent = track.fileName;
  fixFileName.title = track.filePath;
  fixIssuesList.innerHTML = opts.issues.length > 0
    ? `<span class="fix-issues-title">What this fixes</span>${opts.issues.map(i => renderFixIssue(i, track)).join('')}`
    : `<span class="fix-issues-title">What this does</span>${renderFixIssue({ code: '', message: opts.fallback }, track)}`;
  fixModalTitle.textContent = opts.title;
  fixModalDesc.textContent = opts.desc;
  fixModalConfirm.textContent = opts.confirm;
  fixDeleteOriginal.checked = true;
  const label = fixDeleteOriginal.closest<HTMLElement>('.fix-delete-label');
  if (label) label.hidden = opts.inPlace;
  fixModal.dataset.inPlace = opts.inPlace ? '1' : '';
  syncFixDeleteNote();
}

/** The sentence under the tick box says what will happen to the original. */
function syncFixDeleteNote(): void {
  if (!fixModalNote) return;
  const inPlace = fixModal.dataset.inPlace === '1';
  fixModalNote.textContent = inPlace
    ? 'The file keeps its name, so Rekordbox still finds it. The old version goes to the Trash, and you can put it back from Finder.'
    : fixDeleteOriginal.checked
      ? 'The original goes to the Trash once the copy is made, and you can put it back from Finder. If Rekordbox still uses the original, Track Lab keeps it.'
      : 'Both files stay in your library: the original and the new copy.';
  if (fixDeleteText) fixDeleteText.textContent = 'Move the original to the Trash afterwards';
}

function showFixModal(track: LibraryHealthTrack) {
  pendingFixTrack = track;
  pendingReencodeTrack = null;
  const inPlace = /\.(aiff?|aifc)$/i.test(track.filePath);
  fillFixModal({
    track,
    title: 'Make a CDJ-ready copy',
    desc: inPlace
      ? 'Track Lab re-saves this AIFF in the standard form every CDJ and XDJ plays. It sounds exactly the same.'
      : 'Track Lab saves a full-quality AIFF copy next to the original. AIFF plays on every CDJ and XDJ and sounds exactly the same.',
    confirm: inPlace ? 'Re-save as AIFF' : 'Make AIFF copy',
    issues: track.issues.filter((i) => i.suggestedAction === 'convert_aiff' && !i.dismissed),
    fallback: 'Saves a full-quality AIFF that plays on every CDJ and XDJ.',
    inPlace,
  });
  openFixModal();
}

function renderFixIssue(issue: { code: string; message: string }, track: LibraryHealthTrack): string {
  const name = issue.code ? (issueDescriptions[issue.code] || issue.code) : '';
  const detail = issue.code
    ? [issueSpecifics(issue.code, track), issueWhy[issue.code]].filter(Boolean).join(' ')
    : issue.message;
  return `
    <div class="fix-issue">
      <svg class="fix-issue-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      <div class="fix-issue-text">
        ${name ? `<span class="fix-issue-code">${escapeHtml(name)}</span>` : ''}
        <span class="fix-issue-message">${escapeHtml(detail)}</span>
      </div>
    </div>
  `;
}

function showReencodeModal(track: LibraryHealthTrack) {
  pendingReencodeTrack = track;
  pendingFixTrack = null;
  const inPlace = /\.mp3$/i.test(track.filePath);
  fillFixModal({
    track,
    title: 'Re-save as a standard MP3',
    desc: 'Track Lab re-saves this track as a 320 kbps MP3, the standard every Pioneer player accepts. It fixes playback problems, but it can’t make the sound better.',
    confirm: 'Re-save MP3',
    issues: track.issues.filter((i) => i.suggestedAction === 'reencode_mp3' && !i.dismissed),
    fallback: 'Re-saves it as a standard 320 kbps MP3.',
    inPlace,
  });
  openFixModal();
}

// The fix modal is a dialog like Settings: focus moves in on open (to Cancel,
// so Enter never converts by accident), Tab stays inside, and focus goes back
// to whatever opened it on close.
let fixModalFocusReturn: (() => void) | null = null;

function openFixModal() {
  if (fixModal.style.display === 'none') fixModalFocusReturn = captureFocusReturn();
  fixModal.style.display = 'flex';
  requestAnimationFrame(() => fixModalCancel.focus());
}

function hideFixModal() {
  const wasOpen = fixModal.style.display !== 'none';
  fixModal.style.display = 'none';
  pendingFixTrack = null;
  pendingReencodeTrack = null;
  if (wasOpen) fixModalFocusReturn?.();
  fixModalFocusReturn = null;
}

/**
 * After a successful convert / re-encode, say where the original went and
 * keep the list honest: the original leaves the list only when it actually
 * left the library. It stays when "Move the original to the Trash" was off,
 * when main kept it because Rekordbox still points at it, or when the Trash
 * move failed. A file re-saved under its own name stays, minus the problems
 * the re-save fixed.
 */
function reportConversion(
  track: LibraryHealthTrack,
  result: ConversionResult,
  deleteOriginal: boolean,
  title: string,
  fixedAction: SuggestedAction,
): void {
  const name = track.title || track.fileName;
  const inPlace = !!result.outputPath && result.outputPath === track.filePath;
  if (inPlace) {
    track.issues = track.issues.filter(i => i.suggestedAction !== fixedAction);
    track.isHealthy = !track.issues.some(i => i.severity === 'error');
    recalculateSummary();
    syncHealthState();
    rebuildBrowseTracks();
    renderCompactList();
    if (healthResult) renderKpiDashboard(healthResult);
    if (selectedTrackPath === track.filePath) openInspector(track);
    showToast('success', title, `${name} is fixed. The old version is in the Trash if you need it back.`);
    return;
  }
  if (result.originalTrashFailed) {
    showToast('warning', title, `${name} has a new copy, but the original couldn’t go to the Trash, so both are in your library.${result.originalDeleteError ? ` ${result.originalDeleteError}` : ''}`);
  } else if (result.keptOriginalForRekordbox) {
    showToast('success', title, `${name} has a new copy. The original was kept because Rekordbox still uses it.`);
  } else if (deleteOriginal) {
    removeTrackFromHealthResult(track);
    showToast('success', title, `${name} has a new copy. The original is in the Trash if you need it back. Check again to see the copy in your list.`);
  } else {
    showToast('success', title, `${name} has a new copy next to the original. Check again to see it in your list.`);
  }
}

async function handleFixConfirm() {
  if (!pendingFixTrack) return;
  const track = pendingFixTrack;
  const deleteOriginal = fixDeleteOriginal.checked;

  hideFixModal();
  const taskId = addConversionTask(track.fileName, 'aiff');

  try {
    const result = await window.candybar.fixTrackFile(track.filePath, deleteOriginal);
    if (result.success) {
      updateConversionTask(taskId, 'completed', result.outputPath);
      reportConversion(track, result, deleteOriginal, 'CDJ-ready copy made', 'convert_aiff');
    } else {
      updateConversionTask(taskId, 'failed');
      showToast('error', 'Couldn’t make the copy', result.errorMessage || 'The conversion stopped without saying why. Your original is unchanged.');
    }
  } catch (err) {
    updateConversionTask(taskId, 'failed');
    const message = getErrorMessage(err);
    showToast('error', 'Couldn’t make the copy', message);
  }
}

async function handleReencodeConfirm() {
  if (!pendingReencodeTrack) return;
  const track = pendingReencodeTrack;
  const deleteOriginal = fixDeleteOriginal.checked;

  hideFixModal();
  const taskId = addConversionTask(track.fileName, 'mp3');

  try {
    const result = await window.candybar.reencodeTrackFile(track.filePath, deleteOriginal);
    if (result.success) {
      updateConversionTask(taskId, 'completed', result.outputPath);
      reportConversion(track, result, deleteOriginal, 'Re-saved as 320 kbps MP3', 'reencode_mp3');
    } else {
      updateConversionTask(taskId, 'failed');
      showToast('error', 'Couldn’t re-save the MP3', result.errorMessage || 'It stopped without saying why. Your original is unchanged.');
    }
  } catch (err) {
    updateConversionTask(taskId, 'failed');
    const message = getErrorMessage(err);
    showToast('error', 'Couldn’t re-save the MP3', message);
  }
}

/** Every Library delete: confirm, move to the Trash, report. Resolves true
 *  only when the file is in the Trash. A failure (including main refusing to
 *  delete anything it can't trash) is shown, never swallowed. */
async function trashTrack(track: LibraryHealthTrack): Promise<boolean> {
  if (!(await confirmMoveToTrash([{ fileName: track.fileName, filePath: track.filePath }]))) return false;

  try {
    const result = await window.candybar.deleteTrackFile(track.filePath);
    if (result.success) {
      showToast('success', 'Moved to the Trash', `${track.fileName} is in the Trash if you need it back.`);
      removeTrackFromHealthResult(track);
      return true;
    }
    showToast('error', 'Couldn’t move it to the Trash', result.error || 'The file is still in your library.');
  } catch (err) {
    showToast('error', 'Couldn’t move it to the Trash', getErrorMessage(err));
  }
  return false;
}

/** Resolves true once the file is in the archive folder. */
async function handleArchiveTrack(track: LibraryHealthTrack): Promise<boolean> {
  try {
    const result = await window.candybar.archiveTrackFile(track.filePath);
    if (result.success) {
      showToast('success', 'Moved to your archive folder', `${track.fileName} is out of your library. Nothing was deleted.`);
      removeTrackFromHealthResult(track);
      return true;
    }
    showToast('error', 'Couldn’t move it to the archive folder', result.errorMessage || 'The file is still in your library.');
  } catch (err) {
    const message = getErrorMessage(err);
    showToast('error', 'Couldn’t move it to the archive folder', message);
  }
  return false;
}

// ========== Dismiss / Restore Health Issues ==========

/** Resolves true when every change was saved; a failure toasts and resolves false. */
async function applyDismissalChanges(track: LibraryHealthTrack, codes: string[], dismissed: boolean): Promise<boolean> {
  if (!healthResult || codes.length === 0) return false;
  const libraryRoot = healthResult.libraryRoot;
  try {
    await Promise.all(codes.map(code => dismissed
      ? window.candybar.dismissHealthIssue(libraryRoot, track.filePath, code)
      : window.candybar.undismissHealthIssue(libraryRoot, track.filePath, code)
    ));
    for (const issue of track.issues) {
      if (codes.includes(issue.code)) issue.dismissed = dismissed;
    }
    recalculateSummary();
    syncHealthState();
    rebuildBrowseTracks();
    renderCompactList();
    renderKpiDashboard(healthResult);
    if (selectedTrackPath === track.filePath) openInspector(track);
    return true;
  } catch (err) {
    showToast('error', dismissed ? 'Couldn\u2019t ignore that problem' : 'Couldn\u2019t flag that problem again', getErrorMessage(err));
    return false;
  }
}

async function handleDismissIssue(track: LibraryHealthTrack, code: string): Promise<void> {
  if (!(await applyDismissalChanges(track, [code], true))) return;
  const label = issueDescriptions[code] || code;
  showToast('info', 'Problem ignored', `\u201c${label}\u201d won\u2019t be flagged on ${track.title || track.fileName} any more. You can bring it back from the track details.`);
}

async function handleDismissAllIssues(track: LibraryHealthTrack): Promise<void> {
  const codes = Array.from(new Set(track.issues.filter(i => !i.dismissed).map(i => i.code)));
  if (codes.length === 0) return;
  if (!(await applyDismissalChanges(track, codes, true))) return;
  showToast('info', 'Problems ignored', `${plural(codes.length, 'problem')} won\u2019t be flagged on ${track.title || track.fileName} any more.`);
}

async function handleRestoreIssue(track: LibraryHealthTrack, code: string): Promise<void> {
  if (!(await applyDismissalChanges(track, [code], false))) return;
  const label = issueDescriptions[code] || code;
  showToast('info', 'Problem flagged again', `\u201c${label}\u201d is back on ${track.title || track.fileName}.`);
}

// ========== Library Folder Availability ==========
// A missing library folder (an unplugged external drive, usually) isn't an
// error to toast about: the last scan stays on screen under a calm banner
// with a Retry, and the empty list says what to do instead of "No tracks".

const availabilityBanner = document.getElementById('browse-health-summary') as HTMLElement | null;

function isLibraryMissingError(message: string): boolean {
  return /Library directory not found/i.test(message);
}

function setLibraryAvailability(state: typeof libraryAvailability, root: string | null = null): void {
  libraryAvailability = state;
  offlineRoot = root;
  renderAvailabilityBanner();
  renderCompactList(); // the empty state depends on it
}

function renderAvailabilityBanner(): void {
  if (!availabilityBanner) return;
  // With nothing loaded yet, the list's empty state says all of this (and
  // has the buttons), so the callout would only repeat it.
  if (libraryAvailability === 'ok' || !healthResult) {
    availabilityBanner.hidden = true;
    availabilityBanner.innerHTML = '';
    return;
  }
  const lastScan = healthResult.scannedAt ? formatWhen(healthResult.scannedAt) : null;
  const drive = driveNameOf(offlineRoot);
  let title: string;
  let body: string;
  if (libraryAvailability === 'unset') {
    title = 'Choose your library folder';
    body = 'Track Lab doesn\u2019t know where your music is yet. Choose the folder and it checks every track in it.';
  } else {
    title = drive ? `\u201c${drive}\u201d isn\u2019t plugged in` : 'Track Lab can\u2019t find your library folder';
    body = `${lastScan ? `You\u2019re seeing the last check (${lastScan}). ` : ''}${drive
      ? 'Plug it in, then try again to see what\u2019s changed.'
      : 'If it was moved or renamed, choose where it is now.'}`;
  }
  const actions = libraryAvailability === 'unset'
    ? '<button class="btn-secondary btn-sm" data-availability-action="setup">Choose your library folder</button>'
    : `<button class="btn-secondary btn-sm" data-availability-action="retry">Try again</button>
       <button class="btn-ghost btn-sm" data-availability-action="settings">Choose a different folder</button>`;
  availabilityBanner.innerHTML = `
    <div class="callout callout--warn library-availability-banner" role="status">
      ${libraryAvailability === 'unset' ? ICON.folder.replace('<svg', '<svg class="callout-icon"') : ICON.drive.replace('<svg', '<svg class="callout-icon"')}
      <div class="callout-body"><strong></strong><p class="library-availability-text"></p></div>
      <div class="callout-actions">${actions}</div>
    </div>`;
  (availabilityBanner.querySelector('.callout-body strong') as HTMLElement).textContent = title;
  const textEl = availabilityBanner.querySelector<HTMLElement>('.library-availability-text')!;
  textEl.textContent = body;
  if (offlineRoot) textEl.title = `Library folder: ${offlineRoot}`;
  availabilityBanner.querySelector('[data-availability-action="setup"]')?.addEventListener('click', () => requestOpenSetup('library'));
  availabilityBanner.querySelector('[data-availability-action="settings"]')?.addEventListener('click', () => requestOpenSettings('library'));
  availabilityBanner.querySelector('[data-availability-action="retry"]')?.addEventListener('click', () => void autoRefreshLibrary());
  availabilityBanner.hidden = false;
}

/** After a failed scan: is the folder unset, or set but not there? */
async function noteLibraryMissing(message: string): Promise<void> {
  const root = message.replace(/^.*Library directory not found:\s*/i, '').trim() || null;
  let unset = false;
  try {
    unset = !(await window.candybar.getConfig()).libraryRoot;
  } catch { /* treat as offline */ }
  setLibraryAvailability(unset ? 'unset' : 'offline', root);
}

// ========== Public Data Load API ==========

export async function loadLibraryData(result: LibraryHealthResult): Promise<void> {
  if (lastLoadedLibraryRoot !== null && lastLoadedLibraryRoot !== result.libraryRoot) {
    resetLibraryFilters();
  }
  lastLoadedLibraryRoot = result.libraryRoot;
  healthResult = result;
  if (libraryAvailability !== 'ok') { libraryAvailability = 'ok'; offlineRoot = null; renderAvailabilityBanner(); }
  await annotateDismissedIssues();
  recalculateSummary();
  rebuildBrowseTracks();
  renderCompactList();
  renderKpiDashboard(result);
}

/** Clear all filter values so a freshly-loaded library isn't hidden by stale selections. */
function resetLibraryFilters(): void {
  for (const col of columns) col.selected = null;
  splitSelected = null;
  activeIssueFilter = null;
  activeIssueCode = null;
  activeHealthFilter = null;
  browseSearchQuery = '';
  const searchInput = document.getElementById('browse-search') as HTMLInputElement | null;
  if (searchInput) searchInput.value = '';
  if (splitPanelOpen) renderSplitPanel();
  renderColumnStrip();
}

export async function restoreLibraryResults(result: LibraryHealthResult, filter?: string): Promise<void> {
  lastLoadedLibraryRoot = result.libraryRoot;
  healthResult = result;
  if (filter && filter !== 'all') activeIssueFilter = filter;
  await annotateDismissedIssues();
  recalculateSummary();
  rebuildBrowseTracks();
  renderCompactList();
  renderKpiDashboard(result);
  healthSkeletonSection.style.display = 'none';
}

export function showHealthSkeleton(): void {
  if (healthSkeletonSection) healthSkeletonSection.style.display = 'block';
}

export function hideHealthSkeleton(): void {
  if (healthSkeletonSection) healthSkeletonSection.style.display = 'none';
}

// ========== Background Auto-Refresh ==========

export async function autoRefreshLibrary(opts: { silent?: boolean } = {}): Promise<LibraryHealthResult | null> {
  // If a refresh is already in flight, chain a fresh run behind it so callers
  // (e.g. organize-scan finished) are guaranteed to see their writes reflected.
  if (backgroundScanRunning) {
    const inFlight = pendingAutoRefresh;
    pendingAutoRefresh = (inFlight ?? Promise.resolve(null))
      .catch(() => null)
      .then(() => runLibraryAutoRefresh(opts));
    return pendingAutoRefresh;
  }
  return runLibraryAutoRefresh(opts);
}

async function runLibraryAutoRefresh(opts: { silent?: boolean }): Promise<LibraryHealthResult | null> {
  backgroundScanRunning = true;
  activeLibraryScanId = null;

  runLibraryScanBtn.disabled = true;
  runLibraryScanBtn.classList.add('scanning');
  if (runLibraryScanLabel) runLibraryScanLabel.textContent = 'Checking\u2026';
  libraryProgressBar.style.width = '0%';
  libraryProgressMessage.textContent = 'Checking your library\u2026';
  libraryProgressCount.textContent = '';
  libraryProgressSection.style.display = '';

  let refreshedResult: LibraryHealthResult | null = null;
  try {
    const response = await window.candybar.scanLibraryHealth(false, false);
    if (response.result) {
      healthResult = response.result;
      refreshedResult = response.result;

      await loadLibraryData(healthResult);

      if (!opts.silent) {
        const s = healthResult.summary;
        showToast('success', 'All checked', s.healthy === s.total
          ? `All ${plural(s.total, 'track')} are ready to play.`
          : `${s.healthy.toLocaleString()} of ${plural(s.total, 'track')} are ready to play. ${s.warnings.toLocaleString()} could use a fix and ${s.errors.toLocaleString()} may not play on CDJs.`);
      }
    }
  } catch (err) {
    const message = getErrorMessage(err);
    if (isLibraryMissingError(message)) {
      await noteLibraryMissing(message); // banner + empty state, no error toast
    } else {
      showToast('error', 'Couldn\u2019t check your library', message);
    }
  } finally {
    backgroundScanRunning = false;
    runLibraryScanBtn.disabled = false;
    runLibraryScanBtn.classList.remove('scanning');
    if (runLibraryScanLabel) runLibraryScanLabel.textContent = 'Check again';
    libraryProgressSection.style.display = 'none';
  }
  return refreshedResult;
}

// ========== Fix Flow ==========

function getFixActionDescription(action: SuggestedAction): string {
  switch (action) {
    case 'convert_aiff': return 'Track Lab saves a full-quality AIFF copy that every CDJ plays, and moves the old file to the Trash. It sounds the same.';
    case 'reencode_mp3': return 'Track Lab re-saves it as a standard 320 kbps MP3 that Pioneer players accept, and moves the old file to the Trash.';
    case 'populate_tags': return 'Track Lab looks the track up online and fills in what\u2019s empty. What you already have is kept.';
    case 'search_art': return 'Track Lab searches online for a cover and saves the one you pick into the file.';
    case 'archive': return 'Track Lab moves the file out of your library into your archive folder. Nothing is deleted.';
    case 'delete': return 'Track Lab moves the file to the Trash. You\u2019re asked first, and you can put it back from Finder.';
    case 'none': return 'There\u2019s no automatic fix for this one. Skip it, or edit the track yourself.';
  }
}

function getFixActionButton(action: SuggestedAction): { label: string; cls: string } {
  switch (action) {
    case 'convert_aiff': return { label: 'Make AIFF copy', cls: 'btn-primary' };
    case 'reencode_mp3': return { label: 'Re-save MP3', cls: 'btn-primary' };
    case 'populate_tags': return { label: trackActions.populateTags.label, cls: 'btn-primary' };
    case 'search_art': return { label: trackActions.searchArt.label, cls: 'btn-primary' };
    case 'archive': return { label: 'Move to archive folder', cls: 'btn-primary' };
    case 'delete': return { label: 'Move to Trash', cls: 'btn-danger' };
    case 'none': return { label: 'Skip', cls: 'btn-primary' };
  }
}

function getFixFlowTrack(): LibraryHealthTrack | null {
  if (!fixFlow || !healthResult) return null;
  const fp = fixFlow.trackPaths[fixFlow.currentIndex];
  return healthResult.tracks.find(t => t.filePath === fp) ?? null;
}

function getActionForIssueCode(track: LibraryHealthTrack, issueCode: string): SuggestedAction {
  const issue = track.issues.find(i => i.code === issueCode);
  return issue?.suggestedAction ?? 'none';
}

function renderFixFlowDrawer(): void {
  if (!fixFlow) return;
  const track = getFixFlowTrack();

  if (!track) {
    // Show completion state
    const pct = fixFlow.trackPaths.length > 0 ? Math.round((fixFlow.fixedCount / fixFlow.trackPaths.length) * 100) : 100;
    setDrawerTitle('Fix one by one');
    setDrawerContent(`
      <div class="fix-flow-content">
        <div class="fix-flow-complete">
          <div class="fix-flow-complete-icon">${icons.success}</div>
          <div class="fix-flow-complete-text">
            ${fixFlow.fixedCount > 0 ? 'All done! ' : ''}Fixed ${fixFlow.fixedCount.toLocaleString()} of ${plural(fixFlow.trackPaths.length, 'track')}.
          </div>
          <div class="fix-flow-progress">
            <div class="fix-flow-progress-bar"><div class="fix-flow-progress-fill" style="width:${pct}%"></div></div>
          </div>
          <button class="btn-secondary btn-sm fix-flow-done" style="margin-top:12px" data-tooltip="Close this panel">Close</button>
        </div>
      </div>
    `);
    const body = getDrawerBody();
    body.querySelector('.fix-flow-done')?.addEventListener('click', exitFixFlow);
    return;
  }

  const action = getActionForIssueCode(track, fixFlow.issueCode);
  const issue = track.issues.find(i => i.code === fixFlow!.issueCode);
  const sev = issue ? (issueSeverities[issue.code] ?? issue.severity) : 'warning';
  const label = issueDescriptions[fixFlow.issueCode] || fixFlow.issueCode;
  const message = [issueWhy[fixFlow.issueCode], issueSpecifics(fixFlow.issueCode, track)].filter(Boolean).join(' ');
  const tech = [issue?.message, issue?.detail].filter(Boolean).join(' \u2014 ');

  // Progress
  const remaining = fixFlow.trackPaths.filter(fp => healthResult!.tracks.some(t => t.filePath === fp)).length;
  const done = fixFlow.trackPaths.length - remaining;
  const pos = done + 1;
  const total = fixFlow.trackPaths.length;
  const pct = Math.round((done / total) * 100);

  const isNone = action === 'none';
  const applyBtn = getFixActionButton(action);

  setDrawerTitle('Fix one by one');
  setDrawerContent(`
    <div class="fix-flow-content">
      <div class="fix-flow-progress">
        <span class="fix-flow-counter">Track ${pos.toLocaleString()} of ${total.toLocaleString()}</span>
        <div class="fix-flow-progress-bar"><div class="fix-flow-progress-fill" style="width:${pct}%"></div></div>
      </div>

      <div class="fix-flow-track-info">
        <div class="fix-flow-track-title">${esc(track.title || track.fileName)}</div>
        <div class="fix-flow-track-artist">${esc(track.artist || 'Unknown artist')}</div>
      </div>

      <div class="fix-flow-issue">
        <div class="fix-flow-issue-badge ${esc(sev)}">${esc(label)}</div>
        <div class="fix-flow-issue-message">${esc(message)}</div>
        ${tech ? `<details class="inspector-tech fix-flow-issue-detail"><summary>Technical details</summary><p>${esc(tech)}</p></details>` : ''}
      </div>

      <div class="fix-flow-action-desc">
        ${icons.wrench}
        <span>${getFixActionDescription(action)}</span>
      </div>

      <div class="fix-flow-buttons">
        ${isNone
          ? `<button class="btn-primary fix-flow-skip-primary" data-tooltip="Move on to the next track">Skip</button>`
          : `<button class="${applyBtn.cls} fix-flow-apply" data-tooltip="Do this for this track only, then show the next one">${esc(applyBtn.label)}</button>
             <button class="btn-ghost fix-flow-skip" data-tooltip="Leave this track as it is and show the next one">Skip</button>`
        }
      </div>

      <div class="fix-flow-nav">
        <button class="btn-ghost btn-sm fix-flow-prev" ${fixFlow.currentIndex === 0 ? 'disabled' : ''} data-tooltip="Go back to the previous track" data-tooltip-disabled="This is the first track">Previous track</button>
        <button class="btn-ghost btn-sm fix-flow-next" data-tooltip="Show the next track without changing this one">Next track</button>
      </div>
    </div>
  `);

  // Wire events
  const body = getDrawerBody();
  body.querySelector('.fix-flow-apply')?.addEventListener('click', fixFlowApply);
  body.querySelector('.fix-flow-skip')?.addEventListener('click', () => fixFlowAdvance(1));
  body.querySelector('.fix-flow-skip-primary')?.addEventListener('click', () => fixFlowAdvance(1));
  body.querySelector('.fix-flow-prev')?.addEventListener('click', () => fixFlowAdvance(-1));
  body.querySelector('.fix-flow-next')?.addEventListener('click', () => fixFlowAdvance(1));
}



async function launchBulkPopulate(issueCode: 'MISSING_TAGS' | 'SPARSE_TAGS'): Promise<void> {
  if (!healthResult || bulkPopulateRunning) return;

  // The tracks the button counted: visible, with this issue not dismissed.
  const tracks = tracksForIssue(issueCode);
  if (tracks.length === 0) {
    showToast('info', 'Nothing to fill in', 'None of the tracks shown are missing that info.');
    return;
  }

  const n = tracks.length;
  const hasWavOrFlac = tracks.some(t => /\.(wav|flac)$/i.test(t.filePath));
  const ok = await confirmAction({
    title: `Fill in track info for ${plural(n, 'track')}?`,
    message: 'Track Lab looks each track up on Spotify, SoundCloud and Beatport, and saves any empty artist, album, year, genre, key or tempo into the file.',
    safetyNote: hasWavOrFlac
      ? 'What you already have is kept. WAV and FLAC files can\u2019t hold this info well, so they\u2019re saved as AIFF copies (same sound) and the originals go to the Trash.'
      : 'What you already have is kept.',
    confirmLabel: 'Fill in track info',
    tone: 'info',
  });
  if (!ok) return;

  bulkPopulateRunning = true;
  const paint = (text: string) => {
    document.querySelectorAll<HTMLButtonElement>('#fix-flow-start, .lib-guide-fix').forEach(b => { b.disabled = true; b.textContent = text; });
  };
  paint(`Filling in 0 of ${tracks.length.toLocaleString()}\u2026`);
  setStatus(`Filling in track info (0 of ${tracks.length.toLocaleString()})\u2026`);

  // Unsubscribed in finally, so a later single-track Fill In Tags doesn't
  // drive this run's button and status text.
  const offProgress = window.candybar.onAutopopulateProgress((p) => {
    setStatus(`Filling in track info (${p.current.toLocaleString()} of ${p.total.toLocaleString()})\u2026`);
    paint(`Filling in ${p.current.toLocaleString()} of ${p.total.toLocaleString()}\u2026`);
  });

  try {
    const input = tracks.map(t => ({
      filePath: t.filePath,
      title: t.title,
      artist: t.artist,
      album: t.album,
      year: t.year != null ? String(t.year) : '',
      genre: t.genre,
      label: '', key: '', bpm: '', remixer: '',
      hasAlbumArt: t.hasAlbumArt
    }));

    const results = await window.candybar.autopopulateTracks(input, true);

    const updatedPaths = new Set(results.filter(r => r.updated).map(r => r.filePath));
    for (const t of tracks) {
      if (updatedPaths.has(t.filePath)) {
        await refreshTrackAfterPopulate(t);
      }
    }

    const updated = updatedPaths.size;
    const errored = results.filter(r => r.error).length;
    const noMatch = tracks.length - updated - errored;
    const tone = updated > 0 ? 'success' : 'warning';
    const parts = [`Filled in ${plural(updated, 'track')}.`];
    if (noMatch > 0) parts.push(`${plural(noMatch, 'track')} had no sure match online, so ${noMatch === 1 ? 'it was' : 'they were'} left as ${noMatch === 1 ? 'it was' : 'they were'}.`);
    if (errored > 0) parts.push(`${plural(errored, 'track')} couldn\u2019t be saved.`);
    showToast(tone, updated > 0 ? 'Track info filled in' : 'Nothing filled in', parts.join(' '));
    setStatus('Idle');
  } catch (err) {
    const message = getErrorMessage(err);
    showToast('error', 'Couldn\u2019t fill in track info', message);
    setStatus('Error');
  } finally {
    offProgress();
    bulkPopulateRunning = false;
    document.querySelectorAll<HTMLButtonElement>('#fix-flow-start, .lib-guide-fix').forEach(b => { b.disabled = false; });
    // Re-render the fix buttons (the count may have dropped to zero)
    renderCompactList();
  }
}

function enterFixFlow(): void {
  if (!healthResult || !activeIssueCode) return;

  // Album art gets a dedicated full-screen flow; other issue codes use the drawer.
  if (activeIssueCode === 'MISSING_ALBUM_ART') {
    launchAlbumArtFix();
    return;
  }

  // Missing / sparse tag issues batch-run the autopopulate process (one
  // Spotify+Beatport search per track) rather than walking a per-track drawer.
  if (activeIssueCode === 'MISSING_TAGS' || activeIssueCode === 'SPARSE_TAGS') {
    const code = activeIssueCode;
    void launchBulkPopulate(code);
    return;
  }

  const filtered = tracksForIssue(activeIssueCode);
  if (filtered.length === 0) {
    showToast('info', 'Nothing to fix here', 'None of the tracks shown have this problem.');
    return;
  }

  closeInspector();

  fixFlow = {
    issueCode: activeIssueCode,
    trackPaths: filtered.map(t => t.filePath),
    currentIndex: 0,
    applying: false,
    fixedCount: 0,
    unsubDrawer: null,
  };

  // Skip to first track that still exists
  skipToNextExisting(1);

  document.body.classList.add('fix-flow-active');

  // Listen for drawer close to exit fix flow
  fixFlow.unsubDrawer = onDrawerStateChange((state) => {
    if (state === 'hidden' && fixFlow) exitFixFlow();
  });

  renderFixFlowDrawer();
  expandDrawer();
  highlightFixFlowTrack();
}

function exitFixFlow(): void {
  if (!fixFlow) return;
  fixFlow.unsubDrawer?.();
  fixFlow = null;

  document.body.classList.remove('fix-flow-active');

  const list = document.getElementById('browse-compact-list');
  if (list) {
    list.querySelectorAll('.bv4-row.fix-flow-focus').forEach(r => r.classList.remove('fix-flow-focus'));
  }

  hideDrawer();
  if (healthResult) renderKpiDashboard(healthResult);
}

function skipToNextExisting(direction: 1 | -1): boolean {
  if (!fixFlow || !healthResult) return false;
  let idx = fixFlow.currentIndex;
  while (idx >= 0 && idx < fixFlow.trackPaths.length) {
    if (healthResult.tracks.some(t => t.filePath === fixFlow!.trackPaths[idx])) {
      fixFlow.currentIndex = idx;
      return true;
    }
    idx += direction;
  }
  return false;
}

function fixFlowAdvance(direction: 1 | -1): void {
  if (!fixFlow || fixFlow.applying) return;

  fixFlow.currentIndex += direction;

  // Skip removed tracks
  if (!skipToNextExisting(direction)) {
    // Reached end
    if (direction > 0) {
      // Show completion
      renderFixFlowDrawer();
      // Clear row highlight
      const list = document.getElementById('browse-compact-list');
      if (list) list.querySelectorAll('.bv4-row.fix-flow-focus').forEach(r => r.classList.remove('fix-flow-focus'));
      return;
    }
    // Going backwards past start — clamp
    fixFlow.currentIndex = 0;
    skipToNextExisting(1);
  }

  renderFixFlowDrawer();
  highlightFixFlowTrack();
}

async function fixFlowApply(): Promise<void> {
  if (!fixFlow || fixFlow.applying || !healthResult) return;
  const track = getFixFlowTrack();
  if (!track) { fixFlowAdvance(1); return; }

  const action = getActionForIssueCode(track, fixFlow.issueCode);
  if (action === 'none') { fixFlowAdvance(1); return; }

  // Lock the drawer's buttons too: a Next/Skip mid-apply would move on, and
  // then the apply finishing would move on again past an unseen track.
  fixFlow.applying = true;
  const body = getDrawerBody();
  body.querySelectorAll<HTMLButtonElement>('.fix-flow-buttons button, .fix-flow-nav button').forEach(b => { b.disabled = true; });
  const applyBtn = body.querySelector('.fix-flow-apply') as HTMLButtonElement | null;
  if (applyBtn) applyBtn.textContent = 'Working\u2026';

  let success = false;
  try {
    switch (action) {
      case 'convert_aiff':
      case 'reencode_mp3': {
        const aiff = action === 'convert_aiff';
        const taskId = addConversionTask(track.fileName, aiff ? 'aiff' : 'mp3');
        const result = aiff
          ? await window.candybar.fixTrackFile(track.filePath, true)
          : await window.candybar.reencodeTrackFile(track.filePath, true);
        if (result.success) {
          updateConversionTask(taskId, 'completed', result.outputPath);
          reportConversion(track, result, true, aiff ? 'CDJ-ready copy made' : 'Re-saved as 320 kbps MP3', action);
          success = true;
        } else {
          updateConversionTask(taskId, 'failed');
          showToast('error', aiff ? 'Couldn\u2019t make the copy' : 'Couldn\u2019t re-save the MP3', result.errorMessage || 'It stopped without saying why. Your original is unchanged.');
        }
        break;
      }
      case 'archive':
        success = await handleArchiveTrack(track);
        break;
      case 'delete':
        // Same confirm as every other Move to Trash.
        success = await trashTrack(track);
        break;
      case 'populate_tags':
        success = await handlePopulateTags(track);
        break;
    }
  } catch (err) {
    showToast('error', 'Couldn\u2019t fix that track', getErrorMessage(err));
  }

  // The flow may have been closed while this ran (Escape, the drawer's close
  // button, an issue chip); the file work above still counts, the flow doesn't.
  if (!fixFlow) return;
  if (success) fixFlow.fixedCount++;
  fixFlow.applying = false;
  // A cancelled (or failed) Move to Trash stays on this track instead of
  // skipping past it.
  if (action === 'delete' && !success) renderFixFlowDrawer();
  else fixFlowAdvance(1);
}

// ========== View options ==========
// Which extra columns the list shows. Off by default so the list reads as
// tracks, not file specs; remembered per computer.

type ViewCol = 'type' | 'bpm' | 'dur';
const VIEW_COLS_KEY = 'trackLab.library.viewCols';
const VIEW_COLS_DEFAULT: Record<ViewCol, boolean> = { type: false, bpm: false, dur: true };

function loadViewCols(): Record<ViewCol, boolean> {
  try {
    const raw = localStorage.getItem(VIEW_COLS_KEY);
    if (raw) return { ...VIEW_COLS_DEFAULT, ...(JSON.parse(raw) as Partial<Record<ViewCol, boolean>>) };
  } catch { /* storage unavailable: defaults */ }
  return { ...VIEW_COLS_DEFAULT };
}

function applyViewCols(cols: Record<ViewCol, boolean>): void {
  const page = document.getElementById('page-library');
  if (!page) return;
  (Object.keys(cols) as ViewCol[]).forEach(k => page.classList.toggle(`lib-show-${k}`, cols[k]));
  document.querySelectorAll<HTMLInputElement>('[data-col-toggle]').forEach(cb => {
    cb.checked = !!cols[cb.dataset.colToggle as ViewCol];
  });
}

function initViewOptions(): void {
  const menu = document.getElementById('lib-view-menu') as HTMLDetailsElement | null;
  const cols = loadViewCols();
  applyViewCols(cols);
  document.querySelectorAll<HTMLInputElement>('[data-col-toggle]').forEach(cb => {
    cb.addEventListener('change', () => {
      cols[cb.dataset.colToggle as ViewCol] = cb.checked;
      applyViewCols(cols);
      try { localStorage.setItem(VIEW_COLS_KEY, JSON.stringify(cols)); } catch { /* not remembered */ }
    });
  });
  if (!menu) return;
  // Opening it scrolls the list up so the menu has room under the bar.
  menu.addEventListener('toggle', () => {
    if (menu.open) scrollToList();
  });
  // A menu, not a section: a click outside or Escape closes it.
  document.addEventListener('click', (e) => {
    if (menu.open && !menu.contains(e.target as Node)) menu.open = false;
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.open) {
      e.stopPropagation();
      menu.open = false;
      menu.querySelector<HTMLElement>('summary')?.focus();
    }
  });
}

/** Scroll the page so the search bar sits at the top with the list under it. */
function scrollToList(): void {
  const page = document.getElementById('page-library');
  const bar = document.getElementById('lib-browse-bar');
  const above = bar?.previousElementSibling as HTMLElement | null;
  if (!page || !bar || !above) return;
  // Where the bar starts in the page's own scroll (just under the summary),
  // whether or not it's stuck yet.
  const naturalTop = page.scrollTop + above.getBoundingClientRect().bottom - page.getBoundingClientRect().top;
  if (naturalTop > page.scrollTop + 1) page.scrollTo({ top: naturalTop, behavior: 'smooth' });
}

/** Keep the sticky list header and the side panels just under the sticky
 *  search bar, whatever height it wraps to. */
function initStickyOffsets(): void {
  const page = document.getElementById('page-library');
  const bar = document.getElementById('lib-browse-bar');
  if (!page || !bar || typeof ResizeObserver === 'undefined') return;
  const set = () => page.style.setProperty('--lib-bar-h', `${Math.ceil(bar.getBoundingClientRect().height)}px`);
  new ResizeObserver(set).observe(bar);
  set();
}

export function initLibrary(): void {
  initViewOptions();
  initStickyOffsets();

  // Filter dropdowns: "Clear filters" removes them all
  document.getElementById('toggle-columns-panel')?.addEventListener('click', () => {
    columns = [];
    renderColumnStrip();
    renderCompactList();
    (document.getElementById('browse-search') as HTMLElement | null)?.focus();
  });

  // "Narrow the list": add a filter dropdown
  const addSelect = document.getElementById('add-column-select') as HTMLSelectElement | null;
  addSelect?.addEventListener('change', () => {
    const dim = addSelect.value as Dimension;
    if (dim) {
      const menu = document.getElementById('lib-view-menu') as HTMLDetailsElement | null;
      if (menu) menu.open = false;
      addColumn(dim);
      addSelect.value = '';
    }
  });

  // Side list: its close button
  document.getElementById('toggle-split-panel')?.addEventListener('click', () => {
    setSplitPanel(false);
    (document.getElementById('browse-search') as HTMLElement | null)?.focus();
  });

  // Side list: "None" closes it, anything else opens it on that
  const dimSelect = document.getElementById('split-dimension') as HTMLSelectElement | null;
  dimSelect?.addEventListener('change', () => {
    const v = dimSelect.value as Dimension | '';
    setSplitPanel(v !== '', v || undefined);
  });

  // Search
  const searchInput = document.getElementById('browse-search') as HTMLInputElement | null;
  searchInput?.addEventListener('input', () => {
    browseSearchQuery = searchInput.value.trim().toLowerCase();
    renderCompactList();
  });

  // Health summary: the three tiles filter the list
  for (const [tile, state] of [[kpiHealthy, 'ready'], [kpiWarnings, 'fix'], [kpiErrors, 'wontplay']] as const) {
    tile?.addEventListener('click', () => setHealthFilter(state));
  }
  filterClearBtn?.addEventListener('click', clearAllFilters);
  problemsMoreBtn?.addEventListener('click', () => {
    showAllProblems = !showAllProblems;
    renderProblemList();
  });
  document.getElementById('lib-guide-start')?.addEventListener('click', startGuide);

  // Service status click handlers
  document.getElementById('spotify-status')?.addEventListener('click', async () => {
    // Signed in: check again. Otherwise go straight to the sign-in.
    const s = await window.candybar.spotifySignInStatus().catch(() => null);
    if (s?.signedIn) void checkSpotifyConnectionFn(true);
    else void signInToSpotifyFlow();
  });
  document.getElementById('soundcloud-status')?.addEventListener('click', () => {
    void checkSoundCloudConnectionFn(true);
  });
  document.getElementById('qobuz-status')?.addEventListener('click', () => {
    openSettingsTo('qobuz');
  });
  document.getElementById('beatport-status')?.addEventListener('click', () => {
    openSettingsTo('beatport');
  });

  // Connected devices auto-detection
  initConnectedDevices();

  // Manual library rescan
  runLibraryScanBtn?.addEventListener('click', () => {
    void autoRefreshLibrary();
  });

  // Wire scan progress events to the inline progress bar + spinner
  window.candybar.onHealthScanProgress(updateScanProgress);

  // Initial render
  renderCompactList();

  inspectorClose.addEventListener('click', () => {
    const fp = selectedTrackPath;
    closeInspector();
    // Back to the row the details were for, for keyboard users.
    if (fp) document.querySelector<HTMLElement>(`#browse-compact-list .bv4-row[data-fp="${CSS.escape(fp)}"]`)?.focus();
  });

  // Escape closes the fix modal and Tab stays inside it (a confirm opened over
  // it handles those keys first and stops or marks them).
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || fixModal.style.display === 'none') return;
    if (e.key === 'Escape') {
      e.preventDefault();
      hideFixModal();
    } else if (e.key === 'Tab') {
      trapDialogFocus(fixModal.querySelector<HTMLElement>('.modal') ?? fixModal, e);
    }
  });

  // Fix modal events
  fixDeleteOriginal.addEventListener('change', syncFixDeleteNote);
  fixModalClose.addEventListener('click', hideFixModal);
  fixModalCancel.addEventListener('click', hideFixModal);
  fixModalConfirm.addEventListener('click', () => {
    if (pendingReencodeTrack) {
      handleReencodeConfirm();
    } else {
      handleFixConfirm();
    }
  });

  // Close modal on overlay click
  fixModal.addEventListener('click', (e) => {
    if (e.target === fixModal) hideFixModal();
  });
}
