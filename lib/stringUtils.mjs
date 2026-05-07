// Parallel to src/lib/stringUtils.ts. Kept as .mjs because the top-level
// .mjs scripts can't import from .ts under the current moduleResolution.
// Keep `normalizeTrackKey` semantically identical to the TS version.

const COMBINING_MARKS_RX = /[̀-ͯ]/g;

// Aggressive normalization: strips bracketed version/feat info, then
// collapses to [a-z0-9]. Used by fuzzy scan/match pipelines where
// "Innerbloom (Original Mix)" should hash to the same key as plain
// "Innerbloom" so cross-format candidates collide.
export function normalizeAggressive(s) {
  if (!s) return '';
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_MARKS_RX, '')
    .replace(/[\(\[].*?[\)\]]/g, ' ')
    .replace(/feat\..*$|ft\..*$/g, ' ')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

// Version-preserving: mirrors src/lib/stringUtils.ts:normalizeTrackKey.
// Does NOT strip bracketed content so remix/edit info stays distinct.
export function normalizeTrackKey(s) {
  if (!s) return '';
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_MARKS_RX, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

export function makeAggressiveKey(artist, title) {
  return `${normalizeAggressive(artist)}|${normalizeAggressive(title)}`;
}

export function makeTagKey(artist, title) {
  return `${normalizeTrackKey(artist)}|${normalizeTrackKey(title)}`;
}
