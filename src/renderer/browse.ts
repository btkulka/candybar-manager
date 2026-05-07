// ============================================================
// Browse page
//   - Compact list: always visible, full width
//   - Top columns strip: dynamically add/remove/collapse columns
//   - Left split panel: single-dimension filter list
// ============================================================

import type { LibraryHealthTrack, LibraryHealthResult, HealthIssue } from './shared';

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

// ── Track Data ───────────────────────────────────────────────

let allTracks: BrowseTrack[] = [];

function artColorFromArtist(artist: string): string {
  let hash = 0;
  for (let i = 0; i < artist.length; i++) {
    hash = (hash * 31 + artist.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 28%, 18%)`;
}

function secondsToMMSS(secs: number | null): string {
  if (secs === null) return '—';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Issue metadata ────────────────────────────────────────────

const ISSUE_DESCRIPTIONS: Record<string, string> = {
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
};

const ISSUE_SEVERITIES: Record<string, 'error' | 'warning'> = {
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
};

// ── Browse Summary ────────────────────────────────────────────

function renderBrowseSummary(result: LibraryHealthResult): void {
  const el = document.getElementById('browse-health-summary');
  if (!el) return;

  const { summary } = result;
  const total = summary.total;
  const pct = (n: number) => total > 0 ? `${Math.round((n / total) * 100)}%` : '0%';

  const kpiEl = el.querySelector('.browse-kpi-strip');
  if (kpiEl) {
    kpiEl.innerHTML = `
      <span class="browse-kpi-total"><strong>${total.toLocaleString()}</strong> tracks</span>
      <span class="browse-kpi-sep">·</span>
      <span class="browse-kpi-healthy"><strong>${summary.healthy.toLocaleString()}</strong> healthy <em>${pct(summary.healthy)}</em></span>
      <span class="browse-kpi-sep">·</span>
      <span class="browse-kpi-warnings"><strong>${summary.warnings.toLocaleString()}</strong> warnings <em>${pct(summary.warnings)}</em></span>
      <span class="browse-kpi-sep">·</span>
      <span class="browse-kpi-errors"><strong>${summary.errors.toLocaleString()}</strong> errors <em>${pct(summary.errors)}</em></span>
    `;
  }

  const chips = el.querySelector<HTMLElement>('.browse-issue-chips');
  if (chips) {
    const issueCodes = Object.entries(summary.byIssueCode).sort((a, b) => b[1] - a[1]);
    chips.innerHTML = issueCodes.map(([code, count]) => {
      const sev = ISSUE_SEVERITIES[code] || 'warning';
      const label = ISSUE_DESCRIPTIONS[code] || code;
      const active = activeIssueFilter === code ? ' active' : '';
      return `<button class="browse-issue-chip ${sev}${active}" data-code="${esc(code)}" data-tooltip="Filter to tracks with this issue">${esc(label)} <span>${count}</span></button>`;
    }).join('');

    chips.querySelectorAll<HTMLElement>('.browse-issue-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = btn.dataset.code!;
        activeIssueFilter = activeIssueFilter === code ? null : code;
        chips.querySelectorAll('.browse-issue-chip').forEach(b =>
          b.classList.toggle('active', (b as HTMLElement).dataset.code === activeIssueFilter)
        );
        renderCompactList();
      });
    });
  }

  el.hidden = false;
}

// ── Art Cache ─────────────────────────────────────────────────

const artCache = new Map<string, string | null>();
let artObserver: IntersectionObserver | null = null;

function setupArtLazyLoad(container: HTMLElement): void {
  if (artObserver) artObserver.disconnect();

  artObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target as HTMLImageElement;
      const fp = img.dataset.fp!;
      artObserver!.unobserve(img);

      const wrap = img.parentElement!;
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

  container.querySelectorAll<HTMLImageElement>('img.bv4-art').forEach(img => {
    const fp = img.dataset.fp!;
    const wrap = img.parentElement!;
    if (artCache.has(fp)) {
      const cached = artCache.get(fp);
      wrap.classList.remove('loading');
      if (cached) { img.src = cached; img.style.display = 'block'; }
    } else {
      artObserver!.observe(img);
    }
  });
}

export function loadBrowseData(result: LibraryHealthResult): void {
  artCache.clear();
  activeIssueFilter = null;
  allTracks = result.tracks.map((t, i) => {
    const ext = t.fileName.split('.').pop()?.toUpperCase() ?? '';
    const container = t.format.container?.toUpperCase() ?? ext;
    return {
      id: i + 1,
      filePath: t.filePath,
      hasAlbumArt: t.hasAlbumArt,
      isHealthy: t.isHealthy,
      issues: t.issues,
      title: t.title || t.fileName,
      artist: t.artist,
      album: t.album,
      genre: t.genre,
      year: t.year ?? 0,
      duration: secondsToMMSS(t.format.duration),
      format: container,
      bitrate: t.format.bitRate ?? 0,
      bpm: null,
      artColor: artColorFromArtist(t.artist),
    };
  });
  renderBrowseSummary(result);
  renderCompactList();
  if (columnsPanelOpen) renderColumnStrip();
  if (splitPanelOpen) renderSplitPanel();
}

// ── State ─────────────────────────────────────────────────────

let searchQuery = '';
let columnsPanelOpen = false;
let columns: BrowseColumn[] = [];

let splitPanelOpen = false;
let splitDimension: Dimension = 'artist';
let splitSelected: string | null = null;

let activeIssueFilter: string | null = null;

// ── Helpers ───────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unique<T>(arr: T[]): T[] { return [...new Set(arr)]; }

const DIM_LABELS: Record<Dimension, string> = {
  artist: 'Artist', album: 'Album', genre: 'Genre',
  format: 'Format', bpm: 'BPM Range', year: 'Year',
};

function bpmRange(bpm: number | null): string {
  if (bpm === null) return 'Unknown';
  const low = Math.floor(bpm / 10) * 10;
  return `${low}–${low + 9}`;
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

// ── Filtering ─────────────────────────────────────────────────

function applyAllFilters(): BrowseTrack[] {
  let tracks = allTracks;

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    tracks = tracks.filter(t =>
      t.title.toLowerCase().includes(q) ||
      t.artist.toLowerCase().includes(q) ||
      t.album.toLowerCase().includes(q)
    );
  }

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

  // Issue type filter (from summary chips)
  if (activeIssueFilter !== null) {
    tracks = tracks.filter(t => t.issues.some(i => i.code === activeIssueFilter));
  }

  return tracks;
}

// ── Compact List ──────────────────────────────────────────────

function artThumb(t: BrowseTrack): string {
  const cachedSrc = artCache.get(t.filePath);
  const loaded = t.hasAlbumArt && cachedSrc != null;
  const loading = t.hasAlbumArt && !loaded;
  const imgAttrs = loaded ? `src="${esc(cachedSrc!)}" style="display:block"` : 'style="display:none"';
  const inner = t.hasAlbumArt
    ? `<img class="bv4-art" data-fp="${esc(t.filePath)}" ${imgAttrs} alt="">`
    : '';
  return `<div class="bv4-art-wrap${loading ? ' loading' : ''}" style="background:${esc(t.artColor)}">${inner}</div>`;
}

function healthDot(t: BrowseTrack): string {
  if (t.isHealthy) return '';
  const hasError = t.issues.some(i => (ISSUE_SEVERITIES[i.code] ?? i.severity) === 'error');
  const cls = hasError ? 'error' : 'warning';
  const tooltip = t.issues.map(i => ISSUE_DESCRIPTIONS[i.code] || i.code).join(', ');
  return `<span class="bv4-health-dot ${cls}" title="${esc(tooltip)}"></span>`;
}

function rowHealthClass(t: BrowseTrack): string {
  if (t.isHealthy) return '';
  const hasError = t.issues.some(i => (ISSUE_SEVERITIES[i.code] ?? i.severity) === 'error');
  return hasError ? ' has-error' : ' has-warning';
}

function renderCompactList(): void {
  const list = document.getElementById('browse-compact-list');
  if (!list) return;
  const tracks = applyAllFilters();
  list.innerHTML = tracks.map((t, i) => `
    <div class="bv4-row${rowHealthClass(t)}" data-id="${t.id}">
      <span class="bv4-num">${i + 1}</span>
      ${artThumb(t)}
      <div class="bv4-title-group">
        <span class="bv4-title">${esc(t.title)}</span>
      </div>
      <span class="bv4-artist">${esc(t.artist)}</span>
      <div class="bv4-right">
        ${healthDot(t)}
        ${formatBadge(t.format)}
        <span class="bv4-bpm">${t.bpm ?? '—'}</span>
        <span class="bv4-dur">${esc(t.duration)}</span>
      </div>
    </div>
  `).join('') || '<div class="browse-empty">No tracks found.</div>';

  setupArtLazyLoad(list);
}

// ── Column Strip ──────────────────────────────────────────────

function renderColumnStrip(): void {
  const strip = document.getElementById('browse-column-strip');
  if (!strip) return;

  strip.innerHTML = '';

  columns.forEach((col, i) => {
    const values = unique(allTracks.map(t => dimValue(t, col.dim))).sort();
    const all = ['All', ...values];

    const el = document.createElement('div');
    el.className = `browse-column${col.collapsed ? ' collapsed' : ''}`;
    el.dataset.idx = String(i);

    // Collapse SVG: chevron down when expanded, right when collapsed
    const chevronPath = col.collapsed
      ? '<polyline points="9 18 15 12 9 6"/>'
      : '<polyline points="6 9 12 15 18 9"/>';

    el.innerHTML = `
      <div class="browse-column-header">
        <span class="browse-column-label">${esc(DIM_LABELS[col.dim])}</span>
        <div class="browse-column-btns">
          <button class="browse-column-btn col-collapse-btn" data-tooltip="${col.collapsed ? 'Expand' : 'Collapse'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${chevronPath}</svg>
          </button>
          <button class="browse-column-btn col-remove-btn" data-tooltip="Remove column">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>
      <ul class="browse-column-list">
        ${all.map(v => {
          const isAll = v === 'All';
          const active = isAll ? col.selected === null : col.selected === v;
          return `<li class="browse-col-item${active ? ' active' : ''}" data-val="${isAll ? '' : esc(v)}">${esc(v)}</li>`;
        }).join('')}
      </ul>
    `;

    // Collapse/expand
    el.querySelector('.col-collapse-btn')?.addEventListener('click', () => {
      columns[i].collapsed = !columns[i].collapsed;
      renderColumnStrip();
    });

    // Remove
    el.querySelector('.col-remove-btn')?.addEventListener('click', () => {
      columns.splice(i, 1);
      renderColumnStrip();
      renderCompactList();
    });

    // Item selection
    el.querySelectorAll('.browse-col-item').forEach(item => {
      item.addEventListener('click', () => {
        const val = (item as HTMLElement).dataset.val || null;
        columns[i].selected = val;
        renderColumnStrip();
        renderCompactList();
      });
    });

    strip.appendChild(el);
  });
}

// ── Split Panel ───────────────────────────────────────────────

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

// ── Column Panel Visibility ───────────────────────────────────

function setColumnsPanelVisibility(): void {
  const area = document.getElementById('browse-columns-area') as HTMLElement | null;
  const btn  = document.getElementById('toggle-columns-panel');
  if (!area) return;
  area.hidden = !columnsPanelOpen;
  btn?.classList.toggle('active', columnsPanelOpen);
  if (columnsPanelOpen) renderColumnStrip();
}

// ── Add Column ────────────────────────────────────────────────

function addColumn(dim: Dimension): void {
  columns.push({ dim, selected: null, collapsed: false });
  renderColumnStrip();
  renderCompactList();
}

// ── Init ─────────────────────────────────────────────────────

export function initBrowse(): void {
  // Columns toggle
  document.getElementById('toggle-columns-panel')?.addEventListener('click', () => {
    columnsPanelOpen = !columnsPanelOpen;
    setColumnsPanelVisibility();
  });

  // Add column select
  const addSelect = document.getElementById('add-column-select') as HTMLSelectElement | null;
  addSelect?.addEventListener('change', () => {
    const dim = addSelect.value as Dimension;
    if (dim) {
      addColumn(dim);
      addSelect.value = ''; // reset to placeholder
    }
  });

  // Split toggle
  document.getElementById('toggle-split-panel')?.addEventListener('click', () => {
    splitPanelOpen = !splitPanelOpen;
    const panel = document.getElementById('split-panel');
    const btn   = document.getElementById('toggle-split-panel');
    if (panel) panel.hidden = !splitPanelOpen;
    btn?.classList.toggle('active', splitPanelOpen);
    if (splitPanelOpen) renderSplitPanel();
  });

  // Split dimension
  const dimSelect = document.getElementById('split-dimension') as HTMLSelectElement | null;
  dimSelect?.addEventListener('change', () => {
    splitDimension = dimSelect.value as Dimension;
    splitSelected = null;
    if (splitPanelOpen) renderSplitPanel();
    renderCompactList();
  });

  // Search
  const searchInput = document.getElementById('browse-search') as HTMLInputElement | null;
  searchInput?.addEventListener('input', () => {
    searchQuery = searchInput.value.trim().toLowerCase();
    renderCompactList();
  });

  // Initial render
  renderCompactList();
}
