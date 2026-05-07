// ============================================================
// Library page — merged Browse (compact list, columns, split)
// + Health (scan, KPI, inspector, actions, duplicates, modals)
// ============================================================

import type {
  LibraryHealthTrack, DuplicateTrackInfo,
  DuplicatePair, LibraryHealthResult,
  HealthIssue, SuggestedAction
} from './shared';
import { addConversionTask, updateConversionTask } from './activity';
import {
  showToast, setStatus, escapeHtml, icons, formatDuration, showContextMenu,
  openTagEditor, getErrorMessage,
  checkSpotifyConnection as checkSpotifyConnectionFn,
  checkSoundCloudConnection as checkSoundCloudConnectionFn
} from './shared';
import { openSettingsTo } from './settings';
import { openAlbumArtFix } from './albumArtFix';
import { playFile } from './player';
import {
  issueDescriptions, issueSeverities, issueTooltips,
  formatHealthFormatInfo, getPrimarySuggestedAction,
  updateScanProgress as updateScanProgressShared
} from './healthTrackTable';
import { initConnectedDevices } from './connectedDevices';
import {
  expandDrawer, hideDrawer, setDrawerTitle, setDrawerContent,
  getDrawerBody, onDrawerStateChange
} from './rightDrawer';

const esc = escapeHtml;

// Stub — duplicate rendering UI lives in health.ts; this keeps library.ts
// references resolvable at runtime until the duplicates panel is ported here.
function renderDuplicates(): void {}

// ========== Browse Types ==========

interface BrowseTrack {
  id: number;
  filePath: string;
  hasAlbumArt: boolean;
  isHealthy: boolean;
  issues: HealthIssue[];
  title: string;
  artist: string;
  album: string;
  genre: string;
  year: number;
  duration: string;
  format: string;
  bitrate: number;
  bpm: number | null;
  artColor: string;
}

type Dimension = 'artist' | 'album' | 'genre' | 'format' | 'bpm' | 'year';

interface BrowseColumn {
  dim: Dimension;
  selected: string | null;  // null = "All"
  collapsed: boolean;
}

// ========== DOM Elements ==========

// Health scan controls
const runLibraryScanBtn = document.getElementById('run-library-scan') as HTMLButtonElement;
const libraryProgressSection = document.getElementById('library-progress-section') as HTMLElement;
const libraryProgressMessage = document.getElementById('library-progress-message') as HTMLSpanElement;
const libraryProgressBar = document.getElementById('library-progress-bar') as HTMLDivElement;
const libraryProgressCount = document.getElementById('library-progress-count') as HTMLSpanElement;
const libraryDashboard = document.getElementById('library-dashboard') as HTMLElement;
const scanTimestamp = document.getElementById('scan-timestamp') as HTMLSpanElement;
const kpiTotal = document.getElementById('kpi-total') as HTMLElement;
const kpiHealthy = document.getElementById('kpi-healthy') as HTMLElement;
const kpiWarnings = document.getElementById('kpi-warnings') as HTMLElement;
const kpiErrors = document.getElementById('kpi-errors') as HTMLElement;
const issueListEl = document.getElementById('issue-list') as HTMLDivElement;

// Skeleton
const healthSkeletonSection = document.getElementById('health-skeleton-section') as HTMLElement;

// Inspector
const inspectorPanel = document.getElementById('library-inspector') as HTMLDivElement;
const inspectorClose = document.getElementById('inspector-close') as HTMLButtonElement;
const inspectorArt = document.getElementById('inspector-art') as HTMLDivElement;
const inspectorTitle = document.getElementById('inspector-title') as HTMLDivElement;
const inspectorArtist = document.getElementById('inspector-artist') as HTMLDivElement;
const inspectorMeta = document.getElementById('inspector-meta') as HTMLDivElement;
const inspectorFormat = document.getElementById('inspector-format') as HTMLDivElement;
const inspectorIssues = document.getElementById('inspector-issues') as HTMLDivElement;
const inspectorActions = document.getElementById('inspector-actions') as HTMLDivElement;

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

// Health state
let healthResult: LibraryHealthResult | null = null;
let activeIssueCode: string | null = null;
let selectedTrackPath: string | null = null;
let activeLibraryScanId: string | null = null;
let backgroundScanRunning = false;
let pendingAutoRefresh: Promise<LibraryHealthResult | null> | null = null;

let pendingFixTrack: LibraryHealthTrack | null = null;
const multiSelectedPaths = new Set<string>();
let dragSelecting = false;
let dragStartIndex: number | null = null;
let dragCurrentIndex: number | null = null;
let dragAnchorSelected = false; // whether the anchor row was already selected (for toggle logic)

let pendingReencodeTrack: LibraryHealthTrack | null = null;
let pendingDeleteTrack: LibraryHealthTrack | null = null;
let pendingBatchDelete: LibraryHealthTrack[] | null = null;
let allTracks: BrowseTrack[] = [];
let trackLookup: Map<string, LibraryHealthTrack> = new Map();

let searchQuery = '';
let columnsPanelOpen = false;
let columns: BrowseColumn[] = [];

let splitPanelOpen = false;
let splitDimension: Dimension = 'artist';
let splitSelected: string | null = null;

let activeIssueFilter: string | null = null;
let browseSearchQuery = '';
let lastLoadedLibraryRoot: string | null = null;

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function artColorFromArtist(artist: string): string {
  let hash = 0;
  for (let i = 0; i < artist.length; i++) {
    hash = ((hash << 5) - hash) + artist.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

function clearMultiSelection(): void {
  multiSelectedPaths.clear();
  const list = document.getElementById('browse-compact-list');
  list?.querySelectorAll('.bv4-row.multi-selected').forEach(r => r.classList.remove('multi-selected'));
}

function highlightFixFlowTrack(): void {
  if (!fixFlow) return;
  const targetPath = fixFlow.trackPaths[fixFlow.currentIndex];
  const list = document.getElementById('browse-compact-list');
  if (!list) return;
  list.querySelectorAll('.bv4-row.fix-flow-focus').forEach(r => r.classList.remove('fix-flow-focus'));
  const row = list.querySelector<HTMLElement>(`.bv4-row[data-path="${CSS.escape(targetPath)}"]`);
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

// ========== Utility Helpers ==========

// ========== Browse Dimension Helpers ==========

const DIM_LABELS: Record<Dimension, string> = {
  artist: 'Artist', album: 'Album', genre: 'Genre',
  format: 'Format', bpm: 'BPM Range', year: 'Year',
};

function bpmRange(bpm: number | null): string {
  if (bpm === null) return 'Unknown';
  const low = Math.floor(bpm / 10) * 10;
  return `${low}\u2013${low + 9}`;
}

function dimValue(t: BrowseTrack, dim: Dimension): string {
  switch (dim) {
    case 'artist': return t.artist;
    case 'album':  return t.album;
    case 'genre':  return t.genre;
    case 'format': return t.format;
    case 'bpm':    return bpmRange(t.bpm);
    case 'year':   return String(t.year);
  }
}

function formatBadge(fmt: string): string {
  const cls = fmt === 'AIFF' || fmt === 'WAV' ? 'fmt-lossless' : fmt === 'FLAC' ? 'fmt-flac' : 'fmt-lossy';
  return `<span class="fmt-badge ${cls}">${esc(fmt)}</span>`;
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
    const ext = t.fileName.split('.').pop()?.toUpperCase() ?? '';
    const container = t.format.container?.toUpperCase() ?? ext;
    // Dismissed issues are hidden from the Library's filters, dots, and counts.
    // They remain on the source track (healthResult.tracks[i]) so the inspector
    // can surface them and offer restore.
    const activeIssues = t.issues.filter(issue => !issue.dismissed);
    return {
      id: i + 1,
      filePath: t.filePath,
      hasAlbumArt: t.hasAlbumArt,
      isHealthy: activeIssues.length === 0,
      issues: activeIssues,
      title: t.title || t.fileName,
      artist: t.artist,
      album: t.album,
      genre: t.genre,
      year: t.year ?? 0,
      duration: formatDuration(t.format.duration),
      format: container,
      bitrate: t.format.bitRate ?? 0,
      bpm: null,
      artColor: artColorFromArtist(t.artist),
    } satisfies BrowseTrack;
  });
}

function applyAllFilters(): BrowseTrack[] {
  let tracks = allTracks.slice();

  // Each column narrows by its selected value
  for (const col of columns) {
    if (col.selected !== null) {
      tracks = tracks.filter(t => dimValue(t, col.dim) === col.selected);
    }
  }

  // Split panel filter
  if (splitSelected !== null) {
    tracks = tracks.filter(t => dimValue(t, splitDimension) === splitSelected);
  }

  // Issue type filter. 'all' is a legacy "no filter" sentinel from the
  // Health tab's tab-filter config, not an issue code — treat it as null.
  const rawIssueCode = activeIssueCode ?? activeIssueFilter;
  const effectiveIssueCode = rawIssueCode && rawIssueCode !== 'all' ? rawIssueCode : null;
  if (effectiveIssueCode !== null) {
    tracks = tracks.filter(t => t.issues.some(i => i.code === effectiveIssueCode));
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

// ========== Compact List Rendering ==========

function artThumb(t: BrowseTrack): string {
  const cachedSrc = artCache.get(t.filePath);
  const loaded = t.hasAlbumArt && cachedSrc != null;
  const loading = t.hasAlbumArt && !loaded;
  const imgAttrs = loaded ? `src="${esc(cachedSrc!)}" style="display:block"` : 'style="display:none"';
  const inner = t.hasAlbumArt
    ? `<img class="bv4-art" ${imgAttrs} alt="">`
    : '';
  const bg = t.artColor ? `style="background:${esc(t.artColor)}"` : '';
  const dataFp = t.hasAlbumArt ? ` data-fp="${esc(t.filePath)}"` : '';
  return `<div class="bv4-art-wrap${loading ? ' loading' : ''}"${dataFp} ${bg}>${inner}</div>`;
}

function healthDot(t: BrowseTrack): string {
  if (t.isHealthy) return '';
  const hasError = t.issues.some(i => (issueSeverities[i.code] ?? i.severity) === 'error');
  const cls = hasError ? 'error' : 'warning';
  const tooltip = t.issues.map(i => issueTooltips[i.code] || issueDescriptions[i.code] || i.code).join('\n\n');
  return `<span class="bv4-health-dot ${cls}" title="${esc(tooltip)}"></span>`;
}

function rowHealthClass(t: BrowseTrack): string {
  if (t.isHealthy) return '';
  const hasError = t.issues.some(i => (issueSeverities[i.code] ?? i.severity) === 'error');
  return hasError ? ' has-error' : ' has-warning';
}

function inlineActionHtml(t: BrowseTrack): string {
  const healthTrack = trackLookup.get(t.filePath);
  if (!healthTrack || t.isHealthy) return '';
  const action = getPrimarySuggestedAction(healthTrack.issues);
  if (action === 'none') return '';
  const title = action === 'convert_aiff' ? 'Convert to AIFF'
    : action === 'reencode_mp3' ? 'Re-encode to 320kbps'
    : action === 'populate_tags' ? 'Populate Tags'
    : action === 'archive' ? 'Archive track'
    : action === 'delete' ? 'Delete track'
    : '';
  return `<button class="bv4-inline-action" data-action="${esc(action)}" data-fp="${esc(t.filePath)}" data-tooltip="${esc(title)}">${esc(title)}</button>`;
}

function renderCompactList(): void {
  const list = document.getElementById('browse-compact-list');
  if (!list) return;
  const tracks = applyAllFilters();

  list.innerHTML = tracks.map((t, i) => {
    const selected = selectedTrackPath === t.filePath ? ' selected' : '';
    const subtitle = t.album
      ? `${esc(t.artist)}<span class="bv4-sep">&middot;</span>${esc(t.album)}`
      : esc(t.artist);
    return `
    <div class="bv4-row${rowHealthClass(t)}${selected}" data-id="${t.id}" data-fp="${esc(t.filePath)}">
      <span class="bv4-num">${i + 1}</span>
      ${artThumb(t)}
      <div class="bv4-title-group">
        <span class="bv4-title">${esc(t.title)}</span>
        <span class="bv4-artist">${subtitle}</span>
      </div>
      <div class="bv4-right">
        ${healthDot(t)}
        ${inlineActionHtml(t)}
        ${formatBadge(t.format)}
        <span class="bv4-bpm">${t.bpm ?? '\u2014'}</span>
        <span class="bv4-dur">${esc(t.duration)}</span>
      </div>
    </div>`;
  }).join('') || '<div class="browse-empty"><div class="browse-empty-title">No tracks found</div><div class="browse-empty-hint">Adjust your filters or run a library scan.</div></div>';

  setupArtLazyLoad(list);
  wireCompactListEvents(list);
  renderIssueChips();
}

function wireCompactListEvents(list: HTMLElement): void {
  list.querySelectorAll<HTMLElement>('.bv4-row').forEach(row => {
    const fp = row.dataset.fp;
    if (!fp) return;

    // Click to open inspector
    row.addEventListener('click', (e) => {
      // Don't trigger on inline action button clicks
      if ((e.target as HTMLElement).closest('.bv4-inline-action')) return;
      const healthTrack = trackLookup.get(fp);
      if (healthTrack) openInspector(healthTrack);
    });

    // Right-click context menu
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const healthTrack = trackLookup.get(fp);
      if (!healthTrack) return;

      const container = healthTrack.format.container?.toUpperCase() || '';
      const isAiff = container === 'AIFF' || container === 'AIFF-C';
      const isLossy = healthTrack.format.lossless === false;
      const isMp3 = container === 'MPEG' || healthTrack.filePath.toLowerCase().endsWith('.mp3');

      const activeIssues = healthTrack.issues.filter(i => !i.dismissed);
      const dismissItems = activeIssues.map(issue => ({
        label: `Dismiss: ${issueDescriptions[issue.code] || issue.code}`,
        icon: icons.ignore,
        action: () => handleDismissIssue(healthTrack, issue.code)
      }));
      const dismissAllItem = activeIssues.length > 1
        ? [{
            label: 'Dismiss all issues on this track',
            icon: icons.ignore,
            action: () => handleDismissAllIssues(healthTrack)
          }]
        : [];

      const items = [
        { label: 'Play track', icon: icons.play, action: () => playFile(healthTrack.filePath, healthTrack.fileName) },
        { separator: true, label: '' },
        ...(!isAiff && !isLossy ? [{ label: 'Convert to AIFF', icon: icons.wrench, action: () => showFixModal(healthTrack) }] : []),
        ...(isMp3 ? [{ label: 'Re-encode to 320kbps', icon: icons.wrench, action: () => showReencodeModal(healthTrack) }] : []),
        { label: 'Edit tags', icon: icons.edit, action: () => handleEditTags(healthTrack) },
        ...(dismissItems.length > 0 || dismissAllItem.length > 0 ? [{ separator: true, label: '' }] : []),
        ...dismissItems,
        ...dismissAllItem,
        ...(dismissItems.length > 0 || dismissAllItem.length > 0 ? [{ separator: true, label: '' }] : []),
        { label: 'Archive track', icon: icons.archive, action: () => handleArchiveTrack(healthTrack) },
        { label: 'Delete track', icon: icons.trash, action: () => showDeleteModal(healthTrack) }
      ];
      showContextMenu(e.clientX, e.clientY, items);
    });

    // Inline action button
    const actionBtn = row.querySelector<HTMLButtonElement>('.bv4-inline-action');
    if (actionBtn) {
      actionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const healthTrack = trackLookup.get(fp);
        if (!healthTrack) return;
        const action = actionBtn.dataset.action;
        if (action === 'convert_aiff') showFixModal(healthTrack);
        else if (action === 'reencode_mp3') showReencodeModal(healthTrack);
        else if (action === 'populate_tags') handlePopulateTags(healthTrack);
        else if (action === 'archive') handleArchiveTrack(healthTrack);
        else if (action === 'delete') showDeleteModal(healthTrack);
      });
    }
  });
}

function renderColumnStrip(): void {
  const strip = document.getElementById('browse-column-strip');
  if (!strip) return;

  strip.innerHTML = '';

  columns.forEach((col, i) => {
    const chevronPath = col.collapsed
      ? '<polyline points="9 18 15 12 9 6"/>'
      : '<polyline points="15 18 9 12 15 6"/>';
    const el = document.createElement('div');
    el.className = 'browse-column-el';
    el.innerHTML = `
      <span class="col-label">${DIM_LABELS[col.dim]}</span>
      <button class="browse-column-btn col-collapse-btn" data-tooltip="${col.collapsed ? 'Expand' : 'Collapse'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${chevronPath}</svg>
      </button>
      <button class="browse-column-btn col-remove-btn" data-tooltip="Remove column">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    `;
    el.querySelector('.col-collapse-btn')?.addEventListener('click', () => {
      columns[i].collapsed = !columns[i].collapsed;
      renderColumnStrip();
    });
    el.querySelector('.col-remove-btn')?.addEventListener('click', () => {
      columns.splice(i, 1);
      renderColumnStrip();
      clearMultiSelection();
      renderCompactList();
    });
    el.querySelectorAll<HTMLElement>('.col-val-item').forEach(item => {
      item.addEventListener('click', () => {
        const val = item.dataset.val || null;
        columns[i].selected = val;
        renderColumnStrip();
        renderCompactList();
      });
    });
    strip.appendChild(el);
  });
}

async function handleBatchArchive(tracks: LibraryHealthTrack[]): Promise<void> {
  showToast('info', 'Batch Archive', `Archiving ${tracks.length} tracks...`);
  let success = 0;
  let failed = 0;
  for (const track of tracks) {
    try {
      await window.candybar.archiveTrackFile(track.filePath);
      success++;
    } catch {
      failed++;
    }
  }
  clearMultiSelection();
  renderCompactList();
  if (healthResult) renderKpiDashboard(healthResult)();
  if (failed > 0) showToast('warning', 'Batch Archive', `${success} archived, ${failed} failed`);
  else showToast('success', 'Batch Archive', `${success} tracks archived`);
}

// ========== Split Panel ==========

function renderSplitPanel(): void {
  const header = document.getElementById('split-panel-header');
  const ul = document.getElementById('split-list');
  if (!header || !ul) return;

  header.textContent = DIM_LABELS[splitDimension];

  const values = unique(allTracks.map(t => dimValue(t, splitDimension))).sort();
  ul.innerHTML = ['All', ...values].map(v => {
    const isAll = v === 'All';
    const active = isAll ? splitSelected === null : splitSelected === v;
    return `<li class="bv5-item${active ? ' active' : ''}" data-val="${isAll ? '' : esc(v)}">${esc(v)}</li>`;
  }).join('');

  ul.querySelectorAll('.bv5-item').forEach(el => {
    el.addEventListener('click', () => {
      splitSelected = (el as HTMLElement).dataset.val || null;
      renderSplitPanel();
      renderCompactList();
    });
  });
}

// ========== Column Panel Visibility ==========

function setColumnsPanelVisibility(): void {
  const area = document.getElementById('browse-columns-area') as HTMLElement | null;
  const btn  = document.getElementById('toggle-columns-panel');
  if (!area) return;
  area.hidden = !columnsPanelOpen;
  btn?.classList.toggle('active', columnsPanelOpen);
  if (columnsPanelOpen) renderColumnStrip();
}

function addColumn(dim: Dimension): void {
  columns.push({ dim, selected: null, collapsed: false });
  renderColumnStrip();
  renderCompactList();
}

// ========== KPI Strip ==========

function renderKpiDashboard(result: LibraryHealthResult) {
  const { summary } = result;

  // Update inline KPI text
  kpiTotal.textContent = `${summary.total.toLocaleString()} tracks`;
  kpiHealthy.textContent = `${summary.healthy.toLocaleString()} healthy`;
  kpiWarnings.textContent = `${summary.warnings.toLocaleString()} warnings`;
  kpiErrors.textContent = `${summary.errors.toLocaleString()} errors`;

  // Timestamp
  if (result.scannedAt) {
    const d = new Date(result.scannedAt);
    scanTimestamp.textContent = d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  // Issue chips (counts reflect the currently filtered list)
  renderIssueChips();

  return () => {
    renderFixFlowButton();
    libraryDashboard.style.display = '';
  };
}

/**
 * Render the filter chip row. Each chip's count reflects how many tracks
 * would remain if its filter were added on top of the current non-issue filters
 * (search, split, columns). The active chip is highlighted with a filled
 * background. Called on every filter change so counts stay current.
 */
function renderIssueChips(): void {
  if (!healthResult || !issueListEl) return;

  // Count against the filtered list *minus* the active issue filter, so each
  // chip answers "how many tracks would this filter show right now?".
  const savedIssueCode = activeIssueCode;
  activeIssueCode = null;
  const baseList = applyAllFilters();
  activeIssueCode = savedIssueCode;

  const counts = new Map<string, number>();
  for (const t of baseList) {
    for (const issue of t.issues) {
      counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
    }
  }

  const entries = Array.from(counts.entries())
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  issueListEl.innerHTML = entries.map(([code, count]) => {
    const sev = issueSeverities[code] || 'warning';
    const label = issueDescriptions[code] || code;
    const activeCls = activeIssueCode === code ? ' active' : '';
    return `<button class="browse-issue-chip ${sev}${activeCls}" data-code="${esc(code)}" data-tooltip="Filter to tracks with this issue">${esc(label)} <span class="chip-count">${count}</span></button>`;
  }).join('');

  issueListEl.querySelectorAll<HTMLElement>('.browse-issue-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      if (fixFlow) exitFixFlow();
      const code = btn.dataset.code!;
      activeIssueCode = activeIssueCode === code ? null : code;
      renderIssueChips();
      renderCompactList();
      renderFixFlowButton();
    });
  });

  updateMissingArtButton(counts.get('MISSING_ALBUM_ART') ?? 0);
}

// ========== Missing Album Art Entry Point ==========

function updateMissingArtButton(count: number): void {
  const btn = document.getElementById('missing-art-mode') as HTMLButtonElement | null;
  const countEl = document.getElementById('missing-art-count');
  if (!btn) return;
  btn.style.display = count > 0 ? '' : 'none';
  if (countEl) countEl.textContent = String(count);
}

function launchAlbumArtFix(): void {
  if (!healthResult) return;
  const tracks = healthResult.tracks.filter(t =>
    t.issues.some(i => i.code === 'MISSING_ALBUM_ART')
  );
  if (tracks.length === 0) {
    showToast('info', 'Missing Art', 'No tracks are missing album art.');
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

      recalculateSummary();
      syncHealthState();
      rebuildBrowseTracks();
      renderCompactList();
      if (healthResult) renderKpiDashboard(healthResult)();
    },
  });
}

function renderFixFlowButton(): void {
  let btn = document.getElementById('fix-flow-start');
  if (!activeIssueCode || !healthResult) {
    btn?.remove();
    return;
  }

  const count = healthResult.tracks.filter(t =>
    t.issues.some(i => i.code === activeIssueCode)
  ).length;
  if (count === 0) { btn?.remove(); return; }

  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'fix-flow-start';
    btn.className = 'btn-primary btn-sm fix-flow-start-btn';
    btn.setAttribute('data-tooltip', 'Step through every affected track and fix this issue');
    issueListEl.parentElement?.appendChild(btn);
    btn.addEventListener('click', enterFixFlow);
  }
  const isTagIssue = activeIssueCode === 'MISSING_TAGS' || activeIssueCode === 'SPARSE_TAGS';
  btn.textContent = isTagIssue ? `Populate ${count} Track${count === 1 ? '' : 's'}` : `Fix Flow (${count})`;
}

function openInspector(track: LibraryHealthTrack): void {
  selectedTrackPath = track.filePath;

  const browseBody = document.querySelector('.browse-body') as HTMLElement | null;
  if (browseBody) browseBody.classList.add('inspector-open');

  document.querySelectorAll<HTMLElement>('.bv4-row').forEach(row => {
    row.classList.toggle('selected', row.dataset.fp === track.filePath);
  });

  inspectorTitle.textContent = track.title || track.fileName;

  const metaParts: string[] = [];
  if (track.artist) metaParts.push(`Artist: ${track.artist}`);
  if (track.album) metaParts.push(`Album: ${track.album}`);
  if (track.year) metaParts.push(`Year: ${track.year}`);
  if (track.genre) metaParts.push(`Genre: ${track.genre}`);
  inspectorMeta.innerHTML = metaParts.length > 0
    ? metaParts.map((p) => `<div class="inspector-meta-item">${escapeHtml(p)}</div>`).join('')
    : '<div class="inspector-meta-item muted">No metadata</div>';

  // Issues — dismissed issues are shown but visually muted + offer Restore
  inspectorIssues.innerHTML = track.issues.length > 0
    ? track.issues.map(i => `
      <div class="inspector-issue ${(issueSeverities[i.code] ?? i.severity) || ''}${i.dismissed ? ' dismissed' : ''}" data-code="${escapeHtml(i.code)}">
        <span class="inspector-issue-code">${i.code}</span>
        <span class="inspector-issue-msg">${escapeHtml(i.message)}</span>
        ${i.detail ? `<span class="inspector-issue-detail">${escapeHtml(i.detail)}</span>` : ''}
        ${i.dismissed
          ? `<span class="inspector-issue-dismissed-badge">Dismissed</span>
             <button class="btn-ghost btn-sm inspector-issue-restore" data-code="${escapeHtml(i.code)}" data-tooltip="Bring this issue back into the active list">Restore</button>`
          : `<button class="btn-ghost btn-sm inspector-issue-dismiss" data-code="${escapeHtml(i.code)}" data-tooltip="Hide this issue for this track">Dismiss</button>`
        }
      </div>
    `).join('')
    : '<div class="inspector-no-issues">No issues detected</div>';

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

  // Actions
  const canConvertAiff = track.issues.some((i) => i.suggestedAction === 'convert_aiff');
  const canReencode = track.issues.some((i) => i.suggestedAction === 'reencode_mp3');
  const canPopulateTags = track.issues.some((i) => i.suggestedAction === 'populate_tags');
  const suggestedAction = getPrimarySuggestedAction(track.issues);

  let actionsHtml = '';
  if (canConvertAiff) {
    actionsHtml += `<button class="btn-primary btn-sm inspector-action-fix" data-tooltip="Convert to AIFF">Convert to AIFF</button>`;
  }
  if (canReencode) {
    actionsHtml += `<button class="btn-primary btn-sm inspector-action-reencode" data-tooltip="Re-encode to 320kbps MP3">Re-encode MP3</button>`;
  }
  if (canPopulateTags) {
    actionsHtml += `<button class="btn-primary btn-sm inspector-action-populate-tags" data-tooltip="Search online and populate missing tags">Populate Tags</button>`;
  }
  actionsHtml += `<button class="btn-secondary btn-sm inspector-action-edit-tags" data-tooltip="Edit ID3 tags">Edit Tags</button>`;
  actionsHtml += `<button class="btn-secondary btn-sm inspector-action-archive${suggestedAction === 'archive' ? ' suggested' : ''}" data-tooltip="Archive track">Archive</button>`;
  actionsHtml += `<button class="btn-danger btn-sm inspector-action-delete" data-tooltip="Delete track">Delete</button>`;

  inspectorActions.innerHTML = actionsHtml;

  // Wire action buttons
  inspectorActions.querySelector('.inspector-action-fix')?.addEventListener('click', () => showFixModal(track));
  inspectorActions.querySelector('.inspector-action-reencode')?.addEventListener('click', () => showReencodeModal(track));
  inspectorActions.querySelector('.inspector-action-populate-tags')?.addEventListener('click', () => handlePopulateTags(track));
  inspectorActions.querySelector('.inspector-action-edit-tags')?.addEventListener('click', () => handleEditTags(track));
  inspectorActions.querySelector('.inspector-action-archive')?.addEventListener('click', () => handleArchiveTrack(track));
  inspectorActions.querySelector('.inspector-action-delete')?.addEventListener('click', () => showDeleteModal(track));

  inspectorPanel.style.display = 'flex';
}

function closeInspector() {
  selectedTrackPath = null;

  const browseBody = document.querySelector('.browse-body') as HTMLElement | null;
  if (browseBody) browseBody.classList.remove('inspector-open');

  inspectorPanel.style.display = 'none';

  const list = document.getElementById('browse-compact-list');
  if (list) {
    list.querySelectorAll('.bv4-row.selected').forEach((row) => {
      row.classList.remove('selected');
    });
  }
}

// ========== Edit Tags ==========

function handleEditTags(track: LibraryHealthTrack) {
  openTagEditor(track, (updatedTrack) => {
    if (!healthResult) return;
    const idx = healthResult.tracks.findIndex(t => t.filePath === updatedTrack.filePath);
    if (idx !== -1) {
      healthResult.tracks[idx] = {
        ...healthResult.tracks[idx],
        title: updatedTrack.title,
        artist: updatedTrack.artist,
        album: updatedTrack.album,
        year: updatedTrack.year ? parseInt(updatedTrack.year, 10) || null : null,
        genre: updatedTrack.genre,
        hasAlbumArt: !!updatedTrack.albumArt
      };
      syncHealthState();
      rebuildBrowseTracks();
      renderCompactList();
      if (selectedTrackPath === track.filePath) {
        openInspector(healthResult.tracks[idx]);
      }
    }
  });
}

async function handlePopulateTags(track: LibraryHealthTrack): Promise<void> {
  const btn = document.querySelector<HTMLButtonElement>('.inspector-action-populate-tags');
  if (btn) { btn.disabled = true; btn.textContent = 'Searching...'; }

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
      showToast('error', 'Populate Failed', result.error);
      return;
    }
    if (!result.updated) {
      showToast('warning', 'No Match', 'Could not find a confident match for this track');
      return;
    }

    await refreshTrackAfterPopulate(track);

    showToast('success', 'Tags Updated', `+${result.fieldsPopulated.join(', ')}`);
  } catch (err) {
    const message = getErrorMessage(err);
    showToast('error', 'Populate Failed', message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Populate Tags'; }
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

    syncHealthState();
    rebuildBrowseTracks();
    renderCompactList();
    if (selectedTrackPath === track.filePath) openInspector(track);
  } catch (err) {
    const message = getErrorMessage(err);
    showToast('warning', 'Tag Refresh Failed', message);
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

function showFixModal(track: LibraryHealthTrack) {
  pendingFixTrack = track;
  pendingReencodeTrack = null;

  fixFileName.textContent = track.fileName;
  fixFileName.title = track.fileName;
  const fixableIssues = track.issues.filter((i) => i.suggestedAction === 'convert_aiff');
  fixIssuesList.innerHTML = fixableIssues.length > 0
    ? fixableIssues.map(renderFixIssue).join('')
    : renderFixIssue({ code: 'CONVERT', message: 'Convert to lossless AIFF format' });
  fixDeleteOriginal.checked = true;
  fixModal.style.display = 'flex';
}

function renderFixIssue(issue: { code: string; message: string }): string {
  return `
    <div class="fix-issue">
      <svg class="fix-issue-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <div class="fix-issue-text">
        <span class="fix-issue-code">${escapeHtml(issue.code)}</span>
        <span class="fix-issue-message">${escapeHtml(issue.message)}</span>
      </div>
    </div>
  `;
}

function showReencodeModal(track: LibraryHealthTrack) {
  pendingReencodeTrack = track;
  pendingFixTrack = null;

  fixFileName.textContent = track.fileName;
  fixFileName.title = track.fileName;
  const reencodeIssues = track.issues.filter((i) => i.suggestedAction === 'reencode_mp3');
  fixIssuesList.innerHTML = reencodeIssues.length > 0
    ? reencodeIssues.map(renderFixIssue).join('')
    : renderFixIssue({ code: 'REENCODE', message: 'Re-encode MP3 at 320kbps' });
  fixDeleteOriginal.checked = true;
  fixModal.style.display = 'flex';
}

function hideFixModal() {
  fixModal.style.display = 'none';
  pendingFixTrack = null;
  pendingReencodeTrack = null;
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
      removeTrackFromHealthResult(track);
      showToast('success', 'Converted to AIFF', `${track.fileName} has been converted.`);
    } else {
      updateConversionTask(taskId, 'failed');
      showToast('error', 'Conversion Failed', result.errorMessage || 'Unknown error during conversion.');
    }
  } catch (err) {
    updateConversionTask(taskId, 'failed');
    const message = getErrorMessage(err);
    showToast('error', 'Conversion Failed', message);
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
      removeTrackFromHealthResult(track);
      showToast('success', 'Re-encoded to MP3', `${track.fileName} has been re-encoded at 320kbps.`);
    } else {
      updateConversionTask(taskId, 'failed');
      showToast('error', 'Re-encode Failed', result.errorMessage || 'Unknown error during re-encoding.');
    }
  } catch (err) {
    updateConversionTask(taskId, 'failed');
    const message = getErrorMessage(err);
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
  pendingBatchDelete = null;
}

async function handleDeleteConfirm() {
  if (!pendingDeleteTrack) return;
  const track = pendingDeleteTrack;
  hideDeleteModal();

  try {
    const result = await window.candybar.deleteTrackFile(track.filePath);
    if (result.success) {
      showToast('success', 'Track Deleted', `${track.fileName} has been deleted.`);
      removeTrackFromHealthResult(track);
    } else {
      showToast('error', 'Delete Failed', result.error || 'Unknown error deleting file.');
    }
  } catch (err) {
    const message = getErrorMessage(err);
    showToast('error', 'Delete Failed', message);
  }
}

async function handleArchiveTrack(track: LibraryHealthTrack) {
  try {
    const result = await window.candybar.archiveTrackFile(track.filePath);
    if (result.success) {
      showToast('success', 'Track Archived', `${track.fileName} moved to archive.`);
      removeTrackFromHealthResult(track);
    } else {
      showToast('error', 'Archive Failed', result.errorMessage || 'Unknown error archiving file.');
    }
  } catch (err) {
    const message = getErrorMessage(err);
    showToast('error', 'Archive Failed', message);
  }
}

// ========== Dismiss / Restore Health Issues ==========

async function applyDismissalChanges(track: LibraryHealthTrack, codes: string[], dismissed: boolean): Promise<void> {
  if (!healthResult || codes.length === 0) return;
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
    renderKpiDashboard(healthResult)();
    if (selectedTrackPath === track.filePath) openInspector(track);
  } catch (err) {
    const verb = dismissed ? 'Dismiss' : 'Restore';
    showToast('error', `${verb} Failed`, getErrorMessage(err));
  }
}

async function handleDismissIssue(track: LibraryHealthTrack, code: string): Promise<void> {
  await applyDismissalChanges(track, [code], true);
  const label = issueDescriptions[code] || code;
  showToast('info', 'Issue Dismissed', `${label} hidden for ${track.fileName}.`);
}

async function handleDismissAllIssues(track: LibraryHealthTrack): Promise<void> {
  const codes = Array.from(new Set(track.issues.filter(i => !i.dismissed).map(i => i.code)));
  if (codes.length === 0) return;
  await applyDismissalChanges(track, codes, true);
  showToast('info', 'Issues Dismissed', `${codes.length} issue${codes.length === 1 ? '' : 's'} hidden for ${track.fileName}.`);
}

async function handleRestoreIssue(track: LibraryHealthTrack, code: string): Promise<void> {
  await applyDismissalChanges(track, [code], false);
  const label = issueDescriptions[code] || code;
  showToast('info', 'Issue Restored', `${label} re-enabled for ${track.fileName}.`);
}

// ========== Duplicates ==========

async function removeDuplicatePair(pair: DuplicatePair, persist = true) {
  if (!healthResult) return;
  healthResult.duplicates = healthResult.duplicates.filter(d => d !== pair);
  renderDuplicates();
  syncHealthState();
  if (persist) {
    try {
      await window.candybar.dismissDuplicate(
        pair.track1.artist, pair.track1.title,
        pair.track2.artist, pair.track2.title
      );
    } catch {
      showToast('error', 'Dismiss Failed', 'Could not save dismissal to database.');
    }
  }
}

async function keepTrack(pair: DuplicatePair, keep: 'track1' | 'track2') {
  const toDelete = keep === 'track1' ? pair.track2 : pair.track1;
  const toKeep = keep === 'track1' ? pair.track1 : pair.track2;

  try {
    const result = await window.candybar.deleteTrackFile(toDelete.filePath);
    if (result.success) {
      showToast('success', 'Duplicate Resolved', `Kept "${toKeep.fileName}", deleted "${toDelete.fileName}".`);
      removeDuplicatePair(pair);
    } else {
      showToast('error', 'Delete Failed', result.error || 'Unknown error deleting file.');
    }
  } catch (err) {
    const message = getErrorMessage(err);
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
    <div class="duplicate-track-card" data-key="${esc(trackKey)}">
      <div class="duplicate-track-header">
        <span class="duplicate-track-name">${esc(track.fileName)}</span>
        ${renderTagCompleteness(track)}
      </div>
      <div class="duplicate-track-meta">
        <span class="duplicate-track-format">${esc(track.format || '')}</span>
        ${tagLine ? `<span class="duplicate-tag-line">${esc(tagLine)}</span>` : ''}
      </div>
      <div class="duplicate-track-path">${esc(track.filePath)}</div>
      <button class="btn-sm duplicate-keep" data-tooltip="Keep this copy and remove the others">Keep This</button>
    </div>
  `;
}



// ========== Public Data Load API ==========

export async function loadLibraryData(result: LibraryHealthResult): Promise<void> {
  if (lastLoadedLibraryRoot !== null && lastLoadedLibraryRoot !== result.libraryRoot) {
    resetLibraryFilters();
  }
  lastLoadedLibraryRoot = result.libraryRoot;
  healthResult = result;
  await annotateDismissedIssues();
  recalculateSummary();
  rebuildBrowseTracks();
  renderCompactList();
  renderKpiDashboard(result)();
}

/** Clear all filter values so a freshly-loaded library isn't hidden by stale selections. */
function resetLibraryFilters(): void {
  for (const col of columns) col.selected = null;
  splitSelected = null;
  activeIssueFilter = null;
  activeIssueCode = null;
  browseSearchQuery = '';
  const searchInput = document.getElementById('browse-search') as HTMLInputElement | null;
  if (searchInput) searchInput.value = '';
  if (splitPanelOpen) renderSplitPanel();
}

export async function restoreLibraryResults(result: LibraryHealthResult, filter?: string): Promise<void> {
  lastLoadedLibraryRoot = result.libraryRoot;
  healthResult = result;
  if (filter && filter !== 'all') activeIssueFilter = filter;
  await annotateDismissedIssues();
  recalculateSummary();
  rebuildBrowseTracks();
  renderCompactList();
  renderKpiDashboard(result)();
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
  libraryProgressBar.style.width = '0%';
  libraryProgressMessage.textContent = 'Starting scan...';
  libraryProgressCount.textContent = '';
  libraryProgressSection.style.display = '';

  let refreshedResult: LibraryHealthResult | null = null;
  try {
    const response = await window.candybar.scanLibraryHealth(false, false);
    if (response.result) {
      healthResult = response.result;
      refreshedResult = response.result;

      await loadLibraryData(healthResult);
      renderDuplicates();

      if (!opts.silent) {
        const s = response.result.summary;
        showToast('success', 'Scan Complete', `${s.total} tracks · ${s.errors} errors · ${s.warnings} warnings`);
      }
    }
  } catch (err) {
    const message = getErrorMessage(err);
    showToast('error', 'Auto-Refresh Failed', message);
  } finally {
    backgroundScanRunning = false;
    runLibraryScanBtn.disabled = false;
    runLibraryScanBtn.classList.remove('scanning');
    libraryProgressSection.style.display = 'none';
  }
  return refreshedResult;
}

// ========== Fix Flow ==========

function getFixActionDescription(action: SuggestedAction): string {
  switch (action) {
    case 'convert_aiff': return 'Convert to lossless AIFF format and delete the original file.';
    case 'reencode_mp3': return 'Re-encode as 320kbps MP3 and delete the original file.';
    case 'populate_tags': return 'Search Spotify/SoundCloud for metadata and fill missing tags.';
    case 'search_art': return 'Search online for album art and embed it.';
    case 'archive': return 'Move the file to the archive folder.';
    case 'delete': return 'Permanently delete the file.';
    case 'none': return 'No automated fix available. Skip or edit tags manually.';
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
    setDrawerTitle('Fix Flow');
    setDrawerContent(`
      <div class="fix-flow-content">
        <div class="fix-flow-complete">
          <div class="fix-flow-complete-icon">${icons.success}</div>
          <div class="fix-flow-complete-text">
            All done! Fixed ${fixFlow.fixedCount} of ${fixFlow.trackPaths.length} tracks.
          </div>
          <div class="fix-flow-progress">
            <div class="fix-flow-progress-bar"><div class="fix-flow-progress-fill" style="width:${pct}%"></div></div>
          </div>
          <button class="btn-secondary btn-sm fix-flow-done" style="margin-top:12px" data-tooltip="Close the fix flow">Close</button>
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
  const detail = issue?.detail || issue?.message || '';
  const message = issue?.message || '';

  // Progress
  const remaining = fixFlow.trackPaths.filter(fp => healthResult!.tracks.some(t => t.filePath === fp)).length;
  const done = fixFlow.trackPaths.length - remaining;
  const pos = done + 1;
  const total = fixFlow.trackPaths.length;
  const pct = Math.round((done / total) * 100);

  const isNone = action === 'none';

  setDrawerTitle('Fix Flow');
  setDrawerContent(`
    <div class="fix-flow-content">
      <div class="fix-flow-progress">
        <span class="fix-flow-counter">${pos} of ${total}</span>
        <div class="fix-flow-progress-bar"><div class="fix-flow-progress-fill" style="width:${pct}%"></div></div>
      </div>

      <div class="fix-flow-track-info">
        <div class="fix-flow-track-title">${esc(track.title || track.fileName)}</div>
        <div class="fix-flow-track-artist">${esc(track.artist || 'Unknown Artist')}</div>
      </div>

      <div class="fix-flow-issue">
        <div class="fix-flow-issue-badge ${esc(sev)}">${esc(label)}</div>
        <div class="fix-flow-issue-message">${esc(message)}</div>
        ${detail ? `<div class="fix-flow-issue-detail">${esc(detail)}</div>` : ''}
      </div>

      <div class="fix-flow-action-desc">
        ${icons.wrench}
        <span>${getFixActionDescription(action)}</span>
      </div>

      <div class="fix-flow-buttons">
        ${isNone
          ? `<button class="btn-primary fix-flow-skip-primary" data-tooltip="Skip this track — nothing to fix">Skip</button>`
          : `<button class="btn-primary fix-flow-apply" data-tooltip="Apply the suggested fix to this track">Apply Fix</button>
             <button class="btn-ghost fix-flow-skip" data-tooltip="Skip this track without applying the fix">Skip</button>`
        }
      </div>

      <div class="fix-flow-nav">
        <button class="btn-ghost btn-sm fix-flow-prev" ${fixFlow.currentIndex === 0 ? 'disabled' : ''} data-tooltip="Go back to the previous track">Previous</button>
        <button class="btn-ghost btn-sm fix-flow-next" data-tooltip="Go to the next track">Next</button>
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
  if (!healthResult) return;

  const tracks = healthResult.tracks.filter(t => t.issues.some(i => i.code === issueCode));
  if (tracks.length === 0) {
    showToast('info', 'No Tracks', 'No tracks match this issue filter.');
    return;
  }

  const fixBtn = document.getElementById('fix-flow-start') as HTMLButtonElement | null;
  if (fixBtn) { fixBtn.disabled = true; fixBtn.textContent = `Populating 0 / ${tracks.length}...`; }
  setStatus(`Autopopulating (0/${tracks.length})...`);

  const offProgress = (() => {
    const handler = (p: { current: number; total: number; filePath: string }) => {
      setStatus(`Autopopulating (${p.current}/${p.total})...`);
      if (fixBtn) fixBtn.textContent = `Populating ${p.current} / ${p.total}...`;
    };
    window.candybar.onAutopopulateProgress(handler);
    return () => {}; // preload registers but doesn't expose an unsubscribe; handler is idempotent.
  })();

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
    showToast(
      tone,
      'Populate Complete',
      `${updated} updated · ${noMatch} no match${errored > 0 ? ` · ${errored} errored` : ''}`
    );
    setStatus('Idle');
  } catch (err) {
    const message = getErrorMessage(err);
    showToast('error', 'Populate Failed', message);
    setStatus('Error');
  } finally {
    offProgress();
    if (fixBtn) { fixBtn.disabled = false; }
    // Re-render the Fix Flow button (count may have dropped to zero)
    renderIssueChips();
    renderFixFlowButton();
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

  const filtered = applyAllFilters().filter(t =>
    t.issues.some(i => i.code === activeIssueCode)
  );
  if (filtered.length === 0) {
    showToast('info', 'No Tracks', 'No tracks match this issue filter.');
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
  renderKpiDashboard(healthResult!);
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
  if (!fixFlow) return;

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

  fixFlow.applying = true;
  const applyBtn = getDrawerBody().querySelector('.fix-flow-apply') as HTMLButtonElement | null;
  if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Applying...'; }

  try {
    let success = false;
    switch (action) {
      case 'convert_aiff': {
        const taskId = addConversionTask(track.fileName, 'aiff');
        const result = await window.candybar.fixTrackFile(track.filePath, true);
        if (result.success) {
          updateConversionTask(taskId, 'completed', result.outputPath);
          removeTrackFromHealthResult(track);
          showToast('success', 'Converted to AIFF', `${track.fileName}`);
          success = true;
        } else {
          updateConversionTask(taskId, 'failed');
          showToast('error', 'Conversion Failed', result.errorMessage || 'Unknown error.');
        }
        break;
      }
      case 'reencode_mp3': {
        const taskId = addConversionTask(track.fileName, 'mp3');
        const result = await window.candybar.reencodeTrackFile(track.filePath, true);
        if (result.success) {
          updateConversionTask(taskId, 'completed', result.outputPath);
          removeTrackFromHealthResult(track);
          showToast('success', 'Re-encoded to 320kbps', `${track.fileName}`);
          success = true;
        } else {
          updateConversionTask(taskId, 'failed');
          showToast('error', 'Re-encode Failed', result.errorMessage || 'Unknown error.');
        }
        break;
      }
      case 'archive': {
        const result = await window.candybar.archiveTrackFile(track.filePath);
        if (result.success) {
          removeTrackFromHealthResult(track);
          showToast('success', 'Archived', `${track.fileName}`);
          success = true;
        } else {
          showToast('error', 'Archive Failed', result.errorMessage || 'Unknown error.');
        }
        break;
      }
      case 'delete': {
        const result = await window.candybar.deleteTrackFile(track.filePath);
        if (result.success) {
          removeTrackFromHealthResult(track);
          showToast('success', 'Deleted', `${track.fileName}`);
          success = true;
        } else {
          showToast('error', 'Delete Failed', result.error || 'Unknown error.');
        }
        break;
      }
      case 'populate_tags': {
        await handlePopulateTags(track);
        success = true;
        break;
      }
    }
    if (success) fixFlow!.fixedCount++;
  } catch (err) {
    showToast('error', 'Fix Failed', getErrorMessage(err));
  }

  if (fixFlow) {
    fixFlow.applying = false;
    fixFlowAdvance(1);
  }
}

export function initLibrary(): void {
  // Browse: Columns toggle
  document.getElementById('toggle-columns-panel')?.addEventListener('click', () => {
    columnsPanelOpen = !columnsPanelOpen;
    setColumnsPanelVisibility();
  });

  // Browse: Add column select
  const addSelect = document.getElementById('add-column-select') as HTMLSelectElement | null;
  addSelect?.addEventListener('change', () => {
    const dim = addSelect.value as Dimension;
    if (dim) {
      addColumn(dim);
      addSelect.value = '';
    }
  });

  // Browse: Split toggle
  document.getElementById('toggle-split-panel')?.addEventListener('click', () => {
    splitPanelOpen = !splitPanelOpen;
    const panel = document.getElementById('split-panel');
    const btn   = document.getElementById('toggle-split-panel');
    if (panel) panel.hidden = !splitPanelOpen;
    btn?.classList.toggle('active', splitPanelOpen);
    if (splitPanelOpen) renderSplitPanel();
  });

  // Browse: Split dimension
  const dimSelect = document.getElementById('split-dimension') as HTMLSelectElement | null;
  dimSelect?.addEventListener('change', () => {
    splitDimension = dimSelect.value as Dimension;
    splitSelected = null;
    if (splitPanelOpen) renderSplitPanel();
    renderCompactList();
  });

  // Browse: Search
  const searchInput = document.getElementById('browse-search') as HTMLInputElement | null;
  searchInput?.addEventListener('input', () => {
    searchQuery = searchInput.value.trim().toLowerCase();
    renderCompactList();
  });

  // Service status click handlers
  document.getElementById('spotify-status')?.addEventListener('click', () => {
    void checkSpotifyConnectionFn(true);
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

  // Duplicates drawer toggle
  const toggleDuplicatesDrawer = () => {
    const section = document.getElementById('duplicates-section');
    if (!section) return;
    section.style.display = section.style.display === 'none' ? '' : 'none';
  };
  document.getElementById('toggle-duplicates')?.addEventListener('click', toggleDuplicatesDrawer);
  document.getElementById('duplicates-close')?.addEventListener('click', toggleDuplicatesDrawer);

  // Manual library rescan
  runLibraryScanBtn?.addEventListener('click', () => {
    void autoRefreshLibrary();
  });

  // Wire scan progress events to the inline progress bar + spinner
  window.candybar.onHealthScanProgress(updateScanProgress);

  // Missing Album Art — launch dedicated fix overlay
  document.getElementById('missing-art-mode')?.addEventListener('click', launchAlbumArtFix);

  // Initial render
  renderCompactList();


// ========== Batch Delete (internal, kept for modal confirm) ==========

async function handleBatchDeleteConfirm() {
  if (!pendingBatchDelete) return;
  const tracks = pendingBatchDelete;
  const count = tracks.length;
  pendingBatchDelete = null;
  hideDeleteModal();

  showToast('info', 'Batch Delete', `Deleting ${count} tracks...`);
  let success = 0;
  let failed = 0;

  for (const track of tracks) {
    try {
      const result = await window.candybar.deleteTrackFile(track.filePath);
      if (result.success) {
        removeTrackFromHealthResult(track);
        success++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  syncHealthState();
  rebuildBrowseTracks();
  renderCompactList();
  if (healthResult) renderKpiDashboard(healthResult)();
  clearMultiSelection();

  if (failed > 0) {
    showToast('warning', 'Batch Delete', `${success} deleted, ${failed} failed`);
  } else {
    showToast('success', 'Batch Delete', `${success} tracks deleted`);
  }
}

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
  deleteModalConfirm.addEventListener('click', () => {
    if (pendingBatchDelete) {
      handleBatchDeleteConfirm();
    } else {
      handleDeleteConfirm();
    }
  });

  // Close modals on overlay click
  fixModal.addEventListener('click', (e) => {
    if (e.target === fixModal) hideFixModal();
  });
  deleteModal.addEventListener('click', (e) => {
    if (e.target === deleteModal) hideDeleteModal();
  });
}
