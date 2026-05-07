import path from 'path';
import { stringSimilarity, normalizeForComparison, makeTrackKey } from './stringUtils';
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

/**
 * Calculate similarity score between two tracks
 */
function calculateTrackSimilarity(
  track1: TrackForDuplicateCheck,
  track2: TrackForDuplicateCheck
): { similarity: number; reason: string } {
  const artist1 = normalizeForComparison(track1.artist);
  const artist2 = normalizeForComparison(track2.artist);
  const title1 = normalizeForComparison(track1.title);
  const title2 = normalizeForComparison(track2.title);

  // Exact normalized match
  if (artist1 === artist2 && title1 === title2) {
    return { similarity: 1.0, reason: 'Exact match (artist + title)' };
  }

  // Calculate fuzzy similarity
  const artistSim = stringSimilarity(artist1, artist2);
  const titleSim = stringSimilarity(title1, title2);

  // Title is more important for matching
  const weightedSim = titleSim * 0.6 + artistSim * 0.4;

  // Duration check - if durations are very close, boost confidence
  let durationBonus = 0;
  if (track1.duration && track2.duration) {
    const durationDiff = Math.abs(track1.duration - track2.duration);
    if (durationDiff < 1) {
      durationBonus = 0.1; // Very close duration
    } else if (durationDiff < 5) {
      durationBonus = 0.05; // Close duration
    }
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
  const checkedPairs = new Set<string>();

  // Sort tracks by artist+title for more efficient comparison
  const sortedTracks = [...tracks].sort((a, b) => {
    const keyA = `${a.artist}-${a.title}`.toLowerCase();
    const keyB = `${b.artist}-${b.title}`.toLowerCase();
    return keyA.localeCompare(keyB);
  });

  for (let i = 0; i < sortedTracks.length; i++) {
    const track1 = sortedTracks[i];

    // Only compare with nearby tracks (optimization)
    // Since sorted, similar tracks should be close together
    const searchWindow = Math.min(50, sortedTracks.length - i);

    for (let j = i + 1; j < i + searchWindow && j < sortedTracks.length; j++) {
      const track2 = sortedTracks[j];

      // Skip if same file
      if (track1.filePath === track2.filePath) continue;

      // Create a unique key for this pair
      const pairKey = [track1.filePath, track2.filePath].sort().join('|');
      if (checkedPairs.has(pairKey)) continue;
      checkedPairs.add(pairKey);

      // Quick check - if first characters of normalized titles don't match, skip
      const title1Start = normalizeForComparison(track1.title).substring(0, 3);
      const title2Start = normalizeForComparison(track2.title).substring(0, 3);
      if (title1Start !== title2Start && stringSimilarity(title1Start, title2Start) < 0.5) {
        continue;
      }

      const { similarity, reason } = calculateTrackSimilarity(track1, track2);

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

  // Sort by similarity (highest first)
  duplicates.sort((a, b) => b.similarity - a.similarity);

  return duplicates;
}
