import { cartUrl } from '../lib/storeUrls';
import type {
  LosslessUpgradeProgress, LosslessUpgradeResult, LosslessUpgradeRow, RekordboxPlaylistSummary, StoreMatch,
  UpgradeSwapInput, UpgradeSwapPlanItem, UpgradeSwapPreflight, UpgradeSwapProgress, UpgradeSwapResult,
} from '../types';
import type { FreeSourceHit, FreeSourceMiss, FreeUpgradeOutcome } from '../lib/freeSources';
import { showToast, setStatus, escapeHtml, getErrorMessage, plural, formatPriceTotal, isReleaseMatch } from './shared';
import { confirmChoice } from './confirmDialog';
import { gateEmailFieldHtml, fillGateEmailField, commitGateEmail, savedGateEmail, knownGateEmail } from './gateEmail';
import { fillPlaylistCard } from './playlistCard';
import { SOURCE_KIND_ICONS } from './sourceInputTemplate';
import {
  type Store, STORE_LABEL, autoSelectable, isOtherVersion, parsePriceDollars, toStoreMatch,
  uniqueByTrack, addToStoreCarts, isAddingToCart, toastCartOutcome, mergeAdded,
  matchPillHtml, qualityHtml, AUTO_SELECT_CONFIDENCE, revealInContent,
  reconcileWithCart, type CartReconcile,
} from './storeCart';

// Upgrade track quality: one guided flow in four step cards.
//   1 Pick a Rekordbox playlist → 2 See what can be upgraded (tick the copies
//   to buy) → 3 Buy them (check out, then download) → 4 Replace them in
//   Rekordbox (the swap engine keeps each entry, so cues, plays, date added,
//   ratings and playlists stay).
// Only the current step is open and shows its one action; finished steps fold
// to a one-line summary with a "Show" to reopen them. Same rules as Find and
// buy: a compressed store match is shown but can never be ticked or carted,
// and only confident same-version matches start ticked.
// Ben's order for where a copy comes from: a SoundCloud free download first,
// then Bandcamp (free, or bought there by hand), and only then Qobuz/Beatport.

type Step = 'pick' | 'review' | 'buy' | 'swap';
const STEPS: Step[] = ['pick', 'review', 'buy', 'swap'];
type Group = 'relink' | 'notfound' | 'lossless';
type RowKind = 'free' | 'found' | Group;

const STATE_KEY = 'candybar:upgrade-state:v1';
const LAST_PLAYLIST_KEY = 'candybar:upgrade-last-playlist';
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
const CHEVRON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
const NOTE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
const SEARCH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const SPINNER_SVG = '<svg class="buy-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-opacity="0.2"/><path d="M12 3a9 9 0 0 1 9 9" stroke-linecap="round"/></svg>';
const ICON = {
  info: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  warn: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  danger: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  success: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
};
const BANDCAMP_SVG = '<svg class="buy-kind-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="8 6 22 6 16 18 2 18"/></svg>';

// ========== Swap engine API ==========
// upgradeSwap* and the download's `files` (key `rb:<rbId>`) come from
// preload.ts, typed on window.candybar in shared.ts.
const swapApi = () => window.candybar;

// ========== DOM ==========

const page = document.getElementById('page-upgrade') as HTMLElement;
const playlistSelect = document.getElementById('upgrade-playlist') as HTMLSelectElement;
const refreshBtn = document.getElementById('upgrade-refresh') as HTMLButtonElement;
const runBtn = document.getElementById('upgrade-run') as HTMLButtonElement;
const clearBtn = document.getElementById('upgrade-clear') as HTMLButtonElement;
const hint = document.getElementById('upgrade-hint') as HTMLElement;
const pickBody = document.getElementById('upgrade-pick-body') as HTMLElement;

const progressSection = document.getElementById('upgrade-progress') as HTMLElement;
const progressMessage = document.getElementById('upgrade-progress-message') as HTMLElement;
const progressSub = document.getElementById('upgrade-progress-sub') as HTMLElement;
const progressCount = document.getElementById('upgrade-progress-count') as HTMLElement;
const progressPercent = document.getElementById('upgrade-progress-percent') as HTMLElement;
const progressBar = document.getElementById('upgrade-progress-bar') as HTMLElement;

const resultsSection = document.getElementById('upgrade-results') as HTMLElement;
const playlistCard = document.getElementById('upgrade-playlist-card') as HTMLElement;
const summary = document.getElementById('upgrade-summary') as HTMLElement;
const groupsContainer = document.getElementById('upgrade-groups') as HTMLElement;
const searchInput = document.getElementById('upgrade-search') as HTMLInputElement;

const cartAddProgress = document.getElementById('upgrade-cart-add-progress') as HTMLElement;
const cartAddStore = document.getElementById('upgrade-cart-add-store') as HTMLElement;
const cartAddCount = document.getElementById('upgrade-cart-add-count') as HTMLElement;
const cartAddBar = document.getElementById('upgrade-cart-add-bar') as HTMLElement;
const cartAddMessage = document.getElementById('upgrade-cart-add-message') as HTMLElement;

const buyBarN = document.getElementById('upgrade-buybar-n') as HTMLElement;
const buyBarQobuz = document.getElementById('upgrade-buybar-qobuz') as HTMLElement;
const buyBarBeatport = document.getElementById('upgrade-buybar-beatport') as HTMLElement;
const addToCartBtn = document.getElementById('upgrade-add-to-cart') as HTMLButtonElement;
const skipToSwapBtn = document.getElementById('upgrade-skip-to-swap') as HTMLButtonElement;

const buyBody = document.getElementById('upgrade-buy-body') as HTMLElement;
const cartSummary = document.getElementById('upgrade-cart-summary') as HTMLElement;
const openQobuzBtn = document.getElementById('upgrade-open-qobuz') as HTMLButtonElement;
const openBeatportBtn = document.getElementById('upgrade-open-beatport') as HTMLButtonElement;
const downloadBtn = document.getElementById('upgrade-download') as HTMLButtonElement;
const downloadResult = document.getElementById('upgrade-download-result') as HTMLElement;

const swapBody = document.getElementById('upgrade-swap') as HTMLElement;

const stepEl = (s: Step) => document.getElementById(`upgrade-step-${s}`) as HTMLElement;
const stepDesc = (s: Step) => document.getElementById(`upgrade-step-${s}-desc`) as HTMLElement;

// ========== State ==========

let playlists: RekordboxPlaylistSummary[] = [];
let playlistsLoaded = false;
let loadingPlaylists = false;
let running = false;
let result: LosslessUpgradeResult | null = null;
/** Ticked rows, by Rekordbox entry id. */
let selected = new Set<string>();
let searchQuery = '';
let openGroups = new Set<string>();
const openRows = new Set<string>();
/** Everything this tab has put in a cart. */
let lastAdded: StoreMatch[] = [];
/** The full-quality file each Rekordbox entry should switch to, by rbId: from a
 *  download, or chosen by hand (purchases can predate this session). */
let newFiles: Record<string, string> = {};
/** Where each file came from, shown on its row: 'downloaded', 'chosen', or any
 *  label a caller of addUpgradeFiles gives ("free download"). */
let fileOrigin: Record<string, string> = {};
/** Rows the person said to leave alone in step 4. */
let leaveAlone = new Set<string>();
/** "Get free downloads" is running; its latest line and where it's up to. */
let fetchingFree = false;
let fetchLine = '';
let fetchCount: { i: number; n: number } | null = null;
/** A yes for gates to follow, like and comment on SoundCloud. Asked each time, never kept. */
let freeAccountActions = false;
/** "I already have the files": open step 4 without buying first. */
let skipToSwap = false;
let lastDownload: { downloaded: number; total: number; matched: number; destDir: string | null } | null = null;
/** A step the person reopened; otherwise the flow picks the current one. */
let focusStep: Step | null = null;

// Step 4
type SwapStage = 'files' | 'planning' | 'plan' | 'applying' | 'done';
let swapStage: SwapStage = 'files';
let preflight: UpgradeSwapPreflight | null = null;
let preflightLoading = false;
let plan: UpgradeSwapPlanItem[] | null = null;
let planError: string | null = null;
let swapProgress: UpgradeSwapProgress | null = null;
let swapResult: UpgradeSwapResult | null = null;
let swapError: string | null = null;
/** After a one-track test, the ids still to do. */
let remainingAfterTest: string[] = [];

function readLocal(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLocal(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable or full — non-fatal */ }
}

// ========== Row classification ==========

/** The free copy to go for: SoundCloud's, else Bandcamp giving it away. */
function freeHit(r: LosslessUpgradeRow): FreeSourceHit | null {
  const f = r.free;
  if (!f) return null;
  return f.soundcloud ?? (f.bandcamp?.kind === 'free' ? f.bandcamp : null);
}

/** "Get free downloads" ran for this row and nothing full quality landed. */
function freeFailed(r: LosslessUpgradeRow): boolean {
  return !!r.freeOutcome && !r.freeOutcome.filePath;
}

/** A Bandcamp copy with a price: bought there by hand, ahead of the stores. */
function bandcampPaid(r: LosslessUpgradeRow): FreeSourceHit | null {
  const b = r.free?.bandcamp;
  return b?.kind === 'paid' ? b : null;
}

/** Bandcamp's free copy, when it's the only one and Bandcamp emails it. */
function needsEmailOnly(r: LosslessUpgradeRow): boolean {
  const h = freeHit(r);
  return !!h && h.source === 'bandcamp' && !!h.needsEmail;
}

/** A free row "Get free downloads" can still do something with. */
function fetchable(r: LosslessUpgradeRow): boolean {
  return !!freeHit(r) && !r.freeOutcome?.filePath && !needsEmailOnly(r);
}

const storeLossless = (r: LosslessUpgradeRow) => r.match?.status === 'matched' && r.match.lossless === true;

function kindOf(r: LosslessUpgradeRow): RowKind {
  if (r.format === 'lossless') return 'lossless';
  if (r.losslessCopy) return 'relink';
  // A free copy goes first; if it didn't work, the row falls back to Bandcamp
  // or the stores below.
  if (freeHit(r) && !freeFailed(r)) return 'free';
  if (storeLossless(r) || bandcampPaid(r)) return 'found';
  return 'notfound';
}

function rowName(r: LosslessUpgradeRow): string {
  return r.title || r.artist || r.filePath.split('/').pop() || r.filePath;
}

function fileNameOf(p: string): string {
  return p.split('/').pop() || p;
}

const SOURCE_NAME = { soundcloud: 'SoundCloud', bandcamp: 'Bandcamp' } as const;

/** One free-download attempt, in plain words ("the file was an MP3, so it was deleted"). */
function attemptText(a: FreeUpgradeOutcome['attempts'][number]): string {
  switch (a.status) {
    case 'lossy':
    case 'lossy-dropped': return 'the file was compressed (like an MP3), so it was deleted';
    case 'needs-email': return 'the download page wants an email address. Add yours next to "Get free downloads" and get it again';
    case 'emailed': return 'the download link was emailed';
    case 'needs-you':
    case 'stalled': return 'the download page needs a person to finish it';
    case 'not-free': return "it turned out not to be free";
    case 'several-files': return 'several files arrived (maybe the parts of the track). Choose the full track in step 4';
    case 'pending':
    case 'skipped': return "it wasn't tried";
    default: return "the download didn't finish";
  }
}

/** Why "Get free downloads" didn't land a file for this row, as a sentence. */
function freeFailedReason(r: LosslessUpgradeRow): string {
  const tried = (r.freeOutcome?.attempts ?? []).filter(a => a.status !== 'covered');
  if (tried.length === 0) return "The free download didn't work.";
  return `The free download didn't work: ${tried.map(a => `on ${SOURCE_NAME[a.source]}, ${attemptText(a)}`).join('; ')}.`;
}

/** Why an MP3 / streaming row has nothing to buy, as a sentence. */
function notFoundReason(r: LosslessUpgradeRow): string {
  if (r.note) return r.note;
  if (r.format === 'unknown') return `Track Lab couldn't tell whether ${r.formatLabel} is full quality, so it didn't look for a copy.`;
  const free = freeFailed(r) ? freeFailedReason(r)
    : r.free?.errors.length ? "Track Lab couldn't search SoundCloud or Bandcamp for this one."
    : '';
  const m = r.match;
  let store: string;
  if (!m) store = free ? 'Check the playlist again to look on Qobuz and Beatport too.' : "Track Lab didn't look for this one.";
  else if (m.status === 'error') store = "Track Lab couldn't search the stores for this one. Check the playlist again later.";
  else if (m.status === 'matched' && !m.lossless) store = `${m.source ? STORE_LABEL[m.source] : 'The store'} only sells a compressed copy, so it stays out of your cart.`;
  else if (r.free && !free) store = 'Nothing free on SoundCloud or Bandcamp, and not for sale in full quality on Qobuz or Beatport.';
  else store = 'Not found in full quality on Qobuz or Beatport.';
  const near = !free && !freeHit(r) ? nearMissSentence(r.free?.soundcloudMisses) : '';
  return [free, store, near].filter(Boolean).join(' ');
}

/** The closest SoundCloud upload the search passed over, and why: "On
 *  SoundCloud, "Go Back (Shizz Lo Flip)" by Shizz Lo is the closest, but it
 *  offers no free download." Another version is only worth a mention when
 *  nothing closer was passed over. */
function nearMissSentence(misses: FreeSourceMiss[] | undefined): string {
  const m = misses?.[0];
  if (!m) return '';
  return `On SoundCloud, "${m.listedAs}" by ${m.uploader} is the closest, but ${m.why.text}.`;
}

function matchesFilter(r: LosslessUpgradeRow): boolean {
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  const store = r.match?.qobuzTrack ?? r.match?.beatportTrack;
  const free = [r.free?.soundcloud, r.free?.bandcamp].map(h => h ? `${h.listedAs} ${h.uploader}` : '').join(' ');
  return `${r.artist} ${r.title} ${store ? `${store.artists.join(' ')} ${store.name}` : ''} ${free}`.toLowerCase().includes(q);
}

/** Step 2's one-line summary: what can be upgraded, and how many are ticked. */
function reviewDesc(): string {
  const can = rowsOf('free', false).length + rowsOf('found', false).length;
  return can > 0
    ? `${plural(can, 'track')} can be upgraded${selected.size > 0 ? ` · ${selected.size.toLocaleString()} ticked` : ''}`
    : 'Nothing to buy for this playlist.';
}

function rowsOf(kind: RowKind, filtered = true): LosslessUpgradeRow[] {
  return (result?.rows ?? []).filter(r => kindOf(r) === kind && (!filtered || matchesFilter(r)));
}

/** Ticked rows that may go to a cart (full-quality matches only), as cart
 *  payloads, one per store track: what "Add to carts" sends and the totals. */
function selectedForCart(store: Store): StoreMatch[] {
  const cartIds = new Set(UPGRADE_GROUPS.filter(g => g.cart).flatMap(g => g.rows(false).map(r => r.rbId)));
  return uniqueByTrack((result?.rows ?? [])
    // Ticked, in a cart group, and a full-quality store match: nothing else is carted.
    .filter(r => selected.has(r.rbId) && cartIds.has(r.rbId) && r.match?.status === 'matched' && r.match.lossless === true && r.match.source === store)
    .map(r => toStoreMatch(r.match!, store)));
}

const total = (items: StoreMatch[]) =>
  formatPriceTotal(items.reduce((s, m) => s + parsePriceDollars(m.price), 0), items.map(m => m.price));

// ========== Steps ==========

function stepUnlocked(s: Step): boolean {
  if (s === 'pick') return true;
  if (!result || running) return false;
  if (s === 'buy') return lastAdded.length > 0;
  return true;
}

function defaultStep(): Step {
  if (running || !result) return 'pick';
  if (swapResult || skipToSwap || Object.keys(newFiles).length > 0) return 'swap';
  if (lastAdded.length > 0) return 'buy';
  return 'review';
}

function currentStep(): Step {
  return focusStep && stepUnlocked(focusStep) ? focusStep : defaultStep();
}

function stepDone(s: Step): boolean {
  if (!result) return false;
  if (s === 'pick') return true;
  if (s === 'review') return lastAdded.length > 0 || skipToSwap || Object.keys(newFiles).length > 0;
  if (s === 'buy') return !!lastDownload;
  return !!swapResult && swapResult.swapped > 0;
}

function openStep(s: Step, scroll = true) {
  focusStep = s;
  renderSteps();
  if (s === 'swap') void ensurePreflight();
  if (scroll) revealInContent(stepEl(s), 'start');
}

function renderSteps() {
  const current = currentStep();
  for (const s of STEPS) {
    const el = stepEl(s);
    const unlocked = stepUnlocked(s);
    el.classList.toggle('is-current', s === current);
    el.classList.toggle('is-locked', !unlocked);
    el.classList.toggle('is-done', unlocked && s !== current && stepDone(s));
    const openBtn = el.querySelector<HTMLButtonElement>('.upg-step-open');
    if (openBtn) openBtn.hidden = !unlocked || s === current;
  }

  // Step 1
  pickBody.style.display = current === 'pick' && !running ? '' : 'none';
  progressSection.style.display = running ? '' : 'none';
  clearBtn.hidden = !result;
  if (result) {
    const p = result.playlist;
    stepDesc('pick').textContent = `${p.name} · ${plural(playlistCount(), 'track')}`;
  } else {
    stepDesc('pick').textContent = "Track Lab reads it and finds the tracks you only have as an MP3, AAC or streaming link. Nothing in Rekordbox changes.";
  }

  // Step 2
  resultsSection.style.display = current === 'review' && result ? '' : 'none';
  stepDesc('review').textContent = result ? reviewDesc() : 'Check a playlist first.';

  // Step 3
  buyBody.style.display = current === 'buy' ? '' : 'none';
  stepDesc('buy').textContent = lastAdded.length === 0
    ? 'Add tracks to your carts first.'
    : lastDownload
      ? `${plural(lastDownload.downloaded, 'track')} downloaded`
      : `${plural(lastAdded.length, 'track')} added to your carts. Check out, then download them.`;

  // Step 4
  swapBody.style.display = current === 'swap' ? '' : 'none';
  stepDesc('swap').textContent = swapResult
    ? `${plural(swapResult.swapped, 'track')} replaced in Rekordbox`
    : 'Track Lab points each track in Rekordbox at its new full-quality file. Cue points, beatgrid, play count, date added, rating, My Tags and playlists all stay.';

  if (current === 'review') renderGroups();
  if (current === 'buy') renderBuy();
  if (current === 'swap') renderSwap();
  updateBuyRow();
}

function playlistCount(): number {
  if (!result) return 0;
  const p = result.playlist;
  // A smart playlist listed as "not counted" was counted by the run itself.
  return p.countUnknown || p.count === 0 ? result.rows.length : p.count;
}

// ========== Step 1: playlist picker ==========

function optionLabel(p: RekordboxPlaylistSummary): string {
  const suffix = p.unreadable ? "can't read its rules"
    : p.countUnknown ? 'not counted yet'
    : p.count === 0 ? 'empty'
    : plural(p.count, 'track');
  return `${p.name}${p.kind === 'smart' ? ' (smart playlist)' : ''} · ${suffix}`;
}

/** Can be run: readable, and either has tracks or (a smart playlist the
 *  reader ran out of time to count) might. */
function pickable(p: RekordboxPlaylistSummary): boolean {
  return !p.unreadable && (p.count > 0 || !!p.countUnknown);
}

function setPickerMessage(text: string) {
  playlistSelect.innerHTML = '';
  playlistSelect.appendChild(new Option(text, ''));
  playlistSelect.disabled = true;
  updateRunButton();
}

function renderPlaylistOptions() {
  const remembered = playlistSelect.value || result?.playlist.id || readLocal(LAST_PLAYLIST_KEY) || '';
  playlistSelect.innerHTML = '';
  playlistSelect.appendChild(new Option('Choose a playlist…', ''));
  // One <optgroup> per folder, in the collection's own order.
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const p of playlists) {
    const label = p.path || 'Not in a folder';
    let group = groups.get(label);
    if (!group) {
      group = document.createElement('optgroup');
      group.label = label;
      groups.set(label, group);
      playlistSelect.appendChild(group);
    }
    const opt = new Option(optionLabel(p), p.id);
    opt.disabled = !pickable(p);
    if (p.unreadable) opt.title = p.unreadable;
    group.appendChild(opt);
  }
  if (playlists.some(p => p.id === remembered && pickable(p))) playlistSelect.value = remembered;
  playlistSelect.disabled = running || playlists.length === 0;
  updateRunButton();
}

async function loadPlaylists() {
  if (loadingPlaylists || running) return;
  loadingPlaylists = true;
  refreshBtn.disabled = true;
  playlistSelect.disabled = true;
  hint.className = 'field-help';
  hint.textContent = 'Reading your playlists from Rekordbox…';
  try {
    const res = await window.candybar.upgradeListPlaylists();
    if (!res.success || !res.playlists) throw new Error(res.error || "Track Lab couldn't read your Rekordbox playlists.");
    playlists = res.playlists;
    playlistsLoaded = true;
    renderPlaylistOptions();
    hint.textContent = playlists.length > 0
      ? `${plural(playlists.length, 'playlist')} in your Rekordbox collection.`
      : 'Your Rekordbox collection has no playlists yet.';
  } catch (err) {
    const message = getErrorMessage(err);
    if (playlists.length === 0) setPickerMessage("Couldn't read your playlists");
    else renderPlaylistOptions(); // keep the last good list usable
    hint.className = 'field-help is-error';
    hint.textContent = `Track Lab couldn't read your Rekordbox playlists. ${message} Press Look again to try once more.`;
  } finally {
    loadingPlaylists = false;
    refreshBtn.disabled = false;
  }
}

function updateRunButton() {
  runBtn.disabled = running || !playlistSelect.value;
}

// ========== Step 2: what can be upgraded ==========

function artHtml(url: string | null | undefined): string {
  return url
    ? `<img class="buy-art" src="${escapeHtml(url)}" alt="" loading="lazy" />`
    : `<div class="buy-art buy-art--placeholder">${NOTE_SVG}</div>`;
}

function attachArtFallback(root: HTMLElement) {
  root.querySelectorAll<HTMLImageElement>('img.buy-art').forEach((img) => {
    img.addEventListener('error', () => {
      const ph = document.createElement('div');
      ph.className = 'buy-art buy-art--placeholder';
      ph.innerHTML = NOTE_SVG;
      img.replaceWith(ph);
    }, { once: true });
  });
}

function needsCheck(r: LosslessUpgradeRow): boolean {
  const m = r.match!;
  return isOtherVersion(m) || isReleaseMatch(m) || m.confidence < AUTO_SELECT_CONFIDENCE;
}

function sourceChip(h: FreeSourceHit): string {
  return `<span class="buy-kind">${h.source === 'soundcloud' ? SOURCE_KIND_ICONS.soundcloud : BANDCAMP_SVG}${SOURCE_NAME[h.source]}</span>`;
}

/** "On Bandcamp for £2.00 or more (you choose the price)" with a link out. */
function bandcampLineHtml(b: FreeSourceHit): string {
  return `<span class="buy-sub upg-free-via">${sourceChip(b)}<span>On Bandcamp for <b>${escapeHtml(b.price!.label)}</b> or more. You choose the price and buy it there.</span>
    <button type="button" class="btn-link upg-link" data-url="${escapeHtml(b.url)}" data-tooltip="Open the track on Bandcamp in your browser. Track Lab never pays for you.">Open on Bandcamp</button></span>`;
}

function wireLinks(root: HTMLElement) {
  root.querySelectorAll<HTMLButtonElement>('.upg-link').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (btn.dataset.url) void window.candybar.openExternal(btn.dataset.url);
  }));
}

const NEED_TEXT: Record<string, string> = {
  email: 'your email', 'soundcloud-connect': 'a SoundCloud connect', comment: 'a comment',
  'spotify-connect': 'a Spotify connect', spotify: 'a Spotify follow', 'soundcloud-support': 'SoundCloud support (follow, like, repost)',
  instagram: 'an Instagram follow', tiktok: 'a TikTok follow', youtube: 'a YouTube follow', facebook: 'a Facebook follow',
  x: 'an X follow', beatport: 'a Beatport follow', mixcloud: 'a Mixcloud follow', 'droploud-follow': 'a Droploud follow',
  disclaimer: 'a rights checkbox', 'apple-music': 'an Apple Music connect', deezer: 'a Deezer follow',
};
const listText = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** The download page wants to act on the SoundCloud account (connect, comment). */
function needsAccountOk(h: FreeSourceHit): boolean {
  return !!h.gateInfo?.needs.some(n => n === 'soundcloud-connect' || n === 'comment');
}

/** "Found a free download?": paste a SoundCloud page or the download page for
 *  this track. Track Lab checks it against the copy it would replace, keeps it
 *  across checks, and fetches it with the other free downloads. */
function pasteLinkControl(r: LosslessUpgradeRow, label = 'Found a free download?'): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'upg-paste';
  wrap.innerHTML = `
    <button type="button" class="btn-link upg-paste-open" data-tooltip="Found a free download yourself? Paste its SoundCloud page or its download page. Track Lab checks it's the same version and gets it with the other free downloads.">${escapeHtml(label)}</button>
    <form class="upg-paste-form" hidden>
      <input type="url" required placeholder="SoundCloud page or download page link" aria-label="Free download link for ${escapeHtml(rowName(r))}" />
      <button type="submit" class="btn-secondary btn-sm">Use this link</button>
      <button type="button" class="btn-ghost btn-sm upg-paste-cancel">Cancel</button>
      <p class="upg-paste-error" role="alert" hidden></p>
    </form>`;
  const open = wrap.querySelector<HTMLButtonElement>('.upg-paste-open')!;
  const form = wrap.querySelector<HTMLFormElement>('.upg-paste-form')!;
  const input = form.querySelector<HTMLInputElement>('input')!;
  const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const error = form.querySelector<HTMLElement>('.upg-paste-error')!;
  const stop = (e: Event) => e.stopPropagation();
  wrap.addEventListener('click', stop);
  wrap.addEventListener('keydown', stop);
  open.addEventListener('click', () => { open.hidden = true; form.hidden = false; input.focus(); });
  form.querySelector('.upg-paste-cancel')!.addEventListener('click', () => { form.hidden = true; open.hidden = false; error.hidden = true; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = input.value.trim();
    if (!url) return;
    submit.disabled = true;
    submit.textContent = 'Checking…';
    error.hidden = true;
    try {
      const res = await window.candybar.upgradeUseLink(r.rbId, url);
      if (!res.success || !res.hit) throw new Error(res.error || "Track Lab couldn't use that link");
      r.free = { ...(r.free ?? { soundcloud: null, bandcamp: null, errors: [] }), soundcloud: res.hit, pasted: res.pasted ?? { url, warning: null } };
      r.freeOutcome = undefined;
      if (fetchable(r)) selected.add(r.rbId);
      openRows.add(r.rbId);
      saveState();
      renderSteps();
      const warning = res.pasted?.warning;
      showToast(warning ? 'warning' : 'success', warning ? 'Link added. Check it first' : 'Link added', warning || `${rowName(r)}: ${res.hit.reason}. It's under Free downloads.`, warning ? 9000 : 5000);
    } catch (err) {
      error.textContent = getErrorMessage(err);
      error.hidden = false;
      submit.disabled = false;
      submit.textContent = 'Use this link';
    }
  });
  return wrap;
}

async function forgetPastedLink(r: LosslessUpgradeRow) {
  const res = await window.candybar.upgradeForgetLink(r.rbId);
  if (!res.success) {
    showToast('error', "Couldn't forget the link", res.error);
    return;
  }
  if (r.free) r.free = { ...r.free, soundcloud: null, pasted: null };
  r.freeOutcome = undefined;
  selected.delete(r.rbId);
  saveState();
  renderSteps();
  showToast('info', 'Link forgotten', 'Check the playlist again to look for another free copy.');
}

/** A track only Bandcamp sells: never ticked, never carted; bought on Bandcamp. */
function buildBandcampRow(r: LosslessUpgradeRow): HTMLElement {
  const b = bandcampPaid(r)!;
  const el = document.createElement('div');
  el.className = 'buy-row buy-row--info upg-bandcamp-row';
  el.innerHTML = `
    <span class="buy-trk">
      <span class="buy-t">${escapeHtml(rowName(r))}</span>
      <span class="buy-a">${escapeHtml(r.artist)} · <span class="upg-from">now ${escapeHtml(r.formatLabel)}</span></span>
      ${freeFailed(r) ? `<span class="buy-sub">${escapeHtml(freeFailedReason(r))}</span>` : ''}
      ${bandcampLineHtml(b)}
    </span>
    <span class="buy-price">${escapeHtml(b.price!.label)}</span>`;
  wireLinks(el);
  el.querySelector('.buy-trk')!.appendChild(pasteLinkControl(r));
  return el;
}

/** A tickable "Free downloads" row: where the free copy is, what happens if
 *  it arrives compressed, and the links behind the chevron. */
function buildFreeRow(r: LosslessUpgradeRow): HTMLElement {
  const h = freeHit(r)!;
  const landed = r.freeOutcome?.filePath ?? null;
  const canTick = fetchable(r) && !fetchingFree;
  const ticked = selected.has(r.rbId) && fetchable(r);
  const open = openRows.has(r.rbId);
  const el = document.createElement('div');
  el.className = 'buy-row buy-row--pick';
  el.classList.toggle('sel', ticked);
  el.classList.toggle('is-open', open);
  el.classList.toggle('buy-row--static', !fetchable(r));
  const detailsId = `upg-row-more-${r.rbId}`;
  const pill = landed
    ? '<span class="buy-pill"><span class="status-pill status-pill--ok">Downloaded</span></span>'
    : needsEmailOnly(r)
      ? `<span class="buy-pill"><span class="status-pill status-pill--warn" tabindex="0" data-tooltip="${escapeHtml("Bandcamp emails this free download when you're signed out, so Track Lab can't get it for you. Open it on Bandcamp to get it yourself.")}">Needs an email</span></span>`
      : h.gateInfo?.needs.includes('email') && knownGateEmail() === ''
        ? `<span class="buy-pill"><span class="status-pill status-pill--warn" tabindex="0" data-tooltip="${escapeHtml('This download page asks for an email address before it gives the file. Add yours next to "Get free downloads" below.')}">Needs an email</span></span>`
      : needsAccountOk(h)
        ? `<span class="buy-pill upg-needs-ok"${freeAccountActions ? ' hidden' : ''}><span class="status-pill status-pill--warn" tabindex="0" data-tooltip="${escapeHtml('This download page wants to connect your SoundCloud and leave a comment. Tick "Let download pages follow, like and comment for me" below, or it\'s skipped.')}">Needs your OK</span></span>`
        : '';
  const pasted = r.free?.pasted && h.pasted ? r.free.pasted : null;
  const sc = r.free?.soundcloud;
  const bc = r.free?.bandcamp;
  // What happens if this copy doesn't work out, in Ben's order.
  const fallback = h.source === 'soundcloud' && bc?.kind === 'free' ? 'the free copy on Bandcamp'
    : h.source === 'soundcloud' && bc?.kind === 'paid' ? `Bandcamp (${bc.price!.label} or more)`
    : storeLossless(r) ? `${STORE_LABEL[r.match!.source!]} (${(r.match!.source === 'qobuz' ? r.match!.qobuzTrack : r.match!.beatportTrack)?.price || 'for sale'})`
    : '';
  const arrival = h.lossless === 'on-arrival'
    ? `SoundCloud doesn't say the file type until it arrives. If it's compressed (like an MP3), it's deleted${fallback ? ` and this track goes to ${escapeHtml(fallback)}` : ''}.`
    : h.source === 'soundcloud'
      ? `The download page says the file is ${h.gateInfo?.format ? `a ${escapeHtml(h.gateInfo.format)}` : 'full quality'}, so it's full quality.`
      : 'Bandcamp gives you the full-quality file (WAV, AIFF or FLAC).';
  const gi = h.gateInfo;
  const needs = gi?.needs.length
    ? `<p>The download page asks for ${escapeHtml(listText(gi.needs.map(n => NEED_TEXT[n] || n)))}.${
      needsAccountOk(h) ? ' Track Lab does the SoundCloud part only when the box below is ticked, with the comment saved in Settings.' : ''}${
      gi.needs.includes('email') ? ' Your saved email is used for the email.' : ''}${
      gi.needs.includes('spotify-connect') ? ' The Spotify connect uses the Spotify account signed in to the download window.' : ''}</p>`
    : '';
  const skipped = gi?.optional?.length ? `<p>It also offers ${escapeHtml(listText(gi.optional.map(n => NEED_TEXT[n] || n)))}, which Track Lab skips.</p>` : '';
  const link = (hit: FreeSourceHit | null | undefined) => hit
    ? `<button type="button" class="btn-ghost btn-sm upg-link" data-url="${escapeHtml(hit.url)}" data-tooltip="Open it on ${SOURCE_NAME[hit.source]} in your browser, to listen first.">Open on ${SOURCE_NAME[hit.source]}</button>`
    : '';
  el.innerHTML = `
    <div class="buy-row-main" role="checkbox" tabindex="${canTick ? 0 : -1}" aria-checked="${ticked}"${canTick ? '' : ' aria-disabled="true"'}>
      <span class="buy-cbx" aria-hidden="true">${CHECK_SVG}</span>
      ${artHtml(null)}
      <span class="buy-trk">
        <span class="buy-t">${escapeHtml(rowName(r))}</span>
        <span class="buy-a">${escapeHtml(r.artist)} · <span class="upg-from">now ${escapeHtml(r.formatLabel)}</span></span>
        <span class="buy-sub upg-free-via">${sourceChip(h)}${pasted ? '<span class="status-pill">Your link</span>' : ''}<span>${landed ? `Ready for step 4: <span class="term" tabindex="0" data-tooltip="${escapeHtml(landed)}">${escapeHtml(fileNameOf(landed))}</span>` : escapeHtml(h.reason)}</span></span>
      </span>
      ${pill}
      <span class="buy-price buy-price--free">Free</span>
    </div>
    <button type="button" class="btn-icon buy-row-expand" aria-expanded="${open}" aria-controls="${detailsId}" aria-label="Details for ${escapeHtml(rowName(r))}" data-tooltip="Where the free copy is, and what happens if it doesn't work out">${CHEVRON_SVG}</button>
    <div class="buy-row-more" id="${detailsId}" ${open ? '' : 'hidden'}>
      ${pasted
        ? `<p>You pasted this link: <span class="term" tabindex="0" data-tooltip="${escapeHtml(pasted.url)}">${escapeHtml(pasted.url)}</span>${h.confidence ? `. Track Lab is ${Math.round(h.confidence * 100)}% sure it's the same version.` : '.'}</p>${pasted.warning ? `<p class="upg-warn">${escapeHtml(pasted.warning)}</p>` : ''}`
        : `<p>The free copy: <b>${escapeHtml(h.listedAs)}</b>, uploaded by ${escapeHtml(h.uploader)}. Track Lab is ${Math.round(h.confidence * 100)}% sure it's the same version.</p>`}
      <p>${arrival}</p>
      ${needs}
      ${skipped}
      ${h.gateNote ? `<p>${escapeHtml(h.gateNote)}</p>` : ''}
      <div class="buy-row-facts">${link(sc)}${link(bc)}${pasted ? '<button type="button" class="btn-ghost btn-sm upg-forget">Forget this link</button>' : ''}</div>
    </div>`;
  attachArtFallback(el);
  wireLinks(el);
  const main = el.querySelector<HTMLElement>('.buy-row-main')!;
  const expand = el.querySelector<HTMLButtonElement>('.buy-row-expand')!;
  const more = el.querySelector<HTMLElement>('.buy-row-more')!;
  const toggle = () => {
    if (!fetchable(r) || fetchingFree) return;
    const on = !selected.has(r.rbId);
    if (on) selected.add(r.rbId); else selected.delete(r.rbId);
    el.classList.toggle('sel', on);
    main.setAttribute('aria-checked', String(on));
    stepDesc('review').textContent = reviewDesc();
    updateBuyRow();
    saveState();
  };
  main.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.term, .status-pill')) return;
    toggle();
  });
  el.querySelector('.upg-forget')?.addEventListener('click', () => void forgetPastedLink(r));
  if (!pasted && !landed) more.appendChild(pasteLinkControl(r, 'Know a better link?'));
  main.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
  expand.addEventListener('click', () => {
    const nowOpen = more.hidden;
    more.hidden = !nowOpen;
    expand.setAttribute('aria-expanded', String(nowOpen));
    el.classList.toggle('is-open', nowOpen);
    if (nowOpen) openRows.add(r.rbId); else openRows.delete(r.rbId);
  });
  return el;
}

/** A tickable "Can be upgraded" row: what it is now, the price, and the store
 *  copy's details behind the chevron. A track only Bandcamp sells gets an
 *  untickable row instead. */
function buildFoundRow(r: LosslessUpgradeRow): HTMLElement {
  if (!storeLossless(r)) return buildBandcampRow(r);
  const m = r.match!;
  const store = m.source!;
  const track = store === 'qobuz' ? m.qobuzTrack! : m.beatportTrack!;
  const open = openRows.has(r.rbId);
  const el = document.createElement('div');
  el.className = 'buy-row buy-row--pick';
  el.classList.toggle('sel', selected.has(r.rbId));
  el.classList.toggle('is-open', open);
  const detailsId = `upg-row-more-${r.rbId}`;
  el.innerHTML = `
    <div class="buy-row-main" role="checkbox" tabindex="0" aria-checked="${selected.has(r.rbId)}">
      <span class="buy-cbx" aria-hidden="true">${CHECK_SVG}</span>
      ${artHtml(store === 'qobuz' ? m.qobuzTrack?.image : null)}
      <span class="buy-trk">
        <span class="buy-t">${escapeHtml(rowName(r))}</span>
        <span class="buy-a">${escapeHtml(r.artist)} · <span class="upg-from">now ${escapeHtml(r.formatLabel)}</span></span>
        ${freeFailed(r) ? `<span class="buy-sub">${escapeHtml(freeFailedReason(r))}</span>` : ''}
        ${bandcampPaid(r) ? bandcampLineHtml(bandcampPaid(r)!) : ''}
      </span>
      ${needsCheck(r) ? `<span class="buy-pill">${matchPillHtml(m)}</span>` : ''}
      <span class="buy-price">${escapeHtml(track.price || '—')}</span>
    </div>
    <button type="button" class="btn-icon buy-row-expand" aria-expanded="${open}" aria-controls="${detailsId}" aria-label="Details for ${escapeHtml(rowName(r))}" data-tooltip="Which copy Track Lab found, and how sure the match is">${CHEVRON_SVG}</button>
    <div class="buy-row-more" id="${detailsId}" ${open ? '' : 'hidden'}>
      <div class="buy-row-facts">
        <span><span class="upg-from">${escapeHtml(r.formatLabel)}</span><span class="upg-arrow">→</span><span class="upg-to">${qualityHtml(m)}</span></span>
        <span>On ${STORE_LABEL[store]}</span>
        <span>${matchPillHtml(m)}</span>
      </div>
      <p>The copy for sale: <b>${escapeHtml(track.name)}</b> — ${escapeHtml(track.artists.join(', '))}</p>
      ${m.note ? `<p>${escapeHtml(m.note)}</p>` : ''}
      <button type="button" class="btn-ghost btn-sm buy-row-open" data-tooltip="Open this track's page in the ${STORE_LABEL[store]} panel, to listen before you buy. Nothing is added to your cart.">Open on ${STORE_LABEL[store]}</button>
    </div>`;
  attachArtFallback(el);
  wireLinks(el);
  const main = el.querySelector<HTMLElement>('.buy-row-main')!;
  const toggle = () => {
    const on = !selected.has(r.rbId);
    if (on) selected.add(r.rbId); else selected.delete(r.rbId);
    el.classList.toggle('sel', on);
    main.setAttribute('aria-checked', String(on));
    updateBuyRow();
    stepDesc('review').textContent = reviewDesc();
    saveState();
  };
  main.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.term, .buy-match, .upg-link')) return;
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
    if (nowOpen) openRows.add(r.rbId); else openRows.delete(r.rbId);
  });
  el.querySelector('.buy-row-open')?.addEventListener('click', () => {
    if (track.url) void window.candybar.storePanelOpen(store, track.url);
  });
  more.appendChild(pasteLinkControl(r, 'Found it free somewhere?'));
  return el;
}

function buildInfoRow(r: LosslessUpgradeRow, kind: Group): HTMLElement {
  const el = document.createElement('div');
  el.className = 'buy-row buy-row--info';
  if (kind === 'relink') {
    const copy = r.losslessCopy!;
    el.innerHTML = `
      <span class="buy-trk">
        <span class="buy-t">${escapeHtml(rowName(r))}</span>
        <span class="buy-a">${escapeHtml(r.artist)}</span>
        <span class="buy-sub">This playlist plays the <b>${escapeHtml(r.formatLabel)}</b>. You also have <b>${escapeHtml(copy.formatLabel)}</b>: <span class="term" tabindex="0" data-tooltip="${escapeHtml(copy.filePath)}">${escapeHtml(fileNameOf(copy.filePath))}</span></span>
      </span>
      <button type="button" class="btn-ghost btn-sm" data-tooltip="Show the full-quality file in Finder">Show file</button>`;
    el.querySelector('button')?.addEventListener('click', () => void window.candybar.showInFinder(copy.filePath));
    return el;
  }
  if (kind === 'lossless') {
    el.innerHTML = `
      <span class="buy-trk"><span class="buy-t">${escapeHtml(rowName(r))}</span><span class="buy-a">${escapeHtml(r.artist)}</span></span>
      <span class="status-pill status-pill--ok">${escapeHtml(r.formatLabel)}</span>`;
    return el;
  }
  const compressedOnly = r.match?.status === 'matched' && !r.match.lossless;
  el.innerHTML = `
    <span class="buy-trk">
      <span class="buy-t">${escapeHtml(rowName(r))}</span>
      <span class="buy-a">${escapeHtml(r.artist)} · now ${escapeHtml(r.formatLabel)}</span>
      <span class="buy-sub">${escapeHtml(notFoundReason(r))}</span>
    </span>
    ${compressedOnly ? '<span class="status-pill status-pill--warn">Compressed only</span>' : '<span class="status-pill">Not found</span>'}`;
  if (r.format === 'lossy' || r.format === 'streaming') el.querySelector('.buy-trk')!.appendChild(pasteLinkControl(r));
  return el;
}

/**
 * Step 2's groups, in the order they show. Data-driven so a new group (say,
 * "Free downloads") is one more entry: its rows, its words, whether its rows
 * can be ticked, and whether ticked rows go to a store cart.
 *  - A `main` group is an open card with its own heading and row list.
 *  - A quiet group is a one-line summary under the main ones that expands.
 *  - `selectable` rows get a tick; `cart` says ticked rows are cart items
 *    (full-quality store matches only — Ben's rule, enforced again in
 *    selectedForCart and in main).
 */
type GroupDef = {
  id: string;
  main: boolean;
  /** Main: the heading. Quiet: the summary line (may hold <b>). */
  title: (n: number) => string;
  /** Quiet only: the short hint at the right of the summary. */
  hint?: string;
  /** One or two plain sentences on what these are and what to do. */
  intro: string;
  /** The group's rows; `filtered` applies the search box. */
  rows: (filtered: boolean) => LosslessUpgradeRow[];
  selectable: boolean;
  cart: boolean;
  /** Excluded from "Tick all" (flagged to check first). */
  holdBack?: (r: LosslessUpgradeRow) => boolean;
  row: (r: LosslessUpgradeRow) => HTMLElement;
  empty?: { title: string; text: string };
  /** Main only: leave the card out for now (nothing in it worth a card). */
  hidden?: () => boolean;
  /** Main only: what goes under the rows (the group's own action). */
  actions?: () => HTMLElement | null;
};

const UPGRADE_GROUPS: GroupDef[] = [
  {
    id: 'free',
    main: true,
    title: () => 'Free downloads',
    intro: "Free copies on SoundCloud and Bandcamp. Track Lab looks there first, before the stores. Ticked tracks download to your new-music folder. If a file arrives compressed, it's deleted and the track goes back to a copy you can buy.",
    rows: (filtered) => rowsOf('free', filtered),
    selectable: true,
    cart: false,
    holdBack: (r) => !fetchable(r),
    row: buildFreeRow,
    hidden: () => rowsOf('free', false).length === 0,
    actions: freeActions,
  },
  {
    id: 'found',
    main: true,
    title: () => 'Can be upgraded',
    intro: 'A full-quality copy is for sale. Strong matches are ticked for you. Tap a track to tick or untick it. When Bandcamp has it too, buy it there first: it\'s often cheaper, and it never goes in a cart.',
    rows: (filtered) => rowsOf('found', filtered),
    selectable: true,
    cart: true,
    holdBack: (r) => !storeLossless(r) || !!bandcampPaid(r) || isOtherVersion(r.match!) || isReleaseMatch(r.match!),
    row: buildFoundRow,
    empty: { title: 'Nothing to buy for this playlist', text: 'Every track is already full quality, owned in full quality, or not for sale. See below.' },
    // With free downloads above, an empty "Can be upgraded" card is just noise.
    hidden: () => rowsOf('found', false).length === 0 && rowsOf('free', false).length > 0,
  },
  {
    id: 'relink',
    main: false,
    title: (n) => `You already own a full-quality copy of <b>${n.toLocaleString()}</b>`,
    hint: 'Nothing to buy',
    intro: "Track Lab found a full-quality file of the same version in your collection. There's nothing to buy. Step 4 explains what happens to these.",
    rows: (filtered) => rowsOf('relink', filtered),
    selectable: false,
    cart: false,
    row: (r) => buildInfoRow(r, 'relink'),
  },
  {
    id: 'notfound',
    main: false,
    title: (n) => `<b>${n.toLocaleString()}</b> ${n === 1 ? 'has' : 'have'} no full-quality copy for sale`,
    hint: 'Compressed only, or not found',
    intro: "Nothing free on SoundCloud or Bandcamp, and Qobuz and Beatport don't sell these in full quality. Compressed copies (like MP3) never go in a cart. If you have a full-quality file from somewhere else, you can choose it in step 4.",
    rows: (filtered) => rowsOf('notfound', filtered),
    selectable: false,
    cart: false,
    row: (r) => buildInfoRow(r, 'notfound'),
  },
  {
    id: 'lossless',
    main: false,
    title: (n) => `<b>${n.toLocaleString()}</b> already full quality`,
    hint: 'Nothing to do',
    intro: 'AIFF, WAV, FLAC or ALAC files. Nothing to do.',
    rows: (filtered) => rowsOf('lossless', filtered),
    selectable: false,
    cart: false,
    row: (r) => buildInfoRow(r, 'lossless'),
  },
];

function emptyHtml(title: string, text: string): string {
  if (searchQuery) {
    return `<div class="empty-state buy-empty"><span class="empty-state-icon">${SEARCH_SVG}</span><h4>No tracks match "${escapeHtml(searchQuery)}"</h4><p>Try a different artist or title.</p><div class="empty-state-actions"><button type="button" class="btn-secondary btn-sm" data-clear-search>Clear the search</button></div></div>`;
  }
  return `<div class="empty-state buy-empty"><span class="empty-state-icon">${CHECK_SVG}</span><h4>${escapeHtml(title)}</h4><p>${escapeHtml(text)}</p></div>`;
}

function renderMainGroup(g: GroupDef): HTMLElement {
  const rows = g.rows(true);
  const section = document.createElement('section');
  section.className = 'buy-group';
  section.dataset.group = g.id;
  section.innerHTML = `
    <div class="buy-group-head">
      <div class="buy-group-text">
        <h3 class="buy-group-title">${escapeHtml(g.title(rows.length))} <span class="buy-group-count">${rows.length.toLocaleString()}</span></h3>
        <p class="card-desc">${escapeHtml(g.intro)}</p>
      </div>
      ${g.selectable && rows.length > 0 ? `<div class="buy-group-actions">
        <button type="button" class="btn-ghost btn-sm" data-select="all" data-tooltip="Tick every track here, except ones marked to check first (a different version or a whole release).">Tick all</button>
        <button type="button" class="btn-ghost btn-sm" data-select="none">Untick all</button>
      </div>` : ''}
    </div>`;
  if (rows.length === 0) {
    section.insertAdjacentHTML('beforeend', emptyHtml(g.empty?.title ?? 'Nothing here', g.empty?.text ?? ''));
  } else {
    const list = document.createElement('div');
    list.className = 'buy-list upg-scroll';
    for (const r of rows) list.appendChild(g.row(r));
    section.appendChild(list);
  }
  section.querySelectorAll<HTMLButtonElement>('[data-select]').forEach(btn => btn.addEventListener('click', () => {
    for (const r of g.rows(true)) {
      if (btn.dataset.select === 'none') selected.delete(r.rbId);
      else if (!g.holdBack?.(r)) selected.add(r.rbId);
    }
    saveState();
    renderSteps();
  }));
  const actions = g.actions?.();
  if (actions) section.appendChild(actions);
  return section;
}

// ---------- Free downloads: the group's own action ----------

/** Ticked free rows that "Get free downloads" would fetch. */
function freeTicked(): LosslessUpgradeRow[] {
  return rowsOf('free', false).filter(r => selected.has(r.rbId) && fetchable(r));
}

/** A downloader line as a sentence, or null to keep the last one showing. */
function applyFetchLine(line: string) {
  const m = line.match(/^\((\d+)\/(\d+)\)\s+(.*?)\s+\[/);
  if (m) {
    fetchCount = { i: Number(m[1]), n: Number(m[2]) };
    fetchLine = `Getting ${m[3]}`;
  } else if (/sign in/i.test(line)) {
    fetchLine = 'Sign in to SoundCloud in the Chrome window that just opened. Track Lab waits for you.';
  } else if (/STOPPED: only/.test(line)) {
    fetchLine = 'Your drive is almost full, so the downloads stopped. Free up some space, then try again.';
  }
}

function updateFetchProgress() {
  const line = document.getElementById('upgrade-free-line');
  const count = document.getElementById('upgrade-free-count');
  const bar = document.getElementById('upgrade-free-bar');
  if (line) line.textContent = fetchLine || 'Starting the downloads…';
  if (count) count.textContent = fetchCount ? `${fetchCount.i.toLocaleString()} of ${plural(fetchCount.n, 'download')}` : '';
  if (bar) bar.style.width = fetchCount ? `${Math.round(((fetchCount.i - 1) / fetchCount.n) * 100)}%` : '0%';
}

function freeActions(): HTMLElement {
  const n = freeTicked().length;
  const el = document.createElement('div');
  el.className = 'upg-free-actions';
  if (fetchingFree) {
    el.innerHTML = `
      <div class="callout upg-free-progress" role="status">${SPINNER_SVG}
        <div class="callout-body">
          <strong>Getting your free downloads…</strong>
          <p id="upgrade-free-line"></p>
          <div class="buy-meter buy-meter--sm"><div class="buy-meter-fill" id="upgrade-free-bar" style="width: 0%"></div></div>
          <p class="upg-free-count" id="upgrade-free-count"></p>
        </div>
        <div class="callout-actions"><button type="button" class="btn-secondary btn-sm" id="upgrade-free-stop" data-tooltip="Stop after the track it's on. Anything already downloaded stays in your new-music folder.">Stop</button></div>
      </div>`;
    el.querySelector('#upgrade-free-stop')?.addEventListener('click', () => void window.candybar.upgradeFetchFreeStop());
    queueMicrotask(updateFetchProgress);
    return el;
  }
  const needingEmail = freeTicked().filter(r => freeHit(r)?.gateInfo?.needs.includes('email')).length;
  el.innerHTML = `
    ${gateEmailFieldHtml('upgrade-free-email', needingEmail)}
    <label class="upg-check">
      <input type="checkbox" id="upgrade-free-actions-ok" ${freeAccountActions ? 'checked' : ''} />
      <span><strong>Let download pages follow, like and comment for me</strong><span>Some free downloads on SoundCloud ask you to follow or like first. This does it on your SoundCloud account. Without it, those ones are skipped.</span></span>
    </label>
    <div class="card-actions">
      <span class="card-actions-note">${ICON.shield}Nothing is bought. Files go to your new-music folder.</span>
      <button type="button" class="${n > 0 ? 'btn-primary' : 'btn-secondary'}" id="upgrade-get-free" ${n === 0 ? 'disabled' : ''}
        data-tooltip="Download the ticked free copies, SoundCloud first, then Bandcamp. A Chrome window opens for the download pages."
        data-tooltip-disabled="Tick at least one free download first">${n > 0 ? `Get ${plural(n, 'free download')}` : 'Get free downloads'}</button>
    </div>`;
  el.querySelector<HTMLInputElement>('#upgrade-free-actions-ok')?.addEventListener('change', (e) => {
    freeAccountActions = (e.target as HTMLInputElement).checked;
    groupsContainer.querySelectorAll<HTMLElement>('.upg-needs-ok').forEach(p => { p.hidden = freeAccountActions; });
  });
  el.querySelector('#upgrade-get-free')?.addEventListener('click', () => void getFreeDownloads());
  fillGateEmailField(el, 'upgrade-free-email');
  return el;
}

async function getFreeDownloads() {
  const rows = freeTicked();
  if (rows.length === 0 || fetchingFree) return;
  // The address in the box goes to Settings first: the downloader reads it there.
  if (await commitGateEmail(document, 'upgrade-free-email') === null) return;
  fetchingFree = true;
  fetchLine = '';
  fetchCount = null;
  setStatus('Downloading…');
  renderSteps();
  const off = window.candybar.onUpgradeProgress((p) => {
    if (p.phase !== 'fetching') return;
    applyFetchLine(p.message);
    updateFetchProgress();
  });
  try {
    const res = await window.candybar.upgradeFetchFree(rows.map(r => r.rbId), { accountActions: freeAccountActions });
    if (!res.success || !res.outcomes) throw new Error(res.error || 'The downloads stopped without saying why.');
    const landed: UpgradeSwapInput[] = [];
    for (const r of rows) {
      const o = res.outcomes[r.rbId];
      if (!o) continue;
      r.freeOutcome = o;
      if (o.filePath) {
        landed.push({ rbId: r.rbId, newFilePath: o.filePath });
        selected.delete(r.rbId);
      } else if (storeLossless(r) && autoSelectable(r.match!) && !bandcampPaid(r)) {
        selected.add(r.rbId); // back on its store copy, ticked like any sure match
      } else {
        selected.delete(r.rbId);
      }
    }
    const missed = rows.length - landed.length;
    showToast(landed.length > 0 && missed === 0 ? 'success' : 'warning',
      landed.length > 0 ? `${plural(landed.length, 'free download')} ready` : 'No free downloads came through',
      missed > 0 ? `${plural(missed, 'track')} didn't work. Each one says why.` : 'They\'re ready to replace in step 4.');
    saveState();
    if (landed.length > 0) {
      addUpgradeFiles(landed, 'free download');
      // Still something to buy? Stay on step 2 for it; step 4 has the files.
      if (rowsOf('found', false).some(storeLossless)) openStep('review', false);
    }
    setStatus('Idle');
  } catch (err) {
    const message = getErrorMessage(err);
    if (message === 'Stopped') showToast('info', 'Free downloads stopped', 'Anything already downloaded stays in your new-music folder. Get them again to pick those up.');
    else showToast('error', 'The free downloads stopped', message);
    setStatus('Idle');
  } finally {
    off();
    fetchingFree = false;
    saveState();
    renderSteps();
  }
}

function renderQuietGroup(g: GroupDef, rows: LosslessUpgradeRow[]): HTMLElement {
  const d = document.createElement('details');
  d.className = 'disclosure buy-quiet';
  d.dataset.group = g.id;
  d.open = openGroups.has(g.id) || !!searchQuery;
  d.innerHTML = `<summary><span class="buy-quiet-title">${g.title(rows.length)}</span>${g.hint ? `<span class="disclosure-hint">${escapeHtml(g.hint)}</span>` : ''}</summary>
    <div class="disclosure-body"><p class="buy-quiet-intro">${escapeHtml(g.intro)}</p><div class="buy-list"></div></div>`;
  const list = d.querySelector('.buy-list')!;
  for (const r of rows) list.appendChild(g.row(r));
  d.addEventListener('toggle', () => {
    if (searchQuery) return;
    if (d.open) openGroups.add(g.id); else openGroups.delete(g.id);
    saveState();
  });
  return d;
}

function renderGroups() {
  if (!result) return;
  fillPlaylistCard(playlistCard, {
    name: result.playlist.name,
    imageUrl: null,
    trackCount: playlistCount(),
    fetchedCount: playlistCount(),
    owner: [result.playlist.path, result.playlist.kind === 'smart' ? 'smart playlist' : ''].filter(Boolean).join(' · '),
    source: 'rekordbox',
  });
  renderSummary();

  groupsContainer.innerHTML = '';
  for (const g of UPGRADE_GROUPS.filter(x => x.main && !x.hidden?.())) groupsContainer.appendChild(renderMainGroup(g));
  const quiet = document.createElement('div');
  quiet.className = 'buy-quiet-list';
  for (const g of UPGRADE_GROUPS.filter(x => !x.main)) {
    const rows = g.rows(true);
    if (rows.length > 0) quiet.appendChild(renderQuietGroup(g, rows));
  }
  if (quiet.childElementCount > 0) groupsContainer.appendChild(quiet);
  groupsContainer.querySelector('[data-clear-search]')?.addEventListener('click', () => {
    searchQuery = '';
    searchInput.value = '';
    renderSteps();
  });
}

function renderSummary() {
  const rows = result?.rows ?? [];
  const n = (k: RowKind) => rowsOf(k, false).length;
  const can = n('free') + n('found');
  const parts: string[] = [];
  if (n('free')) parts.push(`${n('free').toLocaleString()} ${n('free') === 1 ? 'is' : 'are'} free on SoundCloud or Bandcamp.`);
  if (n('lossless')) parts.push(`${n('lossless').toLocaleString()} ${n('lossless') === 1 ? 'is' : 'are'} already full quality.`);
  if (n('relink')) parts.push(`You already own a full-quality copy of ${n('relink').toLocaleString()}.`);
  if (n('notfound')) parts.push(`${n('notfound').toLocaleString()} ${n('notfound') === 1 ? 'has' : 'have'} no full-quality copy for sale.`);
  summary.innerHTML = `
    <h3 class="buy-summary-title">${can > 0 ? `${can.toLocaleString()} of ${plural(rows.length, 'track')} can be upgraded` : 'Nothing to buy for this playlist'}</h3>
    <p>${parts.join(' ') || 'Every track was checked.'}</p>`;
}

function updateBuyRow() {
  const q = selectedForCart('qobuz');
  const b = selectedForCart('beatport');
  const n = q.length + b.length;
  buyBarN.textContent = n > 0 ? `${plural(n, 'track')} selected` : 'No tracks selected';
  buyBarQobuz.textContent = q.length > 0 ? `${total(q)} on Qobuz` : '';
  buyBarBeatport.textContent = b.length > 0 ? `${total(b)} on Beatport` : '';
  const stores = (q.length > 0 ? 1 : 0) + (b.length > 0 ? 1 : 0);
  addToCartBtn.textContent = n > 0 ? `Add ${plural(n, 'track')} to ${stores > 1 ? 'carts' : 'cart'}` : 'Add to carts';
  addToCartBtn.disabled = isAddingToCart() || n === 0;
  // Free downloads come first: while some are ticked, theirs is the step's one
  // primary button and the cart steps back.
  const freeN = fetchingFree ? 1 : freeTicked().length;
  addToCartBtn.classList.toggle('btn-primary', freeN === 0);
  addToCartBtn.classList.toggle('btn-secondary', freeN > 0);
  const getFree = document.getElementById('upgrade-get-free') as HTMLButtonElement | null;
  if (getFree) {
    getFree.disabled = freeN === 0;
    getFree.classList.toggle('btn-primary', freeN > 0);
    getFree.classList.toggle('btn-secondary', freeN === 0);
    getFree.textContent = freeN > 0 ? `Get ${plural(freeN, 'free download')}` : 'Get free downloads';
  }
  addToCartBtn.setAttribute('data-tooltip-disabled', isAddingToCart() ? 'Wait for the tracks going in now to finish' : 'Tick at least one track first');
}

// ========== Step 3: buy ==========

/** The stores' real carts, read when step 3 shows: a track leaves the cart
 *  when it's bought or taken out, so the summary says what's actually there. */
let cartChecks: Record<Store, CartReconcile | null> = { qobuz: null, beatport: null };
let cartCheckedAt = 0;
let cartChecking = false;

function refreshCartChecks(): void {
  if (cartChecking || lastAdded.length === 0 || Date.now() - cartCheckedAt < 30_000) return;
  cartChecking = true;
  const stores = (['qobuz', 'beatport'] as const).filter(s => lastAdded.some(m => m.source === s));
  void Promise.all(stores.map(async s => [s, await reconcileWithCart(s, lastAdded.filter(m => m.source === s))] as const))
    .then((results) => {
      cartChecks = { qobuz: null, beatport: null };
      for (const [s, check] of results) cartChecks[s] = check;
      cartCheckedAt = Date.now();
    })
    .finally(() => {
      cartChecking = false;
      if (currentStep() === 'buy') renderBuy();
    });
}

/** One store's added tracks, split by its cart when that's been read. */
function cartView(store: Store): { inCart: StoreMatch[]; gone: StoreMatch[] } {
  const list = lastAdded.filter(m => m.source === store);
  const gone = new Set((cartChecks[store]?.gone ?? []).map(m => m.trackId));
  return { inCart: list.filter(m => !gone.has(m.trackId)), gone: list.filter(m => gone.has(m.trackId)) };
}

function renderBuy() {
  refreshCartChecks();
  const q = cartView('qobuz');
  const b = cartView('beatport');
  const parts = [
    q.inCart.length ? `${plural(q.inCart.length, 'track')} on Qobuz (${total(q.inCart)})` : '',
    b.inCart.length ? `${plural(b.inCart.length, 'track')} on Beatport (${total(b.inCart)})` : '',
  ].filter(Boolean);
  const gone = q.gone.length + b.gone.length;
  const goneNote = gone > 0 ? ` ${plural(gone, 'other track')} Track Lab added ${gone === 1 ? 'has' : 'have'} left your carts: bought, or taken out.` : '';
  cartSummary.textContent = parts.length > 0
    ? `In your carts: ${parts.join(' and ')}. Nothing is bought until you check out.${goneNote}`
    : `The ${plural(gone, 'track')} Track Lab added ${gone === 1 ? 'has' : 'have'} left your carts: bought, or taken out. If you checked out, download them.`;
  openQobuzBtn.style.display = lastAdded.some(m => m.source === 'qobuz') ? '' : 'none';
  openBeatportBtn.style.display = lastAdded.some(m => m.source === 'beatport') ? '' : 'none';
  if (lastDownload) {
    downloadResult.hidden = false;
    downloadResult.className = `field-help ${lastDownload.downloaded === lastDownload.total ? 'is-ok' : 'is-warn'}`;
    downloadResult.textContent = `${lastDownload.downloaded.toLocaleString()} of ${plural(lastDownload.total, 'track')} downloaded${lastDownload.destDir ? ` to ${lastDownload.destDir}` : ''}.`
      + (lastDownload.matched > 0 ? ` ${plural(lastDownload.matched, 'is', 'are')} ready to replace in step 4.` : '');
  } else {
    downloadResult.hidden = true;
  }
}

async function addSelectedToCarts() {
  if (isAddingToCart()) {
    showToast('info', 'Still adding', 'Wait for the tracks going in now to finish.');
    return;
  }
  const batches = { qobuz: selectedForCart('qobuz'), beatport: selectedForCart('beatport') };
  if (batches.qobuz.length + batches.beatport.length === 0) {
    showToast('warning', 'No tracks ticked', 'Tick at least one track to add it to a cart.');
    return;
  }
  addToCartBtn.disabled = true;
  cartAddProgress.style.display = '';
  const outcome = await addToStoreCarts(batches, (store, p) => {
    cartAddStore.textContent = STORE_LABEL[store];
    cartAddCount.textContent = `${p.current.toLocaleString()} of ${p.total.toLocaleString()}`;
    cartAddBar.style.width = `${p.total > 0 ? Math.round((p.current / p.total) * 100) : 0}%`;
    cartAddMessage.textContent = p.currentTrack ? `Adding ${p.currentTrack}` : p.message;
  });
  cartAddProgress.style.display = 'none';
  toastCartOutcome(outcome);
  const added = [...outcome.added.qobuz, ...outcome.added.beatport];
  lastAdded = mergeAdded(lastAdded, added);
  if (added.length > 0) cartCheckedAt = 0;
  saveState();
  if (added.length > 0) openStep('buy');
  else renderSteps();
}

async function downloadPurchases() {
  if (lastAdded.length === 0) return;
  downloadBtn.disabled = true;
  showToast('info', 'Downloading your purchases', `Getting ${plural(lastAdded.length, 'track')}…`);
  try {
    const res = await swapApi().storeDownloadPurchases(lastAdded);
    if (!res.success) {
      showToast('error', "The downloads didn't start", res.error ?? 'Try again in a moment.');
      return;
    }
    // Each file comes back under its match's input key, `rb:<id>`: the
    // Rekordbox entry it upgrades.
    let matched = 0;
    for (const f of res.files ?? []) {
      const rbId = f.key.startsWith('rb:') ? f.key.slice(3) : '';
      if (!rbId || !f.path) continue;
      newFiles[rbId] = f.path;
      fileOrigin[rbId] = 'downloaded';
      leaveAlone.delete(rbId);
      matched++;
    }
    lastDownload = { downloaded: res.downloaded ?? 0, total: lastAdded.length, matched, destDir: res.destDir ?? null };
    saveState();
    showToast(lastDownload.downloaded === lastAdded.length ? 'success' : 'warning',
      lastDownload.downloaded === lastAdded.length ? 'Downloads finished' : 'Some downloads are still missing',
      `${lastDownload.downloaded.toLocaleString()} of ${plural(lastAdded.length, 'track')} downloaded.`);
    if (matched > 0) {
      resetSwap();
      openStep('swap');
    } else {
      renderSteps();
    }
  } catch (err) {
    showToast('error', "The downloads didn't start", getErrorMessage(err));
  } finally {
    downloadBtn.disabled = false;
  }
}

// ========== Step 4: replace in Rekordbox ==========

/** Every row that isn't full quality yet, with the file it would switch to. */
function swapCandidates(): Array<{ row: LosslessUpgradeRow; path: string | null; origin: string | null }> {
  return (result?.rows ?? [])
    .filter(r => r.format !== 'lossless')
    .map(r => {
      if (newFiles[r.rbId]) return { row: r, path: newFiles[r.rbId], origin: fileOrigin[r.rbId] ?? 'chosen' };
      if (r.losslessCopy) return { row: r, path: r.losslessCopy.filePath, origin: 'owned' as const };
      return { row: r, path: null, origin: null };
    });
}

function readyInputs(): UpgradeSwapInput[] {
  return swapCandidates()
    .filter(c => c.path && !leaveAlone.has(c.row.rbId))
    .map(c => ({ rbId: c.row.rbId, newFilePath: c.path! }));
}

function resetSwap() {
  swapStage = 'files';
  plan = null;
  planError = null;
  swapProgress = null;
  swapError = null;
  if (!remainingAfterTest.length) swapResult = null;
}

async function ensurePreflight(force = false) {
  if (preflightLoading || (preflight && !force)) return;
  preflightLoading = true;
  if (currentStep() === 'swap') renderSwap();
  try {
    preflight = await swapApi().upgradeSwapPreflight();
  } catch (err) {
    preflight = { rekordboxRunning: false, dbFound: false, backupDir: '', backupDirOk: false, archiveDir: '', libraryRoot: '', error: getErrorMessage(err) };
  } finally {
    preflightLoading = false;
    if (currentStep() === 'swap') renderSwap();
  }
}

function preflightOk(): boolean {
  return !!preflight && !preflight.error && !preflight.rekordboxRunning && preflight.dbFound && preflight.backupDirOk;
}

function preflightHtml(): string {
  if (preflightLoading || !preflight) {
    return `<div class="callout upg-preflight">${SPINNER_SVG}<div class="callout-body"><strong>Checking Rekordbox…</strong><p>Making sure it's safe to change your collection.</p></div></div>`;
  }
  const again = '<div class="callout-actions"><button type="button" class="btn-secondary btn-sm" data-swap="preflight">Check again</button></div>';
  if (preflight.rekordboxRunning) {
    return `<div class="callout callout--warn" role="status">${ICON.warn}<div class="callout-body"><strong>Close Rekordbox first</strong><p>Track Lab can't safely change your collection while Rekordbox is open. Quit Rekordbox, then check again.</p></div>${again}</div>`;
  }
  if (preflight.error || !preflight.dbFound) {
    return `<div class="callout callout--danger" role="alert">${ICON.danger}<div class="callout-body"><strong>Track Lab can't find your Rekordbox collection</strong><p>Open Rekordbox once so it sets up its collection, quit it, then check again.</p>${preflight.error ? `<details class="buy-error-details"><summary>Show details</summary><p>${escapeHtml(preflight.error)}</p></details>` : ''}</div>${again}</div>`;
  }
  if (!preflight.backupDirOk) {
    return `<div class="callout callout--warn" role="status">${ICON.warn}<div class="callout-body"><strong>Track Lab can't save a backup yet</strong><p>The backup folder isn't available: <b>${escapeHtml(preflight.backupDir ? friendlyPath(preflight.backupDir) : 'not set')}</b>. Plug in the drive it's on, then check again. Nothing is changed without a backup.</p></div>${again}</div>`;
  }
  return `<div class="callout callout--info">${ICON.shield.replace('<svg ', '<svg class="callout-icon" ')}<div class="callout-body"><strong>A backup comes first</strong><p>Before anything changes, Track Lab saves a copy of your Rekordbox collection to ${pathTerm(preflight.backupDir)}. Old files are set aside in ${pathTerm(preflight.archiveDir)}, never deleted.</p></div></div>`;
}

function originLabel(origin: string | null): string {
  if (origin === 'downloaded') return 'downloaded';
  if (origin === 'owned') return 'already in your collection';
  if (!origin || origin === 'chosen') return 'chosen by you';
  return origin;
}

/**
 * Give step 4 full-quality files from anywhere — a store download, a free
 * download, a file found on disk — as the same {rbId, newFilePath} the swap
 * engine takes. `from` is a few words shown on each row ("free download").
 * Opens step 4 when the page has a playlist checked.
 */
export function addUpgradeFiles(files: UpgradeSwapInput[], from = 'added'): void {
  let n = 0;
  for (const f of files) {
    if (!f?.rbId || !f.newFilePath) continue;
    newFiles[f.rbId] = f.newFilePath;
    fileOrigin[f.rbId] = from;
    leaveAlone.delete(f.rbId);
    n++;
  }
  if (n === 0) return;
  resetSwap();
  saveState();
  if (result) openStep('swap', false);
}

function filesHtml(): string {
  const cands = swapCandidates();
  const ready = cands.filter(c => c.path && !leaveAlone.has(c.row.rbId));
  const left = cands.filter(c => c.path && leaveAlone.has(c.row.rbId));
  const waiting = cands.filter(c => !c.path);
  const row = (c: typeof cands[number], mode: 'ready' | 'left' | 'waiting') => `
    <div class="upg-file-row" data-rb="${escapeHtml(c.row.rbId)}">
      <div class="upg-row-lines">
        <span class="buy-t">${escapeHtml(rowName(c.row))}</span>
        <span class="upg-row-line">${escapeHtml(c.row.artist)} · now <b>${escapeHtml(c.row.formatLabel)}</b></span>
        ${c.path ? `<span class="upg-row-line">New file: <span class="term" tabindex="0" data-tooltip="${escapeHtml(c.path)}">${escapeHtml(fileNameOf(c.path))}</span> (${originLabel(c.origin)})</span>` : ''}
      </div>
      <div class="upg-file-actions">
        ${mode === 'ready' ? `
          <button type="button" class="btn-ghost btn-sm" data-swap="choose">Change file</button>
          <button type="button" class="btn-ghost btn-sm" data-swap="leave" data-tooltip="Don't replace this track. It stays as it is in Rekordbox.">Leave as is</button>`
        : mode === 'left' ? '<button type="button" class="btn-ghost btn-sm" data-swap="include">Replace it after all</button>'
        : '<button type="button" class="btn-secondary btn-sm" data-swap="choose" data-tooltip="Pick the full-quality file (AIFF, WAV, FLAC or ALAC) that should replace this track.">Choose file…</button>'}
      </div>
    </div>`;

  const parts: string[] = [];
  parts.push(`<div class="upg-swap-section">
    <div class="upg-swap-head"><h4>Ready to replace</h4><span>${plural(ready.length, 'track')}</span></div>
    ${ready.length > 0
      ? `<div class="buy-list">${ready.map(c => row(c, 'ready')).join('')}</div>`
      : `<p class="upg-row-line upg-row-line--muted">No files yet. Download your purchases in step 3, or choose a file for a track below.</p>`}
  </div>`);
  if (waiting.length > 0) {
    parts.push(`<details class="disclosure upg-swap-section"${ready.length === 0 ? ' open' : ''}>
      <summary>Choose files for other tracks <span class="disclosure-hint">${plural(waiting.length, 'track')} without a file</span></summary>
      <div class="disclosure-body"><p class="buy-quiet-intro">Bought some of these earlier, or somewhere else? Choose the full-quality file for each.</p><div class="buy-list">${waiting.map(c => row(c, 'waiting')).join('')}</div></div>
    </details>`);
  }
  if (left.length > 0) {
    parts.push(`<details class="disclosure upg-swap-section">
      <summary>Left as they are <span class="disclosure-hint">${plural(left.length, 'track')}</span></summary>
      <div class="disclosure-body"><div class="buy-list">${left.map(c => row(c, 'left')).join('')}</div></div>
    </details>`);
  }
  parts.push(`<div class="card-actions">
    <span class="card-actions-note">${ICON.shield}Nothing changes in Rekordbox yet.</span>
    <button type="button" class="btn-primary" data-swap="plan" ${ready.length === 0 || !preflightOk() ? 'disabled' : ''}
      data-tooltip="Track Lab compares each new file with the old one and shows exactly what will change. Nothing is changed yet."
      data-tooltip-disabled="${escapeHtml(ready.length === 0 ? 'Choose at least one file first' : preflight?.rekordboxRunning ? 'Close Rekordbox first' : 'Rekordbox isn\'t ready yet, see above')}">Check what will change</button>
  </div>`);
  return parts.join('');
}

/** A path as a person reads it: "backups/rekordbox on Candy Bar". The full
 *  path goes in a tooltip. */
function friendlyPath(p: string): string {
  const vol = p.match(/^\/Volumes\/([^/]+)\/(.+)$/);
  if (vol) return `${vol[2]} on ${vol[1]}`;
  const home = p.match(/^\/Users\/[^/]+\/(.+)$/);
  if (home) return `${home[1]} in your home folder`;
  return p;
}

function pathTerm(p: string, label = friendlyPath(p)): string {
  return `<span class="term" tabindex="0" data-tooltip="${escapeHtml(p)}">${escapeHtml(label)}</span>`;
}

function formatDate(raw: string): string {
  // A bare YYYY-MM-DD is a calendar day, not UTC midnight.
  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = ymd ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])) : new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function keepsLine(k: UpgradeSwapPlanItem['keeps']): string {
  const parts: string[] = [];
  const cues = (k.hotCues || 0) + (k.memoryCues || 0);
  if (cues) parts.push(plural(cues, 'cue point'));
  if (k.loops) parts.push(plural(k.loops, 'loop'));
  if (k.playCount) parts.push(plural(k.playCount, 'play'));
  if (k.dateAdded) parts.push(`added ${formatDate(k.dateAdded)}`);
  if (k.rating) parts.push(`rated ${plural(k.rating, 'star')}`);
  if (k.myTags) parts.push(plural(k.myTags, 'My Tag'));
  if (k.playlists) parts.push(`in ${plural(k.playlists, 'playlist')}`);
  return parts.length ? `Keeps ${parts.join(', ')}` : 'Keeps its place in your collection';
}

function formatBefore(item: UpgradeSwapPlanItem): string {
  const row = result?.rows.find(r => r.rbId === item.rbId);
  if (row?.formatLabel) return row.formatLabel;
  const f = (item.before.format || '').toUpperCase();
  return item.before.bitRate ? `${f} ${item.before.bitRate}` : f || 'the old file';
}

function formatAfter(item: UpgradeSwapPlanItem): string {
  const f = (item.after.format || '').toUpperCase() || 'full quality';
  return item.after.bitDepth ? `${f} ${item.after.bitDepth}-bit` : f;
}

function alignmentPill(item: UpgradeSwapPlanItem): string {
  const a = item.alignment;
  const pill = (tone: string, label: string, tip: string) =>
    `<span class="status-pill status-pill--${tone}" tabindex="0" data-tooltip="${escapeHtml(tip)}">${escapeHtml(label)}</span>`;
  const sure = a.confidence ? ` Track Lab is ${Math.round(a.confidence * 100)}% sure.` : '';
  if (a.status === 'aligned') return pill('ok', 'Lines up', `The new file starts at the same moment, so your cue points stay exactly where they are.${sure}`);
  if (a.status === 'shifted') {
    const ms = Math.abs(item.cueShiftMs || a.offsetMs);
    return pill('info', `Cues moved ${ms.toLocaleString()} ms to match`, `The new file starts a moment ${(item.cueShiftMs || a.offsetMs) > 0 ? 'later' : 'earlier'}. Track Lab moves every cue point by the same amount, so they still land on the beat.${sure}`);
  }
  if (a.status === 'mismatch') return pill('danger', 'Different version — not replaced', a.note || "The new file doesn't sound like the same recording.");
  return pill('warn', "Couldn't check", a.note || "Track Lab couldn't compare the two files. Check a cue point or two in Rekordbox afterwards.");
}

function planHtml(): string {
  const items = plan ?? [];
  const swaps = items.filter(i => i.action === 'swap');
  const skips = items.filter(i => i.action === 'skip');
  const relinkIds = new Set((result?.rows ?? []).filter(r => r.losslessCopy).map(r => r.rbId));
  const row = (i: UpgradeSwapPlanItem) => {
    const lines: string[] = [];
    if (i.action === 'swap') {
      lines.push(`<span class="upg-row-line"><span class="upg-from">${escapeHtml(formatBefore(i))}</span><span class="upg-arrow">→</span><span class="upg-to">${escapeHtml(formatAfter(i))}</span></span>`);
      lines.push(`<span class="upg-row-line">${escapeHtml(keepsLine(i.keeps))}</span>`);
      if (i.checkBeatgrid) lines.push('<span class="upg-row-line upg-row-line--warn">Afterwards, re-analyze this track in Rekordbox so its beatgrid matches the new file. The cue points stay.</span>');
      if (i.reason) lines.push(`<span class="upg-row-line">${escapeHtml(i.reason)}</span>`);
      if (i.oldFileGoesTo) lines.push(`<span class="upg-row-line upg-row-line--muted">The old file is set aside in <span class="term" tabindex="0" data-tooltip="${escapeHtml(i.oldFileGoesTo)}">${escapeHtml(fileNameOf(i.oldFileGoesTo.replace(/\/[^/]*$/, '')) || 'the set-aside folder')}</span>, not deleted.</span>`);
    } else {
      if (relinkIds.has(i.rbId)) {
        lines.push('<span class="upg-row-line">You already have this track in full quality as a separate entry in Rekordbox, so Track Lab leaves both as they are. Use the full-quality one in your playlists.</span>');
      }
      if (i.reason) lines.push(`<span class="upg-row-line upg-row-line--muted">${escapeHtml(i.reason)}</span>`);
    }
    const pill = i.action === 'swap' || i.alignment.status === 'mismatch'
      ? alignmentPill(i)
      : '<span class="status-pill">Not replaced</span>';
    return `<div class="upg-plan-row${i.action === 'skip' ? ' is-skip' : ''}">
      <div class="upg-row-lines"><span class="buy-t">${escapeHtml(i.title || 'Untitled')}</span><span class="buy-a">${escapeHtml(i.artist)}</span>${lines.join('')}</div>
      <span class="upg-plan-pill">${pill}</span>
    </div>`;
  };
  const sentence = swaps.length > 0
    ? `${plural(swaps.length, 'track')} will be replaced.${skips.length ? ` ${plural(skips.length, 'track')} will be left as ${skips.length === 1 ? 'it is' : 'they are'}, see why below.` : ''}`
    : 'None of these can be replaced. See why below.';
  return `
    ${planError ? `<div class="callout callout--danger" role="alert">${ICON.danger}<div class="callout-body"><strong>Track Lab couldn't check these files</strong><p>${escapeHtml(planError)}</p></div></div>` : ''}
    <div class="upg-swap-section">
      <h3 class="buy-summary-title">${escapeHtml(sentence)}</h3>
      <div class="buy-list">${swaps.map(row).join('')}</div>
    </div>
    ${skips.length ? `<details class="disclosure upg-swap-section"${swaps.length === 0 ? ' open' : ''}><summary>Won't be replaced <span class="disclosure-hint">${plural(skips.length, 'track')}</span></summary><div class="disclosure-body"><div class="buy-list">${skips.map(row).join('')}</div></div></details>` : ''}
    <div class="card-actions">
      <button type="button" class="btn-ghost" data-swap="back">Back to the files</button>
      <span class="card-actions-note">${ICON.shield}A backup is saved first.</span>
      <button type="button" class="btn-primary" data-swap="apply" ${swaps.length === 0 || !preflightOk() ? 'disabled' : ''}
        data-tooltip-disabled="${escapeHtml(swaps.length === 0 ? 'Nothing here can be replaced' : 'Close Rekordbox first')}">Replace ${plural(swaps.length, 'track')} in Rekordbox</button>
    </div>`;
}

const PHASE_WORDS: Record<UpgradeSwapProgress['phase'], string> = {
  planning: 'Comparing each new file with the old one…',
  converting: 'Making full-quality copies Rekordbox can play…',
  writing: 'Updating your Rekordbox collection…',
  verifying: 'Checking that every cue point and play count stayed…',
  archiving: 'Setting the old files aside…',
  done: 'Finishing up…',
};

function progressHtml(title: string): string {
  const p = swapProgress;
  const pct = p && p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
  return `<div class="upg-swap-progress" aria-live="polite">
    <div class="buy-progress-head">${SPINNER_SVG}<div class="buy-progress-text"><h3>${escapeHtml(p ? PHASE_WORDS[p.phase] : title)}</h3><p class="card-desc">${escapeHtml(p?.message || 'This can take a minute for a long playlist. Keep Rekordbox closed.')}</p></div></div>
    <div class="buy-meter"><div class="buy-meter-fill" style="width: ${pct}%"></div></div>
    <div class="buy-progress-meta"><span>${p && p.total > 0 ? `${p.current.toLocaleString()} of ${plural(p.total, 'track')}` : ''}</span></div>
  </div>`;
}

function resultHtml(): string {
  const r = swapResult!;
  const tone = r.failed > 0 ? 'warn' : r.swapped > 0 ? 'success' : 'info';
  const title = r.failed > 0
    ? `${plural(r.swapped, 'track')} replaced, ${r.failed.toLocaleString()} still the old file`
    : r.swapped > 0 ? `All done! ${plural(r.swapped, 'track')} replaced in Rekordbox.` : 'Nothing was replaced';
  const pill = (s: string) => s === 'swapped' ? '<span class="status-pill status-pill--ok">Replaced</span>'
    : s === 'failed' ? '<span class="status-pill status-pill--danger">Still the old file</span>'
    : '<span class="status-pill">Left as it was</span>';
  const rows = r.items.map(i => `
    <div class="upg-result-row">
      <div class="upg-row-lines">
        <span class="buy-t">${escapeHtml(i.title || 'Untitled')}</span><span class="buy-a">${escapeHtml(i.artist)}</span>
        ${i.detail ? `<span class="upg-row-line">${escapeHtml(i.detail)}</span>` : ''}
        ${i.status === 'swapped' && i.cueShiftMs ? `<span class="upg-row-line">Cue points moved ${Math.abs(i.cueShiftMs).toLocaleString()} ms to match the new file.</span>` : ''}
        ${i.status === 'swapped' && i.checkBeatgrid ? '<span class="upg-row-line upg-row-line--warn">Re-analyze it in Rekordbox so the beatgrid matches. The cue points stay.</span>' : ''}
      </div>
      ${pill(i.status)}
    </div>`).join('');
  const where: string[] = [];
  if (r.backupPath) where.push(`<p class="upg-path">The backup of your collection is in ${pathTerm(r.backupPath, friendlyPath(r.backupPath.replace(/\/[^/]*$/, '')))}. <button type="button" class="btn-link" data-swap="show" data-path="${escapeHtml(r.backupPath)}">Show in Finder</button></p>`);
  if (preflight?.archiveDir && r.swapped > 0) where.push(`<p class="upg-path">The old files are set aside in ${pathTerm(preflight.archiveDir)}, not deleted. <button type="button" class="btn-link" data-swap="show" data-path="${escapeHtml(preflight.archiveDir)}">Show in Finder</button></p>`);
  if (r.rollbackPath) where.push(`<details class="buy-error-details"><summary>If something looks wrong</summary><p>Track Lab kept what it needs to put these tracks back the way they were: ${pathTerm(r.rollbackPath, fileNameOf(r.rollbackPath))}. <button type="button" class="btn-link" data-swap="show" data-path="${escapeHtml(r.rollbackPath)}">Show in Finder</button></p></details>`);
  const more = remainingAfterTest.length > 0
    ? `<button type="button" class="btn-primary" data-swap="rest">Replace the other ${plural(remainingAfterTest.length, 'track')}</button>`
    : '<button type="button" class="btn-primary" data-swap="recheck" data-tooltip="Read the playlist again to see its tracks as they are now. Only reading.">Check the playlist again</button>';
  const head = tone === 'success'
    ? `<div class="art-hero upg-result-hero" role="status"><div class="art-hero-content">
        <h3>${escapeHtml(`${plural(r.swapped, 'track')} upgraded`)}</h3>
        <p>Cue points, plays, dates and playlists kept. Open Rekordbox and check a track: play one and make sure its cue points sit where they should.</p>
      </div></div>`
    : `<div class="callout callout--${tone}" role="status">${ICON[tone === 'warn' ? 'warn' : 'info']}
      <div class="callout-body"><strong>${escapeHtml(title)}</strong>
        <p>${r.swapped > 0 ? 'Open Rekordbox and check a replaced track: play one and make sure its cue points sit where they should.' : 'Your Rekordbox collection is as it was.'}</p>
      </div>
    </div>`;
  return `
    ${head}
    ${swapError ? `<div class="callout callout--danger" role="alert">${ICON.danger}<div class="callout-body"><strong>The replace stopped part way</strong><p>${escapeHtml(swapError)}</p></div></div>` : ''}
    ${where.length ? `<div class="upg-swap-section">${where.join('')}</div>` : ''}
    <div class="upg-swap-section"><div class="buy-list">${rows}</div></div>
    <div class="card-actions">
      <span class="card-actions-note">${remainingAfterTest.length ? 'Happy with the test? Do the rest the same way.' : 'Track Lab is finished with this playlist.'}</span>
      ${more}
    </div>`;
}

function renderSwap() {
  if (!result) {
    swapBody.innerHTML = '';
    return;
  }
  let body = '';
  if (swapStage === 'files') body = filesHtml();
  else if (swapStage === 'planning') body = progressHtml('Comparing each new file with the old one…');
  else if (swapStage === 'plan') body = planHtml();
  else if (swapStage === 'applying') body = progressHtml('Replacing your tracks…');
  else body = resultHtml();
  const showPreflight = swapStage === 'files' || swapStage === 'plan';
  swapBody.innerHTML = `${showPreflight ? preflightHtml() : ''}${body}`;
}

async function chooseFileFor(rbId: string) {
  const picked = await window.candybar.selectPath('file');
  if (!picked) return;
  if (!/\.(aiff?|wav|flac|m4a|alac)$/i.test(picked)) {
    showToast('warning', "That isn't a full-quality file", 'Choose an AIFF, WAV, FLAC or ALAC file. MP3 and other compressed files would not be an upgrade.');
    return;
  }
  newFiles[rbId] = picked;
  fileOrigin[rbId] = 'chosen';
  leaveAlone.delete(rbId);
  saveState();
  renderSteps();
}

async function makePlan(inputs = readyInputs()) {
  if (inputs.length === 0) return;
  swapStage = 'planning';
  swapProgress = null;
  planError = null;
  renderSwap();
  const off = swapApi().onUpgradeSwapProgress((p) => {
    swapProgress = p;
    if (swapStage === 'planning') renderSwap();
  });
  try {
    const res = await swapApi().upgradeSwapPlan(inputs);
    if (!res.success || !res.items) throw new Error(res.error || 'The check stopped without saying why.');
    plan = res.items;
  } catch (err) {
    plan = [];
    planError = getErrorMessage(err);
  } finally {
    off();
    swapProgress = null;
    swapStage = 'plan';
    renderSwap();
  }
}

/** The "are you sure?" for a replace: a backup comes first, and a one-track
 *  test is offered as the second choice. */
function swapConfirmOptions(n: number): Parameters<typeof confirmChoice>[0] {
  return {
    title: `Replace ${plural(n, 'track')} in Rekordbox?`,
    message: 'Track Lab points each one at its new full-quality file. Cue points, play counts, date added, ratings, My Tags and playlists stay.',
    details: [
      { label: 'Tracks', value: n.toLocaleString() },
      { label: 'Backup saved to', value: preflight?.backupDir ? friendlyPath(preflight.backupDir) : '' },
      { label: 'Old files go to', value: preflight?.archiveDir ? friendlyPath(preflight.archiveDir) : '' },
    ],
    safetyNote: 'A backup of your Rekordbox collection is saved first, so this can be put back. Trying one track first is a good idea.',
    confirmLabel: `Replace ${plural(n, 'track')}`,
    secondaryLabel: n > 1 ? 'Just the first track, as a test' : 'Not now',
    cancelLabel: 'Cancel',
    tone: 'caution',
  };
}

async function confirmAndApply(ids?: string[]) {
  const swaps = (plan ?? []).filter(i => i.action === 'swap' && (!ids || ids.includes(i.rbId)));
  if (swaps.length === 0) return;
  await ensurePreflight(true);
  if (!preflightOk()) {
    renderSwap();
    showToast('warning', 'Rekordbox needs to be closed', "Track Lab can't safely change your collection while Rekordbox is open.");
    return;
  }
  const n = swaps.length;
  const choice = await confirmChoice(swapConfirmOptions(n));
  if (choice === 'cancel' || (choice === 'secondary' && n === 1)) return;
  const toApply = choice === 'secondary' ? [swaps[0].rbId] : swaps.map(s => s.rbId);
  remainingAfterTest = choice === 'secondary' ? swaps.slice(1).map(s => s.rbId) : [];
  await apply(toApply);
}

async function apply(rbIds: string[]) {
  swapStage = 'applying';
  swapProgress = null;
  swapError = null;
  renderSwap();
  setStatus('Replacing tracks…');
  const off = swapApi().onUpgradeSwapProgress((p) => {
    swapProgress = p;
    if (swapStage === 'applying') renderSwap();
  });
  try {
    const res = await swapApi().upgradeSwapApply(rbIds);
    if (!res.success || !res.result) throw new Error(res.error || 'The replace stopped without saying why.');
    swapResult = res.result;
    for (const item of res.result.items) {
      if (item.status !== 'swapped') continue;
      delete newFiles[item.rbId];
      delete fileOrigin[item.rbId];
    }
    if (res.result.failed > 0) remainingAfterTest = [];
    setStatus('Idle');
  } catch (err) {
    swapError = getErrorMessage(err);
    swapResult = { swapped: 0, skipped: 0, failed: rbIds.length, backupPath: null, rollbackPath: null, items: [] };
    remainingAfterTest = [];
    setStatus('Error');
  } finally {
    off();
    swapStage = 'done';
    saveState();
    renderSteps();
  }
}

async function onSwapClick(e: Event) {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-swap]');
  if (!btn || btn.disabled) return;
  const rbId = btn.closest<HTMLElement>('[data-rb]')?.dataset.rb;
  switch (btn.dataset.swap) {
    case 'preflight': await ensurePreflight(true); break;
    case 'choose': if (rbId) await chooseFileFor(rbId); break;
    case 'leave': if (rbId) { leaveAlone.add(rbId); saveState(); renderSwap(); } break;
    case 'include': if (rbId) { leaveAlone.delete(rbId); saveState(); renderSwap(); } break;
    case 'plan': await makePlan(); break;
    case 'back': swapStage = 'files'; renderSwap(); break;
    case 'apply': await confirmAndApply(); break;
    case 'rest': {
      // Plan the rest again: the files are checked as they are now.
      const ids = new Set(remainingAfterTest);
      remainingAfterTest = [];
      swapResult = null;
      await makePlan(readyInputs().filter(i => ids.has(i.rbId)));
      break;
    }
    case 'recheck': {
      const id = result?.playlist.id;
      if (id) { playlistSelect.value = id; await run(); }
      break;
    }
    case 'show': if (btn.dataset.path) void window.candybar.showInFinder(btn.dataset.path); break;
  }
}

// ========== Persistence (survives HMR + restarts, like Find and buy) ==========

function saveState() {
  writeLocal(STATE_KEY, JSON.stringify({
    result, selected: [...selected], searchQuery, lastAdded, openGroups: [...openGroups],
    newFiles, fileOrigin, leaveAlone: [...leaveAlone], skipToSwap, lastDownload,
  }));
}

function restoreState() {
  const raw = readLocal(STATE_KEY);
  if (!raw) return;
  try {
    const s = JSON.parse(raw);
    result = s.result ?? null;
    selected = new Set(s.selected ?? []);
    searchQuery = s.searchQuery ?? '';
    lastAdded = s.lastAdded ?? [];
    openGroups = new Set(s.openGroups ?? []);
    newFiles = s.newFiles ?? {};
    fileOrigin = s.fileOrigin ?? {};
    leaveAlone = new Set(s.leaveAlone ?? []);
    skipToSwap = !!s.skipToSwap;
    lastDownload = s.lastDownload ?? null;
  } catch {
    return;
  }
  searchInput.value = searchQuery;
}

function clearResults() {
  result = null;
  selected = new Set();
  lastAdded = [];
  searchQuery = '';
  searchInput.value = '';
  openGroups = new Set();
  newFiles = {};
  fileOrigin = {};
  leaveAlone = new Set();
  skipToSwap = false;
  lastDownload = null;
  focusStep = null;
  remainingAfterTest = [];
  resetSwap();
  swapResult = null;
  saveState();
  renderSteps();
}

// ========== Run (step 1) ==========

function showProgress(p: LosslessUpgradeProgress) {
  if (p.phase === 'fetching') return; // "Get free downloads" shows its own progress
  if (p.phase === 'free') {
    progressMessage.textContent = p.total > 0
      ? `Looking for free copies of ${plural(p.total, 'track')}…`
      : 'Looking for free copies…';
    progressSub.textContent = p.message ? `Now looking for: ${p.message}` : 'On SoundCloud first, then Bandcamp.';
  } else if (p.phase === 'searching') {
    progressMessage.textContent = p.total > 0
      ? `Looking for copies to buy for ${plural(p.total, 'track')}…`
      : 'Looking for copies to buy…';
    progressSub.textContent = p.message ? `Now looking for: ${p.message}` : 'On Qobuz and Beatport.';
  } else if (p.phase === 'resolving') {
    progressMessage.textContent = 'Checking what each track is…';
    progressSub.textContent = p.message || 'Track Lab looks at each file to see whether it is full quality.';
  } else {
    progressMessage.textContent = p.message || 'Reading the playlist from Rekordbox…';
    progressSub.textContent = 'Then Track Lab looks for free copies on SoundCloud and Bandcamp, then on Qobuz and Beatport.';
  }
  const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
  progressBar.style.width = `${pct}%`;
  progressPercent.textContent = '';
  progressCount.textContent = p.total > 0 ? `${p.current.toLocaleString()} of ${plural(p.total, 'track')}` : '';
}

async function run() {
  const playlistId = playlistSelect.value;
  if (!playlistId || running) return;
  writeLocal(LAST_PLAYLIST_KEY, playlistId);
  running = true;
  focusStep = null;
  updateRunButton();
  playlistSelect.disabled = true;
  refreshBtn.disabled = true;
  showProgress({ phase: 'reading', current: 0, total: 0, message: 'Reading the playlist from Rekordbox…' });
  renderSteps();
  setStatus('Checking…');
  const off = window.candybar.onUpgradeProgress(showProgress);

  try {
    const res = await window.candybar.upgradeRun(playlistId);
    if (!res.success || !res.result) throw new Error(res.error || 'The check stopped without saying why.');
    const fresh = res.result;
    // A new playlist starts clean; checking the same one again keeps the carts
    // and chosen files that still belong to its tracks.
    const same = result?.playlist.id === fresh.playlist.id;
    const ids = new Set(fresh.rows.map(r => r.rbId));
    // Checking the same playlist again keeps what the free downloads did.
    if (same) {
      const before = new Map((result?.rows ?? []).map(r => [r.rbId, r.freeOutcome]));
      for (const r of fresh.rows) if (before.get(r.rbId) && r.free) r.freeOutcome = before.get(r.rbId);
    }
    result = fresh;
    searchQuery = '';
    searchInput.value = '';
    // Ticked to start: every free copy that can be fetched, and sure store
    // matches, except where Bandcamp sells it (that one's bought by hand first).
    selected = new Set(fresh.rows.filter(r => kindOf(r) === 'free'
      ? fetchable(r)
      : kindOf(r) === 'found' && storeLossless(r) && autoSelectable(r.match!) && !bandcampPaid(r)).map(r => r.rbId));
    if (!same) {
      lastAdded = [];
      newFiles = {};
      fileOrigin = {};
      leaveAlone = new Set();
      skipToSwap = false;
      lastDownload = null;
      openGroups = new Set();
    } else {
      for (const id of Object.keys(newFiles)) if (!ids.has(id)) { delete newFiles[id]; delete fileOrigin[id]; }
    }
    remainingAfterTest = [];
    resetSwap();
    swapResult = null;
    focusStep = 'review';
    setStatus('Idle');
  } catch (err) {
    hint.className = 'field-help is-error';
    hint.textContent = `Track Lab couldn't check that playlist. ${getErrorMessage(err)}`;
    setStatus('Error');
  } finally {
    off();
    running = false;
    playlistSelect.disabled = playlists.length === 0;
    refreshBtn.disabled = false;
    updateRunButton();
    saveState();
    renderSteps();
    if (result) revealInContent(stepEl(currentStep()), 'start');
  }
}

// ========== Init ==========

export function initUpgrade() {
  playlistSelect.addEventListener('change', updateRunButton);
  refreshBtn.addEventListener('click', () => void loadPlaylists());
  runBtn.addEventListener('click', () => void run());
  clearBtn.addEventListener('click', clearResults);

  document.querySelectorAll<HTMLButtonElement>('#page-upgrade .upg-step-open').forEach(btn => {
    btn.addEventListener('click', () => openStep(btn.dataset.openStep as Step));
  });

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    renderGroups();
  });

  addToCartBtn.addEventListener('click', () => void addSelectedToCarts());
  skipToSwapBtn.addEventListener('click', () => {
    skipToSwap = true;
    saveState();
    openStep('swap');
  });
  openQobuzBtn.addEventListener('click', () => void window.candybar.storePanelOpen('qobuz', cartUrl('qobuz')));
  openBeatportBtn.addEventListener('click', () => void window.candybar.storePanelOpen('beatport', cartUrl('beatport')));
  downloadBtn.addEventListener('click', () => void downloadPurchases());
  swapBody.addEventListener('click', (e) => void onSwapClick(e));

  // Reading Rekordbox spawns Python, so wait until the tab is first shown
  // (a nav click, or the last session's tab being restored). A failed read
  // is retried the next time the tab is opened. Step 4's preflight is also
  // re-read whenever the tab is shown, since Rekordbox may have been opened.
  const onShown = () => {
    if (!page.classList.contains('active')) return;
    if (!playlistsLoaded) void loadPlaylists();
    if (currentStep() === 'swap') void ensurePreflight(true);
  };
  new MutationObserver(onShown).observe(page, { attributes: true, attributeFilter: ['class'] });

  window.addEventListener('beforeunload', saveState);
  restoreState();
  renderSteps();
  onShown();
  // The rows' "Needs an email" pills need the saved address.
  void savedGateEmail().then(() => { if (result) renderSteps(); });
}
