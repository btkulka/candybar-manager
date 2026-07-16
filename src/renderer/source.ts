import type { QobuzCartMatch } from '../lib/qobuzCart';
import type { CsvPreview, StoreMatch, LibraryMatchedRow, LibraryProbableRow, SourcePlaylistInfo } from '../types';
import { showToast, setStatus, escapeHtml, setValue, getErrorMessage } from './shared';
import { Wizard } from './wizard';
import { renderSourceInput } from './sourceInputTemplate';
import { exportM3u8, exportRekordbox, exportCsv } from './libraryExport';

// ========== DOM Elements ==========
// Late-bound refs live inside the source lane (injected at init).

let wizard: Wizard;
let runSearchBtn: HTMLButtonElement;

const progressSection = document.getElementById('source-progress-section') as HTMLElement;
const progressBar = document.getElementById('source-progress-bar') as HTMLDivElement;
const progressMessage = document.getElementById('source-progress-message') as HTMLSpanElement;
const progressCount = document.getElementById('source-progress-count') as HTMLSpanElement;

const resultsSection = document.getElementById('source-results-section') as HTMLElement;
const groupsContainer = document.getElementById('source-groups') as HTMLDivElement;
const emptyState = document.getElementById('source-empty') as HTMLDivElement;
const scanSummary = document.getElementById('source-scan-summary') as HTMLDivElement;

// Segment counts — the merged summary + filter control replaces the old
// duplicate stats row + store tabs.
const segCountNew = document.getElementById('seg-count-new') as HTMLSpanElement;
const segCountMaybe = document.getElementById('seg-count-maybe') as HTMLSpanElement;
const segCountOwned = document.getElementById('seg-count-owned') as HTMLSpanElement;
const segCountNotFound = document.getElementById('seg-count-notfound') as HTMLSpanElement;

const searchInput = document.getElementById('source-search') as HTMLInputElement;

// Sticky buy-bar (replaces the flat filter-bar action row + separate cart lane)
const buyBar = document.getElementById('source-buybar') as HTMLElement;
const buyBarN = document.getElementById('source-buybar-n') as HTMLElement;
const buyBarQobuz = document.getElementById('source-buybar-qobuz') as HTMLElement;
const buyBarBeatport = document.getElementById('source-buybar-beatport') as HTMLElement;
const reviewCartBtn = document.getElementById('source-review-cart') as HTMLButtonElement;
const addMoreBtn = document.getElementById('source-add-more') as HTMLButtonElement;
const addToCartBtn = document.getElementById('source-add-to-cart') as HTMLButtonElement;
const exportCsvBtn = document.getElementById('source-export-csv') as HTMLButtonElement;
const clearResultsBtn = document.getElementById('clear-source-results') as HTMLButtonElement;

// Cart slide-over (replaces the wizard's Cart lane)
const cartDrawer = document.getElementById('source-cart-drawer') as HTMLElement;
const cartScrim = document.getElementById('source-cart-scrim') as HTMLElement;
const cartCloseBtn = document.getElementById('source-cart-close') as HTMLButtonElement;
const openQobuzCartBtn = document.getElementById('source-open-qobuz-cart') as HTMLButtonElement;
const openBeatportCartBtn = document.getElementById('source-open-beatport-cart') as HTMLButtonElement;
const downloadPurchasesBtn = document.getElementById('source-download-purchases') as HTMLButtonElement;

// Cart lane refs
const cartSection = document.getElementById('source-cart-section') as HTMLElement;
const cartQobuzBlock = document.getElementById('source-cart-qobuz') as HTMLElement;
const cartQobuzList = document.getElementById('source-cart-qobuz-list') as HTMLDivElement;
const cartQobuzCount = document.getElementById('source-cart-qobuz-count') as HTMLSpanElement;
const cartQobuzTotal = document.getElementById('source-cart-qobuz-total') as HTMLElement;
const cartBeatportBlock = document.getElementById('source-cart-beatport') as HTMLElement;
const cartBeatportList = document.getElementById('source-cart-beatport-list') as HTMLDivElement;
const cartBeatportCount = document.getElementById('source-cart-beatport-count') as HTMLSpanElement;
const cartBeatportTotal = document.getElementById('source-cart-beatport-total') as HTMLElement;
const autoCheckoutQobuzBtn = document.getElementById('source-auto-checkout-qobuz') as HTMLButtonElement;
const autoCheckoutBeatportBtn = document.getElementById('source-auto-checkout-beatport') as HTMLButtonElement;

// Cart-add inline progress (shown during storeCartAdd IPC so user can see per-track progress)
const cartAddProgress = document.getElementById('source-cart-add-progress') as HTMLElement;
const cartAddStore = document.getElementById('source-cart-add-store') as HTMLElement;
const cartAddCount = document.getElementById('source-cart-add-count') as HTMLElement;
const cartAddBar = document.getElementById('source-cart-add-bar') as HTMLElement;
const cartAddMessage = document.getElementById('source-cart-add-message') as HTMLElement;

// Late-bound: all CSV/Spotify picker elements are injected at init time
let csvDropZone: HTMLDivElement;
let csvFileDisplay: HTMLDivElement;
let csvPreviewSection: HTMLDivElement;
let csvPreviewCount: HTMLSpanElement;
let csvPreviewColumns: HTMLSpanElement;
let csvPreviewThead: HTMLTableSectionElement;
let csvPreviewTbody: HTMLTableSectionElement;
let csvFileName: HTMLSpanElement;
let clearCsvBtn: HTMLButtonElement;
let sourceTypeToggle: HTMLDivElement;
let csvField: HTMLDivElement;
let spotifyField: HTMLDivElement;
let spotifyUrlInput: HTMLInputElement;
let spotifyUrlStatus: HTMLSpanElement;

// ========== State ==========

let matches: QobuzCartMatch[] = [];
/** Library phase-1 buckets from `library-sourcing:run`. `matched` = already in
 *  library (filtered out of store search), `probable` = uncertain library hit
 *  (store-searched AND displayed with a "probable library match" chip). Set
 *  to null when the search hasn't been run yet. */
let libraryMatched: LibraryMatchedRow[] = [];
let libraryProbable: LibraryProbableRow[] = [];
/** Metadata of the last-imported Spotify playlist, shown as a cover-art card. */
let currentPlaylistInfo: SourcePlaylistInfo | null = null;
type Segment = 'new' | 'maybe' | 'owned' | 'notfound';
let activeSegment: Segment = 'new';
let searchQuery = '';
let csvPath = '';
let sourceType: 'csv' | 'spotify' = 'csv';
let spotifyPlaylistUrl = '';
let spotifyUrlValid = false;
let selectedQobuzIds: Set<string> = new Set();
let selectedBeatportIds: Set<string> = new Set();
/** When true, the next runSearch() merges its results into the existing
 *  matches array instead of replacing it. Toggled by "+ Add More Tracks". */
let appendMode = false;
/** Tracks we added to each store's cart during the current Sources session.
 *  Used to auto-trigger downloads when the user completes checkout in the
 *  embedded store panel. */
let lastAddedQobuz: StoreMatch[] = [];
let lastAddedBeatport: StoreMatch[] = [];
let downloadFiredQobuz = false;
let downloadFiredBeatport = false;

function sourceLaneSummary(): { text: string; detail?: string } {
  if (sourceType === 'spotify' && spotifyPlaylistUrl) {
    return { text: 'Spotify playlist', detail: spotifyPlaylistUrl };
  }
  if (csvPath) {
    return { text: csvPath.split('/').pop() || csvPath };
  }
  return { text: '—' };
}

/** Parse a display price like "$2.99", "€1.29", "1.79 USD" into a number.
 *  Anything unparseable returns 0 so a missing price doesn't break the total. */
function parsePriceDollars(raw: string | null | undefined): number {
  if (!raw) return 0;
  const m = raw.replace(/,/g, '.').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

function renderCartLines(container: HTMLDivElement, tracks: StoreMatch[]) {
  container.innerHTML = '';
  for (const t of tracks) {
    const line = document.createElement('div');
    line.className = 'cart-line';
    const price = t.price ? escapeHtml(t.price) : '—';
    const art = t.image
      ? `<img class="cart-line-art" src="${escapeHtml(t.image)}" alt="" loading="lazy" />`
      : `<div class="cart-line-art cart-line-art--placeholder"></div>`;
    line.innerHTML = `
      ${art}
      <div class="cart-line-title">
        ${escapeHtml(t.title)}
        <span class="cart-line-artist"> — ${escapeHtml(t.artist)}</span>
      </div>
      <span class="cart-line-price">${price}</span>
    `;
    // Art fallback in case the CDN URL 404s
    const img = line.querySelector<HTMLImageElement>('img.cart-line-art');
    if (img) {
      img.addEventListener('error', () => {
        const placeholder = document.createElement('div');
        placeholder.className = 'cart-line-art cart-line-art--placeholder';
        img.replaceWith(placeholder);
      }, { once: true });
    }
    container.appendChild(line);
  }
}

function cartLaneSummary(): { text: string; detail?: string } {
  const q = lastAddedQobuz.length;
  const b = lastAddedBeatport.length;
  const qTotal = lastAddedQobuz.reduce((s, t) => s + parsePriceDollars(t.price), 0);
  const bTotal = lastAddedBeatport.reduce((s, t) => s + parsePriceDollars(t.price), 0);
  const parts: string[] = [];
  if (q) parts.push(`${q} Qobuz`);
  if (b) parts.push(`${b} Beatport`);
  const total = qTotal + bTotal;
  return { text: parts.join(' + ') || 'no tracks', detail: total > 0 ? `$${total.toFixed(2)}` : undefined };
}

function renderCartStage() {
  const qTracks = lastAddedQobuz;
  const bTracks = lastAddedBeatport;

  if (qTracks.length > 0) {
    cartQobuzBlock.style.display = '';
    cartQobuzCount.textContent = `${qTracks.length} ${qTracks.length === 1 ? 'track' : 'tracks'}`;
    const total = qTracks.reduce((s, t) => s + parsePriceDollars(t.price), 0);
    cartQobuzTotal.textContent = `$${total.toFixed(2)}`;
    renderCartLines(cartQobuzList, qTracks);
  } else {
    cartQobuzBlock.style.display = 'none';
  }

  if (bTracks.length > 0) {
    cartBeatportBlock.style.display = '';
    cartBeatportCount.textContent = `${bTracks.length} ${bTracks.length === 1 ? 'track' : 'tracks'}`;
    const total = bTracks.reduce((s, t) => s + parsePriceDollars(t.price), 0);
    cartBeatportTotal.textContent = `$${total.toFixed(2)}`;
    renderCartLines(cartBeatportList, bTracks);
  } else {
    cartBeatportBlock.style.display = 'none';
  }

  cartSection.style.display = (qTracks.length + bTracks.length) > 0 ? 'flex' : 'none';
}

function searchLaneSummary(list: QobuzCartMatch[]): { text: string; detail?: string } {
  const qobuzCount = list.filter(m => m.source === 'qobuz').length;
  const beatportCount = list.filter(m => m.source === 'beatport').length;
  const notFoundCount = list.filter(m => m.status !== 'matched').length;
  const parts: string[] = [];
  if (qobuzCount) parts.push(`${qobuzCount} Qobuz`);
  if (beatportCount) parts.push(`${beatportCount} Beatport`);
  if (notFoundCount) parts.push(`${notFoundCount} not found`);
  return { text: parts.join(' · ') || 'no matches', detail: `${list.length} tracks` };
}

// ========== Source Type Toggle ==========

let csvHasRequiredCols = false;

function updateRunButton() {
  if (sourceType === 'csv') {
    runSearchBtn.disabled = !csvPath || !csvHasRequiredCols;
  } else {
    runSearchBtn.disabled = !spotifyUrlValid;
  }
}

function setSourceType(type: 'csv' | 'spotify') {
  sourceType = type;
  sourceTypeToggle.querySelectorAll('.source-type-btn').forEach(btn => {
    btn.classList.toggle('active', (btn as HTMLButtonElement).dataset.sourceType === type);
  });
  csvField.style.display = type === 'csv' ? '' : 'none';
  spotifyField.style.display = type === 'spotify' ? '' : 'none';
  csvPreviewSection.style.display = type === 'csv' && csvPath && csvHasRequiredCols ? 'block' : 'none';
  updateRunButton();
}

function validateSpotifyUrl(url: string) {
  spotifyPlaylistUrl = url.trim();
  if (!spotifyPlaylistUrl) {
    spotifyUrlStatus.textContent = '';
    spotifyUrlStatus.className = 'spotify-url-status';
    spotifyUrlValid = false;
    updateRunButton();
    return;
  }

  spotifyUrlValid = /open\.spotify\.com\/playlist\/[a-zA-Z0-9]+/.test(spotifyPlaylistUrl)
    || /^spotify:playlist:[a-zA-Z0-9]+$/.test(spotifyPlaylistUrl)
    || /^[a-zA-Z0-9]{22}$/.test(spotifyPlaylistUrl);

  spotifyUrlStatus.textContent = spotifyUrlValid ? '\u2713' : '\u2717';
  spotifyUrlStatus.className = `spotify-url-status ${spotifyUrlValid ? 'valid' : 'invalid'}`;
  updateRunButton();
}

// ========== CSV Handling ==========

function renderCsvPreview(preview: CsvPreview) {
  csvPreviewCount.textContent = `${preview.totalRows} rows`;
  csvPreviewColumns.textContent = `${preview.columns.length} columns`;

  const artistColumns = ['artist', 'artists', 'performer'];
  const titleColumns = ['title', 'track', 'name', 'song'];

  csvPreviewThead.innerHTML = `<tr>${preview.columns.map(col => {
    const lower = col.toLowerCase().trim();
    const isKey = artistColumns.includes(lower) || titleColumns.includes(lower);
    return `<th class="${isKey ? 'required' : ''}">${escapeHtml(col)}</th>`;
  }).join('')}</tr>`;

  csvPreviewTbody.innerHTML = preview.rows.map(row =>
    `<tr>${preview.columns.map(col => `<td>${escapeHtml(row[col] || '')}</td>`).join('')}</tr>`
  ).join('');

  csvHasRequiredCols = preview.hasArtistColumn && preview.hasTitleColumn;
  csvPreviewSection.style.display = 'block';
  updateRunButton();
}

function hideCsvPreview() {
  csvPreviewSection.style.display = 'none';
  csvPreviewThead.innerHTML = '';
  csvPreviewTbody.innerHTML = '';
  csvHasRequiredCols = false;
  updateRunButton();
}

/** Restore a persisted Spotify playlist URL from config on app startup.
 *  Hydrates the input field, flips sourceType to 'spotify', and re-runs
 *  URL validation so the Run button wakes up correctly. */
export function restoreSourceSpotifyUrl(url: string) {
  if (!url) return;
  if (spotifyUrlInput) spotifyUrlInput.value = url;
  setSourceType('spotify');
  validateSpotifyUrl(url);
}

export async function setSourceCsvFile(filePath: string) {
  csvPath = filePath;
  setValue('source-csv', filePath);
  const name = filePath.split('/').pop() || filePath;
  csvFileName.textContent = name;
  csvDropZone.classList.add('has-file');

  try {
    const preview = await window.candybar.previewCsv(filePath);
    renderCsvPreview(preview);
  } catch (err) {
    console.error('Failed to preview CSV:', err);
    hideCsvPreview();
  }
}

function clearCsvFile() {
  csvPath = '';
  setValue('source-csv', '');
  csvFileName.textContent = '';
  csvDropZone.classList.remove('has-file');
  hideCsvPreview();
}

// ========== Results Rendering ==========

/** Shared search-filter predicate for a store match. */
function matchesSearch(m: QobuzCartMatch): boolean {
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  const input = `${m.trackInput.artist} ${m.trackInput.title}`.toLowerCase();
  const found = m.qobuzTrack
    ? `${m.qobuzTrack.artists.join(' ')} ${m.qobuzTrack.name}`.toLowerCase()
    : m.beatportTrack
      ? `${m.beatportTrack.artists.join(' ')} ${m.beatportTrack.name}`.toLowerCase()
      : '';
  return input.includes(q) || found.includes(q);
}

/** Store matches belonging to a store-backed segment.
 *   - new:      not in library + a store match was found (the buyable tracks)
 *   - maybe:    a probable library hit, but a store match exists to buy anyway
 *   - notfound: searched, but no lossless store match came back */
function segmentMatches(seg: 'new' | 'maybe' | 'notfound'): QobuzCartMatch[] {
  return matches.filter(m => {
    if (!matchesSearch(m)) return false;
    if (seg === 'notfound') return m.status !== 'matched';
    if (seg === 'maybe') return m.status === 'matched' && m.libraryStatus === 'probable';
    return m.status === 'matched' && m.libraryStatus !== 'probable';
  });
}

/** Small inline check icon for the fake row checkboxes. */
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';

function emptyRow(text: string): HTMLElement {
  const d = document.createElement('div');
  d.className = 'empty-state';
  d.innerHTML = `<p>${escapeHtml(text)}</p>`;
  return d;
}

/** Swap a failed <img> cover for a placeholder <div>. Qobuz covers are
 *  constructed from the album id and occasionally 404, which would otherwise
 *  render as a broken-image icon. Handles both the results list and the
 *  recent-matches preview. */
function attachArtFallback(root: HTMLElement) {
  root.querySelectorAll<HTMLImageElement>('img.source-result-art, img.recent-art').forEach((img) => {
    const baseClass = img.classList.contains('recent-art') ? 'recent-art' : 'source-result-art';
    img.addEventListener('error', () => {
      const placeholder = document.createElement('div');
      placeholder.className = `${baseClass} ${baseClass}--placeholder`;
      img.replaceWith(placeholder);
    }, { once: true });
  });
}

/**
 * Build (or update) the Spotify playlist card — cover art, name, track count,
 * owner — reusing a single `#source-playlist-card` element so it can be moved
 * between the progress and results sections without losing identity.
 */
function buildPlaylistCard(info: SourcePlaylistInfo): HTMLElement {
  let card = document.getElementById('source-playlist-card') as HTMLElement | null;
  if (!card) {
    card = document.createElement('div');
    card.id = 'source-playlist-card';
    card.className = 'source-playlist-card';
  }
  const art = info.imageUrl
    ? `<img class="source-playlist-art" src="${escapeHtml(info.imageUrl)}" alt="" loading="lazy" />`
    : `<div class="source-playlist-art source-playlist-art--placeholder"></div>`;
  // Show fetched vs total when some tracks were local/unavailable and skipped.
  const countLabel = info.fetchedCount < info.trackCount
    ? `${info.fetchedCount} of ${info.trackCount} tracks`
    : `${info.trackCount} ${info.trackCount === 1 ? 'track' : 'tracks'}`;
  card.innerHTML = `
    ${art}
    <div class="source-playlist-meta">
      <div class="source-playlist-name">${escapeHtml(info.name)}</div>
      <div class="source-playlist-sub">${escapeHtml(countLabel)}${info.owner ? ` · ${escapeHtml(info.owner)}` : ''}</div>
    </div>
    <div class="source-playlist-badge">Spotify</div>
  `;
  card.querySelector<HTMLImageElement>('img.source-playlist-art')?.addEventListener('error', function () {
    const ph = document.createElement('div');
    ph.className = 'source-playlist-art source-playlist-art--placeholder';
    this.replaceWith(ph);
  }, { once: true });
  return card;
}

/** Show the playlist card at the top of the progress hero (during the scan). */
function showPlaylistCard(info: SourcePlaylistInfo) {
  currentPlaylistInfo = info;
  const card = buildPlaylistCard(info);
  progressSection.insertBefore(card, progressSection.firstChild);
}

/** Once results are shown, move the same card above the results summary. */
function movePlaylistCardToResults() {
  if (!currentPlaylistInfo) return;
  const card = document.getElementById('source-playlist-card');
  if (card) resultsSection.insertBefore(card, resultsSection.firstChild);
}

/** Drop the card on a fresh (replace-mode) run so a new import starts clean. */
function clearPlaylistCard() {
  currentPlaylistInfo = null;
  document.getElementById('source-playlist-card')?.remove();
}

// ---------- Sources state persistence (survives HMR / renderer reloads) ----------
// A Vite HMR update in dev does a full renderer reload, which wipes all the
// module state above and re-renders the DOM from scratch — losing an entire
// search you were mid-review on. We snapshot the reviewable state into
// sessionStorage (per-window, cleared on app quit) and rehydrate it on init so a
// code edit doesn't cost you the whole run. Cheap enough to leave on always.
const SOURCES_STATE_KEY = 'candybar:sources-state:v1';

function saveSourcesState() {
  try {
    const snapshot = {
      matches,
      libraryMatched,
      libraryProbable,
      playlistInfo: currentPlaylistInfo,
      selectedQobuz: [...selectedQobuzIds],
      selectedBeatport: [...selectedBeatportIds],
      sourceType,
      spotifyPlaylistUrl,
      csvPath,
      segment: activeSegment,
      searchQuery,
      resultsShown: resultsSection.style.display === 'block'
    };
    sessionStorage.setItem(SOURCES_STATE_KEY, JSON.stringify(snapshot));
  } catch {
    // sessionStorage unavailable or over quota — non-fatal, just skip persistence.
  }
}

function restoreSourcesState() {
  let snapshot: ReturnType<typeof JSON.parse> | null = null;
  try {
    const raw = sessionStorage.getItem(SOURCES_STATE_KEY);
    if (!raw) return;
    snapshot = JSON.parse(raw);
  } catch {
    return;
  }
  if (!snapshot) return;

  matches = snapshot.matches ?? [];
  libraryMatched = snapshot.libraryMatched ?? [];
  libraryProbable = snapshot.libraryProbable ?? [];
  currentPlaylistInfo = snapshot.playlistInfo ?? null;
  selectedQobuzIds = new Set(snapshot.selectedQobuz ?? []);
  selectedBeatportIds = new Set(snapshot.selectedBeatport ?? []);
  activeSegment = snapshot.segment ?? 'new';
  searchQuery = snapshot.searchQuery ?? '';

  // Restore the input row (source type + pasted Spotify URL, or the CSV file so
  // the source lane summary + Run button survive an HMR reload).
  if (snapshot.sourceType === 'spotify') {
    setSourceType('spotify');
    if (snapshot.spotifyPlaylistUrl && spotifyUrlInput) {
      spotifyUrlInput.value = snapshot.spotifyPlaylistUrl;
      validateSpotifyUrl(snapshot.spotifyPlaylistUrl);
    }
  } else if (snapshot.csvPath) {
    void setSourceCsvFile(snapshot.csvPath);
  }
  if (searchInput) searchInput.value = searchQuery;

  const hasResults = matches.length > 0 || libraryMatched.length > 0 || libraryProbable.length > 0;
  if (!snapshot.resultsShown || !hasResults) return;

  // Rebuild the results view exactly as runSearch() leaves it.
  resultsSection.style.display = 'block';
  if (currentPlaylistInfo) {
    const card = buildPlaylistCard(currentPlaylistInfo);
    resultsSection.insertBefore(card, resultsSection.firstChild);
  }
  updateSegmentCounts();
  setActiveSegment(activeSegment);
  updateBuyBar();
  wizard.setDone('source', sourceLaneSummary());
  wizard.setDone('search', searchLaneSummary(matches));
  wizard.setActive('review');
}

/**
 * Build (or refresh) the two library-phase-1 sections that sit above the
 * store-match grid: "Already in library" (with M3U8/Rekordbox/CSV exports)
 * and "Probably in library" (per-row treat-as-missing toggle). Rendered into
 * a dynamically-inserted `#source-library-sections` container so the existing
 * HTML doesn't need to change.
 */
/** "Maybe already owned" group — a related version is in the library, but a
 *  store match exists so the user can buy the specific mix anyway. */
function renderMaybeGroup(): HTMLElement {
  const list = segmentMatches('maybe');
  const probableByKey = new Map<string, LibraryProbableRow>(
    libraryProbable.map(r => [`${r.artist.toLowerCase()} - ${r.title.toLowerCase()}`, r])
  );
  const group = document.createElement('div');
  group.className = 'source-group';
  group.innerHTML = `
    <div class="source-group-head">
      <span class="source-group-title">Maybe already owned</span>
      <span class="source-group-desc">A related version is in your library. Buy anyway if it's a different mix you want.</span>
    </div>`;
  if (list.length === 0) {
    group.appendChild(emptyRow(searchQuery ? `No tracks match "${searchQuery}".` : 'Nothing flagged as maybe-owned.'));
    return group;
  }
  const ul = document.createElement('div');
  ul.className = 'source-group-list';
  for (const m of list) {
    const p = probableByKey.get(m.trackInput.key);
    const suspected = p
      ? `you may own <span class="own">${escapeHtml(p.suspectedFileArtist)} — ${escapeHtml(p.suspectedFileTitle)}</span> · ${Math.round(p.confidence * 100)}% match`
      : 'a similar track is already in your library';
    const row = document.createElement('div');
    row.className = 'src-row info';
    row.innerHTML = `
      <div class="src-trk">
        <span class="t">${escapeHtml(m.trackInput.artist)} — ${escapeHtml(m.trackInput.title)}</span>
        <span class="sub">${suspected}</span>
      </div>
      <button class="btn-primary btn-sm src-buy-anyway" data-tooltip="Treat as new and allow it into the cart">Buy anyway</button>`;
    row.querySelector('.src-buy-anyway')?.addEventListener('click', () => treatProbableAsMissing(m.trackInput.key));
    ul.appendChild(row);
  }
  group.appendChild(ul);
  return group;
}

/** "Already in library" group — confirmed duplicates, plus the playlist-export
 *  actions (M3U8 / Rekordbox / CSV) which belong to the owned set. */
function renderOwnedGroup(): HTMLElement {
  const q = searchQuery.toLowerCase();
  const rows = libraryMatched.filter(r => !q || `${r.artist} ${r.title}`.toLowerCase().includes(q));
  const group = document.createElement('div');
  group.className = 'source-group';
  group.innerHTML = `
    <div class="source-group-head">
      <span class="source-group-title">Already in library</span>
      <span class="source-group-desc">Confirmed duplicates — nothing to buy.</span>
      <div class="source-group-actions">
        <button class="btn-sm btn-ghost" id="src-export-m3u8" data-tooltip="Export these as an M3U8 playlist">Export M3U8</button>
        <button class="btn-sm btn-ghost" id="src-export-rbxml" data-tooltip="Export these as a Rekordbox XML">Export Rekordbox</button>
        <button class="btn-sm btn-ghost" id="src-export-owned-csv" data-tooltip="Export these as CSV">Export CSV</button>
      </div>
    </div>`;
  if (rows.length === 0) {
    group.appendChild(emptyRow(searchQuery ? `No tracks match "${searchQuery}".` : 'No owned matches.'));
  } else {
    const ul = document.createElement('div');
    ul.className = 'source-group-list';
    for (const r of rows.slice(0, 200)) {
      const file = r.filePath.split('/').pop() || r.filePath;
      const row = document.createElement('div');
      row.className = 'src-row info';
      row.innerHTML = `
        <div class="src-trk">
          <span class="t">${escapeHtml(r.artist)} — ${escapeHtml(r.title)}</span>
          <span class="sub own" title="${escapeHtml(r.filePath)}">→ ${escapeHtml(file)}</span>
        </div>`;
      ul.appendChild(row);
    }
    group.appendChild(ul);
    if (rows.length > 200) group.appendChild(emptyRow(`+ ${rows.length - 200} more`));
  }
  // Export the same (filtered) rows the user is looking at, not the full set.
  group.querySelector('#src-export-m3u8')?.addEventListener('click', () => void exportM3u8(rows));
  group.querySelector('#src-export-rbxml')?.addEventListener('click', () => void exportRekordbox(rows));
  group.querySelector('#src-export-owned-csv')?.addEventListener('click', () => void exportCsv(
    rows.map(r => ({ artist: r.artist, title: r.title, album: r.album, genre: r.genre })),
    'library-matched'
  ));
  return group;
}

/**
 * Flip a "probably in library" row into the sourcing list. Re-runs the
 * lossless auto-select against the corresponding store match so a confident
 * match gets auto-checked the moment it moves buckets.
 */
function treatProbableAsMissing(inputKey: string) {
  libraryProbable = libraryProbable.filter(r =>
    `${r.artist.toLowerCase()} - ${r.title.toLowerCase()}` !== inputKey
  );
  for (const m of matches) {
    if (m.trackInput.key !== inputKey) continue;
    m.libraryStatus = 'missing';
    m.libraryMatchPath = undefined;
    m.libraryMatchConfidence = undefined;
    m.inLibrary = false;
    // Auto-select if the existing match clears the lossless ≥75% bar.
    if (m.confidence >= 0.75 && m.lossless) {
      if (m.source === 'qobuz' && m.qobuzTrack) selectedQobuzIds.add(m.qobuzTrack.id);
      else if (m.source === 'beatport' && m.beatportTrack) selectedBeatportIds.add(m.beatportTrack.id);
    }
  }
  updateSegmentCounts();
  setActiveSegment('new'); // jump to "New to buy" so the promoted track is visible
  updateBuyBar();
}

/** Build one clean, selectable track row for the New / Not-found groups. */
function buildTrackRow(match: QobuzCartMatch): HTMLElement {
  const el = document.createElement('div');
  el.className = 'src-row';
  const pct = Math.round(match.confidence * 100);
  const pctHtml = `<span class="src-pct ${pct >= 90 ? 'hi' : 'mid'}" title="Match confidence">${pct}%</span>`;

  const bindToggle = (id: string, set: Set<string>) => {
    el.tabIndex = 0;
    el.setAttribute('role', 'checkbox');
    el.setAttribute('aria-checked', String(set.has(id)));
    const toggle = () => {
      const on = !el.classList.contains('sel');
      el.classList.toggle('sel', on);
      el.setAttribute('aria-checked', String(on));
      if (on) set.add(id); else set.delete(id);
      updateBuyBar();
    };
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  };

  if (match.source === 'qobuz' && match.qobuzTrack) {
    const qt = match.qobuzTrack;
    const selectable = match.lossless;
    if (selectable && selectedQobuzIds.has(qt.id)) el.classList.add('sel');
    if (!selectable) el.classList.add('lossy');
    const tail = selectable
      ? `<span class="src-qual">${qt.quality ? `<span class="fmt">${escapeHtml(qt.quality)}</span> · ` : ''}<span class="price">${escapeHtml(qt.price || '—')}</span></span>`
      : `<span class="src-tag-lossy">${escapeHtml(qt.quality || 'lossy')}</span>`;
    el.innerHTML = `
      <span class="src-cbx">${CHECK_SVG}</span>
      <span class="src-badge qobuz">Qobuz</span>
      <span class="src-trk"><span class="t">${escapeHtml(qt.name)}</span><span class="a">${escapeHtml(qt.artists.join(', '))}</span></span>
      ${tail}
      ${pctHtml}`;
    if (selectable) bindToggle(qt.id, selectedQobuzIds);
    return el;
  }

  if (match.source === 'beatport' && match.beatportTrack) {
    const bt = match.beatportTrack;
    const selectable = match.lossless;
    if (selectable && selectedBeatportIds.has(bt.id)) el.classList.add('sel');
    if (!selectable) el.classList.add('lossy');
    const sub = [bt.artists.join(', '), bt.bpm ? `${bt.bpm} BPM` : '', bt.key].filter(Boolean).join(' · ');
    const tail = selectable
      ? `<span class="src-qual"><span class="fmt">Lossless</span> · <span class="price">${escapeHtml(bt.price || '—')}</span></span>`
      : `<span class="src-tag-lossy">lossy</span>`;
    el.innerHTML = `
      <span class="src-cbx">${CHECK_SVG}</span>
      <span class="src-badge beatport">Beatport</span>
      <span class="src-trk"><span class="t">${escapeHtml(bt.name)}</span><span class="a">${escapeHtml(sub)}</span></span>
      ${tail}
      ${pctHtml}`;
    if (selectable) bindToggle(bt.id, selectedBeatportIds);
    return el;
  }

  // No store match found.
  el.classList.add('info');
  el.innerHTML = `
    <span class="src-badge notfound">No source</span>
    <span class="src-trk"><span class="t">${escapeHtml(match.trackInput.artist)} — ${escapeHtml(match.trackInput.title)}</span><span class="sub">${match.error ? escapeHtml(match.error) : 'No lossless source found'}</span></span>`;
  return el;
}

/** Render the active segment's group into the groups container. */
function renderResults() {
  groupsContainer.innerHTML = '';
  emptyState.style.display = 'none';

  if (activeSegment === 'owned') { groupsContainer.appendChild(renderOwnedGroup()); return; }
  if (activeSegment === 'maybe') { groupsContainer.appendChild(renderMaybeGroup()); return; }

  const seg = activeSegment; // 'new' | 'notfound'
  const list = segmentMatches(seg);
  const group = document.createElement('div');
  group.className = 'source-group';
  group.innerHTML = seg === 'new'
    ? `<div class="source-group-head">
         <span class="source-group-title">New to buy</span>
         <span class="source-group-desc">Not in your library — lossless matches are auto-selected, lossy is excluded.</span>
         <div class="source-group-actions"><button class="btn-sm btn-ghost" id="src-select-lossless" data-tooltip="Select every lossless track here">Select all lossless</button></div>
       </div>`
    : `<div class="source-group-head">
         <span class="source-group-title">Not found</span>
         <span class="source-group-desc">Searched Qobuz + Beatport but found no lossless match.</span>
       </div>`;

  if (list.length === 0) {
    group.appendChild(emptyRow(
      searchQuery
        ? `No tracks match "${searchQuery}".`
        : (seg === 'new' ? 'Nothing new to buy in this list.' : 'Every track had a store match.')
    ));
  } else {
    const ul = document.createElement('div');
    ul.className = 'source-group-list';
    for (const m of list) ul.appendChild(buildTrackRow(m));
    group.appendChild(ul);
  }
  groupsContainer.appendChild(group);

  group.querySelector<HTMLButtonElement>('#src-select-lossless')?.addEventListener('click', () => {
    for (const m of segmentMatches('new')) {
      if (!m.lossless) continue;
      if (m.source === 'qobuz' && m.qobuzTrack) selectedQobuzIds.add(m.qobuzTrack.id);
      else if (m.source === 'beatport' && m.beatportTrack) selectedBeatportIds.add(m.beatportTrack.id);
    }
    renderResults();
    updateBuyBar();
  });
}

/** Update the four segment counts and the slim scan-done summary line. The
 *  badge counts track the visible (search-filtered) list; the scan summary
 *  reflects the full, unfiltered scan. */
function updateSegmentCounts() {
  const q = searchQuery.toLowerCase();
  segCountNew.textContent = String(segmentMatches('new').length);
  segCountMaybe.textContent = String(segmentMatches('maybe').length);
  segCountNotFound.textContent = String(segmentMatches('notfound').length);
  segCountOwned.textContent = String(
    libraryMatched.filter(r => !q || `${r.artist} ${r.title}`.toLowerCase().includes(q)).length
  );

  // Scan summary is the whole scan, independent of any active filter.
  const totalChecked = matches.length + libraryMatched.length;
  const notFoundCount = matches.filter(m => m.status !== 'matched').length;
  const qFound = matches.filter(m => m.source === 'qobuz').length;
  const bFound = matches.filter(m => m.source === 'beatport').length;
  if (totalChecked > 0) {
    scanSummary.style.display = 'flex';
    scanSummary.innerHTML = `
      <span class="ok">✓ Checked ${totalChecked} ${totalChecked === 1 ? 'track' : 'tracks'} against your library</span>
      <span class="sep">·</span>
      <span class="chip">Qobuz <b>${qFound}</b></span>
      <span class="chip">Beatport <b>${bFound}</b></span>
      <span class="chip">No source <b>${notFoundCount}</b></span>`;
  } else {
    scanSummary.style.display = 'none';
  }
}

/** Update the sticky buy-bar: selected count, per-store totals, action state. */
function updateBuyBar() {
  // Show the bar whenever the results pane is up (so Clear / Export / + Add list
  // stay reachable even for an all-empty result), hidden only when results are.
  buyBar.style.display = resultsSection.style.display === 'block' ? '' : 'none';

  const qSel = matches.filter(m => m.qobuzTrack && selectedQobuzIds.has(m.qobuzTrack.id));
  const bSel = matches.filter(m => m.beatportTrack && selectedBeatportIds.has(m.beatportTrack.id));
  const qTotal = qSel.reduce((s, m) => s + parsePriceDollars(m.qobuzTrack?.price), 0);
  const bTotal = bSel.reduce((s, m) => s + parsePriceDollars(m.beatportTrack?.price), 0);

  buyBarN.textContent = String(qSel.length + bSel.length);
  buyBarQobuz.textContent = `Qobuz ${qSel.length} · $${qTotal.toFixed(2)}`;
  buyBarBeatport.textContent = `Beatport ${bSel.length} · $${bTotal.toFixed(2)}`;
  addToCartBtn.disabled = (qSel.length + bSel.length) === 0;
  reviewCartBtn.style.display = (lastAddedQobuz.length + lastAddedBeatport.length) > 0 ? '' : 'none';

  // Selection changes are the main post-search mutation — persist for HMR.
  saveSourcesState();
}

function setActiveSegment(seg: Segment) {
  activeSegment = seg;
  document.querySelectorAll<HTMLElement>('#source-segments .source-seg').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.seg === seg);
  });
  renderResults();
}

// ---- Cart slide-over ----
function openCartDrawer() {
  renderCartStage();
  cartScrim.style.display = '';
  cartDrawer.style.display = 'flex';
}
function closeCartDrawer() {
  cartDrawer.style.display = 'none';
  cartScrim.style.display = 'none';
}

// ========== Search Workflow ==========

async function runSearch() {
  if (sourceType === 'csv' && !csvPath) {
    showToast('warning', 'No CSV', 'Select a CSV file first.');
    return;
  }
  if (sourceType === 'spotify' && !spotifyUrlValid) {
    showToast('warning', 'Invalid URL', 'Enter a valid Spotify playlist URL.');
    return;
  }

  setStatus('Searching...');
  runSearchBtn.disabled = true;
  progressSection.style.display = 'block';
  // In append mode we keep the existing results visible (and existing
  // selections) so newly-found tracks stream in alongside them. In replace
  // mode we clear everything and tear down any prior cart stage.
  if (!appendMode) {
    resultsSection.style.display = 'none';
    cartSection.style.display = 'none';
    downloadPurchasesBtn.style.display = 'none';
    matches = [];
    selectedQobuzIds = new Set();
    selectedBeatportIds = new Set();
    lastAddedQobuz = [];
    lastAddedBeatport = [];
    clearPlaylistCard();
  }
  progressBar.style.width = '0%';
  progressMessage.textContent = sourceType === 'spotify' ? 'Fetching Spotify playlist...' : 'Starting search...';
  progressCount.textContent = '';
  (progressSection as HTMLElement & { _resetStats?: () => void })._resetStats?.();

  // Collapse source lane, activate search lane with progress
  wizard.setDone('source', sourceLaneSummary());
  wizard.setActive('search');

  try {
    const result = sourceType === 'spotify'
      ? await window.candybar.librarySourcingRun({ spotifyPlaylistUrl })
      : await window.candybar.librarySourcingRun({ csvPath });

    if (!result.success || !result.result) {
      showToast('error', 'Search Failed', result.error || 'Unknown error');
      wizard.setActive('source');
      return;
    }

    const { matched: freshMatched, probable: freshProbable, storeMatches: freshStoreMatches } = result.result;

    // How many rows were actually appended (post-dedupe) — drives the
    // auto-select slice so we never re-touch previously-loaded rows.
    let appendedCount = freshStoreMatches.length;
    if (appendMode) {
      // Dedupe by the input key (artist - title lowercased) so importing
      // overlapping playlists doesn't duplicate rows in the results list.
      // Library buckets dedupe by a composite "artist - title" key too.
      const existingKeys = new Set(matches.map(m => m.trackInput.key));
      const fresh = freshStoreMatches.filter(m => !existingKeys.has(m.trackInput.key));
      appendedCount = fresh.length;
      matches = [...matches, ...fresh];

      const libKey = (artist: string, title: string) => `${artist.toLowerCase()} - ${title.toLowerCase()}`;
      const existingLibKeys = new Set(libraryMatched.map(r => libKey(r.artist, r.title)));
      libraryMatched = [...libraryMatched, ...freshMatched.filter(r => !existingLibKeys.has(libKey(r.artist, r.title)))];
      const existingProbKeys = new Set(libraryProbable.map(r => libKey(r.artist, r.title)));
      libraryProbable = [...libraryProbable, ...freshProbable.filter(r => !existingProbKeys.has(libKey(r.artist, r.title)))];
    } else {
      matches = freshStoreMatches;
      libraryMatched = freshMatched;
      libraryProbable = freshProbable;
    }

    // Auto-select high-confidence LOSSLESS matches only. Non-lossless (or
    // unverifiable-lossless) matches must be explicitly reviewed — the user
    // buys DJ-grade tracks only. Tracks in the local library (confirmed OR
    // probable) are skipped so we don't nudge the user to re-buy what they
    // already own. "Probable" rows start unchecked; toggling "treat as
    // missing" on one flips its libraryStatus and the user can then select
    // manually.
    const toAutoSelect = appendMode
      ? matches.slice(matches.length - appendedCount)
      : matches;
    for (const m of toAutoSelect) {
      if (m.confidence < 0.75 || !m.lossless) continue;
      if (m.libraryStatus === 'confirmed' || m.libraryStatus === 'probable') continue;
      if (m.inLibrary) continue; // legacy guard for older matches missing libraryStatus
      if (m.source === 'qobuz' && m.qobuzTrack) {
        selectedQobuzIds.add(m.qobuzTrack.id);
      } else if (m.source === 'beatport' && m.beatportTrack) {
        selectedBeatportIds.add(m.beatportTrack.id);
      }
    }
    appendMode = false;

    resultsSection.style.display = 'block';
    movePlaylistCardToResults();
    updateSegmentCounts();
    setActiveSegment('new');
    updateBuyBar();
    wizard.setDone('search', searchLaneSummary(matches));
    wizard.setActive('review');
    setStatus('Idle');
    saveSourcesState();
  } catch (err) {
    const message = getErrorMessage(err);
    showToast('error', 'Search Failed', message);
    wizard.setActive('source');
    setStatus('Error');
  } finally {
    updateRunButton();
    progressSection.style.display = 'none';
    (progressSection as HTMLElement & { _stopTimer?: () => void })._stopTimer?.();
  }
}

async function addSelectedToCart() {
  const qobuzToAdd: StoreMatch[] = matches
    // Belt-and-suspenders lossless guard — the UI disables these checkboxes
    // but this keeps any DOM-tampering / future refactors from slipping lossy
    // tracks into a cart.
    .filter(m => m.qobuzTrack && m.lossless && selectedQobuzIds.has(m.qobuzTrack.id))
    .map(m => {
      const qt = m.qobuzTrack!;
      return {
        input: { key: m.trackInput.key, artist: m.trackInput.artist, title: m.trackInput.title },
        trackId: qt.id,
        title: qt.name,
        artist: qt.artists.join(', '),
        album: qt.album,
        label: '',
        price: qt.price ?? '',
        quality: qt.quality ?? '',
        format: 'lossless',
        lossless: true,
        rx3Compatible: false,
        confidence: m.confidence,
        url: qt.url,
        source: 'qobuz',
        image: qt.image,
      } satisfies StoreMatch;
    });

  const beatportToAdd: StoreMatch[] = matches
    .filter(m => m.beatportTrack && m.lossless && selectedBeatportIds.has(m.beatportTrack.id))
    .map(m => {
      const bt = m.beatportTrack!;
      return {
        input: { key: m.trackInput.key, artist: m.trackInput.artist, title: m.trackInput.title },
        trackId: bt.id,
        title: bt.name,
        artist: bt.artists.join(', '),
        album: '',
        label: bt.label,
        price: bt.price ?? '',
        quality: '',
        format: 'lossless',
        lossless: true,
        rx3Compatible: false,
        confidence: m.confidence,
        url: bt.url,
        source: 'beatport',
      } satisfies StoreMatch;
    });

  if (qobuzToAdd.length === 0 && beatportToAdd.length === 0) {
    showToast('warning', 'No Tracks Selected', 'Select at least one track.');
    return;
  }

  const parts: string[] = [];
  if (qobuzToAdd.length) parts.push(`${qobuzToAdd.length} Qobuz`);
  if (beatportToAdd.length) parts.push(`${beatportToAdd.length} Beatport`);
  showToast('info', 'Adding to Cart', `Adding ${parts.join(' + ')}…`);

  let qobuzAdded = 0;
  let beatportAdded = 0;
  const failures: string[] = [];

  // Both stores now use the fetch-with-session path (store-cart-add). Reuses
  // the Electron login partition, no fresh Playwright browser, no cookie
  // consent modal.
  const ownedMessages: string[] = [];
  const classifyFailure = (storeName: string, title: string, err: string) => {
    if (/already purchased|you own this track/i.test(err)) {
      ownedMessages.push(`${storeName} ${title}`);
    } else {
      failures.push(`${storeName} ${title}: ${err}`);
    }
  };

  // Disable the trigger + show the inline progress card; each store runs in
  // its own phase so the user sees Qobuz progress, then Beatport progress.
  addToCartBtn.disabled = true;
  cartAddProgress.style.display = 'block';
  const setCartProgress = (store: 'qobuz' | 'beatport', phase: { current: number; total: number; message: string; currentTrack?: string }) => {
    cartAddStore.textContent = store === 'qobuz' ? 'Qobuz' : 'Beatport';
    cartAddCount.textContent = `${phase.current} / ${phase.total}`;
    const pct = phase.total > 0 ? Math.round((phase.current / phase.total) * 100) : 0;
    cartAddBar.style.width = `${pct}%`;
    cartAddMessage.textContent = phase.currentTrack
      ? `${phase.message} — ${phase.currentTrack}`
      : phase.message;
  };
  const progressHandler = (activeStore: 'qobuz' | 'beatport') => (payload: { current: number; total: number; currentTrack: string; phase: string; message: string }) => {
    setCartProgress(activeStore, payload);
  };

  if (qobuzToAdd.length > 0) {
    setCartProgress('qobuz', { current: 0, total: qobuzToAdd.length, message: 'Authenticating with Qobuz…' });
    const listener = progressHandler('qobuz');
    window.candybar.onStoreCartProgress(listener);
    try {
      const result = await window.candybar.storeCartAdd(qobuzToAdd, 'qobuz');
      if (result.success && result.result) {
        qobuzAdded = result.result.added.length;
        lastAddedQobuz = result.result.added;
        downloadFiredQobuz = false;
        for (const f of result.result.failed) classifyFailure('Qobuz', f.match.title, f.error);
      } else {
        failures.push(`Qobuz: ${result.error ?? 'failed'}`);
      }
    } finally {
      window.candybar.offStoreCartProgress?.(listener);
    }
  }

  if (beatportToAdd.length > 0) {
    setCartProgress('beatport', { current: 0, total: beatportToAdd.length, message: 'Authenticating with Beatport…' });
    const listener = progressHandler('beatport');
    window.candybar.onStoreCartProgress(listener);
    try {
      const result = await window.candybar.storeCartAdd(beatportToAdd, 'beatport');
      if (result.success && result.result) {
        beatportAdded = result.result.added.length;
        lastAddedBeatport = result.result.added;
        downloadFiredBeatport = false;
        for (const f of result.result.failed) classifyFailure('Beatport', f.match.title, f.error);
      } else {
        failures.push(`Beatport: ${result.error ?? 'failed'}`);
      }
    } finally {
      window.candybar.offStoreCartProgress?.(listener);
    }
  }

  cartAddProgress.style.display = 'none';
  addToCartBtn.disabled = false;

  const totalAdded = qobuzAdded + beatportAdded;
  if (failures.length > 0) for (const f of failures) console.log('[cart-fail]', f);

  const ownedSuffix = ownedMessages.length > 0
    ? ` · ${ownedMessages.length} already owned, skipped`
    : '';

  if (totalAdded > 0 && failures.length === 0) {
    showToast('success', 'Cart Updated', `${totalAdded} tracks added${ownedSuffix}.`);
  } else if (totalAdded > 0) {
    showToast('warning', 'Partially Added',
      `${totalAdded} added, ${failures.length} failed${ownedSuffix}.`);
  } else if (ownedMessages.length > 0 && failures.length === 0) {
    showToast('info', 'Already Owned', `You already own all ${ownedMessages.length} of these tracks.`);
  } else {
    showToast('error', 'Cart Failed', failures[0] ?? 'Failed to add tracks to cart.');
  }

  // If any tracks landed in a cart, slide open the cart drawer so the user can
  // see totals + check out, and surface the "Review carts" button for reopening.
  if (qobuzAdded > 0 || beatportAdded > 0) {
    downloadPurchasesBtn.style.display = 'inline-flex';
    openCartDrawer();
    updateBuyBar();
  }
}

/** Drive the panel through cart → checkout → payment review, stopping before
 *  the final commit. Returns the scraped total (or null) once the page shows
 *  a Place Order CTA. Caller should confirm with the user before clicking. */
async function driveToPlaceOrder(store: 'qobuz' | 'beatport'): Promise<{ ready: boolean; total: string | null; error?: string }> {
  const MAX_STEPS = 6;
  const STEP_WAIT_MS = 2200;

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await window.candybar.storePanelCheckoutAdvance(store);
    if (!res.success || !res.result) {
      return { ready: false, total: null, error: res.error ?? 'Advance failed' };
    }
    const r = res.result;
    if (r.phase === 'place-order-ready') {
      return { ready: true, total: r.total };
    }
    if (r.phase === 'advanced') {
      await new Promise(r => setTimeout(r, STEP_WAIT_MS));
      continue;
    }
    // 'unknown' — no advance button visible. Page may still be loading, wait
    // once more and retry. If still unknown on retry, bail.
    await new Promise(r => setTimeout(r, STEP_WAIT_MS));
    const retry = await window.candybar.storePanelCheckoutAdvance(store);
    if (!retry.success || !retry.result) {
      return { ready: false, total: null, error: retry.error ?? 'Advance failed' };
    }
    if (retry.result.phase === 'place-order-ready') {
      return { ready: true, total: retry.result.total };
    }
    if (retry.result.phase === 'advanced') {
      await new Promise(r => setTimeout(r, STEP_WAIT_MS));
      continue;
    }
    return { ready: false, total: null, error: `Could not find a checkout or Place Order button on the current page.` };
  }
  return { ready: false, total: null, error: `Checkout didn't reach a Place Order page after ${MAX_STEPS} steps.` };
}

async function runAutoCheckout(store: 'qobuz' | 'beatport') {
  const button = store === 'qobuz' ? autoCheckoutQobuzBtn : autoCheckoutBeatportBtn;
  const label = store === 'qobuz' ? 'Qobuz' : 'Beatport';
  const tracks = store === 'qobuz' ? lastAddedQobuz : lastAddedBeatport;

  if (tracks.length === 0) {
    showToast('warning', 'Nothing to check out', `No ${label} tracks queued in this session.`);
    return;
  }

  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = `Opening ${label}…`;

  try {
    // Make sure the panel is open on the cart URL before we start driving.
    const cartUrl = store === 'qobuz'
      ? 'https://www.qobuz.com/us-en/shopping-cart'
      : 'https://www.beatport.com/cart';
    await window.candybar.storePanelOpen(store, cartUrl);
    // Give the page a moment to render after the partition warm-up.
    await new Promise(r => setTimeout(r, 1500));

    button.textContent = `Driving ${label} checkout…`;
    const drive = await driveToPlaceOrder(store);
    if (!drive.ready) {
      showToast('error', 'Auto-checkout stalled', drive.error ?? 'Unknown failure');
      return;
    }

    const displayTotal = drive.total ?? 'unknown total';
    const confirmed = window.confirm(
      `About to place a REAL ORDER on ${label}:\n\n` +
      `  • ${tracks.length} track${tracks.length === 1 ? '' : 's'}\n` +
      `  • Total: ${displayTotal}\n\n` +
      `Click OK to commit. Any 3DS / bank confirmation will still appear in the ${label} panel for you to approve.`
    );
    if (!confirmed) {
      showToast('info', 'Auto-checkout cancelled', 'No order placed.');
      return;
    }

    button.textContent = `Placing ${label} order…`;
    const commit = await window.candybar.storePanelPlaceOrder(store);
    if (commit.success) {
      showToast('success', `${label} order placed`,
        `Complete any 3DS prompt in the panel. Downloads auto-start on confirmation.`);
    } else {
      showToast('error', `${label} order failed`, commit.error ?? 'Place Order click failed');
    }
  } catch (err) {
    showToast('error', 'Auto-checkout error', err instanceof Error ? err.message : String(err));
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function exportResults() {
  const filtered = matches;
  if (filtered.length === 0) {
    showToast('warning', 'Nothing to Export', 'No results to export.');
    return;
  }

  const defaultName = `source-results-${new Date().toISOString().slice(0, 10)}.csv`;
  const filePath = await window.candybar.showSaveDialog(defaultName);
  if (!filePath) return;

  const tracks = filtered.map(m => {
    const source = m.source || 'not_found';
    const matchArtist = m.qobuzTrack?.artists.join(', ') || m.beatportTrack?.artists.join(', ') || '';
    const matchTitle = m.qobuzTrack?.name || m.beatportTrack?.name || '';
    const url = m.qobuzTrack?.url || m.beatportTrack?.url || '';
    const quality = m.qobuzTrack?.quality || '';
    const price = m.qobuzTrack?.price || m.beatportTrack?.price || '';
    return {
      artist: m.trackInput.artist,
      title: m.trackInput.title,
      source,
      match_artist: matchArtist,
      match_title: matchTitle,
      confidence: String(Math.round(m.confidence * 100)),
      quality,
      price,
      url
    };
  });

  const headers = ['Artist', 'Title', 'Source', 'Match Artist', 'Match Title', 'Confidence', 'Quality', 'Price', 'URL'];
  const rows = tracks.map(t => [
    t.artist, t.title, t.source, t.match_artist, t.match_title,
    t.confidence, t.quality, t.price, t.url
  ].map(v => `"${(v || '').replace(/"/g, '""')}"`).join(','));

  const csvContent = [headers.join(','), ...rows].join('\n');

  try {
    const result = await window.candybar.sourceExportCsv(csvContent, filePath);
    if (result.success) {
      showToast('success', 'Exported', `Results saved to ${filePath}`);
    } else {
      showToast('error', 'Export Failed', result.error || 'Could not export results.');
    }
  } catch {
    showToast('error', 'Export Failed', 'Could not export results.');
  }
}

// ========== Init ==========

export function initSource() {
  // Inject source-picker markup and bind the newly-created elements.
  const slot = document.getElementById('source-source-slot');
  if (slot) {
    slot.innerHTML = renderSourceInput({
      actionId: 'run-source-search',
      actionLabel: 'Find Sources',
      actionDisabled: true,
      ids: {
        toggle: 'source-type-toggle',
        csvField: 'source-csv-field',
        dropZone: 'source-csv-drop-zone',
        fileDisplay: 'source-csv-file-display',
        pathInput: 'source-csv',
        clearBtn: 'clear-source-csv',
        browseTarget: 'source-csv',
        spotifyField: 'source-spotify-field',
        spotifyInput: 'source-spotify-playlist-url',
        spotifyStatus: 'source-spotify-url-status',
        previewSection: 'source-csv-preview-section',
        previewCount: 'source-csv-preview-count',
        previewColumns: 'source-csv-preview-columns',
        previewThead: 'source-csv-preview-thead',
        previewTbody: 'source-csv-preview-tbody',
      },
    });
  }

  // Bind refs for injected elements
  runSearchBtn = document.getElementById('run-source-search') as HTMLButtonElement;
  csvDropZone = document.getElementById('source-csv-drop-zone') as HTMLDivElement;
  csvFileDisplay = document.getElementById('source-csv-file-display') as HTMLDivElement;
  csvPreviewSection = document.getElementById('source-csv-preview-section') as HTMLDivElement;
  csvPreviewCount = document.getElementById('source-csv-preview-count') as HTMLSpanElement;
  csvPreviewColumns = document.getElementById('source-csv-preview-columns') as HTMLSpanElement;
  csvPreviewThead = document.getElementById('source-csv-preview-thead') as HTMLTableSectionElement;
  csvPreviewTbody = document.getElementById('source-csv-preview-tbody') as HTMLTableSectionElement;
  csvFileName = csvFileDisplay.querySelector('.file-name') as HTMLSpanElement;
  clearCsvBtn = document.getElementById('clear-source-csv') as HTMLButtonElement;
  sourceTypeToggle = document.getElementById('source-type-toggle') as HTMLDivElement;
  csvField = document.getElementById('source-csv-field') as HTMLDivElement;
  spotifyField = document.getElementById('source-spotify-field') as HTMLDivElement;
  spotifyUrlInput = document.getElementById('source-spotify-playlist-url') as HTMLInputElement;
  spotifyUrlStatus = document.getElementById('source-spotify-url-status') as HTMLSpanElement;

  // Wizard: Edit on source/search/review jumps back to source; Edit on cart
  // goes back to review so the user can revise selections without re-running
  // the search.
  wizard = new Wizard('source-wizard');
  wizard.configure('source', { onEdit: () => wizard.setActive('source') });
  wizard.configure('search', { onEdit: () => wizard.setActive('source') });
  wizard.configure('review', { onEdit: () => wizard.setActive('source') });

  // Run search
  runSearchBtn.addEventListener('click', () => runSearch());

  // CSV Drop Zone
  csvDropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    csvDropZone.classList.add('is-dragging');
  });

  csvDropZone.addEventListener('dragleave', (event) => {
    event.preventDefault();
    csvDropZone.classList.remove('is-dragging');
  });

  csvDropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    csvDropZone.classList.remove('is-dragging');

    const file = event.dataTransfer?.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.csv')) {
      showToast('error', 'Invalid File', 'Please drop a CSV file.');
      return;
    }

    const path = 'path' in file ? (file as File & { path: string }).path : '';
    if (!path) {
      showToast('error', 'Read Error', 'Could not read dropped file path.');
      return;
    }

    setSourceCsvFile(path);
  });

  clearCsvBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    clearCsvFile();
  });

  // Source type toggle
  sourceTypeToggle.querySelectorAll('.source-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = (btn as HTMLButtonElement).dataset.sourceType as 'csv' | 'spotify';
      setSourceType(type);
    });
  });

  // Spotify URL input (debounced)
  let spotifyUrlDebounce: ReturnType<typeof setTimeout>;
  spotifyUrlInput.addEventListener('input', () => {
    clearTimeout(spotifyUrlDebounce);
    spotifyUrlDebounce = setTimeout(() => {
      validateSpotifyUrl(spotifyUrlInput.value);
    }, 250);
  });

  // Segment switching (New / Maybe owned / Owned / Not found)
  document.querySelectorAll<HTMLElement>('#source-segments .source-seg').forEach(btn => {
    btn.addEventListener('click', () => {
      const seg = btn.dataset.seg as Segment | undefined;
      if (seg) setActiveSegment(seg);
    });
  });

  // Cart slide-over open/close
  reviewCartBtn.addEventListener('click', () => openCartDrawer());
  cartCloseBtn.addEventListener('click', () => closeCartDrawer());
  cartScrim.addEventListener('click', () => closeCartDrawer());

  // Search filter
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    renderResults();
    updateSegmentCounts();
  });

  // Add to cart
  addToCartBtn.addEventListener('click', () => addSelectedToCart());

  // "+ Add More Tracks" — queue an append search. Clears the source input so
  // the user can drop a new CSV or paste a new Spotify URL, then the next
  // runSearch() merges the new matches into the existing stack (deduped by
  // input key).
  addMoreBtn.addEventListener('click', () => {
    appendMode = true;
    clearCsvFile();
    if (spotifyUrlInput) {
      spotifyUrlInput.value = '';
      validateSpotifyUrl('');
    }
    wizard.setActive('source');
  });

  // Open cart in embedded store panel
  openQobuzCartBtn.addEventListener('click', () => {
    window.candybar.storePanelOpen('qobuz', 'https://www.qobuz.com/us-en/shopping-cart');
  });
  openBeatportCartBtn.addEventListener('click', () => {
    window.candybar.storePanelOpen('beatport', 'https://www.beatport.com/cart');
  });

  // Auto-checkout — drives the panel from cart → Place Order page, asks the
  // user to confirm with the scraped total, then clicks Place Order. 3DS stays
  // interactive in the panel.
  autoCheckoutQobuzBtn.addEventListener('click', () => runAutoCheckout('qobuz'));
  autoCheckoutBeatportBtn.addEventListener('click', () => runAutoCheckout('beatport'));

  // Accordion toggles: click a header to collapse/expand its body.
  document.querySelectorAll<HTMLButtonElement>('[data-accordion-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const expanded = btn.getAttribute('aria-expanded') !== 'false';
      const next = !expanded;
      btn.setAttribute('aria-expanded', String(next));
      const block = btn.closest<HTMLElement>('.cart-store-block');
      if (block) block.dataset.collapsed = String(!next);
    });
  });

  downloadPurchasesBtn.addEventListener('click', async () => {
    const all = [...lastAddedQobuz, ...lastAddedBeatport];
    if (all.length === 0) {
      showToast('warning', 'Nothing to download', 'No tracks were added to cart in this session.');
      return;
    }
    downloadPurchasesBtn.disabled = true;
    showToast('info', 'Starting downloads', `Fetching ${all.length} purchased tracks…`);
    try {
      const res = await window.candybar.storeDownloadPurchases(all);
      if (res.success) {
        showToast('success', 'Downloads complete',
          `${res.downloaded ?? 0} of ${all.length} downloaded → ${res.destDir ?? 'library'}`);
      } else {
        showToast('error', 'Downloads Failed', res.error ?? 'Unknown error');
      }
    } catch (e) {
      showToast('error', 'Downloads Failed', e instanceof Error ? e.message : 'Download failed');
    } finally {
      downloadPurchasesBtn.disabled = false;
    }
  });

  // Watch panel navigation for purchase-confirmation URLs → auto-trigger
  // downloads of the tracks we pushed to each cart.
  window.candybar.onStorePanelNavigated(async ({ url }) => {
    if (!url) return;
    // Log every navigation so we can tighten the success-URL regex when the
    // user tells us where they landed after completing checkout.
    console.log('[panel-nav]', url);
    const lower = url.toLowerCase();
    const isQobuzSuccess = /qobuz\.com/.test(lower)
      && /(purchase|purchases|order|thank|confirm|success|receipt|my-account\/downloads)/.test(lower)
      && !/shopping-cart/.test(lower);
    const isBeatportSuccess = /beatport\.com/.test(lower)
      && /(order|confirm|thank|success|receipt|downloads|my\/orders)/.test(lower);

    if (isQobuzSuccess && lastAddedQobuz.length > 0 && !downloadFiredQobuz) {
      downloadFiredQobuz = true;
      showToast('info', 'Qobuz Purchase Detected', `Starting downloads for ${lastAddedQobuz.length} tracks…`);
      try {
        const res = await window.candybar.storeDownloadPurchases(lastAddedQobuz);
        if (res.success) {
          showToast('success', 'Qobuz Downloads Started',
            `${res.downloaded ?? 0} downloaded → ${res.destDir ?? 'library'}`);
        } else {
          showToast('error', 'Qobuz Downloads Failed', res.error ?? 'Unknown error');
        }
      } catch (e) {
        showToast('error', 'Qobuz Downloads Failed', e instanceof Error ? e.message : 'Download failed');
      }
    }

    if (isBeatportSuccess && lastAddedBeatport.length > 0 && !downloadFiredBeatport) {
      downloadFiredBeatport = true;
      showToast('info', 'Beatport Purchase Detected', `Starting downloads for ${lastAddedBeatport.length} tracks…`);
      try {
        const res = await window.candybar.storeDownloadPurchases(lastAddedBeatport);
        if (res.success) {
          showToast('success', 'Beatport Downloads Started',
            `${res.downloaded ?? 0} downloaded → ${res.destDir ?? 'library'}`);
        } else {
          showToast('error', 'Beatport Downloads Failed', res.error ?? 'Unknown error');
        }
      } catch (e) {
        showToast('error', 'Beatport Downloads Failed', e instanceof Error ? e.message : 'Download failed');
      }
    }
  });

  // Export CSV
  exportCsvBtn.addEventListener('click', () => exportResults());

  // Clear results
  clearResultsBtn.addEventListener('click', () => {
    matches = [];
    libraryMatched = [];
    libraryProbable = [];
    selectedQobuzIds = new Set();
    selectedBeatportIds = new Set();
    lastAddedQobuz = [];
    lastAddedBeatport = [];
    appendMode = false;
    clearPlaylistCard();
    closeCartDrawer();
    resultsSection.style.display = 'none';
    cartSection.style.display = 'none';
    buyBar.style.display = 'none';
    downloadPurchasesBtn.style.display = 'none';
    saveSourcesState();
    wizard.setActive('source');
  });

  // Progress UX — elapsed, ETA, live counts, last-found preview.
  const progressPercent = document.getElementById('source-progress-percent') as HTMLSpanElement | null;
  const progressElapsed = document.getElementById('source-progress-elapsed') as HTMLSpanElement | null;
  const progressEta = document.getElementById('source-progress-eta') as HTMLSpanElement | null;
  const progressQobuzCount = document.getElementById('source-progress-qobuz-count') as HTMLSpanElement | null;
  const progressBeatportCount = document.getElementById('source-progress-beatport-count') as HTMLSpanElement | null;
  const progressNotFoundCount = document.getElementById('source-progress-notfound-count') as HTMLSpanElement | null;
  const progressRecent = document.getElementById('source-progress-recent') as HTMLDivElement | null;

  let searchStartedAt = 0;
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;
  let liveQobuz = 0;
  let liveBeatport = 0;
  let liveNotFound = 0;
  let lastTotal = 0;
  let lastCurrent = 0;

  function formatSeconds(s: number): string {
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60); const r = s % 60;
    return `${m}m ${r}s`;
  }

  function updateElapsedEta() {
    if (!searchStartedAt) return;
    const elapsed = Math.floor((Date.now() - searchStartedAt) / 1000);
    if (progressElapsed) progressElapsed.textContent = formatSeconds(elapsed);
    if (progressEta) {
      if (lastCurrent > 0 && lastCurrent < lastTotal) {
        const remaining = Math.round((elapsed / lastCurrent) * (lastTotal - lastCurrent));
        progressEta.textContent = `· ~${formatSeconds(remaining)} left`;
      } else {
        progressEta.textContent = '';
      }
    }
  }

  function resetSearchStats() {
    liveQobuz = liveBeatport = liveNotFound = 0;
    lastTotal = lastCurrent = 0;
    if (progressQobuzCount) progressQobuzCount.textContent = '0';
    if (progressBeatportCount) progressBeatportCount.textContent = '0';
    if (progressNotFoundCount) progressNotFoundCount.textContent = '0';
    if (progressRecent) progressRecent.innerHTML = '';
    if (progressPercent) progressPercent.textContent = '0%';
    if (progressElapsed) progressElapsed.textContent = '0s';
    if (progressEta) progressEta.textContent = '';
    searchStartedAt = Date.now();
    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = setInterval(updateElapsedEta, 500);
  }

  function stopSearchTimer() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

  (progressSection as HTMLElement & { _resetStats?: () => void; _stopTimer?: () => void })._resetStats = resetSearchStats;
  (progressSection as HTMLElement & { _resetStats?: () => void; _stopTimer?: () => void })._stopTimer = stopSearchTimer;

  window.candybar.onQobuzCartSearchProgress((payload) => {
    lastTotal = payload.total;
    lastCurrent = payload.current;
    const pct = payload.total > 0 ? Math.round((payload.current / payload.total) * 100) : 0;
    progressBar.style.width = `${pct}%`;
    if (progressPercent) progressPercent.textContent = `${pct}%`;
    progressMessage.textContent = payload.currentTrack.startsWith('Fetching')
      ? payload.currentTrack
      : `Matching: ${payload.currentTrack}`;
    progressCount.textContent = `${payload.current} / ${payload.total}`;
    updateElapsedEta();
  });

  // Phase-1 (library match) progress for the merged flow. Distinct from the
  // legacy qobuz-cart-search progress because phase 1 runs BEFORE the store
  // search — the hero shows "Checking library…" then switches to store
  // progress once phase-2 events start flowing.
  window.candybar.onLibrarySourcingPhase1Progress((payload) => {
    const label = payload.phase === 'parsing'
      ? 'Loading input'
      : payload.phase === 'scanning'
        ? 'Scanning library'
        : payload.phase === 'matching'
          ? 'Matching tracks'
          : 'Checking library';
    progressMessage.textContent = payload.message || label;
    if (payload.total > 0) {
      const pct = Math.round((payload.current / payload.total) * 100);
      progressBar.style.width = `${pct}%`;
      if (progressPercent) progressPercent.textContent = `${pct}%`;
      progressCount.textContent = `${payload.current} / ${payload.total}`;
    }
  });

  // Phase-2 (store search) progress mirrors the legacy qobuz-cart-search-progress
  // shape, so reuse the same UI update path.
  window.candybar.onLibrarySourcingPhase2Progress((payload) => {
    lastTotal = payload.total;
    lastCurrent = payload.current;
    const pct = payload.total > 0 ? Math.round((payload.current / payload.total) * 100) : 0;
    progressBar.style.width = `${pct}%`;
    if (progressPercent) progressPercent.textContent = `${pct}%`;
    progressMessage.textContent = `Store search: ${payload.currentTrack}`;
    progressCount.textContent = `${payload.current} / ${payload.total}`;
    updateElapsedEta();
  });

  // Phase-2 per-match events drive the live-recent-matches feed — reuse the
  // legacy qobuz-cart-search-match renderer by dispatching through the same
  // code path (the shape is identical).
  window.candybar.onLibrarySourcingPhase2Match((match) => {
    onStreamingMatch(match);
  });

  // Playlist metadata arrives once the Spotify fetch resolves (before the
  // library scan) — show the cover-art card immediately.
  window.candybar.onLibrarySourcingPlaylistInfo((info) => {
    showPlaylistCard(info);
    saveSourcesState();
  });

  function onStreamingMatch(match: QobuzCartMatch) {
    if (match.source === 'qobuz') { liveQobuz++; if (progressQobuzCount) progressQobuzCount.textContent = String(liveQobuz); }
    else if (match.source === 'beatport') { liveBeatport++; if (progressBeatportCount) progressBeatportCount.textContent = String(liveBeatport); }
    else { liveNotFound++; if (progressNotFoundCount) progressNotFoundCount.textContent = String(liveNotFound); }

    if (!progressRecent) return;
    const found = match.source && (match.qobuzTrack || match.beatportTrack);
    const art = found
      ? (match.qobuzTrack?.image
          ? `<img class="recent-art" src="${escapeHtml(match.qobuzTrack.image)}" alt="" loading="lazy" />`
          : `<div class="recent-art recent-art--placeholder"></div>`)
      : `<div class="recent-art recent-art--miss">—</div>`;
    const title = found
      ? (match.qobuzTrack?.name ?? match.beatportTrack?.name ?? '')
      : `${match.trackInput.artist} — ${match.trackInput.title}`;
    const artist = found
      ? (match.qobuzTrack?.artists.join(', ') ?? match.beatportTrack?.artists.join(', ') ?? '')
      : 'not found';
    const badgeClass = match.source || 'notfound';
    const badgeText = match.source === 'qobuz' ? 'Qobuz' : match.source === 'beatport' ? 'Beatport' : 'Miss';
    const pct = Math.round((match.confidence ?? 0) * 100);
    const row = document.createElement('div');
    row.className = 'recent-match';
    row.innerHTML = `
      ${art}
      <div class="recent-match-info">
        <div class="recent-match-title">${escapeHtml(title)}</div>
        <div class="recent-match-sub">${escapeHtml(artist)}</div>
      </div>
      <span class="recent-match-badge recent-match-badge--${badgeClass}">${badgeText}</span>
      ${match.source ? `<span class="recent-match-pct">${pct}%</span>` : ''}
    `;
    attachArtFallback(row);
    progressRecent.prepend(row);
    while (progressRecent.children.length > 4) progressRecent.removeChild(progressRecent.lastElementChild!);
  }

  window.candybar.onQobuzCartSearchMatch((match) => {
    if (match.source === 'qobuz') { liveQobuz++; if (progressQobuzCount) progressQobuzCount.textContent = String(liveQobuz); }
    else if (match.source === 'beatport') { liveBeatport++; if (progressBeatportCount) progressBeatportCount.textContent = String(liveBeatport); }
    else { liveNotFound++; if (progressNotFoundCount) progressNotFoundCount.textContent = String(liveNotFound); }

    if (!progressRecent) return;
    const found = match.source && (match.qobuzTrack || match.beatportTrack);
    const art = found
      ? (match.qobuzTrack?.image
          ? `<img class="recent-art" src="${escapeHtml(match.qobuzTrack.image)}" alt="" loading="lazy" />`
          : `<div class="recent-art recent-art--placeholder"></div>`)
      : `<div class="recent-art recent-art--miss">—</div>`;
    const title = found
      ? (match.qobuzTrack?.name ?? match.beatportTrack?.name ?? '')
      : `${match.trackInput.artist} — ${match.trackInput.title}`;
    const artist = found
      ? (match.qobuzTrack?.artists.join(', ') ?? match.beatportTrack?.artists.join(', ') ?? '')
      : 'not found';
    const badgeClass = match.source || 'notfound';
    const badgeText = match.source === 'qobuz' ? 'Qobuz' : match.source === 'beatport' ? 'Beatport' : 'Miss';
    const pct = Math.round((match.confidence ?? 0) * 100);
    const row = document.createElement('div');
    row.className = 'recent-match';
    row.innerHTML = `
      ${art}
      <div class="recent-match-info">
        <div class="recent-match-title">${escapeHtml(title)}</div>
        <div class="recent-match-sub">${escapeHtml(artist)}</div>
      </div>
      <span class="recent-match-badge recent-match-badge--${badgeClass}">${badgeText}</span>
      ${match.source ? `<span class="recent-match-pct">${pct}%</span>` : ''}
    `;
    attachArtFallback(row);
    progressRecent.prepend(row);
    while (progressRecent.children.length > 4) progressRecent.removeChild(progressRecent.lastElementChild!);
  });

  // Persist reviewable state across HMR / renderer reloads, and rehydrate it now.
  window.addEventListener('beforeunload', saveSourcesState);
  restoreSourcesState();
}
