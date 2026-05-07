import type { CheckTrackRecord } from './shared';
import type { QobuzCartMatch } from '../lib/qobuzCart';
import { showToast, escapeHtml } from './shared';

// ========== DOM Elements ==========

const qobuzCartBtn = document.getElementById('qobuz-cart-btn') as HTMLButtonElement;
const modal = document.getElementById('qobuz-cart-modal') as HTMLDivElement;
const modalClose = document.getElementById('qobuz-cart-modal-close') as HTMLButtonElement;
const searchPhase = document.getElementById('qobuz-search-phase') as HTMLDivElement;
const reviewPhase = document.getElementById('qobuz-review-phase') as HTMLDivElement;
const addPhase = document.getElementById('qobuz-add-phase') as HTMLDivElement;
const resultsPhase = document.getElementById('qobuz-results-phase') as HTMLDivElement;
const searchProgressBar = document.getElementById('qobuz-search-progress-bar') as HTMLDivElement;
const searchProgressLabel = document.getElementById('qobuz-search-progress-label') as HTMLElement;
const addProgressBar = document.getElementById('qobuz-add-progress-bar') as HTMLDivElement;
const addProgressLabel = document.getElementById('qobuz-add-progress-label') as HTMLElement;
const matchList = document.getElementById('qobuz-match-list') as HTMLDivElement;
const matchStats = document.getElementById('qobuz-match-stats') as HTMLDivElement;
const confirmBtn = document.getElementById('qobuz-cart-confirm') as HTMLButtonElement;
const cancelBtn = document.getElementById('qobuz-cart-cancel') as HTMLButtonElement;
const closeBrowserBtn = document.getElementById('qobuz-browser-close-btn') as HTMLButtonElement;
const resultsSummary = document.getElementById('qobuz-results-summary') as HTMLDivElement;
const selectAllBtn = document.getElementById('qobuz-select-all') as HTMLButtonElement;
const selectNoneBtn = document.getElementById('qobuz-select-none') as HTMLButtonElement;

// ========== State ==========

let matches: QobuzCartMatch[] = [];
let selectedIds: Set<string> = new Set();

// ========== Helpers ==========

function showPhase(phase: 'search' | 'review' | 'add' | 'results') {
  searchPhase.style.display = phase === 'search' ? 'block' : 'none';
  reviewPhase.style.display = phase === 'review' ? 'block' : 'none';
  addPhase.style.display = phase === 'add' ? 'block' : 'none';
  resultsPhase.style.display = phase === 'results' ? 'block' : 'none';
  confirmBtn.style.display = phase === 'review' ? 'inline-flex' : 'none';
  closeBrowserBtn.style.display = phase === 'results' ? 'inline-flex' : 'none';
}

function updateStatsDisplay() {
  const qobuzMatches = matches.filter(m => m.source === 'qobuz' && m.status === 'matched');
  const beatportMatches = matches.filter(m => m.source === 'beatport' && m.status === 'matched');
  const noMatch = matches.filter(m => m.status !== 'matched');
  const parts = [];
  if (qobuzMatches.length > 0) parts.push(`${qobuzMatches.length} on Qobuz`);
  if (beatportMatches.length > 0) parts.push(`${beatportMatches.length} on Beatport`);
  parts.push(`${noMatch.length} not found`);
  parts.push(`${selectedIds.size} selected`);
  matchStats.textContent = parts.join(' · ');
}

function renderMatchList() {
  const matched = matches.filter(m => m.status === 'matched');

  matchList.innerHTML = '';
  for (const match of matched) {
    const confidenceClass = match.confidence >= 0.85 ? 'high' : match.confidence >= 0.65 ? 'medium' : 'low';
    const pct = Math.round(match.confidence * 100);

    const el = document.createElement('div');
    el.className = 'qobuz-match-item';

    if (match.source === 'qobuz' && match.qobuzTrack) {
      const qt = match.qobuzTrack;
      const checked = selectedIds.has(qt.id) ? 'checked' : '';
      el.innerHTML = `
        <input type="checkbox" class="match-checkbox" data-qobuz-id="${escapeHtml(qt.id)}" ${checked}>
        <div class="match-info">
          <div class="match-original">${escapeHtml(match.trackInput.artist)} — ${escapeHtml(match.trackInput.title)}</div>
          <div class="match-qobuz">${escapeHtml(qt.artists.join(', '))} — ${escapeHtml(qt.name)} (${escapeHtml(qt.album)})</div>
        </div>
        <span class="match-confidence ${confidenceClass}">${pct}%</span>
      `;
      const checkbox = el.querySelector('.match-checkbox') as HTMLInputElement;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedIds.add(qt.id);
        else selectedIds.delete(qt.id);
        updateStatsDisplay();
      });
    } else if (match.source === 'beatport' && match.beatportTrack) {
      const bt = match.beatportTrack;
      el.innerHTML = `
        <div class="match-source-badge beatport">Beatport</div>
        <div class="match-info">
          <div class="match-original">${escapeHtml(match.trackInput.artist)} — ${escapeHtml(match.trackInput.title)}</div>
          <div class="match-qobuz">${escapeHtml(bt.artists.join(', '))} — ${escapeHtml(bt.name)}${bt.label ? ` [${escapeHtml(bt.label)}]` : ''}</div>
        </div>
        <span class="match-confidence ${confidenceClass}">${pct}%</span>
        <button class="btn-sm btn-secondary match-link" data-tooltip="View on Beatport">View</button>
      `;
      const viewBtn = el.querySelector('.match-link') as HTMLButtonElement;
      viewBtn.addEventListener('click', () => {
        window.candybar.openExternal(bt.url);
      });
    }

    matchList.appendChild(el);
  }

  updateStatsDisplay();
}

function closeModal() {
  modal.style.display = 'none';
}

// ========== Workflow ==========

async function startSearch(tracks: CheckTrackRecord[]) {
  modal.style.display = 'flex';
  showPhase('search');
  matches = [];
  selectedIds = new Set();
  searchProgressBar.style.width = '0%';

  const result = await window.candybar.qobuzCartSearch(
    tracks.map(t => ({ key: t.key, artist: t.artist, title: t.title, album: t.album, duration: t.duration }))
  );

  if (!result.success || !result.matches) {
    showToast('error', 'Search Failed', result.error || 'Unknown error');
    closeModal();
    return;
  }

  matches = result.matches;

  // Auto-select high-confidence matches
  for (const m of matches) {
    if (m.qobuzTrack && m.confidence >= 0.75) {
      selectedIds.add(m.qobuzTrack.id);
    }
  }

  showPhase('review');
  renderMatchList();
}

async function addSelectedToCart() {
  const tracksToAdd = matches
    .filter(m => m.qobuzTrack && selectedIds.has(m.qobuzTrack.id))
    .map(m => ({
      id: m.qobuzTrack!.id,
      url: m.qobuzTrack!.url,
      name: m.qobuzTrack!.name,
      artists: m.qobuzTrack!.artists
    }));

  if (tracksToAdd.length === 0) {
    showToast('warning', 'No Tracks Selected', 'Select at least one track to add to cart.');
    return;
  }

  showPhase('add');
  addProgressBar.style.width = '0%';

  const result = await window.candybar.qobuzCartAdd(tracksToAdd);

  showPhase('results');
  if (result.success) {
    resultsSummary.innerHTML = `
      <p><strong>${result.added?.length ?? 0}</strong> tracks added to cart</p>
      ${(result.failed?.length ?? 0) > 0 ? `<p><strong>${result.failed!.length}</strong> failed</p>` : ''}
      <p>Review your cart in the browser window, then close it when done.</p>
    `;
  } else {
    resultsSummary.innerHTML = `<p>Error: ${escapeHtml(result.error || 'Unknown error')}</p>`;
  }
}

// ========== Exports ==========

export function showQobuzCartButton(show: boolean) {
  qobuzCartBtn.style.display = show ? 'inline-flex' : 'none';
}

export function initQobuzCart(getMissingTracks: () => CheckTrackRecord[]) {
  qobuzCartBtn.addEventListener('click', () => {
    const tracks = getMissingTracks().filter(t => !t.ignored);
    if (tracks.length === 0) {
      showToast('warning', 'No Missing Tracks', 'No non-ignored missing tracks to search for.');
      return;
    }
    startSearch(tracks);
  });

  modalClose.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);
  confirmBtn.addEventListener('click', () => addSelectedToCart());

  closeBrowserBtn.addEventListener('click', async () => {
    await window.candybar.qobuzBrowserClose();
    closeModal();
    showToast('success', 'Browser Closed', 'Qobuz browser session ended.');
  });

  selectAllBtn.addEventListener('click', () => {
    const matched = matches.filter(m => m.qobuzTrack && m.status === 'matched');
    selectedIds = new Set(matched.map(m => m.qobuzTrack!.id));
    renderMatchList();
  });

  selectNoneBtn.addEventListener('click', () => {
    selectedIds = new Set();
    renderMatchList();
  });

  // Progress listeners
  window.candybar.onQobuzCartSearchProgress((payload) => {
    const pct = Math.round((payload.current / payload.total) * 100);
    searchProgressBar.style.width = `${pct}%`;
    searchProgressLabel.textContent = `Searching ${payload.current}/${payload.total}: ${payload.currentTrack}`;
  });

  window.candybar.onQobuzCartAddProgress((payload) => {
    if (payload.total > 0) {
      const pct = Math.round((payload.current / payload.total) * 100);
      addProgressBar.style.width = `${pct}%`;
    }
    addProgressLabel.textContent = payload.message;
  });
}
