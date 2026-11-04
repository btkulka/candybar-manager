import type { QobuzCartMatch } from '../lib/qobuzCart';
import { cartUrl } from '../lib/storeUrls';
import type {
  CsvPreview, StoreMatch, LibraryMatchedRow, LibraryProbableRow, SourcePlaylistInfo,
  SavedSource, SavedSourceCounts, SavedSourceInput, SavedSourceKind, SourcingFinderSummary,
} from '../types';
import { showToast, setStatus, escapeHtml, setValue, getErrorMessage, plural, formatPriceTotal, isReleaseMatch, requestOpenSettings } from './shared';
import { confirmAction } from './confirmDialog';
import { renderSourceInput, SOURCE_KIND_ICONS } from './sourceInputTemplate';
import { fillPlaylistCard } from './playlistCard';
import {
  type Store, STORE_LABEL, autoSelectable, isOtherVersion, parsePriceDollars, toStoreMatch,
  addToStoreCarts, isAddingToCart, toastCartOutcome, mergeAdded, uniqueByTrack,
  matchPillHtml, qualityHtml, notForSaleReason, notForSalePillHtml, isCompressedOnly, AUTO_SELECT_CONFIDENCE, revealInContent,
  reconcileWithCart, type CartReconcile,
} from './storeCart';
import { isStoreCheckoutStep } from '../lib/mainGuards';
import { exportM3u8, exportRekordbox, exportCsv } from './libraryExport';
import { isArtistHeader, isTitleHeader } from '../lib/csvHeaders';
import { attachSourcingReview, claudeVerdictHtml, SPINNER_SVG } from './claudeReview';

// Find and buy tracks: a Spotify playlist, SoundCloud set or spreadsheet is
// checked against the Rekordbox collection, the rest is searched on Qobuz and
// Beatport, and the ticked full-quality matches go in the store carts. Only
// lossless matches can ever be ticked or carted; compressed-only matches are
// listed under "Not for sale in full quality" and never sent.
//
// One workspace, no wizard: the picker (plus "Your playlists") is the start
// screen, the progress card shows while a check runs, and the results take
// over afterwards, with the picker collapsed to the "add another" strip.

// ========== DOM Elements ==========

let runSearchBtn: HTMLButtonElement;
let runSearchLabel: HTMLElement;

const inputBar = document.getElementById('source-input-bar') as HTMLElement;
const pickerTitle = document.getElementById('source-picker-title') as HTMLElement;
const addStrip = document.getElementById('source-add-strip') as HTMLElement;
const appendHead = document.getElementById('source-append-head') as HTMLElement;
const progressSection = document.getElementById('source-progress-section') as HTMLElement;
const progressBar = document.getElementById('source-progress-bar') as HTMLDivElement;
const progressMessage = document.getElementById('source-progress-message') as HTMLElement;
const progressSub = document.getElementById('source-progress-sub') as HTMLElement;
const progressCount = document.getElementById('source-progress-count') as HTMLSpanElement;

const savedCard = document.getElementById('source-saved') as HTMLElement;
const savedList = document.getElementById('source-saved-list') as HTMLElement;
const savedDesc = document.getElementById('source-saved-desc') as HTMLElement;
const savedTogetherBtn = document.getElementById('source-saved-together') as HTMLButtonElement;

const resultsSection = document.getElementById('source-results-section') as HTMLElement;
const groupsContainer = document.getElementById('source-groups') as HTMLDivElement;
const emptyState = document.getElementById('source-empty') as HTMLDivElement;
const scanSummary = document.getElementById('source-scan-summary') as HTMLDivElement;


const searchInput = document.getElementById('source-search') as HTMLInputElement;

// Sticky buy bar
const buyBar = document.getElementById('source-buybar') as HTMLElement;
const buyBarN = document.getElementById('source-buybar-n') as HTMLElement;
const buyBarQobuz = document.getElementById('source-buybar-qobuz') as HTMLElement;
const buyBarBeatport = document.getElementById('source-buybar-beatport') as HTMLElement;
const reviewCartBtn = document.getElementById('source-review-cart') as HTMLButtonElement;
const addToCartBtn = document.getElementById('source-add-to-cart') as HTMLButtonElement;
const exportCsvBtn = document.getElementById('source-export-csv') as HTMLButtonElement;

// Cart slide-over
const cartDrawer = document.getElementById('source-cart-drawer') as HTMLElement;
const cartScrim = document.getElementById('source-cart-scrim') as HTMLElement;
const cartCloseBtn = document.getElementById('source-cart-close') as HTMLButtonElement;
const openQobuzCartBtn = document.getElementById('source-open-qobuz-cart') as HTMLButtonElement;
const openBeatportCartBtn = document.getElementById('source-open-beatport-cart') as HTMLButtonElement;
const downloadPurchasesBtn = document.getElementById('source-download-purchases') as HTMLButtonElement;
const cartDownload = document.getElementById('source-cart-download') as HTMLElement;
const cartSection = document.getElementById('source-cart-section') as HTMLElement;
const cartQobuzBlock = document.getElementById('source-cart-qobuz') as HTMLElement;
const cartQobuzList = document.getElementById('source-cart-qobuz-list') as HTMLDivElement;
const cartQobuzMeta = document.getElementById('source-cart-qobuz-meta') as HTMLElement;
const cartQobuzGone = document.getElementById('source-cart-qobuz-gone') as HTMLElement;
const cartBeatportBlock = document.getElementById('source-cart-beatport') as HTMLElement;
const cartBeatportList = document.getElementById('source-cart-beatport-list') as HTMLDivElement;
const cartBeatportMeta = document.getElementById('source-cart-beatport-meta') as HTMLElement;
const cartBeatportGone = document.getElementById('source-cart-beatport-gone') as HTMLElement;
const cartDownloadTitle = document.getElementById('source-cart-download-title') as HTMLElement;
const cartDownloadText = document.getElementById('source-cart-download-text') as HTMLElement;
const autoCheckoutQobuzBtn = document.getElementById('source-auto-checkout-qobuz') as HTMLButtonElement;
const autoCheckoutBeatportBtn = document.getElementById('source-auto-checkout-beatport') as HTMLButtonElement;

// Cart-add progress (shown while tracks go into a store cart)
const cartAddProgress = document.getElementById('source-cart-add-progress') as HTMLElement;
const cartAddStore = document.getElementById('source-cart-add-store') as HTMLElement;
const cartAddCount = document.getElementById('source-cart-add-count') as HTMLElement;
const cartAddBar = document.getElementById('source-cart-add-bar') as HTMLElement;
const cartAddMessage = document.getElementById('source-cart-add-message') as HTMLElement;

// Late-bound: the picker's elements are injected at init
let csvDropZone: HTMLDivElement;
let csvFileDisplay: HTMLDivElement;
let csvPreviewSection: HTMLDetailsElement;
let csvPreviewCount: HTMLSpanElement;
let csvPreviewColumns: HTMLSpanElement;
let csvPreviewThead: HTMLTableSectionElement;
let csvPreviewTbody: HTMLTableSectionElement;
let csvPreviewStatus: HTMLDivElement;
let csvPreviewStatusText: HTMLElement;
let csvFileName: HTMLSpanElement;
let clearCsvBtn: HTMLButtonElement;
/** The one link field: a Spotify playlist or a SoundCloud set, told apart by the link. */
let linkInput: HTMLInputElement;
let linkIcon: HTMLElement;
let linkStatus: HTMLElement;
/** Inline error for a check that failed (what happened + what to do). */
let runError: HTMLElement;

// ========== State ==========

let matches: QobuzCartMatch[] = [];
/** Library buckets from `library-sourcing:run`. `matched` = already in the
 *  library (not store-searched), `probable` = an uncertain library hit (store-
 *  searched AND shown under "You might have these"). */
let libraryMatched: LibraryMatchedRow[] = [];
let libraryProbable: LibraryProbableRow[] = [];
/** The last checked Spotify playlist / SoundCloud set, shown as a cover card. */
let currentPlaylistInfo: SourcePlaylistInfo | null = null;
/** The quieter groups under To buy, by key, that are expanded. */
type Group = 'maybe' | 'owned' | 'notfound';
let openGroups = new Set<Group>();
/** To buy rows whose store / quality details are showing. */
const openRows = new Set<string>();
let searchQuery = '';
let csvPath = '';
type SourceType = SavedSourceKind;
let sourceType: SourceType = 'spotify';
let spotifyPlaylistUrl = '';
let spotifyUrlValid = false;
let soundcloudSetUrl = '';
let soundcloudUrlValid = false;
let selectedQobuzIds: Set<string> = new Set();
let selectedBeatportIds: Set<string> = new Set();
/** When true, the next runSearch() merges its results into the list on screen. */
let appendMode = false;
/** Tracks put in each store's cart during this session; used for the cart
 *  drawer and to download them once a checkout completes. */
let lastAddedQobuz: StoreMatch[] = [];
let lastAddedBeatport: StoreMatch[] = [];
let downloadFiredQobuz = false;
let downloadFiredBeatport = false;
/** When this tab last opened a store's cart (Open cart or Fill in checkout).
 *  The purchase watcher only acts for a store with a recent entry, so a
 *  checkout started from another tab, or a later browse past an order page,
 *  never downloads this tab's list. Saved with the session, like the lists. */
let checkoutArmedAt: Record<Store, number | null> = { qobuz: null, beatport: null };
/** How long after opening the cart a purchase still counts as this tab's. */
const CHECKOUT_WATCH_MS = 3 * 60 * 60 * 1000;
/** Each store's real cart as last read. Not saved: it's read again when the
 *  drawer opens. Null until read, and after an add the read hasn't seen. */
let cartChecks: Record<Store, CartReconcile | null> = { qobuz: null, beatport: null };
let cartChecking = false;
/** The panel reached checkout proper since this tab opened the cart. A
 *  purchase confirmation only counts after one, so browsing your downloads
 *  page never fires the post-checkout download. */
const checkoutSeen: Record<Store, boolean> = { qobuz: false, beatport: false };
/** True while a check is running: the picker, saved list and add strip stay locked. */
let searching = false;

/** One source to check: what kind, and its link or file path. */
type SourceSpec = { kind: SourceType; ref: string; name?: string; relocateFrom?: number };
/** The sources merged into the list on screen, oldest first. */
let sessionSources: Array<{ kind: SourceType; ref: string; name: string }> = [];
/** When the list on screen was last checked. */
let lastRunAt: number | null = null;
/** Playlist metadata for the check that's running (from playlist-info). */
let runPlaylistInfo: SourcePlaylistInfo | null = null;
/** Who picked the store matches on screen: Claude, or the plain search (and why). */
let finderInfo: SourcingFinderSummary | null = null;

// A SoundCloud set's own free downloads ("Free on SoundCloud")
/** Track keys ticked for "Get free downloads". */
let selectedFree = new Set<string>();
let fetchingFree = false;
let freeAccountActions = false;
let freeLine = '';
let freeCount: { i: number; n: number } | null = null;

// Saved playlists
let savedSources: SavedSource[] = [];
let savedLoaded = false;
const savedSelected = new Set<number>();
let renamingId: number | null = null;

const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
const NOTE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
const SEARCH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const INFO_SVG = '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
const ERROR_SVG = '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
const PENCIL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
const REFRESH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';

const KIND_LABEL: Record<SourceType, string> = { spotify: 'Spotify', soundcloud: 'SoundCloud', csv: 'Spreadsheet' };

// ========== Cart drawer ==========

function renderCartLines(container: HTMLDivElement, tracks: StoreMatch[]) {
  container.innerHTML = '';
  for (const t of tracks) {
    const line = document.createElement('div');
    line.className = 'buy-cart-line';
    const art = t.image
      ? `<img class="buy-cart-line-art" src="${escapeHtml(t.image)}" alt="" loading="lazy" />`
      : `<div class="buy-cart-line-art buy-art--placeholder">${NOTE_SVG}</div>`;
    line.innerHTML = `
      ${art}
      <div class="buy-cart-line-text">
        <span class="buy-cart-line-title">${escapeHtml(t.title)}</span>
        <span class="buy-cart-line-artist">${escapeHtml(t.artist)}</span>
      </div>
      <span class="buy-cart-line-price">${t.price ? escapeHtml(t.price) : '—'}</span>
    `;
    const img = line.querySelector<HTMLImageElement>('img.buy-cart-line-art');
    img?.addEventListener('error', () => {
      const placeholder = document.createElement('div');
      placeholder.className = 'buy-cart-line-art buy-art--placeholder';
      placeholder.innerHTML = NOTE_SVG;
      img.replaceWith(placeholder);
    }, { once: true });
    container.appendChild(line);
  }
}

/** Summed price, in the currency the store's own prices are written in. */
function cartTotal(tracks: StoreMatch[]): string {
  return formatPriceTotal(tracks.reduce((s, t) => s + parsePriceDollars(t.price), 0), tracks.map(t => t.price));
}

/** One store's added tracks, split by its real cart once that's been read. */
function cartView(store: Store): CartReconcile {
  const list = store === 'qobuz' ? lastAddedQobuz : lastAddedBeatport;
  const check = cartChecks[store];
  if (!check) return { inCart: list, gone: [], checked: false, empty: false };
  const gone = new Set(check.gone.map(m => m.trackId));
  return { inCart: list.filter(m => !gone.has(m.trackId)), gone: list.filter(m => gone.has(m.trackId)), checked: check.checked, empty: check.empty };
}

/** Read both stores' carts and redraw what depends on them. */
async function refreshCartChecks(): Promise<void> {
  if (cartChecking || lastAddedQobuz.length + lastAddedBeatport.length === 0) return;
  cartChecking = true;
  renderCartStage();
  try {
    const [q, b] = await Promise.all([
      reconcileWithCart('qobuz', lastAddedQobuz),
      reconcileWithCart('beatport', lastAddedBeatport),
    ]);
    cartChecks = { qobuz: q, beatport: b };
  } finally {
    cartChecking = false;
    renderCartStage();
    renderCartHero();
  }
}

function renderCartStore(store: Store, els: { block: HTMLElement; meta: HTMLElement; list: HTMLDivElement; gone: HTMLElement; checkout: HTMLButtonElement }) {
  const remembered = store === 'qobuz' ? lastAddedQobuz : lastAddedBeatport;
  els.block.style.display = remembered.length > 0 ? '' : 'none';
  if (remembered.length === 0) return;
  const label = STORE_LABEL[store];
  const v = cartView(store);

  els.meta.innerHTML = v.inCart.length > 0
    ? `${escapeHtml(plural(v.inCart.length, 'track'))} · <strong>${escapeHtml(cartTotal(v.inCart))}</strong>`
    : v.empty ? 'Cart is empty' : '';
  els.list.style.display = v.inCart.length > 0 ? '' : 'none';
  renderCartLines(els.list, v.inCart);

  const note = cartChecking && !cartChecks[store]
    ? `Checking what's in your ${label} cart…`
    : v.gone.length === 0
      ? ''
      : v.inCart.length === 0
        ? `Your ${label} cart no longer has the ${plural(v.gone.length, 'track')} Track Lab added: bought, or taken out.`
        : `${plural(v.gone.length, 'other track')} Track Lab added ${v.gone.length === 1 ? 'is' : 'are'} no longer in your ${label} cart: bought, or taken out.`;
  els.gone.hidden = !note;
  els.gone.textContent = note;

  // Nothing to drive through when the store's cart is empty.
  els.checkout.disabled = v.empty;
  els.checkout.setAttribute('data-tooltip-disabled', `Your ${label} cart is empty`);
}

function renderCartStage() {
  renderCartStore('qobuz', { block: cartQobuzBlock, meta: cartQobuzMeta, list: cartQobuzList, gone: cartQobuzGone, checkout: autoCheckoutQobuzBtn });
  renderCartStore('beatport', { block: cartBeatportBlock, meta: cartBeatportMeta, list: cartBeatportList, gone: cartBeatportGone, checkout: autoCheckoutBeatportBtn });

  const q = cartView('qobuz');
  const b = cartView('beatport');
  // One primary per view: the first store with something to check out leads;
  // with nothing left in either cart, the download does.
  const qLeads = lastAddedQobuz.length > 0 && !q.empty;
  autoCheckoutQobuzBtn.className = qLeads ? 'btn-primary' : 'btn-secondary';
  autoCheckoutBeatportBtn.className = !qLeads && lastAddedBeatport.length > 0 && !b.empty ? 'btn-primary' : 'btn-secondary';

  const gone = q.gone.length + b.gone.length;
  const any = lastAddedQobuz.length + lastAddedBeatport.length > 0;
  cartDownload.style.display = any ? '' : 'none';
  cartDownloadTitle.textContent = gone > 0 ? `${plural(gone, 'track')} left your carts` : 'Checked out already?';
  cartDownloadText.textContent = gone > 0
    ? 'If you checked out, download them into your new-music folder, ready to sort.'
    : 'Download what you bought into your new-music folder, ready to sort.';
  downloadPurchasesBtn.className = q.inCart.length + b.inCart.length === 0 && gone > 0 ? 'btn-primary' : 'btn-secondary';
  cartSection.style.display = any ? 'flex' : 'none';
}

/** Drop tracks that were downloaded (by input key) from the added lists:
 *  bought and fetched, they're no longer anything to check out. */
function pruneDownloaded(keys: Set<string>) {
  if (keys.size === 0) return;
  lastAddedQobuz = lastAddedQobuz.filter(m => !keys.has(m.input.key));
  lastAddedBeatport = lastAddedBeatport.filter(m => !keys.has(m.input.key));
  saveSourcesState();
  renderCartStage();
  updateBuyBar();
}

// ========== Picker ==========

let csvHasRequiredCols = false;

function updateRunButton() {
  if (!runSearchBtn) return;
  if (searching) {
    runSearchBtn.disabled = true;
  } else if (sourceType === 'csv') {
    runSearchBtn.disabled = !csvPath || !csvHasRequiredCols;
  } else if (sourceType === 'spotify') {
    runSearchBtn.disabled = !spotifyUrlValid;
  } else {
    runSearchBtn.disabled = !soundcloudUrlValid;
  }
  const hint = sourceType === 'csv' && csvPath
    ? 'This spreadsheet needs an Artist column and a Title column'
    : linkInput?.value.trim()
      ? 'That link isn\'t a Spotify playlist or a SoundCloud set'
      : 'Paste a playlist link or choose a spreadsheet first';
  runSearchBtn.setAttribute('data-tooltip-disabled', searching ? 'A check is already running' : hint);
  runSearchLabel.textContent = appendMode && resultsShown() ? 'Add to this list' : 'Check this playlist';
}

function resultsShown(): boolean {
  return resultsSection.style.display !== 'none';
}

/** The picker and the add strip trade places: with a list on screen and
 *  nothing running, the picker collapses to the strip. */
function setInputBarVisible(visible: boolean): void {
  inputBar.style.display = visible ? '' : 'none';
  syncAddStrip();
}

function syncAddStrip(): void {
  const listShown = resultsShown();
  const pickerShown = inputBar.style.display !== 'none';
  addStrip.style.display = listShown && !pickerShown && !searching ? '' : 'none';
  const appending = appendMode && pickerShown && listShown;
  appendHead.style.display = appending ? '' : 'none';
  pickerTitle.textContent = appending ? 'Add another playlist to this list' : 'Add a playlist';
  // The saved list sits under the picker whenever it's open.
  savedCard.style.display = pickerShown && !searching && savedLoaded ? '' : 'none';
  // While merging another list in, the picker is the task; the buy bar waits.
  if (appending) buyBar.style.display = 'none';
  else if (listShown) buyBar.style.display = '';
  updateRunButton();
  renderSaved();
}

/** Reopen the picker above the current list, optionally on one source type;
 *  the next run merges into the list (deduped by input key). */
function beginAppend(): void {
  if (searching) return;
  appendMode = true;
  clearCsvFile();
  linkInput.value = '';
  validateLink('');
  hideRunError();
  setInputBarVisible(true);
  revealInContent(inputBar);
  linkInput.focus();
}

function cancelAppend(): void {
  if (searching) return;
  appendMode = false;
  setInputBarVisible(!resultsShown());
}

/** "Back to your playlists" puts away the list on screen and its ticks, so
 *  ask first. Store carts and the library aren't touched. */
async function confirmClearResults(): Promise<void> {
  if (searching) return;
  if (matches.length + libraryMatched.length + libraryProbable.length > 0) {
    // The playlist's own count; summing the result lists double-counts, since
    // store matches overlap the maybe-owned rows.
    const info = currentPlaylistInfo;
    const count = info ? (info.fetchedCount || info.trackCount) : 0;
    const what = info?.name ? `"${info.name}"${count ? ` (${plural(count, 'track')})` : ''}` : 'the list you are looking at';
    const ok = await confirmAction({
      title: 'Put this list away?',
      message: `This puts away ${what} and your ticks, and takes you back to your playlists. It stays there, so you can check it again any time.`,
      safetyNote: 'Nothing in your Qobuz or Beatport carts or your library changes.',
      confirmLabel: 'Put it away',
      tone: 'caution',
    });
    if (!ok) return;
  }
  clearResults();
}

function clearResults(): void {
  matches = [];
  libraryMatched = [];
  libraryProbable = [];
  selectedQobuzIds = new Set();
  selectedBeatportIds = new Set();
  lastAddedQobuz = [];
  lastAddedBeatport = [];
  cartChecks = { qobuz: null, beatport: null };
  checkoutArmedAt = { qobuz: null, beatport: null };
  sessionSources = [];
  lastRunAt = null;
  appendMode = false;
  selectedFree = new Set();
  finderInfo = null;
  clearPlaylistCard();
  closeCartDrawer();
  resultsSection.style.display = 'none';
  cartSection.style.display = 'none';
  buyBar.style.display = 'none';
  setInputBarVisible(true);
  saveSourcesState();
}

function setFieldHelp(el: HTMLElement, text: string, tone: '' | 'ok' | 'error') {
  el.textContent = text;
  el.className = `field-help${tone ? ` is-${tone}` : ''}`;
}

const SPOTIFY_PLAYLIST = /open\.spotify\.com\/(?:intl-[a-z]+\/)?playlist\/[a-zA-Z0-9]+|^spotify:playlist:[a-zA-Z0-9]+$|^[a-zA-Z0-9]{22}$/;
/** A set link (soundcloud.com/<user>/sets/<name>, optionally with a secret
 *  /s-TOKEN segment) or an on.soundcloud.com share link, which the main
 *  process expands. */
const SOUNDCLOUD_SET = /^(https?:\/\/)?(www\.|m\.)?soundcloud\.com\/[^/?#\s]+\/sets\/[^/?#\s]+|^(https?:\/\/)?on\.soundcloud\.com\/[A-Za-z0-9]+/i;

/** Read the link field: which service it is, whether it's a playlist/set, and
 *  what to tell the person. A track, album or profile link is turned away here
 *  rather than failing later. */
function validateLink(raw: string) {
  const v = raw.trim();
  spotifyPlaylistUrl = '';
  soundcloudSetUrl = '';
  spotifyUrlValid = false;
  soundcloudUrlValid = false;
  let icon: keyof typeof SOURCE_KIND_ICONS = 'link';

  if (!v) {
    if (!csvPath) sourceType = 'spotify';
    setFieldHelp(linkStatus, '', '');
  } else if (/spotify/i.test(v) || /^[a-zA-Z0-9]{22}$/.test(v)) {
    sourceType = 'spotify';
    icon = 'spotify';
    spotifyPlaylistUrl = v;
    spotifyUrlValid = SPOTIFY_PLAYLIST.test(v);
    setFieldHelp(linkStatus, spotifyUrlValid
      ? 'Spotify playlist. Ready to check.'
      : /open\.spotify\.com\/(?:intl-[a-z]+\/)?(track|album|artist|show|episode)\//.test(v)
        ? "That's a link to a single track, album or artist. Copy the link of a playlist instead."
        : "That doesn't look like a Spotify playlist link. It should start with https://open.spotify.com/playlist/",
    spotifyUrlValid ? 'ok' : 'error');
  } else if (/soundcloud/i.test(v)) {
    sourceType = 'soundcloud';
    icon = 'soundcloud';
    soundcloudSetUrl = v;
    soundcloudUrlValid = SOUNDCLOUD_SET.test(v);
    setFieldHelp(linkStatus, soundcloudUrlValid
      ? 'SoundCloud set. Ready to check.'
      : "That's a SoundCloud link, but not to a set. A set link has /sets/ in it, like soundcloud.com/artist/sets/name.",
    soundcloudUrlValid ? 'ok' : 'error');
  } else {
    sourceType = 'spotify';
    setFieldHelp(linkStatus, "Track Lab doesn't recognise that link. Paste a link to a Spotify playlist or a SoundCloud set, or use a spreadsheet below.", 'error');
  }
  linkIcon.innerHTML = SOURCE_KIND_ICONS[icon];
  linkIcon.dataset.kind = icon;
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
  // Say why the check button stays off, instead of leaving a dead button.
  const missing = [!preview.hasArtistColumn && 'an Artist', !preview.hasTitleColumn && 'a Title'].filter(Boolean);
  setCsvStatus(missing.length > 0
    ? `Track Lab couldn't find ${missing.join(' or ')} column. Name the columns "Artist" and "Title" (a playlist saved with Exportify works as it is), then choose the file again.`
    : '');
  csvPreviewSection.style.display = '';
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

/** Restore a Spotify playlist link saved in config by older builds. */
export function restoreSourceSpotifyUrl(url: string) {
  if (!url || !linkInput) return;
  setLink(url);
}

/** Put a link in the field (clearing any spreadsheet) and read it. */
function setLink(url: string) {
  if (csvPath) clearCsvFile();
  linkInput.value = url;
  validateLink(url);
}

export async function setSourceCsvFile(filePath: string) {
  csvPath = filePath;
  sourceType = 'csv';
  setValue('source-csv', filePath);
  csvFileName.textContent = fileNameOf(filePath);
  csvDropZone.classList.add('has-file');
  inputBar.classList.add('has-csv');
  // A spreadsheet replaces any pasted link.
  linkInput.value = '';
  setFieldHelp(linkStatus, '', '');
  linkIcon.innerHTML = SOURCE_KIND_ICONS.link;
  updateRunButton();

  try {
    const preview = await window.candybar.previewCsv(filePath);
    if (csvPath !== filePath) return; // a different file was picked meanwhile
    renderCsvPreview(preview);
  } catch (err) {
    console.error('Failed to preview CSV:', err);
    hideCsvPreview();
    showToast('error', "Couldn't open that spreadsheet", getErrorMessage(err));
  }
}

function clearCsvFile() {
  const had = !!csvPath;
  csvPath = '';
  setValue('source-csv', '');
  csvFileName.textContent = '';
  csvDropZone.classList.remove('has-file');
  inputBar.classList.remove('has-csv');
  hideCsvPreview();
  if (had) validateLink(linkInput.value);
}

function fileNameOf(p: string): string {
  return p.split('/').pop() || p;
}

/** A spreadsheet's name for the saved list: its file name without ".csv". */
function csvDisplayName(p: string): string {
  return fileNameOf(p).replace(/\.csv$/i, '');
}

// ========== Run errors ==========

function showRunError(message: string) {
  const needsSpotify = /spotify/i.test(message) && /(credential|client id|settings)/i.test(message);
  runError.innerHTML = `
    ${ERROR_SVG}
    <div class="callout-body">
      <strong>Track Lab couldn't check this playlist</strong>
      <p>${needsSpotify
        ? 'Track Lab needs to be connected to Spotify before it can read playlists.'
        : 'Check the link or file, then try again. If it keeps happening, the details below say why.'}</p>
      ${needsSpotify ? '' : `<details class="buy-error-details"><summary>Show details</summary><p>${escapeHtml(message)}</p></details>`}
    </div>
    ${needsSpotify ? '<div class="callout-actions"><button type="button" class="btn-secondary btn-sm" data-run-error="spotify">Connect Spotify</button></div>' : ''}`;
  runError.style.display = '';
  runError.querySelector('[data-run-error="spotify"]')?.addEventListener('click', () => requestOpenSettings('spotify'));
}

function hideRunError() {
  if (runError) runError.style.display = 'none';
}

// ========== Results ==========

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
 *  compressed-only match counts as not for sale, the same as on Upgrades. */
function hasLosslessMatch(m: QobuzCartMatch): boolean {
  return m.status === 'matched' && m.lossless;
}

/** "Get free downloads" ran for this track and nothing full quality landed. */
function freeFailed(m: QobuzCartMatch): boolean {
  return !!m.freeOutcome && !m.freeOutcome.filePath;
}

/** In "Free on SoundCloud": the set gives it away, it isn't maybe-owned, and
 *  a free download hasn't already failed (then it falls back to its store
 *  match, in To buy or Not for sale). */
function inFreeGroup(m: QobuzCartMatch): boolean {
  return !!m.free && m.libraryStatus !== 'probable' && !freeFailed(m);
}

/** A free row "Get free downloads" can still do something with. */
function freeFetchable(m: QobuzCartMatch): boolean {
  return inFreeGroup(m) && !m.freeOutcome?.filePath;
}

function freeMatches(list: QobuzCartMatch[] = matches, filtered = true): QobuzCartMatch[] {
  return list.filter(m => inFreeGroup(m) && (!filtered || matchesSearch(m)));
}

/** Store matches belonging to a store-backed segment.
 *   - new:      not in library + a lossless store match (the buyable tracks)
 *   - maybe:    a probable library hit, with a lossless match to buy anyway
 *   - notfound: searched, but no lossless match (compressed-only included)
 *  A track in "Free on SoundCloud" is in neither To buy nor Not for sale
 *  until its free download fails. */
function segmentMatches(seg: 'new' | 'maybe' | 'notfound', list: QobuzCartMatch[] = matches, filtered = true): QobuzCartMatch[] {
  return list.filter(m => {
    if (filtered && !matchesSearch(m)) return false;
    if (seg !== 'maybe' && inFreeGroup(m)) return false;
    if (seg === 'notfound') return !hasLosslessMatch(m);
    if (seg === 'maybe') return hasLosslessMatch(m) && m.libraryStatus === 'probable';
    return hasLosslessMatch(m) && m.libraryStatus !== 'probable';
  });
}

/** The four counts of one check, unfiltered, as saved with the playlist. */
function countsFor(storeMatches: QobuzCartMatch[], owned: LibraryMatchedRow[]): SavedSourceCounts {
  return {
    toBuy: segmentMatches('new', storeMatches, false).length,
    maybeOwned: segmentMatches('maybe', storeMatches, false).length,
    owned: owned.length,
    notForSale: segmentMatches('notfound', storeMatches, false).length,
  };
}

function artHtml(url: string | null | undefined): string {
  return url
    ? `<img class="buy-art" src="${escapeHtml(url)}" alt="" loading="lazy" />`
    : `<div class="buy-art buy-art--placeholder">${NOTE_SVG}</div>`;
}

/** Swap a failed cover <img> for a placeholder. Qobuz covers are built from
 *  the album id and occasionally 404. */
function attachArtFallback(root: HTMLElement) {
  root.querySelectorAll<HTMLImageElement>('img.buy-art').forEach((img) => {
    img.addEventListener('error', () => {
      const placeholder = document.createElement('div');
      placeholder.className = 'buy-art buy-art--placeholder';
      placeholder.innerHTML = NOTE_SVG;
      img.replaceWith(placeholder);
    }, { once: true });
  });
}

/** The playlist card is one element moved between the progress card and the
 *  results, so it keeps its identity (and loaded cover). */
function buildPlaylistCard(info: SourcePlaylistInfo): HTMLElement {
  let card = document.getElementById('source-playlist-card') as HTMLElement | null;
  if (!card) {
    card = document.createElement('div');
    card.id = 'source-playlist-card';
  }
  return fillPlaylistCard(card, info);
}

function showPlaylistCard(info: SourcePlaylistInfo) {
  currentPlaylistInfo = info;
  const card = buildPlaylistCard(info);
  progressSection.insertBefore(card, progressSection.firstChild);
}

function movePlaylistCardToResults() {
  if (!currentPlaylistInfo) return;
  const card = document.getElementById('source-playlist-card');
  if (card) resultsSection.insertBefore(card, resultsSection.firstChild);
}

function clearPlaylistCard() {
  currentPlaylistInfo = null;
  document.getElementById('source-playlist-card')?.remove();
}

// ---------- Session persistence (survives HMR + app restarts) ----------
// The check (library + Qobuz/Beatport search) is the slow step, so the whole
// reviewable state — results, library buckets, ticks, what's in the carts —
// is snapshotted into localStorage and rehydrated on init. "Start a new list"
// wipes it. The saved playlists (candybar.db) are the long-lived list of
// sources; this snapshot is just the list on screen.
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
      openGroups: [...openGroups],
      searchQuery,
      selectedFree: [...selectedFree],
      freeAccountActions,
      finderInfo,
      sessionSources,
      lastRunAt,
      resultsShown: resultsSection.style.display === 'block'
    };
    localStorage.setItem(SOURCES_STATE_KEY, JSON.stringify(snapshot));
  } catch {
    // localStorage unavailable or over quota (huge list) — non-fatal, skip persistence.
  }
}

/** Set once a saved session is rehydrated. Its input row then wins over the
 *  legacy config keys read at startup. */
let snapshotRestored = false;
export function hasRestoredSourcesSession(): boolean {
  return snapshotRestored;
}

/** The legacy single-source fields of a snapshot saved before sessionSources. */
type LegacySnapshot = { sourceType?: string; spotifyPlaylistUrl?: string; soundcloudSetUrl?: string; csvPath?: string };

function legacySessionSource(s: LegacySnapshot): SourceSpec | null {
  if (s.sourceType === 'spotify' && s.spotifyPlaylistUrl) return { kind: 'spotify', ref: s.spotifyPlaylistUrl };
  if (s.sourceType === 'soundcloud' && s.soundcloudSetUrl) return { kind: 'soundcloud', ref: s.soundcloudSetUrl };
  if (s.csvPath && (s.sourceType === 'csv' || !s.sourceType)) return { kind: 'csv', ref: s.csvPath };
  return null;
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
  searchQuery = snapshot.searchQuery ?? '';
  selectedFree = new Set(Array.isArray(snapshot.selectedFree) ? snapshot.selectedFree : []);
  freeAccountActions = snapshot.freeAccountActions === true;
  finderInfo = snapshot.finderInfo ?? null;
  sessionSources = Array.isArray(snapshot.sessionSources) ? snapshot.sessionSources : [];
  lastRunAt = typeof snapshot.lastRunAt === 'number' ? snapshot.lastRunAt : null;

  openGroups = new Set(Array.isArray(snapshot.openGroups) ? snapshot.openGroups : []);

  // Restore the input row (the pasted link, or the spreadsheet).
  if (snapshot.sourceType === 'spotify' && snapshot.spotifyPlaylistUrl) setLink(snapshot.spotifyPlaylistUrl);
  else if (snapshot.sourceType === 'soundcloud' && snapshot.soundcloudSetUrl) setLink(snapshot.soundcloudSetUrl);
  else if (snapshot.sourceType === 'csv' && snapshot.csvPath) void setSourceCsvFile(snapshot.csvPath);
  if (searchInput) searchInput.value = searchQuery;

  const hasResults = matches.length > 0 || libraryMatched.length > 0 || libraryProbable.length > 0;
  if (!snapshot.resultsShown || !hasResults) return;

  // A list checked before playlists were saved: put it in Your playlists
  // (without overwriting a newer check of the same playlist).
  if (sessionSources.length === 0) {
    const legacy = legacySessionSource(snapshot);
    if (legacy) {
      const name = currentPlaylistInfo?.name || (legacy.kind === 'csv' ? csvDisplayName(legacy.ref) : legacy.ref);
      sessionSources = [{ kind: legacy.kind, ref: legacy.ref, name }];
      void persistSaved({
        kind: legacy.kind,
        ref: legacy.ref,
        name,
        imageUrl: currentPlaylistInfo?.imageUrl ?? null,
        owner: currentPlaylistInfo?.owner ?? '',
        trackCount: currentPlaylistInfo ? (currentPlaylistInfo.fetchedCount || currentPlaylistInfo.trackCount) : matches.length + libraryMatched.length,
        counts: countsFor(matches, libraryMatched),
        checkedAt: lastRunAt ?? undefined,
      }, { keepExisting: true });
    }
  }

  // Rebuild the results view exactly as runSearch() leaves it.
  resultsSection.style.display = 'block';
  if (currentPlaylistInfo) {
    const card = buildPlaylistCard(currentPlaylistInfo);
    resultsSection.insertBefore(card, resultsSection.firstChild);
  }
  updateSummary();
  renderResults();
  updateBuyBar();
  setInputBarVisible(false);
}

// ---------- Groups ----------
// The list opens on To buy (everything sensible already ticked). The three
// quieter groups sit under it as one-line summaries you can expand.

const CHEVRON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

/** Designed empty state for a group, or for a search with no hits. */
function emptyGroup(title: string, text: string): HTMLElement {
  const d = document.createElement('div');
  d.className = 'empty-state buy-empty';
  if (searchQuery) {
    d.innerHTML = `
      <span class="empty-state-icon">${SEARCH_SVG}</span>
      <h4>No tracks match "${escapeHtml(searchQuery)}"</h4>
      <p>Try a different artist or title, or clear the search to see everything.</p>
      <div class="empty-state-actions"><button type="button" class="btn-secondary btn-sm" data-clear-search>Clear the search</button></div>`;
    d.querySelector('[data-clear-search]')?.addEventListener('click', () => {
      searchQuery = '';
      searchInput.value = '';
      renderResults();
      saveSourcesState();
    });
  } else {
    d.innerHTML = `
      <span class="empty-state-icon">${CHECK_SVG}</span>
      <h4>${escapeHtml(title)}</h4>
      <p>${escapeHtml(text)}</p>`;
  }
  return d;
}

function probableReason(p: LibraryProbableRow | undefined): string {
  if (!p) return '';
  if (/not in rekordbox/i.test(p.reason ?? '')) return " You have the file, but it isn't in Rekordbox yet.";
  return '';
}

/** One of the quieter groups as a disclosure: a summary line, the list inside. */
function quietGroup(key: Group, summary: string, hint: string, body: (into: HTMLElement) => void): HTMLElement {
  const d = document.createElement('details');
  d.className = 'disclosure buy-quiet';
  d.dataset.group = key;
  // A search opens every group with a hit, so nothing found stays hidden.
  d.open = openGroups.has(key) || !!searchQuery;
  d.innerHTML = `<summary><span class="buy-quiet-title">${summary}</span><span class="disclosure-hint">${escapeHtml(hint)}</span></summary>`;
  const inner = document.createElement('div');
  inner.className = 'disclosure-body';
  body(inner);
  d.appendChild(inner);
  d.addEventListener('toggle', () => {
    if (searchQuery) return;
    if (d.open) openGroups.add(key); else openGroups.delete(key);
    saveSourcesState();
  });
  return d;
}

/** "You might have these": a related version is in the library, and a store
 *  match exists so the specific mix can be bought anyway. */
function maybeRows(into: HTMLElement, list: QobuzCartMatch[]) {
  const probableByKey = new Map<string, LibraryProbableRow>(
    libraryProbable.map(r => [`${r.artist.toLowerCase()} - ${r.title.toLowerCase()}`, r])
  );
  const intro = document.createElement('p');
  intro.className = 'buy-quiet-intro';
  intro.textContent = "Something close is already in your library, like another mix of the same track. If it isn't the one you want, choose Buy anyway to move it up to To buy.";
  into.appendChild(intro);
  const ul = document.createElement('div');
  ul.className = 'buy-list';
  for (const m of list) {
    const p = probableByKey.get(m.trackInput.key);
    const pct = p ? Math.round(p.confidence * 100) : 0;
    const price = m.qobuzTrack?.price ?? m.beatportTrack?.price ?? '';
    const suspected = p
      ? `You might have <b>${escapeHtml(p.suspectedFileArtist)} — ${escapeHtml(p.suspectedFileTitle)}</b> <span class="term" tabindex="0" data-tooltip="${escapeHtml(`Track Lab is ${pct}% sure it's the same track.${probableReason(p)}`)}">(${pct}% alike)</span>`
      : 'A similar track is already in your library';
    const row = document.createElement('div');
    row.className = 'buy-row buy-row--info';
    row.innerHTML = `
      <span class="buy-trk">
        <span class="buy-t">${escapeHtml(m.trackInput.title)}</span>
        <span class="buy-a">${escapeHtml(m.trackInput.artist)}</span>
        <span class="buy-sub">${suspected}</span>
        ${claudeVerdictHtml(m)}
      </span>
      <span class="buy-where">
        <span class="buy-price">${escapeHtml(price || '—')}</span>
        <span class="buy-store">${m.source ? STORE_LABEL[m.source] : ''}</span>
      </span>
      <button type="button" class="btn-secondary btn-sm buy-anyway" data-tooltip="Not the same track after all? Move it to To buy so you can add it to a cart.">Buy anyway</button>`;
    row.querySelector('.buy-anyway')?.addEventListener('click', () => treatProbableAsMissing(m.trackInput.key));
    ul.appendChild(row);
  }
  into.appendChild(ul);
}

/** "Already in your library", with ways to make a playlist of them. */
function ownedRows(into: HTMLElement, rows: LibraryMatchedRow[]) {
  const head = document.createElement('div');
  head.className = 'buy-quiet-actions';
  head.innerHTML = `
    <p class="buy-quiet-intro">Nothing to buy. You can make a playlist of these to import into Rekordbox.</p>
    <div class="buy-group-actions">
      <button type="button" class="btn-secondary btn-sm" id="src-export-rbxml" data-tooltip="Save these tracks as a Rekordbox playlist file (.xml) you can import in Rekordbox.">Make a Rekordbox playlist</button>
      <button type="button" class="btn-ghost btn-sm" id="src-export-m3u8" data-tooltip="Save these tracks as an M3U8 playlist file, which most music apps can open.">Save as M3U8</button>
      <button type="button" class="btn-ghost btn-sm" id="src-export-owned-csv" data-tooltip="Save these tracks as a spreadsheet (CSV file).">Save as spreadsheet</button>
    </div>`;
  into.appendChild(head);
  const ul = document.createElement('div');
  ul.className = 'buy-list';
  for (const r of rows.slice(0, 200)) {
    const row = document.createElement('div');
    row.className = 'buy-row buy-row--info';
    row.innerHTML = `
      <span class="buy-trk">
        <span class="buy-t">${escapeHtml(r.title)}</span>
        <span class="buy-a">${escapeHtml(r.artist)}</span>
      </span>
      <span class="buy-file" tabindex="0" data-tooltip="${escapeHtml(r.filePath)}">${escapeHtml(fileNameOf(r.filePath))}</span>`;
    ul.appendChild(row);
  }
  into.appendChild(ul);
  if (rows.length > 200) {
    const more = document.createElement('p');
    more.className = 'buy-more';
    more.textContent = `And ${plural(rows.length - 200, 'more track')}. Search to find one.`;
    into.appendChild(more);
  }
  // Export the same (filtered) rows the user is looking at, not the full set.
  head.querySelector('#src-export-m3u8')?.addEventListener('click', () => void exportM3u8(rows));
  head.querySelector('#src-export-rbxml')?.addEventListener('click', () => void exportRekordbox(rows));
  head.querySelector('#src-export-owned-csv')?.addEventListener('click', () => void exportCsv(
    rows.map(r => ({ artist: r.artist, title: r.title, album: r.album, genre: r.genre })),
    'library-matched'
  ));
}

/** "Not for sale in full quality": nothing found, a failed search, or only a
 *  compressed copy (never tickable, never carted). */
function notForSaleRows(into: HTMLElement, list: QobuzCartMatch[]) {
  const intro = document.createElement('p');
  intro.className = 'buy-quiet-intro';
  intro.textContent = "Qobuz and Beatport don't sell these in full quality. Tracks only sold as compressed files (like MP3) are listed here and never go in a cart.";
  into.appendChild(intro);
  const ul = document.createElement('div');
  ul.className = 'buy-list';
  for (const m of list) ul.appendChild(buildNotFoundRow(m));
  into.appendChild(ul);
}

/** Move a "You might have these" track to To buy, ticking it when the match is
 *  a confident full-quality copy of the same version. */
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
    if (autoSelectable(m)) {
      if (m.source === 'qobuz' && m.qobuzTrack) selectedQobuzIds.add(m.qobuzTrack.id);
      else if (m.source === 'beatport' && m.beatportTrack) selectedBeatportIds.add(m.beatportTrack.id);
    }
  }
  updateSummary();
  renderResults();
  updateBuyBar();
  showToast('info', 'Moved to To buy', 'Tick it there to add it to a cart.');
}

/** Whether a match needs a look before buying (shown on the row itself). */
function needsCheck(m: QobuzCartMatch): boolean {
  if (m.finder?.by === 'claude' && m.finder.verdict !== 'none') return isReleaseMatch(m) || m.finder.confidence !== 'high';
  return isOtherVersion(m) || isReleaseMatch(m) || m.confidence < AUTO_SELECT_CONFIDENCE;
}

/** What Claude did with a row, as a sub-line; '' when it simply agreed.
 *  "Not sold" rows are under Not found and say so there. */
function finderHtml(m: QobuzCartMatch): string {
  const f = m.finder;
  if (f?.by !== 'claude' || f.verdict === 'none') return '';
  const lead = f.verdict === 'changed' ? "Claude picked this over the plain search's match."
    : f.verdict === 'found' ? 'Claude found this one; the plain search missed it.' : '';
  const text = [lead, f.note].filter(Boolean).join(' ');
  return text ? `<span class="buy-sub buy-finder">${escapeHtml(text)}</span>` : '';
}

/** Why "Get free downloads" didn't land a file, as a sentence. */
function freeFailedReason(m: QobuzCartMatch): string {
  const tried = (m.freeOutcome?.attempts ?? []).filter(a => a.status !== 'covered');
  const why = (a: { status: string; reason: string }) => {
    switch (a.status) {
      case 'lossy':
      case 'lossy-dropped': return 'the file was compressed (like an MP3), so it was deleted';
      case 'needs-email': return 'the download page wants an email address (add one in Settings → SoundCloud)';
      case 'emailed': return 'the download link was emailed';
      case 'needs-you':
      case 'stalled': return 'the download page needs a person to finish it';
      case 'several-files': return 'several files arrived (a stem pack?), so pick the full track in your new-music folder';
      case 'not-free': return 'it turned out not to be free';
      case 'pending':
      case 'skipped': return "it wasn't tried";
      default: return "the download didn't finish";
    }
  };
  return tried.length ? `The free download didn't work: ${tried.map(why).join('; ')}.` : "The free download didn't work.";
}

/** One tickable To buy row: title, artist and price up front; the store,
 *  quality and how sure the match is behind "Details". */
function buildTrackRow(match: QobuzCartMatch): HTMLElement {
  if (!hasLosslessMatch(match)) return buildNotFoundRow(match);
  const store = match.source;
  const track = store === 'qobuz' ? match.qobuzTrack : store === 'beatport' ? match.beatportTrack : null;
  if (!store || !track) return buildNotFoundRow(match);
  const set = store === 'qobuz' ? selectedQobuzIds : selectedBeatportIds;
  const rowKey = `${store}:${track.id}:${match.trackInput.key}`;
  const open = openRows.has(rowKey);

  const el = document.createElement('div');
  el.className = 'buy-row buy-row--pick';
  el.classList.toggle('sel', set.has(track.id));
  el.classList.toggle('is-open', open);

  const bt = store === 'beatport' ? match.beatportTrack : null;
  const sub = [track.artists.join(', '), bt?.bpm ? `${bt.bpm} BPM` : '', bt?.key ?? ''].filter(Boolean).join(' · ');
  const flag = needsCheck(match) ? matchPillHtml(match) : '';
  const askedFor = isOtherVersion(match) || isReleaseMatch(match)
    ? `<p>In your list: <b>${escapeHtml(match.trackInput.artist)} — ${escapeHtml(match.trackInput.title)}</b></p>`
    : '';
  const note = match.note ? `<p>${escapeHtml(match.note)}</p>` : '';
  const detailsId = `buy-row-more-${Math.random().toString(36).slice(2, 9)}`;
  el.innerHTML = `
    <div class="buy-row-main" role="checkbox" tabindex="0" aria-checked="${set.has(track.id)}">
      <span class="buy-cbx" aria-hidden="true">${CHECK_SVG}</span>
      ${artHtml(store === 'qobuz' ? match.qobuzTrack?.image : null)}
      <span class="buy-trk">
        <span class="buy-t">${escapeHtml(track.name)}</span>
        <span class="buy-a">${escapeHtml(sub)}</span>
        ${freeFailed(match) ? `<span class="buy-sub">${escapeHtml(freeFailedReason(match))}</span>` : ''}
        ${finderHtml(match)}
        ${claudeVerdictHtml(match)}
      </span>
      ${flag ? `<span class="buy-pill">${flag}</span>` : ''}
      <span class="buy-price">${escapeHtml(track.price || '—')}</span>
    </div>
    <button type="button" class="btn-icon buy-row-expand" aria-expanded="${open}" aria-controls="${detailsId}" aria-label="Details for ${escapeHtml(track.name)}" data-tooltip="Where it's from and how sure the match is">${CHEVRON_SVG}</button>
    <div class="buy-row-more" id="${detailsId}" ${open ? '' : 'hidden'}>
      <div class="buy-row-facts">
        <span>On ${STORE_LABEL[store]}</span>
        <span>${qualityHtml(match)}</span>
        <span>${matchPillHtml(match)}</span>
      </div>
      ${askedFor}${note}
      <button type="button" class="btn-ghost btn-sm buy-row-open" data-tooltip="Open this track's page in the ${STORE_LABEL[store]} panel, to listen before you buy. Nothing is added to your cart.">Open on ${STORE_LABEL[store]}</button>
    </div>`;
  attachArtFallback(el);

  const main = el.querySelector<HTMLElement>('.buy-row-main')!;
  const toggle = () => {
    const on = !el.classList.contains('sel');
    el.classList.toggle('sel', on);
    main.setAttribute('aria-checked', String(on));
    if (on) set.add(track.id); else set.delete(track.id);
    updateBuyBar();
  };
  main.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.term, .buy-match')) return; // tooltips, not ticks
    toggle();
  });
  main.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
  const expand = el.querySelector<HTMLButtonElement>('.buy-row-expand')!;
  const more = el.querySelector<HTMLElement>('.buy-row-more')!;
  expand.addEventListener('click', () => {
    const nowOpen = more.hidden;
    more.hidden = !nowOpen;
    expand.setAttribute('aria-expanded', String(nowOpen));
    el.classList.toggle('is-open', nowOpen);
    if (nowOpen) openRows.add(rowKey); else openRows.delete(rowKey);
  });
  el.querySelector('.buy-row-open')?.addEventListener('click', () => {
    if (track.url) void window.candybar.storePanelOpen(store, track.url);
  });
  return el;
}

function buildNotFoundRow(match: QobuzCartMatch): HTMLElement {
  const el = document.createElement('div');
  el.className = 'buy-row buy-row--info';
  // Claude turned down the plain search's pick; it's still on the row, so the
  // user can overrule.
  const rejected = match.finder?.by === 'claude' && match.finder.verdict === 'none' && !!match.source && match.lossless
    ? (match.source === 'qobuz' ? match.qobuzTrack : match.beatportTrack) : null;
  el.innerHTML = `
    <span class="buy-trk">
      <span class="buy-t">${escapeHtml(match.trackInput.title)}</span>
      <span class="buy-a">${escapeHtml(match.trackInput.artist)}</span>
      ${freeFailed(match) ? `<span class="buy-sub">${escapeHtml(freeFailedReason(match))}</span>` : ''}
      <span class="buy-sub">${escapeHtml(notForSaleReason(match))}</span>
      ${rejected ? `<span class="buy-sub">The plain search's pick was <b>${escapeHtml(rejected.artists.join(', '))} — ${escapeHtml(rejected.name)}</b> on ${STORE_LABEL[match.source!]}.</span>` : ''}
    </span>
    ${rejected
      ? `<button type="button" class="btn-secondary btn-sm buy-anyway" data-tooltip="Claude thinks it's a different record. If you know it's the one, move it to To buy.">Use it anyway</button>`
      : notForSalePillHtml(match)}`;
  el.querySelector('.buy-anyway')?.addEventListener('click', () => {
    match.status = 'matched';
    match.finder = { by: 'search' };
    updateSummary();
    renderResults();
    updateBuyBar();
    saveSourcesState();
    showToast('info', 'Moved to To buy', 'Tick it there to add it to a cart.');
  });
  return el;
}

// ---------- Free on SoundCloud ----------
// A SoundCloud set says which of its tracks are free (SoundCloud's download
// button, or a gate like Hypeddit). Those go first; the store copy is only
// the fallback, used when the free file turns out compressed or never comes.

/** Ticked free rows that "Get free downloads" would fetch. */
function freeTicked(): QobuzCartMatch[] {
  return freeMatches(matches, false).filter(m => selectedFree.has(m.trackInput.key) && freeFetchable(m));
}

function buildFreeRow(m: QobuzCartMatch): HTMLElement {
  const f = m.free!;
  const key = m.trackInput.key;
  const landed = m.freeOutcome?.filePath ?? null;
  const canTick = freeFetchable(m) && !fetchingFree;
  const ticked = selectedFree.has(key) && freeFetchable(m);
  const rowKey = `free:${key}`;
  const open = openRows.has(rowKey);
  const el = document.createElement('div');
  el.className = 'buy-row buy-row--pick';
  el.classList.toggle('sel', ticked);
  el.classList.toggle('is-open', open);
  el.classList.toggle('buy-row--static', !freeFetchable(m));
  const store = hasLosslessMatch(m) ? m.source : null;
  const storeTrack = store === 'qobuz' ? m.qobuzTrack : store === 'beatport' ? m.beatportTrack : null;
  const fallback = store && storeTrack ? `${STORE_LABEL[store]} (${storeTrack.price || 'for sale'})` : '';
  const detailsId = `buy-row-more-${Math.random().toString(36).slice(2, 9)}`;
  el.innerHTML = `
    <div class="buy-row-main" role="checkbox" tabindex="${canTick ? 0 : -1}" aria-checked="${ticked}"${canTick ? '' : ' aria-disabled="true"'}>
      <span class="buy-cbx" aria-hidden="true">${CHECK_SVG}</span>
      ${artHtml(null)}
      <span class="buy-trk">
        <span class="buy-t">${escapeHtml(m.trackInput.title)}</span>
        <span class="buy-a">${escapeHtml(m.trackInput.artist)}</span>
        <span class="buy-sub upg-free-via"><span class="buy-kind">${SOURCE_KIND_ICONS.soundcloud}SoundCloud</span><span>${landed
          ? `Downloaded: <span class="term" tabindex="0" data-tooltip="${escapeHtml(landed)}">${escapeHtml(fileNameOf(landed))}</span>`
          : escapeHtml(f.reason)}</span></span>
      </span>
      ${landed ? '<span class="buy-pill"><span class="status-pill status-pill--ok">Downloaded</span></span>' : ''}
      <span class="buy-price buy-price--free">Free</span>
    </div>
    <button type="button" class="btn-icon buy-row-expand" aria-expanded="${open}" aria-controls="${detailsId}" aria-label="Details for ${escapeHtml(m.trackInput.title)}" data-tooltip="Where the free copy is, and what happens if it doesn't work out">${CHEVRON_SVG}</button>
    <div class="buy-row-more" id="${detailsId}" ${open ? '' : 'hidden'}>
      <p>On SoundCloud as <b>${escapeHtml(f.listedAs)}</b>${f.uploader ? `, uploaded by ${escapeHtml(f.uploader)}` : ''}.${f.kind === 'gate'
        ? ` The file is behind a download page${f.gateHost ? ` on ${escapeHtml(f.gateHost)}` : ''}, which may ask you to follow or like first.` : ''}</p>
      <p>SoundCloud doesn't say the file type until it arrives. If it's compressed (like an MP3), it's deleted${fallback ? ` and this track goes back to ${escapeHtml(fallback)}` : ''}.</p>
      <div class="buy-row-facts"><button type="button" class="btn-ghost btn-sm buy-row-open" data-tooltip="Open the track on SoundCloud in your browser, to listen first.">Open on SoundCloud</button></div>
    </div>`;
  attachArtFallback(el);

  const main = el.querySelector<HTMLElement>('.buy-row-main')!;
  const toggle = () => {
    if (!freeFetchable(m) || fetchingFree) return;
    const on = !selectedFree.has(key);
    if (on) selectedFree.add(key); else selectedFree.delete(key);
    el.classList.toggle('sel', on);
    main.setAttribute('aria-checked', String(on));
    refreshFreeActions();
    saveSourcesState();
  };
  main.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.term, .status-pill')) return;
    toggle();
  });
  main.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
  const expand = el.querySelector<HTMLButtonElement>('.buy-row-expand')!;
  const more = el.querySelector<HTMLElement>('.buy-row-more')!;
  expand.addEventListener('click', () => {
    const nowOpen = more.hidden;
    more.hidden = !nowOpen;
    expand.setAttribute('aria-expanded', String(nowOpen));
    el.classList.toggle('is-open', nowOpen);
    if (nowOpen) openRows.add(rowKey); else openRows.delete(rowKey);
  });
  el.querySelector('.buy-row-open')?.addEventListener('click', () => void window.candybar.openExternal(f.url));
  return el;
}

/** A downloader line as a sentence; anything else keeps the last one showing. */
function applyFreeLine(line: string) {
  const m = line.match(/^\((\d+)\/(\d+)\)\s+(.*?)\s+\[/);
  if (m) {
    freeCount = { i: Number(m[1]), n: Number(m[2]) };
    freeLine = `Getting ${m[3]}`;
  } else if (/sign in/i.test(line)) {
    freeLine = 'Sign in to SoundCloud in the Chrome window that just opened. Track Lab waits for you.';
  } else if (/STOPPED: only/.test(line)) {
    freeLine = 'Your drive is almost full, so the downloads stopped. Free up some space, then try again.';
  }
}

function updateFreeProgress() {
  const line = document.getElementById('source-free-line');
  const count = document.getElementById('source-free-count');
  const bar = document.getElementById('source-free-bar');
  if (line) line.textContent = freeLine || 'Starting the downloads…';
  if (count) count.textContent = freeCount ? `${freeCount.i.toLocaleString()} of ${plural(freeCount.n, 'download')}` : '';
  if (bar) bar.style.width = freeCount ? `${Math.round(((freeCount.i - 1) / freeCount.n) * 100)}%` : '0%';
}

function freeActionsEl(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'upg-free-actions';
  el.id = 'source-free-actions';
  if (fetchingFree) {
    el.innerHTML = `
      <div class="callout upg-free-progress" role="status">${SPINNER_SVG}
        <div class="callout-body">
          <strong>Getting your free downloads…</strong>
          <p id="source-free-line"></p>
          <div class="buy-meter buy-meter--sm"><div class="buy-meter-fill" id="source-free-bar" style="width: 0%"></div></div>
          <p class="upg-free-count" id="source-free-count"></p>
        </div>
        <div class="callout-actions"><button type="button" class="btn-secondary btn-sm" id="source-free-stop" data-tooltip="Stop after the track it's on. Anything already downloaded stays in your new-music folder.">Stop</button></div>
      </div>`;
    el.querySelector('#source-free-stop')?.addEventListener('click', () => void window.candybar.librarySourcingFetchFreeStop());
    queueMicrotask(updateFreeProgress);
    return el;
  }
  const n = freeTicked().length;
  el.innerHTML = `
    <label class="upg-check">
      <input type="checkbox" id="source-free-actions-ok" ${freeAccountActions ? 'checked' : ''} />
      <span><strong>Let download pages follow, like and comment for me</strong><span>Some free downloads on SoundCloud ask you to follow or like first. This does it on your SoundCloud account. Without it, those ones are skipped.</span></span>
    </label>
    <div class="card-actions">
      <span class="card-actions-note">Nothing is bought. Files go to your new-music folder.</span>
      <button type="button" class="${n > 0 ? 'btn-primary' : 'btn-secondary'}" id="source-get-free" ${n === 0 ? 'disabled' : ''}
        data-tooltip="Download the ticked free copies from SoundCloud. A Chrome window opens for the download pages."
        data-tooltip-disabled="Tick at least one free download first">${n > 0 ? `Get ${plural(n, 'free download')}` : 'Get free downloads'}</button>
    </div>`;
  el.querySelector<HTMLInputElement>('#source-free-actions-ok')?.addEventListener('change', (e) => {
    freeAccountActions = (e.target as HTMLInputElement).checked;
    saveSourcesState();
  });
  el.querySelector('#source-get-free')?.addEventListener('click', () => void getFreeDownloads());
  return el;
}

/** Redraw the group's action bar after a tick (the rows stay as they are). */
function refreshFreeActions() {
  document.getElementById('source-free-actions')?.replaceWith(freeActionsEl());
}

async function getFreeDownloads() {
  const rows = freeTicked();
  if (rows.length === 0 || fetchingFree) return;
  fetchingFree = true;
  freeLine = '';
  freeCount = null;
  setStatus('Downloading…');
  renderResults();
  const off = window.candybar.onLibrarySourcingFreeProgress((p) => {
    applyFreeLine(p.message);
    updateFreeProgress();
  });
  try {
    const res = await window.candybar.librarySourcingFetchFree(rows.map(m => m.trackInput.key), { accountActions: freeAccountActions });
    if (!res.success || !res.outcomes) throw new Error(res.error || 'The downloads stopped without saying why.');
    let landed = 0;
    for (const m of rows) {
      const o = res.outcomes[m.trackInput.key];
      // Never reached (the run stopped early): still free, still ticked.
      if (!o || (!o.filePath && o.attempts.every(a => a.status === 'pending' || a.status === 'skipped'))) continue;
      m.freeOutcome = o;
      selectedFree.delete(m.trackInput.key);
      if (o.filePath) {
        landed++;
      } else if (autoSelectable(m)) {
        // Back on its store copy, ticked like any sure match.
        if (m.source === 'qobuz' && m.qobuzTrack) selectedQobuzIds.add(m.qobuzTrack.id);
        else if (m.source === 'beatport' && m.beatportTrack) selectedBeatportIds.add(m.beatportTrack.id);
      }
    }
    const missed = rows.length - landed;
    showToast(landed > 0 && missed === 0 ? 'success' : 'warning',
      landed > 0 ? `${plural(landed, 'free download')} in your new-music folder` : 'No free downloads came through',
      missed > 0 ? `${plural(missed, 'track')} didn't work and went back to the store list. Each one says why.` : 'Organize files them into your library.');
  } catch (err) {
    const message = getErrorMessage(err);
    if (message === 'Stopped') showToast('info', 'Free downloads stopped', 'Anything already downloaded stays in your new-music folder. Get them again to pick those up.');
    else showToast('error', 'The free downloads stopped', message);
  } finally {
    off();
    fetchingFree = false;
    setStatus('Idle');
    saveSourcesState();
    updateSummary();
    renderResults();
    updateBuyBar();
  }
}

function renderFreeGroup(): HTMLElement {
  const rows = freeMatches();
  const group = document.createElement('section');
  group.className = 'buy-group';
  group.setAttribute('aria-labelledby', 'buy-group-free');
  group.innerHTML = `
    <div class="buy-group-head">
      <div class="buy-group-text">
        <h3 class="buy-group-title" id="buy-group-free">Free on SoundCloud <span class="buy-group-count">${freeMatches(matches, false).length.toLocaleString()}</span></h3>
        <p class="card-desc">The set gives these away, so Track Lab gets them before anything is bought. If a file arrives compressed or doesn't come through, the track goes back to its store copy.</p>
      </div>
      ${rows.some(freeFetchable) && !fetchingFree ? `<div class="buy-group-actions">
        <button type="button" class="btn-ghost btn-sm" data-free-select="all">Tick all</button>
        <button type="button" class="btn-ghost btn-sm" data-free-select="none">Untick all</button>
      </div>` : ''}
    </div>`;
  if (rows.length === 0) {
    group.appendChild(emptyGroup('Nothing free here', ''));
  } else {
    const ul = document.createElement('div');
    ul.className = 'buy-list';
    for (const m of rows) ul.appendChild(buildFreeRow(m));
    group.appendChild(ul);
  }
  if (freeMatches(matches, false).some(freeFetchable) || fetchingFree) group.appendChild(freeActionsEl());
  group.querySelectorAll<HTMLButtonElement>('[data-free-select]').forEach(btn => btn.addEventListener('click', () => {
    for (const m of freeMatches()) {
      if (!freeFetchable(m)) continue;
      if (btn.dataset.freeSelect === 'none') selectedFree.delete(m.trackInput.key);
      else selectedFree.add(m.trackInput.key);
    }
    renderResults();
    saveSourcesState();
  }));
  return group;
}

/** Render To buy, then the quieter groups that have something in them. */
function renderResults() {
  groupsContainer.innerHTML = '';
  emptyState.style.display = 'none';

  if (freeMatches(matches, false).length > 0) groupsContainer.appendChild(renderFreeGroup());

  // ---- To buy ----
  const toBuy = segmentMatches('new');
  const group = document.createElement('section');
  group.className = 'buy-group';
  group.setAttribute('aria-labelledby', 'buy-group-tobuy');
  group.innerHTML = `
    <div class="buy-group-head">
      <div class="buy-group-text">
        <h3 class="buy-group-title" id="buy-group-tobuy">To buy <span class="buy-group-count">${toBuy.length.toLocaleString()}</span></h3>
        <p class="card-desc">Not in your library, and for sale in full quality. Strong matches are ticked for you. Tap a track to tick or untick it.</p>
      </div>
      ${toBuy.length > 0 ? `<div class="buy-group-actions">
        <button type="button" class="btn-ghost btn-sm" data-select="all" data-tooltip="Tick every track here, except ones marked to check first (a different version or a whole release).">Tick all</button>
        <button type="button" class="btn-ghost btn-sm" data-select="none">Untick all</button>
      </div>` : ''}
    </div>`;

  // Ben's rule, said where the tracks would have been.
  const compressed = matches.filter(isCompressedOnly).length;
  if (compressed > 0 && !searchQuery) {
    const note = document.createElement('div');
    note.className = 'callout callout--info buy-rule';
    note.innerHTML = `
      ${INFO_SVG}
      <div class="callout-body">
        <p>${plural(compressed, 'track')} ${compressed === 1 ? 'is' : 'are'} only sold as a compressed file (like an MP3), so ${compressed === 1 ? "it isn't" : "they aren't"} here. Only full-quality copies can go in a cart. <button type="button" class="btn-link" data-goto="notfound">See ${compressed === 1 ? 'it' : 'them'}</button></p>
      </div>`;
    note.querySelector('[data-goto]')?.addEventListener('click', () => {
      openGroups.add('notfound');
      renderResults();
      revealInContent(groupsContainer.querySelector<HTMLElement>('[data-group="notfound"]'), 'start');
    });
    group.appendChild(note);
  }

  if (toBuy.length === 0) {
    group.appendChild(emptyGroup('Nothing new to buy', "Every track in this list is already in your library, might be, or isn't for sale in full quality. See below."));
  } else {
    const ul = document.createElement('div');
    ul.className = 'buy-list';
    for (const m of toBuy) ul.appendChild(buildTrackRow(m));
    group.appendChild(ul);
  }
  groupsContainer.appendChild(group);

  group.querySelectorAll<HTMLButtonElement>('[data-select]').forEach(btn => btn.addEventListener('click', () => {
    for (const m of segmentMatches('new')) {
      const id = m.source === 'qobuz' ? m.qobuzTrack?.id : m.beatportTrack?.id;
      const set = m.source === 'qobuz' ? selectedQobuzIds : selectedBeatportIds;
      if (!id) continue;
      if (btn.dataset.select === 'none') set.delete(id);
      else if (!isOtherVersion(m) && !isReleaseMatch(m)) set.add(id);
    }
    renderResults();
    updateBuyBar();
  }));

  // ---- The quieter groups ----
  const maybe = segmentMatches('maybe');
  const q = searchQuery.toLowerCase();
  const owned = libraryMatched.filter(r => !q || `${r.artist} ${r.title}`.toLowerCase().includes(q));
  const notFound = segmentMatches('notfound');
  const quiet = document.createElement('div');
  quiet.className = 'buy-quiet-list';
  if (maybe.length > 0) {
    quiet.appendChild(quietGroup('maybe',
      `You might have <b>${maybe.length.toLocaleString()}</b> of these already`,
      'Check before buying', (into) => maybeRows(into, maybe)));
  }
  if (owned.length > 0) {
    quiet.appendChild(quietGroup('owned',
      `<b>${owned.length.toLocaleString()}</b> already in your library`,
      'Nothing to buy', (into) => ownedRows(into, owned)));
  }
  if (notFound.length > 0) {
    quiet.appendChild(quietGroup('notfound',
      `<b>${notFound.length.toLocaleString()}</b> not for sale in full quality`,
      'Compressed only, or not found', (into) => notForSaleRows(into, notFound)));
  }
  if (quiet.childElementCount > 0) groupsContainer.appendChild(quiet);
}

/** The summary sentence over the whole list (unfiltered). */
function updateSummary() {
  const total = matches.length + libraryMatched.length;
  if (total === 0) {
    scanSummary.style.display = 'none';
    return;
  }
  const c = countsFor(matches, libraryMatched);
  const sentences: string[] = [];
  sentences.push(c.owned === 0
    ? `None of these ${plural(total, 'track')} are in your library yet.`
    : `You already have ${c.owned.toLocaleString()} of these ${plural(total, 'track')}.`);
  if (c.maybeOwned > 0) {
    sentences.push(`${plural(c.maybeOwned, 'track')} might already be in your library, so check ${c.maybeOwned === 1 ? 'it' : 'them'} before buying.`);
  }
  if (c.notForSale > 0) {
    sentences.push(`${c.notForSale.toLocaleString()} ${c.notForSale === 1 ? "isn't" : "aren't"} for sale in full quality.`);
  }
  const free = freeMatches(matches, false);
  const freeLeft = free.filter(freeFetchable).length;
  if (free.length > 0) {
    sentences.push(freeLeft > 0
      ? `${plural(freeLeft, 'track')} ${freeLeft === 1 ? 'is' : 'are'} free on SoundCloud, so get ${freeLeft === 1 ? 'it' : 'them'} first.`
      : `${plural(free.length, 'free download')} came from SoundCloud.`);
  }
  const combined = sessionSources.length > 1
    ? `<p class="buy-summary-sources">This list combines ${sessionSources.length} playlists: ${sessionSources.map(s => escapeHtml(s.name)).join(', ')}.</p>`
    : '';
  const finder = finderInfo?.note
    ? `<p class="buy-summary-finder${finderInfo.by === 'claude' ? ' is-claude' : ''}">${escapeHtml(finderInfo.note)}</p>`
    : '';
  scanSummary.style.display = '';
  scanSummary.innerHTML = `
    <h3 class="buy-summary-title">${c.toBuy > 0 ? `${plural(c.toBuy, 'track')} to buy in full quality` : freeLeft > 0 ? `${plural(freeLeft, 'free download')} to get` : 'Nothing new to buy'}</h3>
    <p>${sentences.join(' ')}</p>
    ${finder}
    ${combined}`;
}

/** The ticked full-quality matches for one store as cart payloads, one per
 *  store track: exactly what "Add to carts" sends, so the totals agree. */
function selectedForCart(store: Store): StoreMatch[] {
  const ids = store === 'qobuz' ? selectedQobuzIds : selectedBeatportIds;
  return uniqueByTrack(matches
    // Belt-and-braces lossless guard: compressed rows can't be ticked, but
    // this keeps DOM tampering or a future refactor from carting one.
    .filter(m => m.lossless && m.source === store && ids.has((store === 'qobuz' ? m.qobuzTrack : m.beatportTrack)!.id))
    .map(m => toStoreMatch(m, store)));
}

/** "12 tracks are in your carts" — the moment after adding, with the way to
 *  check out. Hidden until Track Lab has put something in a cart. */
function renderCartHero() {
  const hero = document.getElementById('source-cart-hero');
  if (!hero) return;
  const q = cartView('qobuz');
  const b = cartView('beatport');
  const inCart = q.inCart.length + b.inCart.length;
  const gone = q.gone.length + b.gone.length;
  hero.hidden = inCart + gone === 0;
  if (hero.hidden) return;
  const title = document.getElementById('source-cart-hero-title') as HTMLElement;
  const text = document.getElementById('source-cart-hero-text') as HTMLElement;
  const open = document.getElementById('source-cart-hero-open') as HTMLButtonElement;
  if (inCart > 0) {
    const where = [
      q.inCart.length ? `${cartTotal(q.inCart)} on Qobuz` : '',
      b.inCart.length ? `${cartTotal(b.inCart)} on Beatport` : '',
    ].filter(Boolean).join(' and ');
    title.textContent = `${plural(inCart, 'track')} ${inCart === 1 ? 'is' : 'are'} in your carts`;
    text.textContent = `${where}. Check out in the store, then download them into your new-music folder. Nothing is bought until you check out.`;
    open.textContent = 'Review carts and check out';
  } else {
    title.textContent = `${plural(gone, 'track')} left your carts`;
    text.textContent = 'Bought, or taken out. If you checked out, download them into your new-music folder.';
    open.textContent = 'Review carts and download';
  }
}

/** The sticky buy bar: "12 tracks selected · $28.62 on Qobuz" and the one action. */
function updateBuyBar() {
  const listShown = resultsSection.style.display === 'block';
  const appending = appendMode && inputBar.style.display !== 'none';
  buyBar.style.display = listShown && !appending ? '' : 'none';

  const qSel = selectedForCart('qobuz');
  const bSel = selectedForCart('beatport');
  const n = qSel.length + bSel.length;

  buyBarN.textContent = n > 0 ? `${plural(n, 'track')} selected` : 'No tracks selected';
  buyBarQobuz.textContent = qSel.length > 0 ? `${cartTotal(qSel)} on Qobuz` : '';
  buyBarBeatport.textContent = bSel.length > 0 ? `${cartTotal(bSel)} on Beatport` : '';
  const stores = (qSel.length > 0 ? 1 : 0) + (bSel.length > 0 ? 1 : 0);
  addToCartBtn.textContent = n > 0 ? `Add ${plural(n, 'track')} to ${stores > 1 ? 'carts' : 'cart'}` : 'Add to carts';
  addToCartBtn.disabled = isAddingToCart() || n === 0;
  addToCartBtn.setAttribute('data-tooltip-disabled', isAddingToCart() ? 'Wait for the tracks going in now to finish' : 'Tick at least one track first');
  reviewCartBtn.style.display = (lastAddedQobuz.length + lastAddedBeatport.length) > 0 ? '' : 'none';
  renderCartHero();

  // Ticks are the main change after a check — persist them.
  saveSourcesState();
}

// ---- Cart slide-over ----
let cartDrawerReturnFocus: HTMLElement | null = null;
function openCartDrawer() {
  renderCartStage();
  void refreshCartChecks();
  const opening = cartDrawer.style.display === 'none';
  if (opening) cartDrawerReturnFocus = document.activeElement as HTMLElement | null;
  cartScrim.style.display = '';
  cartDrawer.style.display = 'flex';
  // Focus once the slide-in has finished: focused mid-slide, the close
  // button's tooltip is placed where the button was, a drawer-width away.
  const focusClose = () => cartCloseBtn.focus({ preventScroll: true });
  if (!opening || getComputedStyle(cartDrawer).animationName === 'none') focusClose();
  else cartDrawer.addEventListener('animationend', focusClose, { once: true });
}
function closeCartDrawer() {
  const wasOpen = cartDrawer.style.display !== 'none';
  cartDrawer.style.display = 'none';
  cartScrim.style.display = 'none';
  if (wasOpen && cartDrawerReturnFocus?.isConnected) cartDrawerReturnFocus.focus({ preventScroll: true });
  cartDrawerReturnFocus = null;
}

// ========== Saved playlists ==========

function formatChecked(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (days <= 0) return 'checked today';
  if (days === 1) return 'checked yesterday';
  const opts: Intl.DateTimeFormatOptions = d.getFullYear() === today.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' };
  return `checked ${d.toLocaleDateString(undefined, opts)}`;
}

function savedSummary(s: SavedSource): string {
  const parts = [plural(s.trackCount, 'track'), formatChecked(s.lastCheckedAt)];
  parts.push(s.counts.toBuy > 0 ? `${s.counts.toBuy.toLocaleString()} to buy` : 'nothing new to buy');
  return parts.join(' · ');
}

async function loadSaved(): Promise<void> {
  try {
    const res = await window.candybar.savedSourcesList();
    if (res.success && res.sources) savedSources = res.sources;
  } catch (err) {
    console.error('Failed to read saved playlists:', err);
  } finally {
    savedLoaded = true;
    for (const id of [...savedSelected]) if (!savedSources.some(s => s.id === id)) savedSelected.delete(id);
    syncAddStrip();
  }
}

async function persistSaved(input: SavedSourceInput, opts?: { keepExisting?: boolean }): Promise<SavedSource | null> {
  try {
    const res = await window.candybar.savedSourcesSave(input, opts);
    if (!res.success || !res.source) {
      console.warn('Could not save the playlist:', res.error);
      return null;
    }
    const saved = res.source;
    savedSources = [saved, ...savedSources.filter(s => s.id !== saved.id)]
      .sort((a, b) => b.lastCheckedAt - a.lastCheckedAt);
    renderSaved();
    return saved;
  } catch (err) {
    console.error('Failed to save the playlist:', err);
    return null;
  }
}

function specOf(s: SavedSource): SourceSpec {
  return { kind: s.kind, ref: s.ref, name: s.name };
}

function renderSaved(): void {
  if (!savedLoaded) return;
  const appending = appendMode && resultsShown();
  const runnable = [...savedSelected].filter(id => savedSources.some(s => s.id === id && !s.missing));
  savedTogetherBtn.hidden = runnable.length < 2 || searching;
  savedTogetherBtn.textContent = appending ? `Add ${runnable.length} to this list` : `Check ${runnable.length} together`;
  savedTogetherBtn.setAttribute('data-tooltip', appending
    ? 'Merge the ticked playlists into the list you are looking at, without repeats.'
    : 'Check the ticked playlists as one list, without repeats.');
  savedDesc.textContent = appending
    ? 'Pick one to merge into the list you are looking at.'
    : 'Every playlist you check is kept here. Check one again to see what\'s new since last time.';

  if (savedSources.length === 0) {
    savedList.innerHTML = `
      <li class="buy-saved-empty">
        <span class="empty-state-icon">${NOTE_SVG}</span>
        <p>Playlists you check are kept here, so you can check them again in one click.</p>
      </li>`;
    return;
  }

  savedList.innerHTML = '';
  for (const s of savedSources) {
    const li = document.createElement('li');
    li.className = 'buy-saved-row';
    li.dataset.id = String(s.id);
    if (s.missing) li.classList.add('is-missing');
    const art = s.imageUrl
      ? `<img class="buy-saved-art" src="${escapeHtml(s.imageUrl)}" alt="" loading="lazy" />`
      : `<div class="buy-saved-art buy-saved-art--placeholder">${SOURCE_KIND_ICONS[s.kind]}</div>`;
    const name = renamingId === s.id
      ? `<form class="buy-saved-rename" data-rename-form>
           <label class="sr-only" for="buy-rename-${s.id}">New name</label>
           <input type="text" id="buy-rename-${s.id}" value="${escapeHtml(s.name)}" maxlength="200" />
           <button type="submit" class="btn-primary btn-sm">Save</button>
           <button type="button" class="btn-ghost btn-sm" data-act="rename-cancel">Cancel</button>
         </form>
         <p class="field-help">Leave it empty to go back to "${escapeHtml(s.originalName)}".</p>`
      : `<div class="buy-saved-name">${escapeHtml(s.name)}</div>`;
    const missing = s.missing
      ? `<p class="field-help is-warn buy-saved-missing">This file isn't where it was any more. It may have been moved or renamed. <button type="button" class="btn-link" data-act="relocate">Find the file…</button></p>`
      : '';
    const checkLabel = appending ? 'Add to this list' : 'Check again';
    const checkTip = appending
      ? 'Merge this playlist into the list you are looking at, without repeats.'
      : 'Check this playlist again against your library and the stores. Nothing is bought.';
    li.innerHTML = `
      <label class="buy-saved-pick" data-tooltip="${escapeHtml(appending ? 'Tick to add several at once' : 'Tick two or more to check them together')}">
        <input type="checkbox" ${savedSelected.has(s.id) ? 'checked' : ''} ${s.missing || searching ? 'disabled' : ''} aria-label="Select ${escapeHtml(s.name)}" />
      </label>
      ${art}
      <div class="buy-saved-main">
        ${name}
        <div class="buy-saved-meta"><span class="buy-kind buy-kind--${s.kind}">${KIND_LABEL[s.kind]}</span><span>${escapeHtml(savedSummary(s))}</span></div>
        ${missing}
      </div>
      <div class="buy-saved-actions">
        <button type="button" class="btn-secondary btn-sm" data-act="check" ${s.missing || searching ? 'disabled' : ''}
          data-tooltip="${escapeHtml(checkTip)}" data-tooltip-disabled="${escapeHtml(s.missing ? 'Find the file first' : 'A check is already running')}">${REFRESH_SVG}${checkLabel}</button>
        <button type="button" class="btn-icon" data-act="rename" aria-label="Rename ${escapeHtml(s.name)}" data-tooltip="Rename">${PENCIL_SVG}</button>
        <button type="button" class="btn-icon" data-act="remove" aria-label="Remove ${escapeHtml(s.name)} from your playlists" data-tooltip="Remove from this list">${TRASH_SVG}</button>
      </div>`;
    li.querySelector<HTMLImageElement>('img.buy-saved-art')?.addEventListener('error', function () {
      const ph = document.createElement('div');
      ph.className = 'buy-saved-art buy-saved-art--placeholder';
      ph.innerHTML = SOURCE_KIND_ICONS[s.kind];
      this.replaceWith(ph);
    }, { once: true });
    savedList.appendChild(li);
  }
  if (renamingId !== null) {
    const input = savedList.querySelector<HTMLInputElement>(`#buy-rename-${renamingId}`);
    input?.focus();
    input?.select();
  }
}

async function onSavedAction(id: number, act: string): Promise<void> {
  const s = savedSources.find(x => x.id === id);
  if (!s || searching) return;
  if (act === 'check') {
    hideRunError();
    await runSearch(specOf(s));
  } else if (act === 'rename') {
    renamingId = id;
    renderSaved();
  } else if (act === 'rename-cancel') {
    renamingId = null;
    renderSaved();
  } else if (act === 'remove') {
    const ok = await confirmAction({
      title: `Remove "${s.name}" from your playlists?`,
      message: 'Track Lab forgets this playlist and its last check. You can add it again any time by checking it.',
      safetyNote: s.kind === 'csv'
        ? "The spreadsheet file itself isn't touched."
        : `The playlist itself isn't touched on ${KIND_LABEL[s.kind]}.`,
      confirmLabel: 'Remove',
      tone: 'caution',
    });
    if (!ok) return;
    const res = await window.candybar.savedSourcesRemove(id);
    if (!res.success) {
      showToast('error', "Couldn't remove that playlist", res.error ?? 'Try again in a moment.');
      return;
    }
    savedSources = savedSources.filter(x => x.id !== id);
    savedSelected.delete(id);
    renderSaved();
  } else if (act === 'relocate') {
    const picked = await window.candybar.selectPath('file');
    if (!picked) return;
    await runSearch({ kind: 'csv', ref: picked, relocateFrom: id });
  }
}

async function submitRename(id: number, value: string): Promise<void> {
  const res = await window.candybar.savedSourcesUpdate(id, { name: value.trim() || null });
  renamingId = null;
  if (res.success && res.source) {
    const updated = res.source;
    savedSources = savedSources.map(x => (x.id === id ? updated : x));
  } else {
    showToast('error', "Couldn't rename that playlist", res.error ?? 'Try again in a moment.');
  }
  renderSaved();
}

/** Check several saved playlists as one list: the first replaces (or, in
 *  "add to this list" mode, merges), the rest merge in. */
async function runSavedTogether(): Promise<void> {
  const list = savedSources.filter(s => savedSelected.has(s.id) && !s.missing);
  if (list.length === 0 || searching) return;
  hideRunError();
  for (let i = 0; i < list.length; i++) {
    if (i > 0) appendMode = true;
    const ok = await runSearch(specOf(list[i]));
    if (!ok) break;
  }
  savedSelected.clear();
  renderSaved();
}

// ========== Check ==========

/** Put a source into the picker, so the session snapshot and the picker agree
 *  with what's being checked. */
function applySpec(spec: SourceSpec): void {
  if (spec.kind === 'csv') {
    void setSourceCsvFile(spec.ref);
    csvHasRequiredCols = true; // checked before; the run itself re-reads it
  } else {
    setLink(spec.ref);
  }
}

function currentSpec(): SourceSpec | null {
  if (sourceType === 'csv') return csvPath ? { kind: 'csv', ref: csvPath } : null;
  if (sourceType === 'spotify') return spotifyUrlValid ? { kind: 'spotify', ref: spotifyPlaylistUrl } : null;
  return soundcloudUrlValid ? { kind: 'soundcloud', ref: soundcloudSetUrl } : null;
}

/** Check one source: the library check, then the store search. Returns true
 *  when results landed. With no `spec`, checks what's in the picker. */
async function runSearch(spec?: SourceSpec): Promise<boolean> {
  if (searching) return false;
  if (spec) applySpec(spec);
  const source = spec ?? currentSpec();
  if (!source) {
    showToast('warning', 'Add a playlist first',
      sourceType === 'csv' ? 'Choose a spreadsheet (CSV file) to check.'
        : sourceType === 'spotify' ? 'Paste a link to a Spotify playlist.'
        : 'Paste a link to a SoundCloud set (it has /sets/ in it).');
    return false;
  }

  // One run at a time: two would interleave progress on the shared channels
  // and race to write the results.
  searching = true;
  runPlaylistInfo = null;
  hideRunError();
  setStatus('Checking…');
  updateRunButton();
  progressSection.style.display = 'block';
  if (!appendMode) {
    resultsSection.style.display = 'none';
    cartSection.style.display = 'none';
    matches = [];
    selectedQobuzIds = new Set();
    selectedBeatportIds = new Set();
    lastAddedQobuz = [];
    lastAddedBeatport = [];
    sessionSources = [];
    clearPlaylistCard();
  }
  progressBar.style.width = '0%';
  progressMessage.textContent = source.kind === 'spotify'
    ? 'Getting the playlist from Spotify…'
    : source.kind === 'soundcloud' ? 'Getting the set from SoundCloud…' : 'Reading the spreadsheet…';
  progressSub.textContent = 'Then Track Lab checks it against your library and looks for full-quality copies on Qobuz and Beatport.';
  progressCount.textContent = '';
  (progressSection as HTMLElement & { _resetStats?: () => void })._resetStats?.();

  // Collapse the picker; the progress card is now the focus.
  setInputBarVisible(false);
  revealInContent(progressSection);

  let ok = false;
  try {
    const result = await window.candybar.librarySourcingRun(
      source.kind === 'spotify' ? { spotifyPlaylistUrl: source.ref }
        : source.kind === 'soundcloud' ? { soundcloudSetUrl: source.ref }
        : { csvPath: source.ref }
    );

    if (!result.success || !result.result) {
      showRunError(result.error || 'The check stopped without saying why.');
      setInputBarVisible(!resultsShown() || appendMode);
      setStatus('Error');
      return false;
    }

    const { matched: freshMatched, probable: freshProbable, storeMatches: freshStoreMatches } = result.result;

    // Rows actually added (after removing repeats) — drives auto-tick so
    // rows already on screen keep the ticks they have.
    let appendedCount = freshStoreMatches.length;
    if (appendMode) {
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

    // Auto-tick confident FULL-QUALITY matches of the same version only.
    // Compressed (or unverifiable) matches and different versions must be
    // reviewed by hand; tracks in the library (confirmed OR probable) are
    // never nudged into a re-buy.
    const toAutoSelect = appendMode ? matches.slice(matches.length - appendedCount) : matches;
    if (!appendMode) selectedFree = new Set();
    finderInfo = result.result.finder ?? null;
    for (const m of toAutoSelect) {
      // A set's free download goes first: its store copy waits until that fails.
      if (freeFetchable(m)) { selectedFree.add(m.trackInput.key); continue; }
      if (!autoSelectable(m)) continue;
      if (m.libraryStatus === 'confirmed' || m.libraryStatus === 'probable') continue;
      if (m.inLibrary) continue; // legacy guard for older matches missing libraryStatus
      if (m.source === 'qobuz' && m.qobuzTrack) selectedQobuzIds.add(m.qobuzTrack.id);
      else if (m.source === 'beatport' && m.beatportTrack) selectedBeatportIds.add(m.beatportTrack.id);
    }
    appendMode = false;

    // Keep it in Your playlists, with this check's own counts.
    const info = runPlaylistInfo as SourcePlaylistInfo | null;
    const name = info?.name || (source.kind === 'csv' ? csvDisplayName(source.ref) : source.name || source.ref);
    if (!sessionSources.some(s => s.kind === source.kind && s.ref === source.ref)) {
      sessionSources = [...sessionSources, { kind: source.kind, ref: source.ref, name }];
    }
    lastRunAt = Date.now();
    void persistSaved({
      kind: source.kind,
      ref: source.ref,
      name,
      imageUrl: info?.imageUrl ?? null,
      owner: info?.owner ?? '',
      trackCount: info ? (info.fetchedCount || info.trackCount) : freshMatched.length + freshStoreMatches.length,
      counts: countsFor(freshStoreMatches, freshMatched),
    }).then(async (saved) => {
      // A moved spreadsheet was re-pointed: carry its name over and drop the old entry.
      const fromId = source.relocateFrom;
      if (!saved || fromId === undefined || fromId === saved.id) return;
      const old = savedSources.find(x => x.id === fromId);
      if (old?.renamed) {
        const res = await window.candybar.savedSourcesUpdate(saved.id, { name: old.name });
        if (res.success && res.source) savedSources = savedSources.map(x => (x.id === saved.id ? res.source! : x));
      }
      await window.candybar.savedSourcesRemove(fromId);
      savedSources = savedSources.filter(x => x.id !== fromId);
      renderSaved();
    });

    resultsSection.style.display = 'block';
    setInputBarVisible(false);
    movePlaylistCardToResults();
    updateSummary();
    renderResults();
    updateBuyBar();
    setStatus('Idle');
    saveSourcesState();
    ok = true;
    return true;
  } catch (err) {
    showRunError(getErrorMessage(err));
    setInputBarVisible(!resultsShown() || appendMode);
    setStatus('Error');
    return false;
  } finally {
    searching = false;
    if (!ok && !resultsShown()) clearPlaylistCard();
    progressSection.style.display = 'none';
    (progressSection as HTMLElement & { _stopTimer?: () => void })._stopTimer?.();
    syncAddStrip();
  }
}

async function addSelectedToCart() {
  if (isAddingToCart()) {
    showToast('info', 'Still adding', 'Wait for the tracks going in now to finish.');
    return;
  }
  const qobuzToAdd = selectedForCart('qobuz');
  const beatportToAdd = selectedForCart('beatport');

  if (qobuzToAdd.length === 0 && beatportToAdd.length === 0) {
    showToast('warning', 'No tracks ticked', 'Tick at least one track to add it to a cart.');
    return;
  }

  addToCartBtn.disabled = true;
  cartAddProgress.style.display = '';
  const outcome = await addToStoreCarts({ qobuz: qobuzToAdd, beatport: beatportToAdd }, (store, p) => {
    cartAddStore.textContent = STORE_LABEL[store];
    cartAddCount.textContent = `${p.current.toLocaleString()} of ${p.total.toLocaleString()}`;
    cartAddBar.style.width = `${p.total > 0 ? Math.round((p.current / p.total) * 100) : 0}%`;
    cartAddMessage.textContent = p.currentTrack ? `Adding ${p.currentTrack}` : p.message;
  });
  cartAddProgress.style.display = 'none';
  toastCartOutcome(outcome);

  // The carts keep everything added this session, so the lists do too — the
  // drawer and the post-checkout download need every batch, not the last one.
  if (outcome.added.qobuz.length > 0) {
    lastAddedQobuz = mergeAdded(lastAddedQobuz, outcome.added.qobuz);
    downloadFiredQobuz = false;
    cartChecks.qobuz = null;
  }
  if (outcome.added.beatport.length > 0) {
    lastAddedBeatport = mergeAdded(lastAddedBeatport, outcome.added.beatport);
    downloadFiredBeatport = false;
    cartChecks.beatport = null;
  }

  if (outcome.added.qobuz.length + outcome.added.beatport.length > 0) openCartDrawer();
  updateBuyBar();
}

/** This tab is sending the user to `store`'s cart: a purchase confirmation
 *  seen in the panel within CHECKOUT_WATCH_MS is taken as this tab's order. */
function armCheckoutWatch(store: Store) {
  checkoutArmedAt[store] = Date.now();
  checkoutSeen[store] = false;
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
 *  a Place Order button. The caller confirms with the user before clicking. */
async function driveToPlaceOrder(store: 'qobuz' | 'beatport'): Promise<{ ready: boolean; total: string | null; itemCount?: number | null; error?: string }> {
  const MAX_STEPS = 6;
  const STEP_WAIT_MS = 2200;
  const label = STORE_LABEL[store];

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await window.candybar.storePanelCheckoutAdvance(store);
    if (!res.success || !res.result) {
      return { ready: false, total: null, error: res.error ?? `The ${label} checkout didn't move on.` };
    }
    const r = res.result;
    if (r.phase === 'place-order-ready') {
      return { ready: true, total: r.total, itemCount: r.itemCount ?? null };
    }
    if (r.phase === 'advanced') {
      await new Promise(r => setTimeout(r, STEP_WAIT_MS));
      continue;
    }
    // 'unknown' — no next-step button visible. The page may still be loading:
    // wait once more and retry, then give up.
    await new Promise(r => setTimeout(r, STEP_WAIT_MS));
    const retry = await window.candybar.storePanelCheckoutAdvance(store);
    if (!retry.success || !retry.result) {
      return { ready: false, total: null, error: retry.error ?? `The ${label} checkout didn't move on.` };
    }
    if (retry.result.phase === 'place-order-ready') {
      return { ready: true, total: retry.result.total, itemCount: retry.result.itemCount ?? null };
    }
    if (retry.result.phase === 'advanced') {
      await new Promise(r => setTimeout(r, STEP_WAIT_MS));
      continue;
    }
    return { ready: false, total: null, error: `Track Lab couldn't find the next checkout step on this page. Press ${label}'s own Checkout button in the panel, then choose Fill in checkout for me again.` };
  }
  return { ready: false, total: null, error: `The ${label} checkout didn't reach the last step after ${MAX_STEPS} tries. Finish it yourself in the panel.` };
}

async function runAutoCheckout(store: 'qobuz' | 'beatport') {
  const button = store === 'qobuz' ? autoCheckoutQobuzBtn : autoCheckoutBeatportBtn;
  const label = STORE_LABEL[store];
  const tracks = store === 'qobuz' ? lastAddedQobuz : lastAddedBeatport;

  if (tracks.length === 0) {
    showToast('warning', 'Nothing to check out', `Track Lab hasn't put anything in your ${label} cart yet.`);
    return;
  }

  // The drawer's dimmer sits above the panel: a bank's approval step there
  // would be under it, and the first click would only close the drawer.
  closeCartDrawer();
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = `Checking your ${label} cart…`;

  try {
    // An empty cart has no checkout to fill in; say so rather than failing on
    // the store's home page, where an empty cart redirects.
    const check = await reconcileWithCart(store, tracks);
    cartChecks[store] = check;
    renderCartStage();
    renderCartHero();
    if (check.empty) {
      showToast('info', `Your ${label} cart is empty`,
        'Nothing to check out. If you already bought these, choose Download my purchases in Review carts.');
      return;
    }

    // Open the panel on the cart before driving it.
    button.textContent = `Opening ${label}…`;
    armCheckoutWatch(store);
    await window.candybar.storePanelOpen(store, cartUrl(store));
    await new Promise(r => setTimeout(r, 1500));

    button.textContent = `Filling in the ${label} checkout…`;
    const drive = await driveToPlaceOrder(store);
    if (!drive.ready) {
      showToast('error', 'The checkout stopped part way', drive.error ?? `Finish it yourself in the ${label} panel.`);
      return;
    }

    const displayTotal = drive.total ?? 'Shown in the cart panel';
    // The order is the whole store cart, which can hold more than this tab
    // added (Upgrades, an earlier session). Show the store's own count when the
    // checkout page gives one; otherwise say what the count actually is.
    const countDetail = typeof drive.itemCount === 'number'
      ? { label: 'Items in the cart', value: String(drive.itemCount) }
      : { label: 'Added by Track Lab', value: String(tracks.length) };
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
      showToast('info', 'No order placed', `Your ${label} cart is as you left it.`);
      return;
    }

    button.textContent = `Placing your ${label} order…`;
    const commit = await window.candybar.storePanelPlaceOrder(store);
    if (commit.success) {
      showToast('success', `${label} order placed`,
        'If your bank asks you to approve it, do that in the panel. Your downloads start once the order is confirmed.');
    } else {
      showToast('error', `The ${label} order didn't go through`, commit.error ?? 'Finish it yourself in the panel.');
    }
  } catch (err) {
    showToast('error', 'The checkout stopped', err instanceof Error ? err.message : String(err));
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function exportResults() {
  if (matches.length === 0) {
    showToast('warning', 'Nothing to save', 'There are no tracks in this list yet.');
    return;
  }

  const defaultName = `track-lab-list-${new Date().toISOString().slice(0, 10)}.csv`;
  const filePath = await window.candybar.showSaveDialog(defaultName);
  if (!filePath) return;

  const rows = matches.map(m => {
    const source = m.source || 'not_found';
    const matchArtist = m.qobuzTrack?.artists.join(', ') || m.beatportTrack?.artists.join(', ') || '';
    const matchTitle = m.qobuzTrack?.name || m.beatportTrack?.name || '';
    const url = m.qobuzTrack?.url || m.beatportTrack?.url || '';
    const quality = m.qobuzTrack?.quality || '';
    const price = m.qobuzTrack?.price || m.beatportTrack?.price || '';
    return [
      m.trackInput.artist, m.trackInput.title, source, matchArtist, matchTitle,
      String(Math.round(m.confidence * 100)), quality, price, url,
    ].map(v => `"${(v || '').replace(/"/g, '""')}"`).join(',');
  });
  const headers = ['Artist', 'Title', 'Source', 'Match Artist', 'Match Title', 'Confidence', 'Quality', 'Price', 'URL'];
  const csvContent = [headers.join(','), ...rows].join('\n');

  try {
    const result = await window.candybar.sourceExportCsv(csvContent, filePath);
    if (result.success) {
      showToast('success', 'Spreadsheet saved', `Saved to ${filePath}`);
    } else {
      showToast('error', "Couldn't save the spreadsheet", result.error || 'Try a different folder.');
    }
  } catch {
    showToast('error', "Couldn't save the spreadsheet", 'Try a different folder.');
  }
}

/** Download `list`; returns the input keys of the tracks that came down. */
async function downloadList(list: StoreMatch[], label?: string): Promise<Set<string>> {
  const where = label ? `${label} ` : '';
  showToast('info', `Downloading your ${where}purchases`, `Getting ${plural(list.length, 'track')}…`);
  try {
    const res = await window.candybar.storeDownloadPurchases(list);
    if (res.success) {
      const got = res.downloaded ?? 0;
      showToast(got === list.length ? 'success' : 'warning', got === list.length ? 'Downloads finished' : 'Some downloads are still missing',
        `${got.toLocaleString()} of ${plural(list.length, 'track')} downloaded to ${res.destDir ?? 'your new-music folder'}.`);
      return new Set((res.files ?? []).map(f => f.key));
    }
    showToast('error', "The downloads didn't start", res.error ?? 'Try again in a moment.');
  } catch (e) {
    showToast('error', "The downloads didn't start", getErrorMessage(e, 'Try again in a moment.'));
  }
  return new Set();
}

// ========== Init ==========

export function initSource() {
  const slot = document.getElementById('source-source-slot');
  if (slot) {
    slot.innerHTML = renderSourceInput({
      actionId: 'run-source-search',
      actionLabel: 'Check this playlist',
      actionHint: 'Check each track against your library, then look for the rest in full quality on Qobuz and Beatport. Nothing is bought.',
      actionDisabledHint: 'Paste a playlist link or choose a spreadsheet first',
      ids: {
        linkInput: 'source-link',
        linkIcon: 'source-link-icon',
        linkStatus: 'source-link-status',
        dropZone: 'source-csv-drop-zone',
        fileDisplay: 'source-csv-file-display',
        pathInput: 'source-csv',
        clearBtn: 'clear-source-csv',
        browseTarget: 'source-csv',
        previewSection: 'source-csv-preview-section',
        previewCount: 'source-csv-preview-count',
        previewColumns: 'source-csv-preview-columns',
        previewThead: 'source-csv-preview-thead',
        previewTbody: 'source-csv-preview-tbody',
        previewStatus: 'source-csv-preview-status',
        previewStatusText: 'source-csv-preview-status-text',
      },
    });
  }

  runError = document.createElement('div');
  runError.className = 'callout callout--danger buy-run-error';
  runError.setAttribute('role', 'alert');
  runError.style.display = 'none';
  inputBar.insertBefore(runError, document.getElementById('source-source-slot'));

  runSearchBtn = document.getElementById('run-source-search') as HTMLButtonElement;
  runSearchLabel = runSearchBtn.querySelector('.buy-action-label') as HTMLElement;
  csvDropZone = document.getElementById('source-csv-drop-zone') as HTMLDivElement;
  csvFileDisplay = document.getElementById('source-csv-file-display') as HTMLDivElement;
  csvPreviewSection = document.getElementById('source-csv-preview-section') as HTMLDetailsElement;
  csvPreviewCount = document.getElementById('source-csv-preview-count') as HTMLSpanElement;
  csvPreviewColumns = document.getElementById('source-csv-preview-columns') as HTMLSpanElement;
  csvPreviewThead = document.getElementById('source-csv-preview-thead') as HTMLTableSectionElement;
  csvPreviewTbody = document.getElementById('source-csv-preview-tbody') as HTMLTableSectionElement;
  csvPreviewStatus = document.getElementById('source-csv-preview-status') as HTMLDivElement;
  csvPreviewStatusText = document.getElementById('source-csv-preview-status-text') as HTMLElement;
  csvFileName = csvFileDisplay.querySelector('.file-name') as HTMLSpanElement;
  clearCsvBtn = document.getElementById('clear-source-csv') as HTMLButtonElement;
  linkInput = document.getElementById('source-link') as HTMLInputElement;
  linkIcon = document.getElementById('source-link-icon') as HTMLElement;
  linkStatus = document.getElementById('source-link-status') as HTMLElement;

  validateLink('');

  runSearchBtn.addEventListener('click', () => void runSearch());
  // The link field: read as you type (briefly debounced), right away on paste,
  // and Enter runs the check like the button does.
  let linkDebounce: ReturnType<typeof setTimeout>;
  linkInput.addEventListener('input', () => {
    if (csvPath && linkInput.value.trim()) clearCsvFile();
    clearTimeout(linkDebounce);
    linkDebounce = setTimeout(() => validateLink(linkInput.value), 200);
  });
  linkInput.addEventListener('paste', () => setTimeout(() => {
    clearTimeout(linkDebounce);
    if (csvPath) clearCsvFile();
    validateLink(linkInput.value);
    hideRunError();
  }, 0));
  linkInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(linkDebounce);
    validateLink(linkInput.value);
    if (!runSearchBtn.disabled) void runSearch();
  });

  // Spreadsheet: drop it anywhere on the card, or click the empty drop zone /
  // Choose file… to pick one.
  csvDropZone.addEventListener('click', (event) => {
    if (csvDropZone.classList.contains('has-file')) return;
    if ((event.target as HTMLElement).closest('button')) return;
    csvDropZone.querySelector<HTMLButtonElement>('[data-browse]')?.click();
  });
  inputBar.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    csvDropZone.classList.add('is-dragging');
  });
  inputBar.addEventListener('dragleave', (event) => {
    if (inputBar.contains(event.relatedTarget as Node | null)) return;
    csvDropZone.classList.remove('is-dragging');
  });
  inputBar.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    event.preventDefault();
    csvDropZone.classList.remove('is-dragging');
    if (!file.name.toLowerCase().endsWith('.csv')) {
      showToast('error', "That isn't a CSV file", 'Drop a spreadsheet saved as CSV, with Artist and Title columns.');
      return;
    }
    const path = 'path' in file ? (file as File & { path: string }).path : '';
    if (!path) {
      showToast('error', "Couldn't open that file", 'Use Choose file… to pick it instead.');
      return;
    }
    hideRunError();
    void setSourceCsvFile(path);
  });

  clearCsvBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    clearCsvFile();
    linkInput.focus();
  });

  // Saved playlists: row actions, ticks, rename form, "check together"
  savedList.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
    const row = (e.target as HTMLElement).closest<HTMLElement>('.buy-saved-row');
    if (!btn || !row || btn.disabled) return;
    void onSavedAction(Number(row.dataset.id), btn.dataset.act!);
  });
  savedList.addEventListener('change', (e) => {
    const box = e.target as HTMLInputElement;
    const row = box.closest<HTMLElement>('.buy-saved-row');
    if (box.type !== 'checkbox' || !row) return;
    const id = Number(row.dataset.id);
    if (box.checked) savedSelected.add(id); else savedSelected.delete(id);
    renderSaved();
  });
  savedList.addEventListener('submit', (e) => {
    const form = (e.target as HTMLElement).closest<HTMLFormElement>('[data-rename-form]');
    const row = form?.closest<HTMLElement>('.buy-saved-row');
    if (!form || !row) return;
    e.preventDefault();
    void submitRename(Number(row.dataset.id), form.querySelector('input')?.value ?? '');
  });
  savedList.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && renamingId !== null) {
      e.preventDefault();
      e.stopPropagation();
      renamingId = null;
      renderSaved();
    }
  });
  savedTogetherBtn.addEventListener('click', () => void runSavedTogether());

  // Cart slide-over
  reviewCartBtn.addEventListener('click', () => openCartDrawer());
  document.getElementById('source-cart-hero-open')?.addEventListener('click', () => openCartDrawer());
  cartCloseBtn.addEventListener('click', () => closeCartDrawer());
  cartScrim.addEventListener('click', () => closeCartDrawer());
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || cartDrawer.style.display === 'none') return;
    e.preventDefault();
    closeCartDrawer();
  });

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    renderResults();
  });

  addToCartBtn.addEventListener('click', () => void addSelectedToCart());

  // "Add another playlist" reopens the picker above the list; the next check
  // merges into it.
  addStrip.querySelectorAll<HTMLButtonElement>('[data-add-source]').forEach((btn) => {
    btn.addEventListener('click', () => beginAppend());
  });
  document.getElementById('source-append-cancel')?.addEventListener('click', cancelAppend);
  document.getElementById('source-new-list')?.addEventListener('click', () => void confirmClearResults());

  // Open a cart in the store panel. Close the drawer first: its scrim would
  // otherwise sit over the app, and the panel replaces it.
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

  // "Fill in checkout for me": drives the panel from cart to the Place order
  // page, asks with the store's total, then places it. 3-D Secure stays in the panel.
  autoCheckoutQobuzBtn.addEventListener('click', () => void runAutoCheckout('qobuz'));
  autoCheckoutBeatportBtn.addEventListener('click', () => void runAutoCheckout('beatport'));

  downloadPurchasesBtn.addEventListener('click', async () => {
    const all = [...lastAddedQobuz, ...lastAddedBeatport];
    if (all.length === 0) {
      showToast('warning', 'Nothing to download', "Track Lab hasn't put anything in your carts this time.");
      return;
    }
    // Once the carts have been read, what left them is what was bought; the
    // tracks still sitting in a cart weren't, and would only fail.
    const gone = [...cartView('qobuz').gone, ...cartView('beatport').gone];
    downloadPurchasesBtn.disabled = true;
    try {
      pruneDownloaded(await downloadList(gone.length > 0 ? gone : all));
    } finally {
      downloadPurchasesBtn.disabled = false;
    }
  });

  // Watch the panel for a purchase-confirmation page → download what this tab
  // put in that store's cart. Only for a store whose cart this tab opened
  // recently (armCheckoutWatch), and once per checkout.
  window.candybar.onStorePanelNavigated(async ({ url }) => {
    if (!url) return;
    // Log every navigation so the success-URL patterns can be tightened.
    console.log('[panel-nav]', url);
    for (const store of ['qobuz', 'beatport'] as const) {
      const armedAt = checkoutArmedAt[store];
      const list = store === 'qobuz' ? lastAddedQobuz : lastAddedBeatport;
      const fired = store === 'qobuz' ? downloadFiredQobuz : downloadFiredBeatport;
      if (fired || list.length === 0 || armedAt === null || Date.now() - armedAt > CHECKOUT_WATCH_MS) continue;
      // A confirmation only counts after the panel went through checkout.
      if (!(checkoutSeen[store] && isPurchaseConfirmation(store, url))) {
        if (isStoreCheckoutStep(store, url)) checkoutSeen[store] = true;
        continue;
      }

      if (store === 'qobuz') downloadFiredQobuz = true; else downloadFiredBeatport = true;
      checkoutArmedAt[store] = null;
      checkoutSeen[store] = false;
      saveSourcesState();
      pruneDownloaded(await downloadList(list, STORE_LABEL[store]));
    }
  });

  exportCsvBtn.addEventListener('click', () => void exportResults());

  // ---- Progress: plain-words headline, time left, live tally, recent feed ----
  const progressEta = document.getElementById('source-progress-eta') as HTMLSpanElement | null;
  const progressTally = document.getElementById('source-progress-tally') as HTMLElement | null;
  const progressQobuzCount = document.getElementById('source-progress-qobuz-count') as HTMLElement | null;
  const progressBeatportCount = document.getElementById('source-progress-beatport-count') as HTMLElement | null;
  const progressNotFoundCount = document.getElementById('source-progress-notfound-count') as HTMLElement | null;
  const progressRecent = document.getElementById('source-progress-recent') as HTMLDivElement | null;
  const progressRecentWrap = document.getElementById('source-progress-recent-wrap') as HTMLElement | null;

  let searchStartedAt = 0;
  let storeStartedAt = 0;
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;
  let liveQobuz = 0;
  let liveBeatport = 0;
  let liveNotFound = 0;
  let lastTotal = 0;
  let lastCurrent = 0;

  function timeLeft(seconds: number): string {
    if (seconds < 45) return 'less than a minute left';
    const minutes = Math.round(seconds / 60);
    return `about ${plural(Math.max(1, minutes), 'minute')} left`;
  }

  function updateEta() {
    if (!progressEta) return;
    if (storeStartedAt && lastCurrent > 2 && lastCurrent < lastTotal) {
      const elapsed = (Date.now() - storeStartedAt) / 1000;
      progressEta.textContent = timeLeft((elapsed / lastCurrent) * (lastTotal - lastCurrent));
    } else {
      progressEta.textContent = '';
    }
  }

  function setMeter(pct: number) {
    progressBar.style.width = `${pct}%`;
    progressBar.parentElement?.setAttribute('aria-valuenow', String(pct));
  }

  function resetSearchStats() {
    liveQobuz = liveBeatport = liveNotFound = 0;
    lastTotal = lastCurrent = 0;
    storeStartedAt = 0;
    if (progressQobuzCount) progressQobuzCount.textContent = '0';
    if (progressBeatportCount) progressBeatportCount.textContent = '0';
    if (progressNotFoundCount) progressNotFoundCount.textContent = '0';
    if (progressTally) progressTally.hidden = true;
    if (progressRecent) progressRecent.innerHTML = '';
    if (progressRecentWrap) progressRecentWrap.hidden = true;
    if (progressEta) progressEta.textContent = '';
    setMeter(0);
    searchStartedAt = Date.now();
    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = setInterval(updateEta, 1000);
  }

  function stopSearchTimer() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    searchStartedAt = 0;
  }

  (progressSection as HTMLElement & { _resetStats?: () => void; _stopTimer?: () => void })._resetStats = resetSearchStats;
  (progressSection as HTMLElement & { _resetStats?: () => void; _stopTimer?: () => void })._stopTimer = stopSearchTimer;

  // Library check progress (runs before the store search).
  window.candybar.onLibrarySourcingPhase1Progress((payload) => {
    if (!searching) return;
    const total = payload.total;
    if (payload.phase === 'parsing') {
      progressMessage.textContent = total > 1
        ? `Getting the playlist: ${payload.current.toLocaleString()} of ${plural(total, 'track')}…`
        : progressMessage.textContent;
    } else if (payload.phase === 'scanning') {
      progressMessage.textContent = 'Reading your Rekordbox collection…';
      progressSub.textContent = 'Then Track Lab looks for full-quality copies on Qobuz and Beatport.';
    } else if (payload.phase === 'matching') {
      progressMessage.textContent = `Checking ${plural(total, 'track')} against your library…`;
      progressSub.textContent = 'Then Track Lab looks for full-quality copies of the rest on Qobuz and Beatport.';
    } else if (payload.phase === 'complete') {
      progressMessage.textContent = 'Library checked.';
    }
    if (total > 0 && payload.phase !== 'parsing') {
      setMeter(Math.round((payload.current / total) * 100));
      progressCount.textContent = `${payload.current.toLocaleString()} of ${plural(total, 'track')}`;
    }
  });

  // Store search progress.
  window.candybar.onLibrarySourcingPhase2Progress((payload) => {
    if (!searching) return;
    if (!storeStartedAt) storeStartedAt = Date.now();
    lastTotal = payload.total;
    lastCurrent = payload.current;
    const pct = payload.total > 0 ? Math.round((payload.current / payload.total) * 100) : 0;
    setMeter(pct);
    if (payload.total === 0) {
      progressMessage.textContent = 'You already have every track in this list.';
      progressSub.textContent = 'Nothing to look for in the stores.';
    } else {
      progressMessage.textContent = `Looking for full-quality copies of ${plural(payload.total, 'track')}…`;
      progressSub.textContent = payload.current > 0 && payload.currentTrack && !/preparing/i.test(payload.currentTrack)
        ? `Now looking for: ${payload.currentTrack}`
        : 'On Qobuz first, then Beatport.';
    }
    progressCount.textContent = payload.total > 0 ? `${payload.current.toLocaleString()} of ${payload.total.toLocaleString()} looked up` : '';
    if (progressTally) progressTally.hidden = payload.total === 0;
    updateEta();
  });

  window.candybar.onLibrarySourcingPhase2Match((match) => {
    if (searching) onStreamingMatch(match);
  });

  // Phase 3: Claude picking each track's record from what the search found.
  window.candybar.onLibrarySourcingFinderProgress((p) => {
    if (!searching) return;
    progressMessage.textContent = `Claude is picking the right record for ${plural(p.total, 'track')}…`;
    progressSub.textContent = p.done > 0
      ? 'It checks each match’s artist and version, and searches again when nothing fits.'
      : p.message;
    setMeter(p.total > 0 ? Math.round((p.done / p.total) * 100) : 0);
    progressCount.textContent = p.done > 0 ? `${p.done.toLocaleString()} of ${p.total.toLocaleString()} checked` : '';
    if (progressEta) progressEta.textContent = '';
  });

  // Playlist details arrive once Spotify/SoundCloud answer (before the slow
  // library check), so the cover card shows straight away.
  window.candybar.onLibrarySourcingPlaylistInfo((info) => {
    runPlaylistInfo = info;
    showPlaylistCard(info);
    saveSourcesState();
  });

  function onStreamingMatch(match: QobuzCartMatch) {
    // Same rule as the results: only a lossless match counts as for sale.
    const lossless = hasLosslessMatch(match);
    if (lossless && match.source === 'qobuz') { liveQobuz++; if (progressQobuzCount) progressQobuzCount.textContent = liveQobuz.toLocaleString(); }
    else if (lossless && match.source === 'beatport') { liveBeatport++; if (progressBeatportCount) progressBeatportCount.textContent = liveBeatport.toLocaleString(); }
    else { liveNotFound++; if (progressNotFoundCount) progressNotFoundCount.textContent = liveNotFound.toLocaleString(); }

    if (!progressRecent) return;
    if (progressRecentWrap) progressRecentWrap.hidden = false;
    const found = lossless && match.source && (match.qobuzTrack || match.beatportTrack);
    const title = found ? (match.qobuzTrack?.name ?? match.beatportTrack?.name ?? '') : match.trackInput.title;
    const artist = found
      ? (match.qobuzTrack?.artists.join(', ') ?? match.beatportTrack?.artists.join(', ') ?? '')
      : match.trackInput.artist;
    const pill = found
      ? `<span class="status-pill status-pill--ok">For sale on ${STORE_LABEL[match.source!]}</span>`
      : notForSalePillHtml(match);
    const row = document.createElement('div');
    row.className = 'buy-recent';
    row.innerHTML = `
      ${artHtml(found ? match.qobuzTrack?.image : null)}
      <div class="buy-recent-text">
        <span class="buy-t">${escapeHtml(title)}</span>
        <span class="buy-a">${escapeHtml(artist)}</span>
      </div>
      ${pill}`;
    attachArtFallback(row);
    progressRecent.prepend(row);
    while (progressRecent.children.length > 3) progressRecent.removeChild(progressRecent.lastElementChild!);
  }

  // Persist the list on screen across reloads, and bring it back now.
  window.addEventListener('beforeunload', saveSourcesState);
  restoreSourcesState();
  void loadSaved();
  // A saved list of what was added can be days old: read the real carts so
  // the "in your carts" banner says what's actually there.
  void refreshCartChecks();

  // "Check with Claude" (claudeReview.ts): it reads the rows with a
  // full-quality match and its verdicts tick or untick them. Only lossless,
  // not-maybe-owned matches are ever ticked; nothing is carted here.
  attachSourcingReview({
    rows: () => {
      const probableByKey = new Map(libraryProbable.map(r => [`${r.artist.toLowerCase()} - ${r.title.toLowerCase()}`, r]));
      return matches.filter(hasLosslessMatch).map(m => ({ match: m, probable: probableByKey.get(m.trackInput.key) }));
    },
    apply: (items) => {
      for (const { match, verdict } of items) {
        const id = match.source === 'qobuz' ? match.qobuzTrack?.id : match.beatportTrack?.id;
        const set = match.source === 'qobuz' ? selectedQobuzIds : selectedBeatportIds;
        if (!id) continue;
        if (verdict.verdict === 'buy') { if (match.lossless && match.libraryStatus !== 'probable') set.add(id); } else set.delete(id);
      }
      renderResults();
      updateBuyBar();
    },
  });
}
