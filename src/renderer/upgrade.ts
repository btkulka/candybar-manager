import { cartUrl } from '../lib/storeUrls';
import type { LosslessUpgradeProgress, LosslessUpgradeResult, LosslessUpgradeRow, RekordboxPlaylistSummary, StoreMatch } from '../types';
import { showToast, setStatus, escapeHtml, getErrorMessage, plural, formatPriceTotal, isReleaseMatch, RELEASE_MATCH_TAG, matchNoteHtml } from './shared';
import { fillPlaylistCard } from './playlistCard';
import {
  type Store, STORE_LABEL, OTHER_VERSION_TAG, autoSelectable, isOtherVersion, parsePriceDollars, toStoreMatch,
  uniqueByTrack, addToStoreCarts, isAddingToCart, toastCartOutcome, mergeAdded,
} from './storeCart';

// Lossless Upgrades: pick a Rekordbox playlist, see which entries are only
// held as MP3/AAC or a streaming link, and cart lossless copies of them.
// Same rules as Sources: a lossy store match is shown but can never be
// selected or reach a cart, and only confident same-version matches start
// selected.

type Segment = 'found' | 'relink' | 'notfound' | 'lossless';

const SEGMENTS: Segment[] = ['found', 'relink', 'notfound', 'lossless'];
const STATE_KEY = 'candybar:upgrade-state:v1';
const LAST_PLAYLIST_KEY = 'candybar:upgrade-last-playlist';
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';

// ========== DOM ==========

const page = document.getElementById('page-upgrade') as HTMLElement;
const playlistSelect = document.getElementById('upgrade-playlist') as HTMLSelectElement;
const refreshBtn = document.getElementById('upgrade-refresh') as HTMLButtonElement;
const runBtn = document.getElementById('upgrade-run') as HTMLButtonElement;
const hint = document.getElementById('upgrade-hint') as HTMLElement;

const progressSection = document.getElementById('upgrade-progress') as HTMLElement;
const progressMessage = document.getElementById('upgrade-progress-message') as HTMLElement;
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

const buyBar = document.getElementById('upgrade-buybar') as HTMLElement;
const buyBarN = document.getElementById('upgrade-buybar-n') as HTMLElement;
const buyBarQobuz = document.getElementById('upgrade-buybar-qobuz') as HTMLElement;
const buyBarBeatport = document.getElementById('upgrade-buybar-beatport') as HTMLElement;
const clearBtn = document.getElementById('upgrade-clear') as HTMLButtonElement;
const openQobuzBtn = document.getElementById('upgrade-open-qobuz') as HTMLButtonElement;
const openBeatportBtn = document.getElementById('upgrade-open-beatport') as HTMLButtonElement;
const downloadBtn = document.getElementById('upgrade-download') as HTMLButtonElement;
const addToCartBtn = document.getElementById('upgrade-add-to-cart') as HTMLButtonElement;

// ========== State ==========

let playlists: RekordboxPlaylistSummary[] = [];
let playlistsLoaded = false;
let loadingPlaylists = false;
let running = false;
let result: LosslessUpgradeResult | null = null;
/** Selected rows, by Rekordbox entry id. */
let selected = new Set<string>();
let activeSegment: Segment = 'found';
let searchQuery = '';
/** Everything this tab has put in a cart, for the Download purchases button. */
let lastAdded: StoreMatch[] = [];

function readLocal(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLocal(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable or full — non-fatal */ }
}

// ========== Row classification ==========

function segmentOf(r: LosslessUpgradeRow): Segment {
  if (r.format === 'lossless') return 'lossless';
  if (r.losslessCopy) return 'relink';
  if (r.match?.status === 'matched' && r.match.lossless) return 'found';
  return 'notfound';
}

function rowName(r: LosslessUpgradeRow): string {
  if (r.artist && r.title) return `${r.artist} — ${r.title}`;
  return r.title || r.artist || r.filePath;
}

/** Why a lossy/streaming row has nothing to buy. */
function notFoundReason(r: LosslessUpgradeRow): string {
  if (r.note) return r.note;
  if (r.format === 'unknown') return `Couldn't tell whether ${r.formatLabel} is lossless, so it wasn't searched`;
  const m = r.match;
  if (!m) return 'Not searched';
  if (m.status === 'error') return m.error || 'Store search failed';
  if (m.status === 'matched' && !m.lossless) {
    return `Only a lossy copy on ${m.source ? STORE_LABEL[m.source] : 'the store'} (${Math.round(m.confidence * 100)}% match), excluded`;
  }
  return 'No lossless match on Qobuz or Beatport';
}

function matchesFilter(r: LosslessUpgradeRow): boolean {
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  const store = r.match?.qobuzTrack ?? r.match?.beatportTrack;
  return `${r.artist} ${r.title} ${store ? `${store.artists.join(' ')} ${store.name}` : ''}`.toLowerCase().includes(q);
}

function rowsIn(seg: Segment): LosslessUpgradeRow[] {
  return (result?.rows ?? []).filter(r => segmentOf(r) === seg && matchesFilter(r));
}

/** Selected rows that may go to a cart (lossless matches only), as cart
 *  payloads, one per store track: what "Add to carts" sends and the totals. */
function selectedForCart(store: Store): StoreMatch[] {
  return uniqueByTrack((result?.rows ?? [])
    .filter(r => selected.has(r.rbId) && segmentOf(r) === 'found' && r.match!.source === store)
    .map(r => toStoreMatch(r.match!, store)));
}

// ========== Playlist picker ==========

function optionLabel(p: RekordboxPlaylistSummary): string {
  const suffix = p.unreadable ? "can't read smart rules"
    : p.countUnknown ? 'not counted'
    : p.count === 0 ? 'empty'
    : plural(p.count, 'track');
  return `${p.name}${p.kind === 'smart' ? ' (smart)' : ''} · ${suffix}`;
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
  // One <optgroup> per folder, in the collection's own tree order.
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const p of playlists) {
    const label = p.path || 'Top level';
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
  if (playlists.some(p => p.id === remembered && pickable(p))) {
    playlistSelect.value = remembered;
  }
  playlistSelect.disabled = running || playlists.length === 0;
  updateRunButton();
}

async function loadPlaylists() {
  if (loadingPlaylists || running) return;
  loadingPlaylists = true;
  refreshBtn.disabled = true;
  playlistSelect.disabled = true;
  hint.textContent = 'Reading playlists from Rekordbox…';
  try {
    const res = await window.candybar.upgradeListPlaylists();
    if (!res.success || !res.playlists) throw new Error(res.error || 'Could not read Rekordbox playlists.');
    playlists = res.playlists;
    playlistsLoaded = true;
    renderPlaylistOptions();
    hint.textContent = `${plural(playlists.length, 'playlist')}, read live from your Rekordbox collection. Nothing in Rekordbox is changed.`;
  } catch (err) {
    const message = getErrorMessage(err);
    if (playlists.length === 0) setPickerMessage("Couldn't read Rekordbox playlists");
    else renderPlaylistOptions(); // keep the last good list usable
    hint.textContent = message;
    showToast('error', 'Rekordbox', message);
  } finally {
    loadingPlaylists = false;
    refreshBtn.disabled = false;
  }
}

function updateRunButton() {
  runBtn.disabled = running || !playlistSelect.value;
}

// ========== Rendering ==========

function buildFoundRow(r: LosslessUpgradeRow): HTMLElement {
  const m = r.match!;
  const store = m.source!;
  const track = store === 'qobuz' ? m.qobuzTrack! : m.beatportTrack!;
  const pct = Math.round(m.confidence * 100);
  const fmt = store === 'qobuz' ? (m.qobuzTrack!.quality || 'Lossless') : 'Lossless';
  const el = document.createElement('div');
  el.className = 'src-row';
  el.classList.toggle('sel', selected.has(r.rbId));
  el.tabIndex = 0;
  el.setAttribute('role', 'checkbox');
  el.setAttribute('aria-checked', String(selected.has(r.rbId)));
  // Same flags as Sources: a whole-release Qobuz hit and the match's caveat.
  const releaseTag = isReleaseMatch(m) ? RELEASE_MATCH_TAG : '';
  if (releaseTag) el.classList.add('release-match');
  el.innerHTML = `
    <span class="src-cbx">${CHECK_SVG}</span>
    <span class="src-badge ${store}">${STORE_LABEL[store]}</span>
    <span class="src-trk">
      <span class="t">${escapeHtml(rowName(r))}${isOtherVersion(m) ? OTHER_VERSION_TAG : ''}${releaseTag}</span>
      <span class="a"><span class="upg-from" title="What the playlist plays now">${escapeHtml(r.formatLabel)}</span> → ${escapeHtml(track.name)} — ${escapeHtml(track.artists.join(', '))}</span>
      ${matchNoteHtml(m)}
    </span>
    <span class="src-qual"><span class="fmt">${escapeHtml(fmt)}</span> · <span class="price">${escapeHtml(track.price || '—')}</span></span>
    <span class="src-pct ${pct >= 90 ? 'hi' : 'mid'}" title="How sure we are this is the same track. 90% or more is a strong match.">${pct}%</span>`;
  const toggle = () => {
    const on = !selected.has(r.rbId);
    if (on) selected.add(r.rbId); else selected.delete(r.rbId);
    el.classList.toggle('sel', on);
    el.setAttribute('aria-checked', String(on));
    updateBuyBar();
  };
  el.addEventListener('click', toggle);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
  return el;
}

function buildInfoRow(r: LosslessUpgradeRow, seg: Segment): HTMLElement {
  const el = document.createElement('div');
  el.className = 'src-row info';
  if (seg === 'relink') {
    const copy = r.losslessCopy!;
    const file = copy.filePath.split('/').pop() || copy.filePath;
    el.innerHTML = `
      <div class="src-trk">
        <span class="t">${escapeHtml(rowName(r))}</span>
        <span class="sub">Playlist plays <span class="upg-from">${escapeHtml(r.formatLabel)}</span> · you own <span class="upg-ok">${escapeHtml(copy.formatLabel)}</span> <span class="own" title="${escapeHtml(copy.filePath)}">${escapeHtml(file)}</span></span>
      </div>
      <button class="btn-ghost btn-sm" data-tooltip="Show the lossless file in Finder">Show file</button>`;
    el.querySelector('button')?.addEventListener('click', () => void window.candybar.showInFinder(copy.filePath));
    return el;
  }
  const sub = seg === 'lossless' ? '' : `<span class="sub">${escapeHtml(notFoundReason(r))}</span>`;
  const chipClass = seg === 'lossless' ? 'upg-ok' : 'upg-from';
  el.innerHTML = `
    <div class="src-trk"><span class="t">${escapeHtml(rowName(r))}</span>${sub}</div>
    <span class="${chipClass}">${escapeHtml(r.formatLabel)}</span>`;
  return el;
}

const GROUP_COPY: Record<Segment, { title: string; desc: string; empty: string }> = {
  found: {
    title: 'Upgrades found',
    desc: 'Lossless copies for sale. Strong same-version matches are pre-selected; lossy copies are never offered.',
    empty: 'No lossless copies to buy in this playlist.',
  },
  relink: {
    title: 'Have lossless',
    desc: 'You already own a lossless file of the same version. In Rekordbox, swap it into the playlist, or relocate the entry to it to keep its cues.',
    empty: 'No lossless copies hiding elsewhere in your collection.',
  },
  notfound: {
    title: 'No lossless source',
    desc: 'Lossy tracks with no lossless match on Qobuz or Beatport.',
    empty: 'Every lossy track had a lossless match or copy.',
  },
  lossless: {
    title: 'Already lossless',
    desc: 'AIFF, WAV, FLAC or ALAC. Nothing to do.',
    empty: 'No lossless tracks in this playlist.',
  },
};

function renderGroup() {
  groupsContainer.innerHTML = '';
  const copy = GROUP_COPY[activeSegment];
  const list = rowsIn(activeSegment);
  const group = document.createElement('div');
  group.className = 'source-group';
  group.innerHTML = `
    <div class="source-group-head">
      <span class="source-group-title">${copy.title}</span>
      <span class="source-group-desc">${escapeHtml(copy.desc)}</span>
      ${activeSegment === 'found' ? `<div class="source-group-actions">
        <button class="btn-sm btn-ghost" data-select="all" data-tooltip="Select every match here. Ones flagged as a different version or a whole-release match stay unticked.">Select all</button>
        <button class="btn-sm btn-ghost" data-select="none">Select none</button>
      </div>` : ''}
    </div>`;
  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `<p>${escapeHtml(searchQuery ? `No tracks match "${searchQuery}".` : copy.empty)}</p>`;
    group.appendChild(empty);
  } else {
    const ul = document.createElement('div');
    ul.className = 'source-group-list';
    for (const r of list) ul.appendChild(activeSegment === 'found' ? buildFoundRow(r) : buildInfoRow(r, activeSegment));
    group.appendChild(ul);
  }
  groupsContainer.appendChild(group);

  group.querySelectorAll<HTMLButtonElement>('[data-select]').forEach(btn => btn.addEventListener('click', () => {
    for (const r of rowsIn('found')) {
      if (btn.dataset.select === 'none') selected.delete(r.rbId);
      else if (!isOtherVersion(r.match!) && !isReleaseMatch(r.match!)) selected.add(r.rbId);
    }
    renderGroup();
    updateBuyBar();
  }));
}

function updateCounts() {
  for (const seg of SEGMENTS) {
    const el = document.getElementById(`upgrade-count-${seg}`);
    if (el) el.textContent = String(rowsIn(seg).length);
  }
  const rows = result?.rows ?? [];
  const count = (format: LosslessUpgradeRow['format']) => rows.filter(r => r.format === format).length;
  const unknown = count('unknown');
  summary.innerHTML = `
    <span class="ok">✓ Checked ${rows.length} ${rows.length === 1 ? 'track' : 'tracks'}</span>
    <span class="sep">·</span>
    <span class="chip" title="MP3 and AAC files">Lossy <b>${count('lossy')}</b></span>
    <span class="chip" title="Streaming links with no file behind them">Streaming <b>${count('streaming')}</b></span>
    <span class="chip" title="AIFF, WAV, FLAC or ALAC">Lossless <b>${count('lossless')}</b></span>
    ${unknown ? `<span class="chip" title="Formats we couldn't call">Unknown <b>${unknown}</b></span>` : ''}`;
}

function setActiveSegment(seg: Segment) {
  activeSegment = seg;
  document.querySelectorAll<HTMLElement>('#upgrade-segments .source-seg').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.seg === seg);
  });
  renderGroup();
}

function updateBuyBar() {
  buyBar.style.display = result ? '' : 'none';
  const q = selectedForCart('qobuz');
  const b = selectedForCart('beatport');
  // In the currency the store's own prices are written in, not assumed dollars.
  const total = (items: StoreMatch[]) =>
    formatPriceTotal(items.reduce((s, m) => s + parsePriceDollars(m.price), 0), items.map(m => m.price));
  buyBarN.textContent = String(q.length + b.length);
  buyBarQobuz.textContent = `Qobuz ${q.length} · ${total(q)}`;
  buyBarBeatport.textContent = `Beatport ${b.length} · ${total(b)}`;
  addToCartBtn.disabled = isAddingToCart() || q.length + b.length === 0;
  openQobuzBtn.style.display = lastAdded.some(m => m.source === 'qobuz') ? '' : 'none';
  openBeatportBtn.style.display = lastAdded.some(m => m.source === 'beatport') ? '' : 'none';
  downloadBtn.style.display = lastAdded.length > 0 ? '' : 'none';
  saveState();
}

function renderResults() {
  if (!result) {
    resultsSection.style.display = 'none';
    buyBar.style.display = 'none';
    return;
  }
  const p = result.playlist;
  // A smart playlist listed as "not counted" was counted by the run itself.
  const count = p.countUnknown || p.count === 0 ? result.rows.length : p.count;
  fillPlaylistCard(playlistCard, {
    name: p.name,
    imageUrl: null,
    trackCount: count,
    fetchedCount: count,
    owner: [p.path, p.kind === 'smart' ? 'smart playlist' : ''].filter(Boolean).join(' · '),
    source: 'rekordbox',
  });
  resultsSection.style.display = 'block';
  updateCounts();
  setActiveSegment(activeSegment);
  updateBuyBar();
}

// ========== Persistence (survives HMR + restarts, like Sources) ==========

function saveState() {
  writeLocal(STATE_KEY, JSON.stringify({ result, selected: [...selected], segment: activeSegment, searchQuery, lastAdded }));
}

function restoreState() {
  const raw = readLocal(STATE_KEY);
  if (!raw) return;
  try {
    const s = JSON.parse(raw);
    result = s.result ?? null;
    selected = new Set(s.selected ?? []);
    activeSegment = SEGMENTS.includes(s.segment) ? s.segment : 'found';
    searchQuery = s.searchQuery ?? '';
    lastAdded = s.lastAdded ?? [];
  } catch {
    return;
  }
  searchInput.value = searchQuery;
  renderResults();
}

// ========== Run ==========

function showProgress(p: LosslessUpgradeProgress) {
  progressMessage.textContent = p.phase === 'searching' ? `Store search: ${p.message}` : p.message;
  const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
  progressBar.style.width = `${pct}%`;
  progressPercent.textContent = p.total > 0 ? `${pct}%` : '';
  progressCount.textContent = p.total > 0 ? `${p.current} / ${p.total}` : '';
}

async function run() {
  const playlistId = playlistSelect.value;
  if (!playlistId || running) return;
  writeLocal(LAST_PLAYLIST_KEY, playlistId);
  running = true;
  updateRunButton();
  playlistSelect.disabled = true;
  refreshBtn.disabled = true;
  resultsSection.style.display = 'none';
  buyBar.style.display = 'none';
  progressSection.style.display = 'block';
  showProgress({ phase: 'reading', current: 0, total: 0, message: 'Reading the playlist from Rekordbox…' });
  setStatus('Searching...');
  const off = window.candybar.onUpgradeProgress(showProgress);

  try {
    const res = await window.candybar.upgradeRun(playlistId);
    if (!res.success || !res.result) throw new Error(res.error || 'Unknown error');
    result = res.result;
    searchQuery = '';
    searchInput.value = '';
    selected = new Set(result.rows.filter(r => r.match && autoSelectable(r.match)).map(r => r.rbId));
    // Land on the first segment with something in it.
    activeSegment = SEGMENTS.find(seg => rowsIn(seg).length > 0) ?? 'found';
    setStatus('Idle');
  } catch (err) {
    showToast('error', 'Upgrade search failed', getErrorMessage(err));
    setStatus('Error');
  } finally {
    off();
    running = false;
    progressSection.style.display = 'none';
    playlistSelect.disabled = playlists.length === 0;
    refreshBtn.disabled = false;
    updateRunButton();
    renderResults(); // the new results, or the previous ones back after a failure
  }
}

// ========== Cart ==========

async function addSelectedToCarts() {
  if (isAddingToCart()) {
    showToast('info', 'Already Adding', 'Wait for the current cart add to finish.');
    return;
  }
  const batches = { qobuz: selectedForCart('qobuz'), beatport: selectedForCart('beatport') };
  if (batches.qobuz.length + batches.beatport.length === 0) {
    showToast('warning', 'No Tracks Selected', 'Select at least one track.');
    return;
  }
  addToCartBtn.disabled = true;
  cartAddProgress.style.display = 'block';
  const outcome = await addToStoreCarts(batches, (store, p) => {
    cartAddStore.textContent = STORE_LABEL[store];
    cartAddCount.textContent = `${p.current} / ${p.total}`;
    cartAddBar.style.width = `${p.total > 0 ? Math.round((p.current / p.total) * 100) : 0}%`;
    cartAddMessage.textContent = p.currentTrack ? `${p.message} — ${p.currentTrack}` : p.message;
  });
  cartAddProgress.style.display = 'none';
  toastCartOutcome(outcome);
  lastAdded = mergeAdded(lastAdded, [...outcome.added.qobuz, ...outcome.added.beatport]);
  updateBuyBar();
}

async function downloadPurchases() {
  if (lastAdded.length === 0) return;
  downloadBtn.disabled = true;
  showToast('info', 'Starting downloads', `Fetching ${plural(lastAdded.length, 'purchased track')}…`);
  try {
    const res = await window.candybar.storeDownloadPurchases(lastAdded);
    if (res.success) {
      showToast('success', 'Downloads complete', `${res.downloaded ?? 0} of ${lastAdded.length} downloaded → ${res.destDir ?? 'library'}`);
    } else {
      showToast('error', 'Downloads Failed', res.error ?? 'Unknown error');
    }
  } catch (err) {
    showToast('error', 'Downloads Failed', getErrorMessage(err));
  } finally {
    downloadBtn.disabled = false;
  }
}

// ========== Init ==========

export function initUpgrade() {
  playlistSelect.addEventListener('change', updateRunButton);
  refreshBtn.addEventListener('click', () => void loadPlaylists());
  runBtn.addEventListener('click', () => void run());

  document.querySelectorAll<HTMLElement>('#upgrade-segments .source-seg').forEach(btn => {
    btn.addEventListener('click', () => {
      const seg = btn.dataset.seg as Segment | undefined;
      if (seg) { setActiveSegment(seg); saveState(); }
    });
  });

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    updateCounts();
    renderGroup();
  });

  addToCartBtn.addEventListener('click', () => void addSelectedToCarts());
  openQobuzBtn.addEventListener('click', () => void window.candybar.storePanelOpen('qobuz', cartUrl('qobuz')));
  openBeatportBtn.addEventListener('click', () => void window.candybar.storePanelOpen('beatport', cartUrl('beatport')));
  downloadBtn.addEventListener('click', () => void downloadPurchases());

  clearBtn.addEventListener('click', () => {
    result = null;
    selected = new Set();
    lastAdded = [];
    searchQuery = '';
    searchInput.value = '';
    renderResults();
    saveState();
  });

  // Reading Rekordbox spawns Python, so wait until the tab is first shown
  // (a nav click, or the last session's tab being restored). A failed read
  // is retried the next time the tab is opened.
  const loadIfShown = () => {
    if (page.classList.contains('active') && !playlistsLoaded) void loadPlaylists();
  };
  new MutationObserver(loadIfShown).observe(page, { attributes: true, attributeFilter: ['class'] });
  loadIfShown();

  window.addEventListener('beforeunload', saveState);
  restoreState();
}
