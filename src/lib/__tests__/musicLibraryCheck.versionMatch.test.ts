import { describe, it, expect } from 'vitest';
import {
  calculateMatchConfidence,
  MATCH_THRESHOLD,
  UNCERTAIN_THRESHOLD,
  type TrackRecord,
} from '../musicLibraryCheck';
import { normalizeBasic } from '../stringUtils';

// Build a TrackRecord the way the matching engine does (key = version-preserving
// normalizeBasic of "artist - title").
function track(artist: string, title: string): TrackRecord {
  return { key: normalizeBasic(`${artist} - ${title}`), artist, title };
}

// The three buckets the engine sorts into, driven purely by confidence.
function bucket(c: number): 'matched' | 'uncertain' | 'missing' {
  if (c >= UNCERTAIN_THRESHOLD) return 'matched';
  if (c >= MATCH_THRESHOLD) return 'uncertain';
  return 'missing';
}

describe('calculateMatchConfidence — true duplicates stay "matched"', () => {
  it('matches across diacritics', () => {
    const c = calculateMatchConfidence(track('Rufus Du Sol', 'Innerbloom'), track('RÜFÜS DU SOL', 'Innerbloom'));
    expect(bucket(c)).toBe('matched');
  });

  it('matches when only a feat credit differs', () => {
    const c = calculateMatchConfidence(track('Duke Dumont', 'Ocean Drive (feat. Ebenezer)'), track('Duke Dumont', 'Ocean Drive'));
    expect(bucket(c)).toBe('matched');
  });

  it('matches a bare title against its "(Original Mix)"', () => {
    const c = calculateMatchConfidence(track('Boris Brejcha', 'Gravity (Original Mix)'), track('Boris Brejcha', 'Gravity'));
    expect(bucket(c)).toBe('matched');
  });

  it('matches the exact same remix', () => {
    const c = calculateMatchConfidence(
      track('Charlotte de Witte', 'Formula (Adam Beyer Remix)'),
      track('Charlotte de Witte', 'Formula (Adam Beyer Remix)'),
    );
    expect(bucket(c)).toBe('matched');
  });
});

describe('calculateMatchConfidence — a version you do not own is NOT hidden', () => {
  it('does not mark a remix as owned when you only have the original', () => {
    const c = calculateMatchConfidence(track('Charlotte de Witte', 'Formula (Adam Beyer Remix)'), track('Charlotte de Witte', 'Formula'));
    expect(c).toBeLessThan(UNCERTAIN_THRESHOLD);
    expect(bucket(c)).toBe('uncertain');
  });

  it('does not mark an extended mix as owned when you only have the radio version', () => {
    const c = calculateMatchConfidence(track('Fisher', 'Losing It (Extended Mix)'), track('Fisher', 'Losing It'));
    expect(c).toBeLessThan(UNCERTAIN_THRESHOLD);
  });

  it('distinguishes a radio edit from an extended mix of the same song', () => {
    const c = calculateMatchConfidence(
      track('Meduza', 'Piece Of Your Heart (Radio Edit)'),
      track('Meduza', 'Piece Of Your Heart (Extended Mix)'),
    );
    expect(c).toBeLessThan(UNCERTAIN_THRESHOLD);
  });
});

describe('calculateMatchConfidence — subset-token false positives (token_sort fix)', () => {
  it('does not treat two different songs that share a leading word as owned', () => {
    // "Home" vs "Home (Nobody Is Not Loved)" scored a perfect 100 under
    // token_set_ratio; token_sort_ratio must keep them out of "matched".
    const c = calculateMatchConfidence(track('Solomun', 'Home'), track('Solomun', 'Home (Nobody Is Not Loved)'));
    expect(bucket(c)).not.toBe('matched');
  });

  it('does not treat a solo credit as owned via a collab entry with the same title', () => {
    const c = calculateMatchConfidence(track('Adam Beyer', 'Space Date'), track('Adam Beyer, Layton Giordani', 'Space Date'));
    expect(bucket(c)).not.toBe('matched');
  });
});

describe('calculateMatchConfidence — unrelated tracks stay "missing"', () => {
  it('scores a genuinely new track low', () => {
    const c = calculateMatchConfidence(track('Bicep', 'Glue'), track('Four Tet', 'Baby'));
    expect(bucket(c)).toBe('missing');
  });
});

describe('calculateMatchConfidence — title floor keeps unrelated songs out of "maybe owned"', () => {
  it('routes a different song by the SAME artist to missing, not uncertain', () => {
    // Same exact artist, unrelated titles: the artist score alone used to clear
    // the 0.60 bar (uncertain / "maybe owned"). The title floor pushes it to new.
    const c = calculateMatchConfidence(
      track('Starjunk 95', 'Bubblegum Trash'),
      track('Starjunk 95', "Beat Keep Rockin' (Original Mix)"),
    );
    expect(bucket(c)).toBe('missing');
  });

  it('does NOT demote a genuine version variant to missing (stays uncertain via the version cap)', () => {
    // "(Extended Mix)" shares the base title, so its normalized title score is
    // high — above the floor — and it routes through the version cap instead.
    const c = calculateMatchConfidence(track('Fisher', 'Losing It (Extended Mix)'), track('Fisher', 'Losing It'));
    expect(bucket(c)).toBe('uncertain');
    expect(c).toBeLessThan(UNCERTAIN_THRESHOLD);
  });

  it('still matches a true duplicate through the floor', () => {
    const c = calculateMatchConfidence(track('Boris Brejcha', 'Gravity (Original Mix)'), track('Boris Brejcha', 'Gravity'));
    expect(bucket(c)).toBe('matched');
  });
});
