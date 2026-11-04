/**
 * Markup for the "Add a playlist" card on Find and buy: one field that takes a
 * Spotify playlist or SoundCloud set link (source.ts tells which from the link
 * itself, so nobody picks a type first), a drop zone for a spreadsheet, the
 * spreadsheet preview, and the card's action row.
 *
 * source.ts binds these elements by id after injecting the markup.
 */

import { escapeHtml } from './shared';

export interface SourceInputIds {
  /** The link field, its kind icon slot and its status line */
  linkInput: string;
  linkIcon: string;
  linkStatus: string;
  /** Spreadsheet drop zone, its file strip, hidden path input, clear button */
  dropZone: string;
  fileDisplay: string;
  pathInput: string;
  clearBtn: string;
  /** data-browse target name for the Choose file button */
  browseTarget: string;
  /** Spreadsheet preview (a disclosure) and its parts */
  previewSection: string;
  previewCount: string;
  previewColumns: string;
  previewThead: string;
  previewTbody: string;
  /** Warning for a spreadsheet missing its artist/title columns */
  previewStatus: string;
  previewStatusText: string;
}

export interface SourceInputOptions {
  ids: SourceInputIds;
  /** Label of the primary action ("Check this playlist") */
  actionLabel: string;
  /** Tooltip explaining what the action does */
  actionHint?: string;
  /** Tooltip shown while the action is disabled */
  actionDisabledHint?: string;
  /** DOM id for the action button */
  actionId: string;
}

const SOUNDCLOUD_ICON_PATH = 'M72.83,218.485h18.207V103.832c-6.828,1.93-12.982,5.435-18.207,10.041V218.485z M36.415,140.921v77.436l1.174,0.127 h17.033v-77.682H37.589C37.191,140.812,36.814,140.857,36.415,140.921z M0,179.63c0,14.102,7.338,26.328,18.207,33.147V146.52 C7.338,153.329,0,165.556,0,179.63z M109.245,218.485h18.207v-109.6c-5.444-3.396-11.537-5.972-18.207-7.467V218.485z M253.73,140.803h-10.242c0.519-3.934,0.847-7.932,0.847-12.003c0-50.545-41.044-91.635-91.68-91.635 c-29.792,0-56.202,14.347-72.885,36.423v144.897h155.96c20.751,0,37.59-16.848,37.59-37.59S274.481,140.803,253.73,140.803z M181.66,218.485h18.207V130.417c-5.226-4.143-11.199-7.411-17.716-9.677h-0.491V218.485z';
const SPOTIFY_ICON_PATH = 'M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z';

/** Brand marks, a spreadsheet and a plain link icon (24px, for chips and fields). */
export const SOURCE_KIND_ICONS = {
  spotify: `<svg class="buy-kind-icon buy-kind-icon--spotify" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${SPOTIFY_ICON_PATH}"/></svg>`,
  soundcloud: `<svg class="buy-kind-icon buy-kind-icon--soundcloud" viewBox="0 0 291.319 291.319" fill="currentColor" aria-hidden="true"><path d="${SOUNDCLOUD_ICON_PATH}"/></svg>`,
  csv: `<svg class="buy-kind-icon buy-kind-icon--csv" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>`,
  link: `<svg class="buy-kind-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
} as const;

const SHIELD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
const WARN_ICON = '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

/** Returns the card body: the link field + action, the spreadsheet drop zone, preview and a reassurance. */
export function renderSourceInput(options: SourceInputOptions): string {
  const { ids } = options;
  return `
    <div class="buy-add-field">
      <label class="sr-only" for="${ids.linkInput}">Playlist link</label>
      <div class="buy-add-row">
        <div class="buy-link">
          <span class="buy-link-icon" id="${ids.linkIcon}">${SOURCE_KIND_ICONS.link}</span>
          <input type="text" id="${ids.linkInput}" class="buy-link-input" placeholder="Paste a Spotify playlist or SoundCloud set link" autocomplete="off" spellcheck="false" />
        </div>
        <button type="button" class="btn-primary btn-lg" id="${options.actionId}" disabled data-tooltip="${escapeHtml(options.actionHint ?? options.actionLabel)}"${options.actionDisabledHint ? ` data-tooltip-disabled="${escapeHtml(options.actionDisabledHint)}"` : ''}>
          <span class="buy-action-label">${escapeHtml(options.actionLabel)}</span>
        </button>
      </div>
      <p class="field-help" id="${ids.linkStatus}" aria-live="polite"></p>
    </div>

    <div class="buy-drop" id="${ids.dropZone}">
      <div class="buy-drop-empty">
        ${SOURCE_KIND_ICONS.csv}
        <span>Or use a spreadsheet (CSV file) with Artist and Title columns. Drop it here, or</span>
        <button type="button" class="btn-secondary btn-sm" data-browse="${ids.browseTarget}" data-type="file" data-tooltip="Pick a CSV file on your computer. A playlist saved with Exportify works as it is.">Choose file…</button>
      </div>
      <div class="buy-drop-file" id="${ids.fileDisplay}">
        ${SOURCE_KIND_ICONS.csv}
        <span class="file-name"></span>
        <button type="button" class="btn-ghost btn-sm" id="${ids.clearBtn}" data-tooltip="Use a link or a different file instead. The file itself isn't deleted.">Use something else</button>
      </div>
      <input id="${ids.pathInput}" type="hidden" />
    </div>

    <div class="callout callout--warn buy-csv-warning" id="${ids.previewStatus}" role="status" style="display: none;">
      ${WARN_ICON}
      <div class="callout-body">
        <strong>This spreadsheet can't be checked yet</strong>
        <p id="${ids.previewStatusText}"></p>
      </div>
    </div>
    <details class="disclosure buy-csv-preview" id="${ids.previewSection}" style="display: none;">
      <summary>Preview the spreadsheet <span class="disclosure-hint"><span id="${ids.previewCount}">0 rows</span> · <span id="${ids.previewColumns}"></span></span></summary>
      <div class="disclosure-body">
        <div class="buy-csv-table">
          <table class="csv-preview-table">
            <thead id="${ids.previewThead}"></thead>
            <tbody id="${ids.previewTbody}"></tbody>
          </table>
        </div>
      </div>
    </details>

    <p class="card-actions-note buy-add-note">${SHIELD_ICON}Only checking. Nothing is bought, and your library isn't changed.</p>
  `;
}
