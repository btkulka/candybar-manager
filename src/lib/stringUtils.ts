/**
 * Calculate Levenshtein distance between two strings
 */
export function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Calculate string similarity ratio (0 to 1) using Levenshtein distance
 */
export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const distance = levenshteinDistance(a, b);
  const maxLength = Math.max(a.length, b.length);
  return 1 - distance / maxLength;
}

/**
 * Normalize a string for music track comparison.
 * Strips feat/ft tags, parenthetical remix/edit info, and special characters.
 */
export function normalizeForComparison(str: string): string {
  return str
    .toLowerCase()
    // Fold diacritics (é→e, ï→i, ö→o) so accented Latin titles match their plain
    // forms instead of having the accented letters deleted by the [^\w\s] strip.
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s*[\(\[].*(feat|ft|featuring|remix|edit|mix|version|original|extended|radio|club|instrumental|dub|vip|bootleg|remaster).*[\)\]]/gi, '')
    .replace(/\b(feat\.?|ft\.?|featuring)\b.*?(?=\s*[-–—]|$)/gi, '')
    .replace(/&/g, 'and')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Basic normalization: lowercase, replace punctuation with spaces, collapse whitespace.
 * Used for building match keys where preserving word boundaries matters.
 */
export function normalizeBasic(str: string): string {
  return str
    .toLowerCase()
    // Fold diacritics so accented letters survive the [^\w\s] strip as their base letter.
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function makeTrackKey(artist: string, title: string): string {
  return `${artist.toLowerCase().trim()} - ${title.toLowerCase().trim()}`;
}

/**
 * Version-preserving normalization: unlike normalizeForComparison, this does NOT
 * strip bracketed content (so "Innerbloom (Original Mix)" stays distinct from
 * "Innerbloom (Ship Wrek Remix)"). Lowercases, strips diacritics, removes
 * non-alphanumerics, collapses whitespace. Used for building exact (artist|title)
 * index keys where losing remix/edit info would cause false-positive matches.
 */
export function normalizeTrackKey(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/** Compose a tag-based match key from artist + title using version-preserving normalization. */
export function makeTagKey(artist: string, title: string): string {
  return `${normalizeTrackKey(artist)}|${normalizeTrackKey(title)}`;
}

/** Aggressive version-agnostic + diacritic-insensitive normalization. Builds a
 *  "does the user functionally own this song?" key: strips remix/edit/feat
 *  metadata, flattens accents, drops apostrophes/hyphens. "Tiësto — Adagio For
 *  Strings (Extended Mix)" and "Tiesto - Adagio for Strings" collapse to the
 *  same key. Use when duplicate-on-match is a feature (auto-deselect in Sources)
 *  rather than a bug (library health).
 *
 *  Order matters: NFKD first so accented chars decompose, then strip combining
 *  marks to recover the base letter (ë → e), then lowercase, then strip
 *  version/feat metadata, then drop non-alphanumerics. */
export function normalizeLoose(str: string): string {
  if (!str) return '';
  return str
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks (ë → e)
    .toLowerCase()
    // Strip parenthesized version/feat tags: "(Extended Mix)", "[Radio Edit]", "(feat. X)"
    .replace(/\s*[\(\[].*(feat|ft|featuring|remix|edit|mix|version|original|extended|radio|club|instrumental|dub|vip|bootleg|remaster).*[\)\]]/gi, '')
    // Strip dash-suffixed version tags: "Song - Radio Edit", "Song - Extended Mix"
    .replace(/\s+[-–—]\s+.*\b(feat|ft|featuring|remix|edit|mix|version|original|extended|radio|club|instrumental|dub|vip|bootleg|remaster)\b.*$/gi, '')
    .replace(/\b(feat\.?|ft\.?|featuring)\b.*?(?=\s*[-–—]|$)/gi, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build a loose match key from artist + title. */
export function looseTrackKey(artist: string, title: string): string {
  const a = normalizeLoose(artist);
  const t = normalizeLoose(title);
  if (a && t) return `${a} - ${t}`;
  return a || t;
}
