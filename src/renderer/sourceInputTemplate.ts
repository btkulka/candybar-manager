/**
 * Shared markup for the CSV/Spotify/SoundCloud source picker used by both Check and Source
 * wizards. The existing TS in check.ts and source.ts references specific element
 * IDs; this template preserves those IDs by deriving them from a `prefix` plus
 * a known set of suffixes.
 *
 * Returned markup slots into a lane's .lane-content.
 */

import { escapeHtml } from './shared';

export interface SourceInputIds {
  /** Source type (csv/spotify) toggle container */
  toggle: string;
  /** CSV field wrapper */
  csvField: string;
  /** CSV drop zone */
  dropZone: string;
  /** File display strip (shown once a file is set) */
  fileDisplay: string;
  /** Hidden input holding the selected CSV path */
  pathInput: string;
  /** Clear CSV button */
  clearBtn: string;
  /** data-browse target name for the Browse button */
  browseTarget: string;
  /** Spotify field wrapper */
  spotifyField: string;
  /** Spotify URL text input */
  spotifyInput: string;
  /** Spotify URL status badge (check/cross) */
  spotifyStatus: string;
  /** SoundCloud set field wrapper, URL input and status badge. The SoundCloud
   *  option only renders when all three are given. */
  soundcloudField?: string;
  soundcloudInput?: string;
  soundcloudStatus?: string;
  /** Optional extra Spotify info block (only used by Check page) */
  spotifyInfo?: string;
  spotifyInfoName?: string;
  spotifyInfoMeta?: string;
  /** CSV preview section */
  previewSection: string;
  previewCount: string;
  previewColumns: string;
  previewThead: string;
  previewTbody: string;
  /** Optional status strip inside preview (Check page uses this to warn about missing columns) */
  previewStatus?: string;
  previewStatusText?: string;
}

export interface SourceInputOptions {
  ids: SourceInputIds;
  /** Label text for the primary action button (e.g. "Run Check", "Find Sources") */
  actionLabel: string;
  /** Tooltip explaining what the action does */
  actionHint?: string;
  /** Tooltip shown while the action is disabled: what the user still needs to do */
  actionDisabledHint?: string;
  /** DOM id for the action button */
  actionId: string;
  /** Start action disabled until the source is valid */
  actionDisabled?: boolean;
  /** Include the warning status row inside the CSV preview (Check uses this) */
  includePreviewStatus?: boolean;
  /** Placeholder for the Spotify URL field */
  spotifyPlaceholder?: string;
}

const SOUNDCLOUD_ICON_PATH = 'M72.83,218.485h18.207V103.832c-6.828,1.93-12.982,5.435-18.207,10.041V218.485z M36.415,140.921v77.436l1.174,0.127 h17.033v-77.682H37.589C37.191,140.812,36.814,140.857,36.415,140.921z M0,179.63c0,14.102,7.338,26.328,18.207,33.147V146.52 C7.338,153.329,0,165.556,0,179.63z M109.245,218.485h18.207v-109.6c-5.444-3.396-11.537-5.972-18.207-7.467V218.485z M253.73,140.803h-10.242c0.519-3.934,0.847-7.932,0.847-12.003c0-50.545-41.044-91.635-91.68-91.635 c-29.792,0-56.202,14.347-72.885,36.423v144.897h155.96c20.751,0,37.59-16.848,37.59-37.59S274.481,140.803,253.73,140.803z M181.66,218.485h18.207V130.417c-5.226-4.143-11.199-7.411-17.716-9.677h-0.491V218.485z';

/** Returns the HTML for the source-input lane body (source toggle + input area + preview + action). */
export function renderSourceInput(options: SourceInputOptions): string {
  const { ids } = options;
  const spotifyPlaceholder = options.spotifyPlaceholder ?? 'https://open.spotify.com/playlist/...';
  const previewStatus = options.includePreviewStatus && ids.previewStatus && ids.previewStatusText
    ? `
      <div class="csv-preview-status" id="${ids.previewStatus}" role="status" style="display: none;">
        <svg class="status-icon warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <span id="${ids.previewStatusText}"></span>
      </div>`
    : '';

  const spotifyInfoBlock = ids.spotifyInfo && ids.spotifyInfoName && ids.spotifyInfoMeta
    ? `
      <span class="spotify-playlist-info" id="${ids.spotifyInfo}" style="display: none;">
        <span class="spotify-playlist-name" id="${ids.spotifyInfoName}"></span>
        <span class="spotify-playlist-meta" id="${ids.spotifyInfoMeta}"></span>
      </span>`
    : '';

  const hasSoundCloud = !!(ids.soundcloudField && ids.soundcloudInput && ids.soundcloudStatus);
  const soundcloudButton = hasSoundCloud
    ? `<button class="source-type-btn" data-source="soundcloud" data-source-type="soundcloud" data-tooltip="Paste a link to a SoundCloud set (playlist). Public sets and secret links work.">SoundCloud</button>`
    : '';
  const soundcloudField = hasSoundCloud
    ? `
      <div class="source-input" id="${ids.soundcloudField}" style="display: none;">
        <svg class="soundcloud-icon" viewBox="0 0 291.319 291.319" fill="currentColor"><path d="${SOUNDCLOUD_ICON_PATH}"/></svg>
        <input type="text" id="${ids.soundcloudInput}" class="text-input" placeholder="https://soundcloud.com/artist/sets/..." title="On SoundCloud, open the set, choose Share > Copy link, then paste it here. For a private set, copy its secret link." />
        <span class="spotify-url-status" id="${ids.soundcloudStatus}"></span>
      </div>`
    : '';

  return `
    <div class="source-picker">
      <div class="source-type-select" id="${ids.toggle}">
        <button class="source-type-btn active" data-source="csv" data-source-type="csv" data-tooltip="Use a spreadsheet (CSV) with artist and title columns, such as an Exportify export">CSV</button>
        <button class="source-type-btn" data-source="spotify" data-source-type="spotify" data-tooltip="Paste a link to a Spotify playlist">Spotify</button>
        ${soundcloudButton}
      </div>

      <div class="source-input" id="${ids.csvField}">
        <div class="drop-zone" id="${ids.dropZone}">
          <div class="csv-source-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <span>Drop CSV or click to browse</span>
            <button type="button" class="btn-ghost btn-sm" data-browse="${ids.browseTarget}" data-type="file" data-tooltip="Pick a CSV file on your computer">Choose…</button>
          </div>
          <div class="csv-source-file" id="${ids.fileDisplay}" style="display: none;">
            <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            <span class="file-name"></span>
            <button class="btn-icon btn-sm" id="${ids.clearBtn}" aria-label="Remove this CSV" data-tooltip="Use a different file. The file itself isn't deleted.">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <input id="${ids.pathInput}" type="hidden" />
        </div>
      </div>

      <div class="source-input" id="${ids.spotifyField}" style="display: none;">
        <svg class="spotify-icon" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
        </svg>
        <input type="text" id="${ids.spotifyInput}" class="text-input" placeholder="${spotifyPlaceholder}" title="In Spotify, open the playlist, choose Share > Copy link, then paste it here" />
        <span class="spotify-url-status" id="${ids.spotifyStatus}"></span>
        ${spotifyInfoBlock}
      </div>
      ${soundcloudField}
    </div>

    <div class="csv-preview-popover" id="${ids.previewSection}" style="display: none;">
      <div class="csv-preview-header">
        <h4>CSV Preview</h4>
        <div class="csv-preview-meta">
          <span id="${ids.previewCount}">0 rows</span>
          <span class="csv-preview-columns" id="${ids.previewColumns}"></span>
        </div>
      </div>
      ${previewStatus}
      <div class="csv-preview-table-wrapper">
        <table class="csv-preview-table">
          <thead id="${ids.previewThead}"></thead>
          <tbody id="${ids.previewTbody}"></tbody>
        </table>
      </div>
    </div>

    <div class="lane-actions">
      <button class="btn-primary" id="${options.actionId}"${options.actionDisabled ? ' disabled' : ''} data-tooltip="${escapeHtml(options.actionHint ?? options.actionLabel)}"${options.actionDisabledHint ? ` data-tooltip-disabled="${escapeHtml(options.actionDisabledHint)}"` : ''}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="5 3 19 12 5 21 5 3" fill="currentColor"/>
        </svg>
        ${options.actionLabel}
      </button>
    </div>
  `;
}
