import path from 'path';
import { stringSimilarity, normalizeForComparison, normalizeTrackKey } from './stringUtils';
import type { DuplicatePair } from '../types';
export type { DuplicatePair };

/**
 * Track info for duplicate detection
 */
export type TrackForDuplicateCheck = {
  filePath: string;
  artist: string;
  title: string;
  format: string;
  bitRate: number | null;
  duration: number | null;
  album: string | null;
  year: number | null;
  genre: string | null;
  hasAlbumArt: boolean;
  tagCompleteness: number;
  dateAdded: number | null;
};

type NormTrack = {
  track: TrackForDuplicateCheck;
  /** Version-STRIPPED (remix/edit/feat removed) — fuzzy "same song?" scoring. */
  nArtist: string;
  nTitle: string;
  /** Primary artist only ("The X", "X feat. Y", "X, Y" and "X & Y" all → "x"),
   *  so spelling/credit variants of the same act still sort and score together. */
  pArtist: string;
  /** Version-PRESERVING — tells an original apart from a remix/edit. */
  vArtist: string;
  vTitle: string;
  /** First 3 chars of nTitle, for the cheap pre-filter. */
  titleStart: string;
};

/** Precompute both normalized forms once per track. findDuplicates compares each
 *  track against up to ~50 neighbours, so recomputing these regexes per-pair was
 *  the hot path. */
/** Primary-artist key: drop a leading "The", feat. credits and co-artists. */
function primaryArtistKey(artist: string): string {
  const first = artist
    .split(/\s*(?:,|;|&|\/|\s+x\s+|\s+vs\.?\s+|\s+and\s+)\s*/i)[0] ?? '';
  return normalizeForComparison(first).replace(/^the\s+/, '');
}

/** Exact artist+title pairs whose lengths differ by more than this are different
 *  recordings that happen to share tags (two "Intro"s), not duplicates. */
const EXACT_MATCH_MAX_DURATION_DIFF_SEC = 5;

function normalizeTrack(track: TrackForDuplicateCheck): NormTrack {
  const nTitle = normalizeForComparison(track.title);
  return {
    track,
    nArtist: normalizeForComparison(track.artist),
    nTitle,
    pArtist: primaryArtistKey(track.artist),
    vArtist: normalizeTrackKey(track.artist),
    vTitle: normalizeTrackKey(track.title),
    titleStart: nTitle.substring(0, 3),
  };
}

/**
 * Calculate similarity score between two (pre-normalized) tracks
 */
function calculateTrackSimilarity(
  a: NormTrack,
  b: NormTrack
): { similarity: number; reason: string } {
  const { track: track1, nArtist: artist1, nTitle: title1, vArtist: vArtist1, vTitle: vTitle1 } = a;
  const { track: track2, nArtist: artist2, nTitle: title2, vArtist: vArtist2, vTitle: vTitle2 } = b;

  const durationDiff = (track1.duration && track2.duration)
    ? Math.abs(track1.duration - track2.duration)
    : null;

  // True exact match: the version-preserving keys agree (and are non-empty).
  if (vArtist1 === vArtist2 && vTitle1 === vTitle2 && vArtist1 !== '' && vTitle1 !== '') {
    if (durationDiff !== null && durationDiff > EXACT_MATCH_MAX_DURATION_DIFF_SEC) {
      return { similarity: 0.8, reason: 'Same artist and title, but different length' };
    }
    return { similarity: 1.0, reason: 'Exact match (artist + title)' };
  }

  // Calculate fuzzy similarity. Guard empty normalized strings: non-Latin/symbol-only
  // titles normalize to '' and stringSimilarity('','') is 1.0, which would otherwise
  // score two unrelated tracks as a perfect match and invite a destructive delete.
  const fullArtistSim = (artist1 === '' || artist2 === '') ? 0 : stringSimilarity(artist1, artist2);
  const primaryArtistSim = (a.pArtist === '' || b.pArtist === '') ? 0 : stringSimilarity(a.pArtist, b.pArtist);
  const artistSim = Math.max(fullArtistSim, primaryArtistSim);
  const titleSim = (title1 === '' || title2 === '') ? 0 : stringSimilarity(title1, title2);

  // Title is more important for matching
  const weightedSim = titleSim * 0.6 + artistSim * 0.4;
  let durationBonus = 0;
  if (durationDiff !== null) {
    if (durationDiff < 1) {
      durationBonus = 0.1; // Very close duration
    } else if (durationDiff < 5) {
      durationBonus = 0.05; // Close duration
    }
  }

  // Version mismatch: the version-stripped titles match but the version-preserving
  // ones differ → these are DIFFERENT versions (original vs remix/edit). Keep them
  // below the duplicate threshold unless the durations match closely (in which case
  // it's likely the same recording tagged differently — surface for review, but
  // never as a definitive exact match).
  const versionMismatch = title1 === title2 && vTitle1 !== vTitle2;
  if (versionMismatch) {
    const sameLength = durationDiff !== null && durationDiff < 2;
    const capped = sameLength ? 0.9 : 0.8;
    return {
      similarity: Math.min(weightedSim, capped),
      reason: sameLength
        ? 'Likely same recording (version tag differs, matching length)'
        : 'Different version (original vs remix/edit)',
    };
  }

  const finalSim = Math.min(1, weightedSim + durationBonus);

  // Determine reason
  let reason = '';
  if (titleSim > 0.9 && artistSim > 0.9) {
    reason = 'Very similar artist and title';
  } else if (titleSim > 0.9) {
    reason = 'Very similar title';
  } else if (artistSim > 0.9 && titleSim > 0.7) {
    reason = 'Same artist, similar title';
  } else {
    reason = 'Fuzzy match';
  }

  if (durationBonus > 0) {
    reason += ' (similar duration)';
  }

  return { similarity: finalSim, reason };
}

/**
 * Find potential duplicates in a list of tracks
 * Uses fuzzy matching to identify tracks that might be duplicates
 *
 * @param tracks - List of tracks to check
 * @param threshold - Minimum similarity score to consider as duplicate (0-1, default 0.85)
 * @returns List of potential duplicate pairs
 */
export function findDuplicates(
  tracks: TrackForDuplicateCheck[],
  threshold = 0.85
): DuplicatePair[] {
  const duplicates: DuplicatePair[] = [];
  const seenPairs = new Set<string>();

  // Normalize each track ONCE up front (the window scans below would otherwise
  // recompute these regexes for every neighbour comparison).
  const normed = tracks.map(normalizeTrack);

  // Two windowed passes over differently sorted lists: by primary artist + title
  // (variants like "The X" / "X feat. Y" land together), then by title + artist
  // (catches the same song under an artist spelling the first sort split apart).
  const byArtist = [...normed].sort((a, b) =>
    `${a.pArtist} ${a.nTitle}`.localeCompare(`${b.pArtist} ${b.nTitle}`));
  const byTitle = [...normed].sort((a, b) =>
    `${a.nTitle} ${a.pArtist}`.localeCompare(`${b.nTitle} ${b.pArtist}`));

  for (const sorted of [byArtist, byTitle]) {
    for (let i = 0; i < sorted.length; i++) {
      const n1 = sorted[i];
      const track1 = n1.track;

      // Only compare with nearby tracks: similar tracks sort close together.
      for (let j = i + 1; j < i + 50 && j < sorted.length; j++) {
        const n2 = sorted[j];
        const track2 = n2.track;

        // Skip if same file
        if (track1.filePath === track2.filePath) continue;
        const pairKey = track1.filePath < track2.filePath
          ? `${track1.filePath}\u0000${track2.filePath}`
          : `${track2.filePath}\u0000${track1.filePath}`;
        if (seenPairs.has(pairKey)) continue;

        // Quick check - if first characters of normalized titles don't match, skip
        if (n1.titleStart !== n2.titleStart && stringSimilarity(n1.titleStart, n2.titleStart) < 0.5) {
          continue;
        }
        seenPairs.add(pairKey);

        const { similarity, reason } = calculateTrackSimilarity(n1, n2);

        if (similarity >= threshold) {
          duplicates.push({
            track1: {
              filePath: track1.filePath,
              fileName: path.basename(track1.filePath),
              artist: track1.artist,
              title: track1.title,
              format: track1.format,
              bitRate: track1.bitRate,
              duration: track1.duration,
              album: track1.album,
              year: track1.year,
              genre: track1.genre,
              hasAlbumArt: track1.hasAlbumArt,
              tagCompleteness: track1.tagCompleteness,
              dateAdded: track1.dateAdded
            },
            track2: {
              filePath: track2.filePath,
              fileName: path.basename(track2.filePath),
              artist: track2.artist,
              title: track2.title,
              format: track2.format,
              bitRate: track2.bitRate,
              duration: track2.duration,
              album: track2.album,
              year: track2.year,
              genre: track2.genre,
              hasAlbumArt: track2.hasAlbumArt,
              tagCompleteness: track2.tagCompleteness,
              dateAdded: track2.dateAdded
            },
            similarity,
            reason
          });
        }
      }
    }
  }

  // Sort by similarity (highest first)
  duplicates.sort((a, b) => b.similarity - a.similarity);

  return duplicates;
}
