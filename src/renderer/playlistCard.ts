import type { SourcePlaylistInfo } from '../types';
import { escapeHtml } from './shared';

const PLAYLIST_BADGE: Record<NonNullable<SourcePlaylistInfo['source']>, string> = {
  spotify: 'Spotify',
  soundcloud: 'SoundCloud',
  rekordbox: 'Rekordbox',
};

/**
 * Fill a `.source-playlist-card` with a playlist's cover art, name, track
 * count, owner and source badge. The caller owns the element, so a page can
 * keep one card and move it between sections without losing identity.
 */
export function fillPlaylistCard(card: HTMLElement, info: SourcePlaylistInfo): HTMLElement {
  card.classList.add('source-playlist-card');
  // A session saved by an older build can carry a source this map lacks;
  // fall back to Spotify (the only source those builds had) over "undefined".
  const source = info.source && info.source in PLAYLIST_BADGE ? info.source : 'spotify';
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
    <div class="source-playlist-badge ${source}">${PLAYLIST_BADGE[source]}</div>
  `;
  card.querySelector<HTMLImageElement>('img.source-playlist-art')?.addEventListener('error', function () {
    const ph = document.createElement('div');
    ph.className = 'source-playlist-art source-playlist-art--placeholder';
    this.replaceWith(ph);
  }, { once: true });
  return card;
}
