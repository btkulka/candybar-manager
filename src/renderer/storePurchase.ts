import type { CheckTrackRecord } from './shared';
import type { StoreMatch } from '../types';
import { showToast, escapeHtml } from './shared';
import { addDownloadTask, updateDownloadProgress, completeDownloadTask } from './activity';

// ========== DOM Elements ==========

const modal = document.getElementById('store-purchase-modal') as HTMLDivElement;
const closeBtn = document.getElementById('store-purchase-close') as HTMLButtonElement;
const cancelBtn = document.getElementById('store-purchase-cancel') as HTMLButtonElement;
const purchaseBtn = document.getElementById('store-purchase-btn') as HTMLButtonElement;

// Search + Results (combined phase)
const searchPhase = document.getElementById('store-search-phase') as HTMLDivElement;
const searchProgressBar = document.getElementById('store-search-progress-bar') as HTMLDivElement;
const searchProgressLabel = document.getElementById('store-search-progress-label') as HTMLElement;
const matchStats = document.getElementById('store-match-stats') as HTMLDivElement;
const matchActions = document.getElementById('store-match-actions') as HTMLDivElement;
const matchList = document.getElementById('store-match-list') as HTMLDivElement;
const selectAllBtn = document.getElementById('store-select-all') as HTMLButtonElement;
const selectNoneBtn = document.getElementById('store-select-none') as HTMLButtonElement;
const addCartBtn = document.getElementById('store-add-cart-btn') as HTMLButtonElement;
const researchBtn = document.getElementById('store-research-btn') as HTMLButtonElement;

// Cart
const cartPhase = document.getElementById('store-cart-phase') as HTMLDivElement;
const cartProgressBar = document.getElementById('store-cart-progress-bar') as HTMLDivElement;
const cartProgressLabel = document.getElementById('store-cart-progress-label') as HTMLElement;

// Done
const donePhase = document.getElementById('store-done-phase') as HTMLDivElement;
const doneSummary = document.getElementById('store-done-summary') as HTMLDivElement;
const openQobuzCartBtn = document.getElementById('store-open-qobuz-cart') as HTMLButtonElement;
const openBeatportCartBtn = document.getElementById('store-open-beatport-cart') as HTMLButtonElement;
const downloadBtn = document.getElementById('store-download-btn') as HTMLButtonElement;

// Download
const downloadPhase = document.getElementById('store-download-phase') as HTMLDivElement;
const downloadProgressBar = document.getElementById('store-download-progress-bar') as HTMLDivElement;
const downloadProgressLabel = document.getElementById('store-download-progress-label') as HTMLElement;

// ========== State ==========

let allMatches: StoreMatch[] = [];
let selectedKeys: Set<string> = new Set(); // source:trackId
let getMissingTracksFn: (() => CheckTrackRecord[]) | null = null;
let searchInProgress = false;

// ========== Helpers ==========

function matchKey(m: StoreMatch): string {
  return `${m.source}:${m.trackId}`;
}

function showPhase(phase: 'search' | 'cart' | 'done' | 'download') {
  searchPhase.style.display = phase === 'search' ? 'block' : 'none';
  cartPhase.style.display = phase === 'cart' ? 'block' : 'none';
  donePhase.style.display = phase === 'done' ? 'block' : 'none';
  downloadPhase.style.display = phase === 'download' ? 'block' : 'none';

  addCartBtn.style.display = phase === 'search' && !searchInProgress && allMatches.length > 0 ? 'inline-flex' : 'none';
  researchBtn.style.display = phase === 'search' && !searchInProgress && allMatches.length > 0 ? 'inline-flex' : 'none';
  openQobuzCartBtn.style.display = phase === 'done' ? 'inline-flex' : 'none';
  openBeatportCartBtn.style.display = phase === 'done' ? 'inline-flex' : 'none';
  downloadBtn.style.display = phase === 'done' ? 'inline-flex' : 'none';
}

function updateStats() {
  const ownedCount = allMatches.filter(m => m.ownedOn).length;
  const purchasable = allMatches.filter(m => !m.ownedOn);
  const qobuzMatches = purchasable.filter(m => m.source === 'qobuz');
  const beatportMatches = purchasable.filter(m => m.source === 'beatport');
  const lossyCount = purchasable.filter(m => !m.lossless).length;
  const parts: string[] = [];
  if (ownedCount > 0) parts.push(`${ownedCount} already owned`);
  if (qobuzMatches.length > 0) parts.push(`${qobuzMatches.length} on Qobuz`);
  if (beatportMatches.length > 0) parts.push(`${beatportMatches.length} on Beatport`);
  if (lossyCount > 0) parts.push(`${lossyCount} lossy`);
  parts.push(`${selectedKeys.size} selected`);
  matchStats.textContent = parts.join(' · ');
}

function appendMatch(match: StoreMatch) {
  const key = matchKey(match);
  const confidenceClass = match.confidence >= 0.85 ? 'high' : match.confidence >= 0.65 ? 'medium' : 'low';
  const pct = Math.round(match.confidence * 100);

  const isOwned = !!match.ownedOn;

  // Auto-select high-confidence matches (but not already-owned ones)
  if (match.confidence >= 0.75 && !isOwned) {
    selectedKeys.add(key);
  }
  const checked = selectedKeys.has(key) ? 'checked' : '';

  const ownedFlag = isOwned
    ? `<span class="match-owned-flag" title="Already purchased on ${match.ownedOn === 'qobuz' ? 'Qobuz' : 'Beatport'}">OWNED</span>`
    : '';
  const lossyFlag = !match.lossless && !isOwned
    ? '<span class="match-lossy-flag" title="Lossless not available">LOSSY</span>'
    : '';
  const formatFlag = match.lossless && !match.rx3Compatible && !isOwned
    ? '<span class="match-convert-flag" title="FLAC needs conversion to AIFF for RX3">FLAC</span>'
    : '';

  const el = document.createElement('div');
  el.className = `qobuz-match-item${isOwned ? ' match-owned' : ''}`;
  el.innerHTML = `
    <input type="checkbox" class="match-checkbox" data-key="${escapeHtml(key)}" ${checked}${isOwned ? ' disabled' : ''}>
    <div class="match-source-badge ${match.source}">${match.source === 'qobuz' ? 'Qobuz' : 'Beatport'}</div>
    <div class="match-info">
      <div class="match-original">${escapeHtml(match.input.artist)} — ${escapeHtml(match.input.title)}</div>
      <div class="match-qobuz">${isOwned ? 'Already purchased' : `${escapeHtml(match.artist)} — ${escapeHtml(match.title)}${match.price ? ` (${escapeHtml(match.price)})` : ''}${match.quality ? ` [${escapeHtml(match.quality)}]` : ''}`} ${ownedFlag}${lossyFlag}${formatFlag}</div>
    </div>
    ${isOwned ? '' : `<span class="match-confidence ${confidenceClass}">${pct}%</span>`}
  `;

  const checkbox = el.querySelector('.match-checkbox') as HTMLInputElement;
  if (!isOwned) {
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedKeys.add(key);
      else selectedKeys.delete(key);
      updateStats();
    });
  }

  matchList.appendChild(el);
  matchActions.style.display = 'flex';
  updateStats();
}

function rebuildCheckboxes() {
  const checkboxes = matchList.querySelectorAll('.match-checkbox') as NodeListOf<HTMLInputElement>;
  for (const cb of checkboxes) {
    cb.checked = selectedKeys.has(cb.dataset.key || '');
  }
  updateStats();
}

function loadMatches(matches: StoreMatch[]) {
  allMatches = matches;
  selectedKeys = new Set();
  matchList.innerHTML = '';
  matchActions.style.display = 'none';

  for (const m of matches) {
    appendMatch(m);
  }
}

function closeModal() {
  modal.style.display = 'none';
}

// ========== Workflow ==========

async function openModal() {
  modal.style.display = 'flex';
  showPhase('search');

  // Try loading saved results first
  const saved = await window.candybar.storeLoadResults();
  if (saved.success && saved.matches && saved.matches.length > 0) {
    const ago = saved.savedAt ? formatTimeAgo(saved.savedAt) : '';
    searchProgressBar.style.width = '100%';
    searchProgressLabel.textContent = `Loaded ${saved.matches.length} saved results${ago ? ` from ${ago}` : ''}`;
    loadMatches(saved.matches);
    addCartBtn.style.display = 'inline-flex';
    researchBtn.style.display = 'inline-flex';
    return;
  }

  // No saved results — start fresh search
  startAutoSearch();
}

function formatTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function startAutoSearch() {
  if (!getMissingTracksFn) return;

  const tracks = getMissingTracksFn().filter(t => !t.ignored);
  if (tracks.length === 0) {
    showToast('warning', 'No Missing Tracks', 'No non-ignored missing tracks to search for.');
    closeModal();
    return;
  }

  searchInProgress = true;
  allMatches = [];
  selectedKeys = new Set();
  matchList.innerHTML = '';
  matchActions.style.display = 'none';
  searchProgressBar.style.width = '0%';
  searchProgressLabel.textContent = 'Logging in...';
  addCartBtn.style.display = 'none';
  researchBtn.style.display = 'none';
  showPhase('search');

  const trackInputs = tracks.map(t => ({
    key: t.key,
    artist: t.artist,
    title: t.title,
    album: t.album,
    duration: t.duration
  }));

  const result = await window.candybar.storeSearchAll(trackInputs);

  searchInProgress = false;

  if (!result.success) {
    showToast('error', 'Search Failed', result.error || 'Unknown error');
    closeModal();
    return;
  }

  if (allMatches.length === 0) {
    showToast('info', 'No Matches', 'No tracks found on Qobuz or Beatport.');
    closeModal();
    return;
  }

  // Search complete — show Add to Cart and Re-search buttons
  searchProgressBar.style.width = '100%';
  searchProgressLabel.textContent = `Search complete — ${allMatches.length} matches found`;
  addCartBtn.style.display = 'inline-flex';
  researchBtn.style.display = 'inline-flex';
}

async function addSelectedToCart() {
  const selected = allMatches.filter(m => selectedKeys.has(matchKey(m)));
  if (selected.length === 0) {
    showToast('warning', 'No Tracks Selected', 'Select at least one track.');
    return;
  }

  showPhase('cart');
  cartProgressBar.style.width = '0%';

  const qobuzTracks = selected.filter(m => m.source === 'qobuz');
  const beatportTracks = selected.filter(m => m.source === 'beatport');

  let qobuzAdded = 0, beatportAdded = 0;
  let totalCost = '';
  const allFailed: Array<{ artist: string; title: string; source: string; error: string }> = [];

  if (qobuzTracks.length > 0) {
    const result = await window.candybar.storeCartAdd(qobuzTracks, 'qobuz');
    if (result.success && result.result) {
      qobuzAdded = result.result.added.length;
      totalCost = result.result.totalCost;
      for (const f of result.result.failed) {
        allFailed.push({ artist: f.match.artist, title: f.match.title, source: 'Qobuz', error: f.error });
      }
    }
  }

  if (beatportTracks.length > 0) {
    const result = await window.candybar.storeCartAdd(beatportTracks, 'beatport');
    if (result.success && result.result) {
      beatportAdded = result.result.added.length;
      for (const f of result.result.failed) {
        allFailed.push({ artist: f.match.artist, title: f.match.title, source: 'Beatport', error: f.error });
      }
    }
  }

  showPhase('done');
  const parts: string[] = [];
  if (qobuzAdded > 0) parts.push(`<strong>${qobuzAdded}</strong> added to Qobuz cart${totalCost ? ` (${totalCost})` : ''}`);
  if (beatportAdded > 0) parts.push(`<strong>${beatportAdded}</strong> added to Beatport cart`);
  if (allFailed.length > 0) parts.push(`<strong>${allFailed.length}</strong> failed`);

  let html = `<p>${parts.join(' · ')}</p>`;
  if (allFailed.length > 0) {
    html += '<div class="cart-failed-list">';
    for (const f of allFailed) {
      html += `<div class="cart-failed-item"><span class="match-source-badge ${f.source.toLowerCase()}">${escapeHtml(f.source)}</span> ${escapeHtml(f.artist)} — ${escapeHtml(f.title)} <span class="text-secondary">(${escapeHtml(f.error)})</span></div>`;
    }
    html += '</div>';
  }
  html += '<p>Open the cart to review and complete your purchase.</p>';
  doneSummary.innerHTML = html;
}

async function downloadPurchasedTracks() {
  // Download all owned tracks + tracks that were successfully added to cart
  const toDownload = allMatches.filter(m => m.ownedOn || m.trackId);
  if (toDownload.length === 0) {
    showToast('warning', 'Nothing to Download', 'No purchased tracks to download.');
    return;
  }

  showPhase('download');
  downloadProgressBar.style.width = '0%';
  downloadProgressLabel.textContent = 'Starting downloads...';

  // Register in activity tray so progress is visible even if modal is closed
  addDownloadTask(toDownload.length);

  const result = await window.candybar.storeDownloadPurchases(toDownload);

  // Complete the activity tray task
  const failedCount = result.failed ? result.failed.length : 0;
  completeDownloadTask(result.downloaded || 0, failedCount);

  showPhase('done');

  if (result.success) {
    let html = `<p><strong>${result.downloaded}</strong> tracks downloaded to organize folder</p>`;
    if (result.failed && result.failed.length > 0) {
      html += '<div class="cart-failed-list">';
      for (const f of result.failed) {
        html += `<div class="cart-failed-item">${escapeHtml(f.artist)} — ${escapeHtml(f.title)} <span class="text-secondary">(${escapeHtml(f.error)})</span></div>`;
      }
      html += '</div>';
    }
    html += '<p>Head to the Organize tab to move them into your library.</p>';
    doneSummary.innerHTML = html;
  } else {
    doneSummary.innerHTML = `<p class="text-danger">Download failed: ${escapeHtml(result.error || 'Unknown error')}</p>`;
  }
}

// ========== Exports ==========

export function showStorePurchaseButton(show: boolean) {
  purchaseBtn.style.display = show ? 'inline-flex' : 'none';
}

export function initStorePurchase(getMissingTracks: () => CheckTrackRecord[]) {
  getMissingTracksFn = getMissingTracks;

  purchaseBtn.addEventListener('click', () => openModal());

  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') closeModal();
  });

  addCartBtn.addEventListener('click', () => addSelectedToCart());

  researchBtn.addEventListener('click', async () => {
    await window.candybar.storeClearResults();
    startAutoSearch();
  });

  selectAllBtn.addEventListener('click', () => {
    selectedKeys = new Set(allMatches.map(matchKey));
    rebuildCheckboxes();
  });

  selectNoneBtn.addEventListener('click', () => {
    selectedKeys = new Set();
    rebuildCheckboxes();
  });

  openQobuzCartBtn.addEventListener('click', () => {
    window.candybar.storePanelOpen('qobuz', 'https://www.qobuz.com/us-en/shopping-cart');
  });
  openBeatportCartBtn.addEventListener('click', () => {
    window.candybar.storePanelOpen('beatport', 'https://www.beatport.com/cart');
  });
  downloadBtn.addEventListener('click', () => downloadPurchasedTracks());

  // Progress listener — updates the search progress bar
  window.candybar.onStoreSearchProgress((payload) => {
    const pct = Math.round((payload.current / payload.total) * 100);
    searchProgressBar.style.width = `${pct}%`;
    searchProgressLabel.textContent = `[${payload.source}] ${payload.current}/${payload.total}: ${payload.currentTrack}`;
  });

  // Match listener — appends each match to the list as it arrives
  window.candybar.onStoreSearchMatch((match) => {
    allMatches.push(match);
    appendMatch(match);
  });

  // Download progress listener — updates both modal and activity tray
  window.candybar.onStoreDownloadProgress((payload) => {
    if (payload.total > 0) {
      const pct = Math.round((payload.current / payload.total) * 100);
      downloadProgressBar.style.width = `${pct}%`;
    }
    downloadProgressLabel.textContent = payload.message;
    updateDownloadProgress(payload);
  });

  // Cart progress listener
  window.candybar.onStoreCartProgress((payload) => {
    if (payload.total > 0) {
      const pct = Math.round((payload.current / payload.total) * 100);
      cartProgressBar.style.width = `${pct}%`;
    }
    cartProgressLabel.textContent = payload.message;
  });

  // Store panel toolbar + resize handle
  const panelToolbar = document.getElementById('store-panel-toolbar') as HTMLDivElement;
  const panelLabel = document.getElementById('store-panel-label') as HTMLSpanElement;
  const panelBackBtn = document.getElementById('store-panel-back') as HTMLButtonElement;
  const panelForwardBtn = document.getElementById('store-panel-forward') as HTMLButtonElement;
  const panelCloseBtn = document.getElementById('store-panel-close') as HTMLButtonElement;
  const panelResizeHandle = document.getElementById('store-panel-resize-handle') as HTMLDivElement;

  panelBackBtn.addEventListener('click', () => window.candybar.storePanelBack());
  panelForwardBtn.addEventListener('click', () => window.candybar.storePanelForward());
  panelCloseBtn.addEventListener('click', () => window.candybar.storePanelClose());

  // Drag-to-resize: the handle sits at the right edge of the app content.
  // We send the mouse's screen X to main, which calculates the new split.
  let resizeDragging = false;

  panelResizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    resizeDragging = true;
    document.body.classList.add('store-panel-resizing');
  });

  window.addEventListener('mousemove', (e) => {
    if (!resizeDragging) return;
    // Send the desired app content width (= mouse screen X relative to window)
    // Main process will compute panelWidth = totalWindowWidth - appWidth
    window.candybar.storePanelResize(Math.round(e.screenX));
  });

  window.addEventListener('mouseup', () => {
    if (resizeDragging) {
      resizeDragging = false;
      document.body.classList.remove('store-panel-resizing');
    }
  });

  window.candybar.onStorePanelState((state) => {
    if (state.open && state.panelWidth > 0) {
      panelToolbar.style.display = 'flex';
      panelResizeHandle.style.display = 'block';
      const label = state.store === 'qobuz' ? 'Qobuz Cart'
        : state.store === 'beatport' ? 'Beatport Cart'
        : (state.store ?? '');
      panelLabel.textContent = label;
      // Keep toolbar width in sync with the actual panel-column width.
      document.documentElement.style.setProperty('--store-panel-width', `${state.panelWidth}px`);
    } else {
      panelToolbar.style.display = 'none';
      panelResizeHandle.style.display = 'none';
      document.documentElement.style.removeProperty('--store-panel-width');
    }
  });

  window.candybar.onStorePanelAuth((auth) => {
    if (auth.loggedIn) {
      showToast('success', `${auth.store.charAt(0).toUpperCase() + auth.store.slice(1)} login detected`, 'You can now search and add to cart.');
    }
  });
}
