import type { QobuzCartMatch } from '../lib/qobuzCart';
import { cartUrl } from '../lib/storeUrls';
import type { CsvPreview, StoreMatch, LibraryMatchedRow, LibraryProbableRow, SourcePlaylistInfo } from '../types';
import { showToast, setStatus, escapeHtml, setValue, getErrorMessage, plural, formatPriceTotal, isReleaseMatch, RELEASE_MATCH_TAG, matchNoteHtml } from './shared';
import { confirmAction } from './confirmDialog';
import { renderSourceInput } from './sourceInputTemplate';
import { fillPlaylistCard } from './playlistCard';
import {
  type Store, STORE_LABEL, OTHER_VERSION_TAG, autoSelectable, isOtherVersion, parsePriceDollars, toStoreMatch,
  addToStoreCarts, isAddingToCart, toastCartOutcome, mergeAdded, uniqueByTrack,
} from './storeCart';
import { exportM3u8, exportRekordbox, exportCsv } from './libraryExport';
import { isArtistHeader, isTitleHeader } from '../lib/csvHeaders';

// ========== DOM Elements ==========
// Late-bound refs live inside the source lane (injected at init).

let runSearchBtn: HTMLButtonElement;

// The Sources page is a single workspace (no wizard): the input bar collapses
// away once a search runs, the progress strip shows while sourcing, and the
// results section takes over. These three drive that flow.
const inputBar = document.getElementById('source-input-bar') as HTMLElement;
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
let csvPreviewStatus: HTMLDivElement;
let csvPreviewStatusText: HTMLSpanElement;
let csvFileName: HTMLSpanElement;
let clearCsvBtn: HTMLButtonElement;
let sourceTypeToggle: HTMLDivElement;
let csvField: HTMLDivElement;
let spotifyField: HTMLDivElement;
let spotifyUrlInput: HTMLInputElement;
let spotifyUrlStatus: HTMLSpanElement;
let soundcloudField: HTMLDivElement;
let soundcloudUrlInput: HTMLInputElement;
let soundcloudUrlStatus: HTMLSpanElement;

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
type SourceType = 'csv' | 'spotify' | 'soundcloud';
let sourceType: SourceType = 'csv';
let spotifyPlaylistUrl = '';
let spotifyUrlValid = false;
let soundcloudSetUrl = '';
let soundcloudUrlValid = false;
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
/** When this tab last opened a store's cart (Open Cart or Auto-Checkout).
 *  The purchase watcher only acts for a store with a recent entry, so a
 *  checkout started from another tab, or a later browse past an order page,
 *  never downloads this tab's list. Saved with the session, like the lists. */
let checkoutArmedAt: Record<Store, number | null> = { qobuz: null, beatport: null };
/** How long after opening the cart a purchase still counts as this tab's. */
const CHECKOUT_WATCH_MS = 3 * 60 * 60 * 1000;
/** True while a sourcing run is in flight: the input, Clear and + Add list stay locked. */
let searching = false;

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

/** Summed price, in the currency the store's own prices are written in. */
function cartTotal(tracks: StoreMatch[]): string {
  return formatPriceTotal(tracks.reduce((s, t) => s + parsePriceDollars(t.price), 0), tracks.map(t => t.price));
}

function renderCartStage() {
  const qTracks = lastAddedQobuz;
  const bTracks = lastAddedBeatport;

  if (qTracks.length > 0) {
    cartQobuzBlock.style.display = '';
    cartQobuzCount.textContent = plural(qTracks.length, 'track');
    cartQobuzTotal.textContent = cartTotal(qTracks);
    renderCartLines(cartQobuzList, qTracks);
  } else {
    cartQobuzBlock.style.display = 'none';
  }

  if (bTracks.length > 0) {
    cartBeatportBlock.style.display = '';
    cartBeatportCount.textContent = plural(bTracks.length, 'track');
    cartBeatportTotal.textContent = cartTotal(bTracks);
    renderCartLines(cartBeatportList, bTracks);
  } else {
    cartBeatportBlock.style.display = 'none';
  }

  cartSection.style.display = (qTracks.length + bTracks.length) > 0 ? 'flex' : 'none';
}

// ========== Source Type Toggle ==========

let csvHasRequiredCols = false;

function updateRunButton() {
  if (searching) {
    runSearchBtn.disabled = true;
  } else if (sourceType === 'csv') {
    runSearchBtn.disabled = !csvPath || !csvHasRequiredCols;
  } else if (sourceType === 'spotify') {
    runSearchBtn.disabled = !spotifyUrlValid;
  } else {
    runSearchBtn.disabled = !soundcloudUrlValid;
  }
}

function setSourceType(type: SourceType) {
  sourceType = type;
  sourceTypeToggle.querySelectorAll('.source-type-btn').forEach(btn => {
    btn.classList.toggle('active', (btn as HTMLButtonElement).dataset.sourceType === type);
  });
  csvField.style.display = type === 'csv' ? '' : 'none';
  spotifyField.style.display = type === 'spotify' ? '' : 'none';
  soundcloudField.style.display = type === 'soundcloud' ? '' : 'none';
  // Shown whenever a file's preview loaded, including one missing its
  // artist/title columns: the preview carries the warning saying so.
  csvPreviewSection.style.display = type === 'csv' && csvPath && csvPreviewThead.childElementCount > 0 ? 'block' : 'none';
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

/** A set link (soundcloud.com/<user>/sets/<name>, optionally with a secret
 *  /s-TOKEN segment) or an on.soundcloud.com share link, which the main
 *  process expands. A track or profile link is rejected here rather than
 *  failing later at resolve time. */
function validateSoundCloudUrl(url: string) {
  soundcloudSetUrl = url.trim();
  if (!soundcloudSetUrl) {
    soundcloudUrlStatus.textContent = '';
    soundcloudUrlStatus.className = 'spotify-url-status';
    soundcloudUrlValid = false;
    updateRunButton();
    return;
  }

  soundcloudUrlValid = /^(https?:\/\/)?(www\.|m\.)?soundcloud\.com\/[^/?#\s]+\/sets\/[^/?#\s]+/i.test(soundcloudSetUrl)
    || /^(https?:\/\/)?on\.soundcloud\.com\/[A-Za-z0-9]+/i.test(soundcloudSetUrl);

  soundcloudUrlStatus.textContent = soundcloudUrlValid ? '\u2713' : '\u2717';
  soundcloudUrlStatus.className = `spotify-url-status ${soundcloudUrlValid ? 'valid' : 'invalid'}`;
  updateRunButton();
}

// ========== CSV Handling ==========

function renderCsvPreview(preview: CsvPreview) {
  csvPreviewCount.textContent = plural(preview.totalRows, 'row');
  csvPreviewColumns.textContent = plural(preview.columns.length, 'column');

  csvPreviewThead.innerHTML = `<tr>${preview.columns.map(col => {
    const isKey = isArtistHeader(col) || isTitleHeader(col);
    return `<th class="${isKey ? 'required' : ''}">${escapeHtml(col)}</th>`;
  }).join('')}</tr>`;

  csvPreviewTbody.innerHTML = preview.rows.map(row =>
    `<tr>${preview.columns.map(col => `<td>${escapeHtml(row[col] || '')}</td>`).join('')}</tr>`
  ).join('');

  csvHasRequiredCols = preview.hasArtistColumn && preview.hasTitleColumn;
  // Say why Find Sources stays off, instead of leaving a dead button.
  const missing = [!preview.hasArtistColumn && 'artist', !preview.hasTitleColumn && 'title'].filter(Boolean);
  setCsvStatus(missing.length > 0
    ? `No ${missing.join(' or ')} column found. Name the columns "Artist" and "Title" (an Exportify export works as is), then choose the file again.`
    : '');
  csvPreviewSection.style.display = 'block';
  updateRunButton();
}

function setCsvStatus(text: string) {
  csvPreviewStatusText.textContent = text;
  csvPreviewStatus.style.display = text ? '' : 'none';
}

function hideCsvPreview() {
  csvPreviewSection.style.display = 'none';
  csvPreviewThead.innerHTML = '';
  csvPreviewTbody.innerHTML = '';
  setCsvStatus('');
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
    showToast('error', "Couldn't read that CSV", getErrorMessage(err));
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

/** A store match that can actually be bought: found, and lossless. A
 *  lossy-only match counts as not found, the same as on Upgrades. */
function hasLosslessMatch(m: QobuzCartMatch): boolean {
  return m.status === 'matched' && m.lossless;
}

/** Store matches belonging to a store-backed segment.
 *   - new:      not in library + a lossless store match was found (the buyable tracks)
 *   - maybe:    a probable library hit, but a lossless store match exists to buy anyway
 *   - notfound: searched, but no lossless store match came back (lossy-only included) */
function segmentMatches(seg: 'new' | 'maybe' | 'notfound'): QobuzCartMatch[] {
  return matches.filter(m => {
    if (!matchesSearch(m)) return false;
    if (seg === 'notfound') return !hasLosslessMatch(m);
    if (seg === 'maybe') return hasLosslessMatch(m) && m.libraryStatus === 'probable';
    return hasLosslessMatch(m) && m.libraryStatus !== 'probable';
  });
}

/** Why a track has nothing to buy. Same wording as Upgrades' "No lossless source". */
function notFoundReason(m: QobuzCartMatch): string {
  if (m.status === 'error') return m.error || 'Store search failed';
  if (m.status === 'matched' && !m.lossless) {
    return `Only a lossy copy on ${m.source ? STORE_LABEL[m.source] : 'the store'} (${Math.round(m.confidence * 100)}% match), excluded`;
  }
  return m.error || 'No lossless match on Qobuz or Beatport';
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
 * Build (or update) the playlist card, reusing a single `#source-playlist-card`
 * element so it can be moved between the progress and results sections
 * without losing identity.
 */
function buildPlaylistCard(info: SourcePlaylistInfo): HTMLElement {
  let card = document.getElementById('source-playlist-card') as HTMLElement | null;
  if (!card) {
    card = document.createElement('div');
    card.id = 'source-playlist-card';
  }
  return fillPlaylistCard(card, info);
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

// ---------- Sources state persistence (survives HMR + app restarts) ----------
// The sourcing scan (library check + Qobuz/Beatport search) is the expensive
// step, so we snapshot the whole reviewable state — results, library buckets,
// selections, and the tracks already pushed to a cart — into localStorage and
// rehydrate it on init. That way a code edit (HMR reload) OR quitting and
// reopening the app drops you back into your cart instead of forcing another
// full scan. "Clear" wipes it. Cheap enough to save on every mutation.
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
      lastAddedQobuz,
      lastAddedBeatport,
      downloadFiredQobuz,
      downloadFiredBeatport,
      checkoutArmedAt,
      sourceType,
      spotifyPlaylistUrl,
      soundcloudSetUrl,
      csvPath,
      segment: activeSegment,
      searchQuery,
      resultsShown: resultsSection.style.display === 'block'
    };
    localStorage.setItem(SOURCES_STATE_KEY, JSON.stringify(snapshot));
  } catch {
    // localStorage unavailable or over quota (huge scan) — non-fatal, skip persistence.
  }
}

/** Set once a saved session is rehydrated. Its input row (source type + link
 *  or CSV) then wins over the legacy config keys read at startup. */
let snapshotRestored = false;
export function hasRestoredSourcesSession(): boolean {
  return snapshotRestored;
}

function restoreSourcesState() {
  let snapshot: ReturnType<typeof JSON.parse> | null = null;
  try {
    const raw = localStorage.getItem(SOURCES_STATE_KEY);
    if (!raw) return;
    snapshot = JSON.parse(raw);
  } catch {
    return;
  }
  if (!snapshot) return;
  snapshotRestored = true;

  matches = snapshot.matches ?? [];
  libraryMatched = snapshot.libraryMatched ?? [];
  libraryProbable = snapshot.libraryProbable ?? [];
  currentPlaylistInfo = snapshot.playlistInfo ?? null;
  selectedQobuzIds = new Set(snapshot.selectedQobuz ?? []);
  selectedBeatportIds = new Set(snapshot.selectedBeatport ?? []);
  lastAddedQobuz = snapshot.lastAddedQobuz ?? [];
  lastAddedBeatport = snapshot.lastAddedBeatport ?? [];
  // A session saved before these were kept: treat its lists as already handled
  // rather than letting the first order-looking page download them.
  downloadFiredQobuz = snapshot.downloadFiredQobuz ?? true;
  downloadFiredBeatport = snapshot.downloadFiredBeatport ?? true;
  checkoutArmedAt = { qobuz: snapshot.checkoutArmedAt?.qobuz ?? null, beatport: snapshot.checkoutArmedAt?.beatport ?? null };
  activeSegment = snapshot.segment ?? 'new';
  searchQuery = snapshot.searchQuery ?? '';

  // Restore the input row (source type + pasted Spotify/SoundCloud URL, or the
  // CSV file so the source lane summary + Run button survive an HMR reload).
  if (snapshot.sourceType === 'spotify') {
    setSourceType('spotify');
    if (snapshot.spotifyPlaylistUrl && spotifyUrlInput) {
      spotifyUrlInput.value = snapshot.spotifyPlaylistUrl;
      validateSpotifyUrl(snapshot.spotifyPlaylistUrl);
    }
  } else if (snapshot.sourceType === 'soundcloud') {
    setSourceType('soundcloud');
    if (snapshot.soundcloudSetUrl && soundcloudUrlInput) {
      soundcloudUrlInput.value = snapshot.soundcloudSetUrl;
      validateSoundCloudUrl(snapshot.soundcloudSetUrl);
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
  inputBar.style.display = 'none';
  // If a prior session already pushed tracks to a cart, keep the download path live.
  if (lastAddedQobuz.length + lastAddedBeatport.length > 0) {
    downloadPurchasesBtn.style.display = 'inline-flex';
  }
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
      <button class="btn-primary btn-sm src-buy-anyway" data-tooltip="Not the same track after all? Move it to New to buy so you can add it to a cart.">Buy anyway</button>`;
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
        <button class="btn-sm btn-ghost" id="src-export-m3u8" data-tooltip="Save these as a playlist file most music apps can open (M3U8)">Export M3U8</button>
        <button class="btn-sm btn-ghost" id="src-export-rbxml" data-tooltip="Save these as a file Rekordbox can import as a playlist">Export Rekordbox</button>
        <button class="btn-sm btn-ghost" id="src-export-owned-csv" data-tooltip="Save these as a spreadsheet (CSV)">Export CSV</button>
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
    // Auto-select if the existing match is a confident lossless copy of this version.
    if (autoSelectable(m)) {
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
  if (!hasLosslessMatch(match)) return buildNotFoundRow(match);
  const el = document.createElement('div');
  el.className = 'src-row';
  const pct = Math.round(match.confidence * 100);
  const pctHtml = `<span class="src-pct ${pct >= 90 ? 'hi' : 'mid'}" title="How sure we are this is the same track. 90% or more is a strong match.">${pct}%</span>`;
  const versionTag = isOtherVersion(match) ? OTHER_VERSION_TAG : '';
  // A flagged row names what was asked for, so the mismatch can be judged.
  const askedFor = isOtherVersion(match) ? ` · you asked for ${escapeHtml(match.trackInput.title)}` : '';

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

  // A release-level Qobuz hit or a match with a caveat says so on the row.
  const releaseTag = isReleaseMatch(match) ? RELEASE_MATCH_TAG : '';
  const note = matchNoteHtml(match);
  if (releaseTag) el.classList.add('release-match');

  if (match.source === 'qobuz' && match.qobuzTrack) {
    const qt = match.qobuzTrack;
    if (selectedQobuzIds.has(qt.id)) el.classList.add('sel');
    el.innerHTML = `
      <span class="src-cbx">${CHECK_SVG}</span>
      <span class="src-badge qobuz">Qobuz</span>
      <span class="src-trk"><span class="t">${escapeHtml(qt.name)}${versionTag}${releaseTag}</span><span class="a">${escapeHtml(qt.artists.join(', '))}${askedFor}</span>${note}</span>
      <span class="src-qual">${qt.quality ? `<span class="fmt">${escapeHtml(qt.quality)}</span> · ` : ''}<span class="price">${escapeHtml(qt.price || '—')}</span></span>
      ${pctHtml}`;
    bindToggle(qt.id, selectedQobuzIds);
    return el;
  }

  if (match.source === 'beatport' && match.beatportTrack) {
    const bt = match.beatportTrack;
    if (selectedBeatportIds.has(bt.id)) el.classList.add('sel');
    const sub = [bt.artists.join(', '), bt.bpm ? `${bt.bpm} BPM` : '', bt.key].filter(Boolean).join(' · ');
    el.innerHTML = `
      <span class="src-cbx">${CHECK_SVG}</span>
      <span class="src-badge beatport">Beatport</span>
      <span class="src-trk"><span class="t">${escapeHtml(bt.name)}${versionTag}</span><span class="a">${escapeHtml(sub)}${askedFor}</span>${note}</span>
      <span class="src-qual"><span class="fmt">Lossless</span> · <span class="price">${escapeHtml(bt.price || '—')}</span></span>
      ${pctHtml}`;
    bindToggle(bt.id, selectedBeatportIds);
    return el;
  }

  return buildNotFoundRow(match);
}

/** A Not-found row: no store match, a failed search, or only a lossy copy
 *  (never selectable, never carted). */
function buildNotFoundRow(match: QobuzCartMatch): HTMLElement {
  const el = document.createElement('div');
  el.className = 'src-row info';
  const lossy = match.status === 'matched' && !match.lossless;
  const quality = lossy ? (match.qobuzTrack?.quality || 'lossy') : '';
  el.innerHTML = `
    <span class="src-badge notfound">No source</span>
    <span class="src-trk"><span class="t">${escapeHtml(match.trackInput.artist)} — ${escapeHtml(match.trackInput.title)}</span><span class="sub">${escapeHtml(notFoundReason(match))}</span></span>
    ${lossy ? `<span class="src-tag-lossy">${escapeHtml(quality)}</span>` : ''}`;
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
         <span class="source-group-desc">Not in your library, with a lossless copy for sale. Strong same-version matches are pre-selected; lossy-only matches are under Not found.</span>
         <div class="source-group-actions"><button class="btn-sm btn-ghost" id="src-select-lossless" data-tooltip="Select every track available in full (lossless) quality. Matches flagged as a different version or a whole-release match stay unticked, and compressed copies are never added.">Select all lossless</button></div>
       </div>`
    : `<div class="source-group-head">
         <span class="source-group-title">Not found</span>
         <span class="source-group-desc">No lossless match on Qobuz or Beatport. Lossy-only copies are listed here and never added to a cart.</span>
       </div>`;

  if (list.length === 0) {
    group.appendChild(emptyRow(
      searchQuery
        ? `No tracks match "${searchQuery}".`
        : (seg === 'new' ? 'Nothing new to buy in this list.' : 'Every track had a lossless match.')
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
      if (isOtherVersion(m) || isReleaseMatch(m)) continue;
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

  // Scan summary is the whole scan, independent of any active filter. Only
  // lossless matches count as found; a lossy-only match is "No source".
  const totalChecked = matches.length + libraryMatched.length;
  const notFoundCount = matches.filter(m => !hasLosslessMatch(m)).length;
  const lossyOnly = matches.filter(m => m.status === 'matched' && !m.lossless).length;
  const qFound = matches.filter(m => hasLosslessMatch(m) && m.source === 'qobuz').length;
  const bFound = matches.filter(m => hasLosslessMatch(m) && m.source === 'beatport').length;
  if (totalChecked > 0) {
    scanSummary.style.display = 'flex';
    scanSummary.innerHTML = `
      <span class="ok">✓ Checked ${plural(totalChecked, 'track')} against your library</span>
      <span class="sep">·</span>
      <span class="chip" title="Tracks with a lossless copy on Qobuz">Qobuz <b>${qFound}</b></span>
      <span class="chip" title="Tracks with a lossless copy on Beatport">Beatport <b>${bFound}</b></span>
      <span class="chip" title="${lossyOnly > 0 ? `No lossless copy on either store (${lossyOnly} only lossy, excluded)` : 'No lossless copy on either store'}">No source <b>${notFoundCount}</b></span>`;
  } else {
    scanSummary.style.display = 'none';
  }
}

/** The selected lossless matches for one store as cart payloads, one per store
 *  track: exactly what "Add to carts" sends, so the buy-bar totals agree. */
function selectedForCart(store: Store): StoreMatch[] {
  const ids = store === 'qobuz' ? selectedQobuzIds : selectedBeatportIds;
  return uniqueByTrack(matches
    // Belt-and-suspenders lossless guard — the UI disables these checkboxes
    // but this keeps any DOM-tampering / future refactors from slipping lossy
    // tracks into a cart.
    .filter(m => m.lossless && m.source === store && ids.has((store === 'qobuz' ? m.qobuzTrack : m.beatportTrack)!.id))
    .map(m => toStoreMatch(m, store)));
}

/** Update the sticky buy-bar: selected count, per-store totals, action state. */
function updateBuyBar() {
  // Show the bar whenever the results pane is up (so Clear / Export / + Add list
  // stay reachable even for an all-empty result), hidden only when results are.
  buyBar.style.display = resultsSection.style.display === 'block' ? '' : 'none';

  const qSel = selectedForCart('qobuz');
  const bSel = selectedForCart('beatport');

  buyBarN.textContent = String(qSel.length + bSel.length);
  buyBarQobuz.textContent = `Qobuz ${qSel.length} · ${cartTotal(qSel)}`;
  buyBarBeatport.textContent = `Beatport ${bSel.length} · ${cartTotal(bSel)}`;
  addToCartBtn.disabled = isAddingToCart() || (qSel.length + bSel.length) === 0;
  // A scan in flight owns the results: no clearing them or queueing another list.
  clearResultsBtn.disabled = searching;
  addMoreBtn.disabled = searching;
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
let cartDrawerReturnFocus: HTMLElement | null = null;
function openCartDrawer() {
  renderCartStage();
  if (cartDrawer.style.display === 'none') cartDrawerReturnFocus = document.activeElement as HTMLElement | null;
  cartScrim.style.display = '';
  cartDrawer.style.display = 'flex';
  cartCloseBtn.focus({ preventScroll: true });
}
function closeCartDrawer() {
  const wasOpen = cartDrawer.style.display !== 'none';
  cartDrawer.style.display = 'none';
  cartScrim.style.display = 'none';
  if (wasOpen && cartDrawerReturnFocus?.isConnected) cartDrawerReturnFocus.focus({ preventScroll: true });
  cartDrawerReturnFocus = null;
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
  if (sourceType === 'soundcloud' && !soundcloudUrlValid) {
    showToast('warning', 'Invalid URL', 'Enter a SoundCloud set link (soundcloud.com/…/sets/…).');
    return;
  }
  if (searching) return;

  // One run at a time: two would interleave progress on the shared channels
  // and race to write the results.
  searching = true;
  setStatus('Searching...');
  updateRunButton();
  clearResultsBtn.disabled = true;
  addMoreBtn.disabled = true;
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
  progressMessage.textContent = sourceType === 'spotify'
    ? 'Fetching Spotify playlist...'
    : sourceType === 'soundcloud' ? 'Fetching SoundCloud set...' : 'Starting search...';
  progressCount.textContent = '';
  (progressSection as HTMLElement & { _resetStats?: () => void })._resetStats?.();

  // Collapse the input bar; the progress strip is now the focus.
  inputBar.style.display = 'none';

  try {
    const result = await window.candybar.librarySourcingRun(
      sourceType === 'spotify' ? { spotifyPlaylistUrl }
        : sourceType === 'soundcloud' ? { soundcloudSetUrl }
        : { csvPath }
    );

    if (!result.success || !result.result) {
      showToast('error', 'Search Failed', result.error || 'Unknown error');
      inputBar.style.display = '';
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
    // buys DJ-grade tracks only — and so must a match for a different version
    // (a remix's original, a sped-up edit). Tracks in the local library (confirmed OR
    // probable) are skipped so we don't nudge the user to re-buy what they
    // already own. "Probable" rows start unchecked; toggling "treat as
    // missing" on one flips its libraryStatus and the user can then select
    // manually.
    const toAutoSelect = appendMode
      ? matches.slice(matches.length - appendedCount)
      : matches;
    for (const m of toAutoSelect) {
      if (!autoSelectable(m)) continue;
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
    inputBar.style.display = 'none';
    movePlaylistCardToResults();
    updateSegmentCounts();
    setActiveSegment('new');
    updateBuyBar();
    setStatus('Idle');
    saveSourcesState();
  } catch (err) {
    const message = getErrorMessage(err);
    showToast('error', 'Search Failed', message);
    inputBar.style.display = '';
    setStatus('Error');
  } finally {
    searching = false;
    updateRunButton();
    clearResultsBtn.disabled = false;
    addMoreBtn.disabled = false;
    progressSection.style.display = 'none';
    (progressSection as HTMLElement & { _stopTimer?: () => void })._stopTimer?.();
  }
}

async function addSelectedToCart() {
  if (isAddingToCart()) {
    showToast('info', 'Already Adding', 'Wait for the current cart add to finish.');
    return;
  }
  const qobuzToAdd = selectedForCart('qobuz');
  const beatportToAdd = selectedForCart('beatport');

  if (qobuzToAdd.length === 0 && beatportToAdd.length === 0) {
    showToast('warning', 'No Tracks Selected', 'Select at least one track.');
    return;
  }

  const parts: string[] = [];
  if (qobuzToAdd.length) parts.push(`${qobuzToAdd.length} Qobuz`);
  if (beatportToAdd.length) parts.push(`${beatportToAdd.length} Beatport`);
  showToast('info', 'Adding to Cart', `Adding ${parts.join(' + ')}…`);

  // Disable the trigger + show the inline progress card; each store runs in
  // its own phase so the user sees Qobuz progress, then Beatport progress.
  addToCartBtn.disabled = true;
  cartAddProgress.style.display = 'block';
  const outcome = await addToStoreCarts({ qobuz: qobuzToAdd, beatport: beatportToAdd }, (store, p) => {
    cartAddStore.textContent = STORE_LABEL[store];
    cartAddCount.textContent = `${p.current} / ${p.total}`;
    cartAddBar.style.width = `${p.total > 0 ? Math.round((p.current / p.total) * 100) : 0}%`;
    cartAddMessage.textContent = p.currentTrack ? `${p.message} — ${p.currentTrack}` : p.message;
  });
  cartAddProgress.style.display = 'none';
  toastCartOutcome(outcome);

  // The carts keep everything added this session, so the lists do too — the
  // drawer and the post-checkout download need every batch, not the last one.
  if (outcome.added.qobuz.length > 0) {
    lastAddedQobuz = mergeAdded(lastAddedQobuz, outcome.added.qobuz);
    downloadFiredQobuz = false;
  }
  if (outcome.added.beatport.length > 0) {
    lastAddedBeatport = mergeAdded(lastAddedBeatport, outcome.added.beatport);
    downloadFiredBeatport = false;
  }

  // If any tracks landed in a cart, slide open the cart drawer so the user can
  // see totals + check out, and surface the "Review carts" button for reopening.
  if (outcome.added.qobuz.length + outcome.added.beatport.length > 0) {
    downloadPurchasesBtn.style.display = 'inline-flex';
    openCartDrawer();
  }
  updateBuyBar();
}

/** This tab is sending the user to `store`'s cart: a purchase confirmation
 *  seen in the panel within CHECKOUT_WATCH_MS is taken as this tab's order. */
function armCheckoutWatch(store: Store) {
  checkoutArmedAt[store] = Date.now();
  if (store === 'qobuz') downloadFiredQobuz = false; else downloadFiredBeatport = false;
  saveSourcesState();
}

/** Purchase-confirmation pages, matched on host + path only (never the query,
 *  where sort params like `order_by` live). Cart, login and search pages, and
 *  checkout steps before payment (a "confirm your order" review), are ruled
 *  out even when their path contains a matching word. The exact success URLs
 *  aren't pinned down yet ([panel-nav] logs every one), so the words stay
 *  broad; the arm-on-open window is what keeps stray pages from firing. */
function isPurchaseConfirmation(store: Store, rawUrl: string): boolean {
  let host: string;
  let path: string;
  try {
    const u = new URL(rawUrl);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    return false;
  }
  if (/(^|\/)(cart|shopping-cart|basket|login|signin|sign-in|search)(\/|$)/.test(path)) return false;
  if (/checkout/.test(path) && !/(success|thank|complete|receipt)/.test(path)) return false;
  if (store === 'qobuz') {
    return /(^|\.)qobuz\.com$/.test(host)
      && /(purchase|order|thank|confirm|success|receipt|my-account\/downloads)/.test(path);
  }
  return /(^|\.)beatport\.com$/.test(host)
    && /(order|confirm|thank|success|receipt|downloads|my\/orders)/.test(path);
}

/** Drive the panel through cart → checkout → payment review, stopping before
 *  the final commit. Returns the scraped total (or null) once the page shows
 *  a Place Order CTA. Caller should confirm with the user before clicking. */
async function driveToPlaceOrder(store: 'qobuz' | 'beatport'): Promise<{ ready: boolean; total: string | null; itemCount?: number | null; error?: string }> {
  const MAX_STEPS = 6;
  const STEP_WAIT_MS = 2200;

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await window.candybar.storePanelCheckoutAdvance(store);
    if (!res.success || !res.result) {
      return { ready: false, total: null, error: res.error ?? 'Advance failed' };
    }
    const r = res.result;
    if (r.phase === 'place-order-ready') {
      return { ready: true, total: r.total, itemCount: r.itemCount ?? null };
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
      return { ready: true, total: retry.result.total, itemCount: retry.result.itemCount ?? null };
    }
    if (retry.result.phase === 'advanced') {
      await new Promise(r => setTimeout(r, STEP_WAIT_MS));
      continue;
    }
    return { ready: false, total: null, error: `Couldn't find the next checkout step on this page. Click the store's Checkout button in the panel, then run Auto-Checkout again.` };
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
    armCheckoutWatch(store);
    await window.candybar.storePanelOpen(store, cartUrl(store));
    // Give the page a moment to render after the partition warm-up.
    await new Promise(r => setTimeout(r, 1500));

    button.textContent = `Driving ${label} checkout…`;
    const drive = await driveToPlaceOrder(store);
    if (!drive.ready) {
      showToast('error', 'Auto-checkout stalled', drive.error ?? 'Unknown failure');
      return;
    }

    const displayTotal = drive.total ?? 'Shown in the cart panel';
    // The order is the whole store cart, which can hold more than this tab
    // added (Upgrades, an earlier session). Show the store's own count when the
    // checkout page gives one; otherwise say what the count actually is.
    const countDetail = typeof drive.itemCount === 'number'
      ? { label: 'Items in cart', value: String(drive.itemCount) }
      : { label: 'Added this session', value: String(tracks.length) };
    const confirmed = await confirmAction({
      title: `Buy everything in your ${label} cart?`,
      message: `This places a real order for the whole ${label} cart and charges your ${label} payment method.`,
      details: [
        { label: 'Store', value: label },
        countDetail,
        { label: 'Total', value: displayTotal },
      ],
      safetyNote: `If your bank asks you to approve the payment, that step appears in the ${label} panel.`,
      confirmLabel: drive.total ? `Place order · ${drive.total}` : 'Place order',
      cancelLabel: 'Not now',
      tone: 'caution',
      armMs: 1500,
    });
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
      actionHint: 'Check each track against your library, then look for the missing ones on Qobuz and Beatport. Nothing is bought.',
      actionDisabledHint: 'Choose a CSV file with artist and title columns, or paste a Spotify playlist or SoundCloud set link',
      actionDisabled: true,
      includePreviewStatus: true,
      ids: {
        previewStatus: 'source-csv-preview-status',
        previewStatusText: 'source-csv-preview-status-text',
        soundcloudField: 'source-soundcloud-field',
        soundcloudInput: 'source-soundcloud-set-url',
        soundcloudStatus: 'source-soundcloud-url-status',
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
  csvPreviewStatus = document.getElementById('source-csv-preview-status') as HTMLDivElement;
  csvPreviewStatusText = document.getElementById('source-csv-preview-status-text') as HTMLSpanElement;
  csvFileName = csvFileDisplay.querySelector('.file-name') as HTMLSpanElement;
  clearCsvBtn = document.getElementById('clear-source-csv') as HTMLButtonElement;
  sourceTypeToggle = document.getElementById('source-type-toggle') as HTMLDivElement;
  csvField = document.getElementById('source-csv-field') as HTMLDivElement;
  spotifyField = document.getElementById('source-spotify-field') as HTMLDivElement;
  spotifyUrlInput = document.getElementById('source-spotify-playlist-url') as HTMLInputElement;
  spotifyUrlStatus = document.getElementById('source-spotify-url-status') as HTMLSpanElement;
  soundcloudField = document.getElementById('source-soundcloud-field') as HTMLDivElement;
  soundcloudUrlInput = document.getElementById('source-soundcloud-set-url') as HTMLInputElement;
  soundcloudUrlStatus = document.getElementById('source-soundcloud-url-status') as HTMLSpanElement;

  // Run search
  runSearchBtn.addEventListener('click', () => runSearch());

  // CSV Drop Zone. "Drop CSV or click to browse": a click anywhere on the
  // empty zone opens the same file picker as its Browse button.
  csvDropZone.addEventListener('click', (event) => {
    if (csvDropZone.classList.contains('has-file')) return;
    if ((event.target as HTMLElement).closest('button')) return; // Browse handles itself
    csvDropZone.querySelector<HTMLButtonElement>('[data-browse]')?.click();
  });
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
      const type = (btn as HTMLButtonElement).dataset.sourceType as SourceType;
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

  // SoundCloud set URL input (debounced)
  let soundcloudUrlDebounce: ReturnType<typeof setTimeout>;
  soundcloudUrlInput.addEventListener('input', () => {
    clearTimeout(soundcloudUrlDebounce);
    soundcloudUrlDebounce = setTimeout(() => {
      validateSoundCloudUrl(soundcloudUrlInput.value);
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
  cartCloseBtn.setAttribute('aria-label', 'Close carts');
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || cartDrawer.style.display === 'none') return;
    e.preventDefault();
    closeCartDrawer();
  });

  // Search filter
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    renderResults();
    updateSegmentCounts();
  });

  // Add to cart
  addToCartBtn.addEventListener('click', () => addSelectedToCart());

  // "+ Add More Tracks" — queue an append search. Clears the source input so
  // the user can drop a new CSV or paste a new Spotify/SoundCloud URL, then the
  // next runSearch() merges the new matches into the existing stack (deduped by
  // input key).
  addMoreBtn.addEventListener('click', () => {
    if (searching) return;
    appendMode = true;
    clearCsvFile();
    if (spotifyUrlInput) {
      spotifyUrlInput.value = '';
      validateSpotifyUrl('');
    }
    if (soundcloudUrlInput) {
      soundcloudUrlInput.value = '';
      validateSoundCloudUrl('');
    }
    // Reveal the input bar again above the current results so the next run
    // merges into them.
    inputBar.style.display = '';
    inputBar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  // Open cart in embedded store panel. Close the review drawer first — its
  // full-window scrim would otherwise sit over the app (and the drawer itself
  // hides behind the panel); the native cart panel replaces it.
  openQobuzCartBtn.addEventListener('click', () => {
    closeCartDrawer();
    armCheckoutWatch('qobuz');
    void window.candybar.storePanelOpen('qobuz', cartUrl('qobuz'));
  });
  openBeatportCartBtn.addEventListener('click', () => {
    closeCartDrawer();
    armCheckoutWatch('beatport');
    void window.candybar.storePanelOpen('beatport', cartUrl('beatport'));
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
    showToast('info', 'Starting downloads', `Fetching ${plural(all.length, 'purchased track')}…`);
    try {
      const res = await window.candybar.storeDownloadPurchases(all);
      if (res.success) {
        showToast('success', 'Downloads complete',
          `${res.downloaded ?? 0} of ${all.length} downloaded → ${res.destDir ?? 'library'}`);
      } else {
        showToast('error', 'Downloads Failed', res.error ?? 'Unknown error');
      }
    } catch (e) {
      showToast('error', 'Downloads Failed', getErrorMessage(e, 'Download failed'));
    } finally {
      downloadPurchasesBtn.disabled = false;
    }
  });

  // Watch panel navigation for purchase-confirmation URLs → auto-trigger
  // downloads of the tracks we pushed to each cart. Only for a store whose
  // cart this tab opened recently (armCheckoutWatch), and once per checkout.
  window.candybar.onStorePanelNavigated(async ({ url }) => {
    if (!url) return;
    // Log every navigation so we can tighten the success-URL patterns when the
    // user tells us where they landed after completing checkout.
    console.log('[panel-nav]', url);
    for (const store of ['qobuz', 'beatport'] as const) {
      const armedAt = checkoutArmedAt[store];
      const list = store === 'qobuz' ? lastAddedQobuz : lastAddedBeatport;
      const fired = store === 'qobuz' ? downloadFiredQobuz : downloadFiredBeatport;
      if (fired || list.length === 0 || armedAt === null || Date.now() - armedAt > CHECKOUT_WATCH_MS) continue;
      if (!isPurchaseConfirmation(store, url)) continue;

      if (store === 'qobuz') downloadFiredQobuz = true; else downloadFiredBeatport = true;
      checkoutArmedAt[store] = null;
      saveSourcesState();
      const label = STORE_LABEL[store];
      showToast('info', `${label} Purchase Detected`, `Starting downloads for ${plural(list.length, 'track')}…`);
      try {
        const res = await window.candybar.storeDownloadPurchases(list);
        if (res.success) {
          showToast('success', `${label} Downloads Started`,
            `${res.downloaded ?? 0} downloaded → ${res.destDir ?? 'library'}`);
        } else {
          showToast('error', `${label} Downloads Failed`, res.error ?? 'Unknown error');
        }
      } catch (e) {
        showToast('error', `${label} Downloads Failed`, getErrorMessage(e, 'Download failed'));
      }
    }
  });

  // Export CSV
  exportCsvBtn.addEventListener('click', () => exportResults());

  // Clear results
  clearResultsBtn.addEventListener('click', () => {
    if (searching) return;
    matches = [];
    libraryMatched = [];
    libraryProbable = [];
    selectedQobuzIds = new Set();
    selectedBeatportIds = new Set();
    lastAddedQobuz = [];
    lastAddedBeatport = [];
    checkoutArmedAt = { qobuz: null, beatport: null };
    appendMode = false;
    clearPlaylistCard();
    closeCartDrawer();
    resultsSection.style.display = 'none';
    cartSection.style.display = 'none';
    buyBar.style.display = 'none';
    downloadPurchasesBtn.style.display = 'none';
    inputBar.style.display = '';
    saveSourcesState();
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

  // Phase-1 (library match) progress. Phase 1 runs BEFORE the store search —
  // the hero shows "Checking library…" then switches to store progress once
  // phase-2 events start flowing.
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

  // Phase-2 (store search) progress.
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

  // Phase-2 per-match events drive the live-recent-matches feed.
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
    // Same rule as the results: only a lossless match counts as found.
    const lossless = hasLosslessMatch(match);
    if (lossless && match.source === 'qobuz') { liveQobuz++; if (progressQobuzCount) progressQobuzCount.textContent = String(liveQobuz); }
    else if (lossless && match.source === 'beatport') { liveBeatport++; if (progressBeatportCount) progressBeatportCount.textContent = String(liveBeatport); }
    else { liveNotFound++; if (progressNotFoundCount) progressNotFoundCount.textContent = String(liveNotFound); }

    if (!progressRecent) return;
    const found = lossless && match.source && (match.qobuzTrack || match.beatportTrack);
    const art = found
      ? (match.qobuzTrack?.image
          ? `<img class="recent-art" src="${escapeHtml(match.qobuzTrack.image)}" alt="" loading="lazy" />`
          : `<div class="recent-art recent-art--placeholder"></div>`)
      : `<div class="recent-art recent-art--miss">—</div>`;
    const title = found
      ? (match.qobuzTrack?.name ?? match.beatportTrack?.name ?? '')
      : `${match.trackInput.artist} — ${match.trackInput.title}`;
    const lossyOnly = match.status === 'matched' && !match.lossless;
    const artist = found
      ? (match.qobuzTrack?.artists.join(', ') ?? match.beatportTrack?.artists.join(', ') ?? '')
      : lossyOnly ? 'only a lossy copy, excluded' : 'not found';
    const badgeClass = found ? match.source : 'notfound';
    const badgeText = found ? STORE_LABEL[match.source!] : 'Miss';
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
      ${found ? `<span class="recent-match-pct">${pct}%</span>` : ''}
    `;
    attachArtFallback(row);
    progressRecent.prepend(row);
    while (progressRecent.children.length > 4) progressRecent.removeChild(progressRecent.lastElementChild!);
  }

  // Persist reviewable state across HMR / renderer reloads, and rehydrate it now.
  window.addEventListener('beforeunload', saveSourcesState);
  restoreSourcesState();
}
