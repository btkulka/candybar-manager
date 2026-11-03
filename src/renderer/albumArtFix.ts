// ============================================================
// Album Art Fix Flow — full-screen overlay launched from Browse.
// Runs through a queue of tracks missing album art, fetching
// Spotify/SoundCloud suggestions for each and applying on confirm.
// ============================================================

import type { LibraryHealthTrack, UpdateTagsParams } from '../types';
import type { AlbumArtSuggestion } from './shared';
import {
  showToast, escapeHtml, icons,
  scoreSuggestion, getSoundCloudArtwork, fetchImageAsDataUrl, getErrorMessage,
  updateTrackTagsWithRepair,
} from './shared';

const esc = escapeHtml;

export interface OpenAlbumArtFixOptions {
  tracks: LibraryHealthTrack[];
  onTrackUpdated: (track: LibraryHealthTrack, params: UpdateTagsParams) => void;
  onClose?: () => void;
}

interface Session {
  tracks: LibraryHealthTrack[];
  index: number;
  suggestions: AlbumArtSuggestion[];
  suggestionIndex: number;
  searchToken: number;
  applying: boolean;
  fixedCount: number;
  onTrackUpdated: (track: LibraryHealthTrack, params: UpdateTagsParams) => void;
  onClose?: () => void;
}

let session: Session | null = null;

// DOM refs, resolved on first open.
let overlay: HTMLElement | null = null;
let counterEl: HTMLElement | null = null;
let progressFill: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let artistEl: HTMLElement | null = null;
let metaEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let previewEl: HTMLElement | null = null;
let gridEl: HTMLElement | null = null;
let suggestionMetaEl: HTMLElement | null = null;
let prevBtn: HTMLButtonElement | null = null;
let nextBtn: HTMLButtonElement | null = null;
let applyBtn: HTMLButtonElement | null = null;
let skipBtn: HTMLButtonElement | null = null;
let backBtn: HTMLButtonElement | null = null;
let closeBtn: HTMLButtonElement | null = null;
let bodyEl: HTMLElement | null = null;
let completeEl: HTMLElement | null = null;
let completeText: HTMLElement | null = null;
let doneBtn: HTMLButtonElement | null = null;

let wired = false;

function resolveDom(): boolean {
  overlay = document.getElementById('album-art-fix-overlay');
  if (!overlay) return false;
  counterEl = document.getElementById('aaf-counter');
  progressFill = document.getElementById('aaf-progress-fill');
  titleEl = document.getElementById('aaf-track-title');
  artistEl = document.getElementById('aaf-track-artist');
  metaEl = document.getElementById('aaf-track-meta');
  statusEl = document.getElementById('aaf-status');
  previewEl = document.getElementById('aaf-preview');
  gridEl = document.getElementById('aaf-grid');
  suggestionMetaEl = document.getElementById('aaf-suggestion-meta');
  prevBtn = document.getElementById('aaf-prev-suggestion') as HTMLButtonElement | null;
  nextBtn = document.getElementById('aaf-next-suggestion') as HTMLButtonElement | null;
  applyBtn = document.getElementById('aaf-apply') as HTMLButtonElement | null;
  skipBtn = document.getElementById('aaf-skip') as HTMLButtonElement | null;
  backBtn = document.getElementById('aaf-back') as HTMLButtonElement | null;
  closeBtn = document.getElementById('aaf-close') as HTMLButtonElement | null;
  bodyEl = document.getElementById('aaf-body');
  completeEl = document.getElementById('aaf-complete');
  completeText = document.getElementById('aaf-complete-text');
  doneBtn = document.getElementById('aaf-done') as HTMLButtonElement | null;
  return true;
}

function wireEvents(): void {
  if (wired) return;
  closeBtn?.addEventListener('click', close);
  doneBtn?.addEventListener('click', close);
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', (e) => {
    if (!session) return;
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'Tab') { trapFocus(e); return; }
    // A focused button handles Enter/Space itself: Enter on Skip must skip.
    const onButton = (e.target as Element | null)?.closest?.('button');
    if (e.key === 'Enter') {
      if (!onButton) { e.preventDefault(); void apply(); }
      return;
    }
    if (e.key === 'ArrowLeft' && e.shiftKey) { e.preventDefault(); previousTrack(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); previousSuggestion(); return; }
    if (e.key === 'ArrowRight' && e.shiftKey) { e.preventDefault(); skipTrack(); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); nextSuggestion(); return; }
  });
  prevBtn?.addEventListener('click', previousSuggestion);
  nextBtn?.addEventListener('click', nextSuggestion);
  backBtn?.addEventListener('click', previousTrack);
  skipBtn?.addEventListener('click', skipTrack);
  applyBtn?.addEventListener('click', () => { void apply(); });
  wired = true;
}

let focusBeforeOpen: HTMLElement | null = null;

function trapFocus(e: KeyboardEvent): void {
  if (!overlay) return;
  const focusables = Array.from(overlay.querySelectorAll<HTMLElement>('button:not([disabled])'))
    .filter((el) => el.offsetParent !== null);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const inside = overlay.contains(document.activeElement);
  if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
}

export function openAlbumArtFix(opts: OpenAlbumArtFixOptions): void {
  if (!resolveDom() || !overlay) {
    showToast('error', 'Album Art Fix', 'Overlay markup missing.');
    return;
  }
  wireEvents();

  if (opts.tracks.length === 0) {
    showToast('info', 'Album Art Fix', 'No tracks are missing album art.');
    return;
  }

  session = {
    tracks: opts.tracks.slice(),
    index: 0,
    suggestions: [],
    suggestionIndex: 0,
    searchToken: 0,
    applying: false,
    fixedCount: 0,
    onTrackUpdated: opts.onTrackUpdated,
    onClose: opts.onClose,
  };

  focusBeforeOpen = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlay.hidden = false;
  document.body.classList.add('aaf-open');
  renderTrack();
  skipBtn?.focus();
}

function close(): void {
  if (!session) return;
  const onClose = session.onClose;
  session = null;
  if (overlay) overlay.hidden = true;
  document.body.classList.remove('aaf-open');
  focusBeforeOpen?.focus();
  focusBeforeOpen = null;
  onClose?.();
}

function renderTrack(): void {
  if (!session) return;
  const total = session.tracks.length;
  const pos = session.index + 1;

  if (session.index >= total) {
    renderComplete();
    return;
  }

  if (bodyEl) bodyEl.hidden = false;
  if (completeEl) completeEl.hidden = true;

  const track = session.tracks[session.index];
  if (counterEl) counterEl.textContent = `${pos} of ${total}`;
  if (progressFill) progressFill.style.width = `${Math.round((session.index / total) * 100)}%`;
  if (titleEl) titleEl.textContent = track.title || track.fileName;
  if (artistEl) artistEl.textContent = track.artist || 'Unknown Artist';
  if (metaEl) {
    const parts: string[] = [];
    if (track.album) parts.push(track.album);
    if (track.year) parts.push(String(track.year));
    if (track.genre) parts.push(track.genre);
    metaEl.textContent = parts.join(' · ');
  }

  if (backBtn) backBtn.disabled = session.index === 0;
  if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Apply Album Art'; }
  if (skipBtn) skipBtn.disabled = false;

  session.suggestions = [];
  session.suggestionIndex = 0;
  if (statusEl) statusEl.textContent = 'Searching…';
  if (previewEl) previewEl.innerHTML = `<div class="aaf-loading">Searching…</div>`;
  if (gridEl) gridEl.innerHTML = '';
  if (suggestionMetaEl) suggestionMetaEl.innerHTML = '';
  if (prevBtn) prevBtn.disabled = true;
  if (nextBtn) nextBtn.disabled = true;

  void loadSuggestions(track);
}

function renderComplete(): void {
  if (!session) return;
  if (bodyEl) bodyEl.hidden = true;
  if (completeEl) completeEl.hidden = false;
  if (progressFill) progressFill.style.width = '100%';
  if (counterEl) counterEl.textContent = `${session.tracks.length} of ${session.tracks.length}`;
  if (completeText) {
    completeText.textContent =
      `Fixed ${session.fixedCount} of ${session.tracks.length} track${session.tracks.length === 1 ? '' : 's'}.`;
  }
}

async function loadSuggestions(track: LibraryHealthTrack): Promise<void> {
  if (!session) return;
  const token = ++session.searchToken;
  try {
    const query = `${track.artist} ${track.title}`.trim();
    const result = await window.candybar.searchMusic(query, ['spotify', 'soundcloud']);
    if (!session || token !== session.searchToken) return;

    const spotify: AlbumArtSuggestion[] = (result.spotify?.tracks ?? [])
      .slice(0, 10)
      .map((t) => ({
        source: 'spotify' as const,
        title: t.name,
        artist: t.artists.join(', '),
        imageUrl: t.album_image_url || '',
        externalUrl: t.external_url,
        confidence: scoreSuggestion(track, t.name, t.artists.join(' ')),
        album: t.album || undefined,
        year: t.release_year ? String(t.release_year) : undefined,
      }))
      .filter((s) => s.imageUrl);

    const soundcloud: AlbumArtSuggestion[] = (result.soundcloud?.tracks ?? [])
      .slice(0, 10)
      .map((t) => ({
        source: 'soundcloud' as const,
        title: t.title,
        artist: t.user,
        imageUrl: getSoundCloudArtwork(t.artwork_url) || '',
        externalUrl: t.permalink_url,
        confidence: scoreSuggestion(track, t.title, t.user),
        genre: t.genre || undefined,
      }))
      .filter((s) => s.imageUrl);

    session.suggestions = [...spotify, ...soundcloud].sort((a, b) => b.confidence - a.confidence);

    const errorSources = result.errors.map((e) => e.source).join(', ');
    if (statusEl) {
      if (session.suggestions.length === 0 && errorSources) {
        statusEl.textContent = `No results (${errorSources} unavailable)`;
      } else if (session.suggestions.length === 0) {
        statusEl.textContent = 'No results found';
      } else if (errorSources) {
        statusEl.textContent = `${session.suggestions.length} results (${errorSources} unavailable)`;
      } else {
        statusEl.textContent = `${session.suggestions.length} results`;
      }
    }
    renderSuggestion();
  } catch {
    if (!session || token !== session.searchToken) return;
    if (statusEl) statusEl.textContent = 'Search failed';
    if (previewEl) previewEl.innerHTML = `<div class="aaf-loading">Search failed</div>`;
  }
}

function renderSuggestion(): void {
  if (!session) return;
  if (session.suggestions.length === 0) {
    if (previewEl) previewEl.innerHTML = `<div class="aaf-placeholder">${icons.albumPlaceholder}</div>`;
    if (suggestionMetaEl) suggestionMetaEl.innerHTML = '';
    if (applyBtn) applyBtn.disabled = true;
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    if (gridEl) gridEl.innerHTML = '';
    return;
  }

  const suggestion = session.suggestions[session.suggestionIndex];

  if (previewEl) {
    previewEl.innerHTML = '';
    const img = document.createElement('img');
    img.src = suggestion.imageUrl;
    img.alt = `${suggestion.title} album art`;
    previewEl.appendChild(img);
  }

  if (suggestionMetaEl) {
    suggestionMetaEl.innerHTML = `
      <div class="aaf-suggestion-title">${esc(suggestion.title)}</div>
      <div class="aaf-suggestion-artist">${esc(suggestion.artist)}</div>
      <div class="aaf-suggestion-source">${suggestion.source === 'spotify' ? 'Spotify' : 'SoundCloud'} · ${suggestion.confidence}% match</div>
    `;
  }

  if (applyBtn) applyBtn.disabled = false;
  if (prevBtn) prevBtn.disabled = session.suggestions.length <= 1;
  if (nextBtn) nextBtn.disabled = session.suggestions.length <= 1;

  if (gridEl) {
    gridEl.innerHTML = '';
    session.suggestions.forEach((s, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'aaf-thumb';
      if (i === session!.suggestionIndex) btn.classList.add('selected');
      btn.setAttribute('data-tooltip', `${s.source.toUpperCase()} ${s.confidence}%`);
      const thumb = document.createElement('img');
      thumb.src = s.imageUrl;
      thumb.alt = `${s.title} album art`;
      btn.appendChild(thumb);
      btn.addEventListener('click', () => {
        if (!session) return;
        session.suggestionIndex = i;
        renderSuggestion();
      });
      gridEl!.appendChild(btn);
    });
  }
}

function previousSuggestion(): void {
  if (!session || session.applying || session.suggestions.length <= 1) return;
  session.suggestionIndex = (session.suggestionIndex - 1 + session.suggestions.length) % session.suggestions.length;
  renderSuggestion();
}

function nextSuggestion(): void {
  if (!session || session.applying || session.suggestions.length <= 1) return;
  session.suggestionIndex = (session.suggestionIndex + 1) % session.suggestions.length;
  renderSuggestion();
}

function previousTrack(): void {
  if (!session || session.applying || session.index === 0) return;
  session.index--;
  renderTrack();
}

function skipTrack(): void {
  if (!session || session.applying) return;
  session.index++;
  renderTrack();
}

async function apply(): Promise<void> {
  if (!session || session.applying) return;
  const track = session.tracks[session.index];
  const suggestion = session.suggestions[session.suggestionIndex];
  if (!track || !suggestion) return;

  const current = session;
  current.applying = true;
  if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Applying…'; }
  if (skipBtn) skipBtn.disabled = true;
  if (backBtn) backBtn.disabled = true;

  try {
    const dataUrl = await fetchImageAsDataUrl(suggestion.imageUrl);
    const params: UpdateTagsParams = { filePath: track.filePath, albumArt: dataUrl };
    if (!track.album && suggestion.album) params.album = suggestion.album;
    if (!track.year && suggestion.year) params.year = suggestion.year;
    if (!track.genre && suggestion.genre) params.genre = suggestion.genre;

    await updateTrackTagsWithRepair(params, track.title || track.fileName);
    current.fixedCount++;
    current.onTrackUpdated(track, params);
    showToast('success', 'Art Applied', `Album art saved for ${track.title || track.fileName}`);
    current.applying = false;
    // Closed mid-apply: the art is saved, but there's no queue to advance.
    if (session !== current) return;
    current.index++;
    renderTrack();
  } catch (err) {
    current.applying = false;
    showToast('error', 'Apply Failed', getErrorMessage(err));
    if (session === current) {
      if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = 'Apply Album Art'; }
      if (skipBtn) skipBtn.disabled = false;
      if (backBtn) backBtn.disabled = current.index === 0;
    }
  }
}
