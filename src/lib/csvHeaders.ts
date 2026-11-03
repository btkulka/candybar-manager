/**
 * CSV header aliases for track lists. The same spellings the sourcing CLI
 * accepts (lib/sourcing/playlist.mjs), so an Exportify export ("Artist
 * Name(s)", "Track Name", "Album Name") works in the app too. Pure, so the
 * renderer's CSV preview and the main-process parser share one list.
 */

export const CSV_ARTIST_HEADERS = ['artist', 'artistname', 'artistnames', 'artists', 'albumartist', 'performer'];
export const CSV_TITLE_HEADERS = ['title', 'trackname', 'track', 'name', 'song'];
export const CSV_ALBUM_HEADERS = ['album', 'albumname'];
export const CSV_YEAR_HEADERS = ['year', 'releasedate', 'date'];

/** "Artist Name(s)" → "artistnames": lowercase letters only. */
export function normalizeCsvHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z]/g, '');
}

export function isArtistHeader(header: string): boolean {
  return CSV_ARTIST_HEADERS.includes(normalizeCsvHeader(header));
}

export function isTitleHeader(header: string): boolean {
  return CSV_TITLE_HEADERS.includes(normalizeCsvHeader(header));
}
