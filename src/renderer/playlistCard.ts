import type { SourcePlaylistInfo } from '../types';
import { escapeHtml, plural } from './shared';
import { SOURCE_KIND_ICONS } from './sourceInputTemplate';

const PLAYLIST_LABEL: Record<NonNullable<SourcePlaylistInfo['source']>, string> = {
  spotify: 'Spotify playlist',
  soundcloud: 'SoundCloud set',
  rekordbox: 'Rekordbox playlist',
};

const REKORDBOX_ICON = '<svg class="buy-kind-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>';
const NOTE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';

/**
 * Fill a playlist card (`.buy-list-card`) with a playlist's cover art, name,
 * track count, owner and where it came from. The caller owns the element, so
 * a page can keep one card and move it between sections without losing it.
 */
export function fillPlaylistCard(card: HTMLElement, info: SourcePlaylistInfo): HTMLElement {
  card.classList.add('buy-list-card');
  // A session saved by an older build can carry a source this map lacks;
  // fall back to Spotify (the only source those builds had) over "undefined".
  const source = info.source && info.source in PLAYLIST_LABEL ? info.source : 'spotify';
  const art = info.imageUrl
    ? `<img class="buy-list-art" src="${escapeHtml(info.imageUrl)}" alt="" loading="lazy" />`
    : `<div class="buy-list-art buy-list-art--placeholder">${NOTE_ICON}</div>`;
  // Say so when some tracks were local files or unavailable and were skipped.
  const countLabel = info.fetchedCount < info.trackCount
    ? `${info.fetchedCount.toLocaleString()} of ${plural(info.trackCount, 'track')} (the rest aren't available)`
    : plural(info.trackCount, 'track');
  const icon = source === 'rekordbox' ? REKORDBOX_ICON : SOURCE_KIND_ICONS[source];
  card.innerHTML = `
    ${art}
    <div class="buy-list-meta">
      <div class="buy-list-name">${escapeHtml(info.name)}</div>
      <div class="buy-list-sub">${escapeHtml(countLabel)}${info.owner ? ` · ${escapeHtml(info.owner)}` : ''}</div>
    </div>
    <span class="buy-kind buy-kind--${source}">${icon}${PLAYLIST_LABEL[source]}</span>
  `;
  card.querySelector<HTMLImageElement>('img.buy-list-art')?.addEventListener('error', function () {
    const ph = document.createElement('div');
    ph.className = 'buy-list-art buy-list-art--placeholder';
    ph.innerHTML = NOTE_ICON;
    this.replaceWith(ph);
  }, { once: true });
  return card;
}
