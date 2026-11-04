// Helpers for exporting the "already in library" subset of a sourcing run as
// an M3U8 playlist, a Rekordbox XML, or a CSV. Lifted verbatim out of the old
// Check tab's button handlers so the merged Source flow can re-use them.
//
// Each helper opens a save dialog, writes via the existing main-process IPC,
// and surfaces success/failure with a toast. Keep these pure w.r.t. state:
// the caller supplies a tracks array and the helper does the rest.

import { showToast, plural, getErrorMessage } from './shared';

export type LibraryMatchedTrack = {
  artist: string;
  title: string;
  filePath: string;
  duration?: number;
};

export type CsvTrackRow = {
  artist: string;
  title: string;
  album?: string;
  genre?: string;
};

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Export matched-in-library tracks as an M3U8 playlist (grouped by artist).
 * Silently no-ops if there are no tracks with resolvable filePaths.
 */
export async function exportM3u8(tracks: LibraryMatchedTrack[]): Promise<void> {
  const usable = tracks.filter(t => !!t.filePath);
  if (usable.length === 0) {
    showToast('warning', 'Nothing to save', 'None of these tracks were found in your library, so there\u2019s no playlist to make.');
    return;
  }
  const defaultName = `library-playlist-${dateStamp()}.m3u8`;
  const filePath = await window.candybar.showSaveDialogM3u8(defaultName);
  if (!filePath) return;

  try {
    const result = await window.candybar.exportPlaylistM3u8(usable, filePath);
    if (result.success) {
      showToast('success', 'Playlist saved', `Saved ${plural(result.trackCount ?? usable.length, 'track')}, grouped by artist.`);
    } else {
      showToast('error', 'Couldn\u2019t save the playlist', result.error || 'It stopped without saying why.');
    }
  } catch (err) {
    showToast('error', 'Couldn\u2019t save the playlist', getErrorMessage(err));
  }
}

/**
 * Export matched-in-library tracks as a Rekordbox-compatible XML playlist.
 * Playlist name is derived from the chosen filename.
 */
export async function exportRekordbox(tracks: LibraryMatchedTrack[]): Promise<void> {
  const usable = tracks.filter(t => !!t.filePath);
  if (usable.length === 0) {
    showToast('warning', 'Nothing to save', 'None of these tracks were found in your library, so there\u2019s no playlist to make.');
    return;
  }
  const defaultName = `playlist-${dateStamp()}.xml`;
  const filePath = await window.candybar.showSaveDialogRekordbox(defaultName);
  if (!filePath) return;

  const playlistName = filePath.split('/').pop()?.replace(/\.xml$/i, '') || 'Playlist';
  try {
    const result = await window.candybar.exportPlaylistRekordbox(usable, filePath, playlistName);
    if (result.success) {
      showToast(
        'success',
        'Rekordbox playlist saved',
        `Saved ${plural(result.trackCount ?? usable.length, 'track')}. To open it in Rekordbox, go to Preferences \u2192 Advanced \u2192 Database and choose this file as the rekordbox xml.`
      );
    } else {
      showToast('error', 'Couldn\u2019t save the playlist', result.error || 'It stopped without saying why.');
    }
  } catch (err) {
    showToast('error', 'Couldn\u2019t save the playlist', getErrorMessage(err));
  }
}

/**
 * Export a CSV of the current subset. Typically used for the "already in
 * library" bucket but works for any row list that has artist + title.
 */
export async function exportCsv(tracks: CsvTrackRow[], basename = 'library-tracks'): Promise<void> {
  if (tracks.length === 0) {
    showToast('warning', 'Nothing to save', 'There are no tracks to put in the spreadsheet.');
    return;
  }
  const defaultName = `${basename}-${dateStamp()}.csv`;
  const filePath = await window.candybar.showSaveDialog(defaultName);
  if (!filePath) return;

  try {
    const result = await window.candybar.exportTracksCsv(tracks, filePath);
    if (result.success) {
      showToast('success', 'Spreadsheet saved', `Saved ${plural(tracks.length, 'track')} to a spreadsheet (CSV file).`);
    } else {
      showToast('error', 'Couldn\u2019t save the spreadsheet', result.error || 'It stopped without saying why.');
    }
  } catch (err) {
    showToast('error', 'Couldn\u2019t save the spreadsheet', getErrorMessage(err));
  }
}
