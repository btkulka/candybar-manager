import { describe, it, expect } from 'vitest';
import {
  levenshteinDistance,
  stringSimilarity,
  normalizeForComparison,
  normalizeBasic,
  makeTrackKey,
} from '../stringUtils';

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshteinDistance('hello', 'hello')).toBe(0);
  });

  it('returns length of b when a is empty', () => {
    expect(levenshteinDistance('', 'abc')).toBe(3);
  });

  it('returns length of a when b is empty', () => {
    expect(levenshteinDistance('abc', '')).toBe(3);
  });

  it('returns 1 for a single substitution', () => {
    expect(levenshteinDistance('cat', 'bat')).toBe(1);
  });

  it('returns 1 for a single insertion', () => {
    expect(levenshteinDistance('ab', 'abc')).toBe(1);
  });

  it('returns 1 for a single deletion', () => {
    expect(levenshteinDistance('abc', 'ab')).toBe(1);
  });

  it('handles transpositions correctly (not a transposition, counts as 2)', () => {
    expect(levenshteinDistance('ab', 'ba')).toBe(2);
  });

  it('computes distance for realistic music title differences', () => {
    // "Levels" vs "Level" — 1 deletion
    expect(levenshteinDistance('levels', 'level')).toBe(1);
  });
});

describe('stringSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(stringSimilarity('hello', 'hello')).toBe(1);
  });

  it('returns 0 when one string is empty and the other is not', () => {
    expect(stringSimilarity('', 'abc')).toBe(0);
    expect(stringSimilarity('abc', '')).toBe(0);
  });

  it('returns 1 for two empty strings (identical)', () => {
    // '' === '' triggers the identity short-circuit
    expect(stringSimilarity('', '')).toBe(1);
  });

  it('returns a value between 0 and 1 for similar strings', () => {
    const score = stringSimilarity('levels', 'level');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
    expect(score).toBeCloseTo(1 - 1 / 6, 5);
  });

  it('returns low similarity for very different strings', () => {
    expect(stringSimilarity('abc', 'xyz')).toBeLessThan(0.5);
  });

  it('is symmetric', () => {
    const a = stringSimilarity('techno', 'house');
    const b = stringSimilarity('house', 'techno');
    expect(a).toBeCloseTo(b, 10);
  });
});

describe('normalizeForComparison', () => {
  it('lowercases the string', () => {
    expect(normalizeForComparison('Avicii')).toBe('avicii');
  });

  it('strips (feat. Artist) from titles', () => {
    expect(normalizeForComparison('One More Time (feat. Daft Punk)')).toBe('one more time');
  });

  it('strips [ft. Artist] from titles', () => {
    expect(normalizeForComparison('Summer [ft. Calvin Harris]')).toBe('summer');
  });

  it('strips (Original Mix) label', () => {
    expect(normalizeForComparison('Levels (Original Mix)')).toBe('levels');
  });

  it('strips (Extended Mix) label', () => {
    expect(normalizeForComparison('Strobe (Extended Mix)')).toBe('strobe');
  });

  it('strips (Radio Edit)', () => {
    expect(normalizeForComparison('Animal (Radio Edit)')).toBe('animal');
  });

  it('strips (Club Mix)', () => {
    expect(normalizeForComparison('Sandstorm (Club Mix)')).toBe('sandstorm');
  });

  it('strips everything from the first bracket containing a remix keyword', () => {
    // The greedy regex matches from "(Da Ba Dee)" through "[Remix]" as one span
    expect(normalizeForComparison('Blue (Da Ba Dee) [Remix]')).toBe('blue');
  });

  it('strips [Remix] appended to a clean title', () => {
    expect(normalizeForComparison('Sandstorm [Remix]')).toBe('sandstorm');
  });

  it('replaces & with and', () => {
    expect(normalizeForComparison('Above & Beyond')).toBe('above and beyond');
  });

  it('removes special characters', () => {
    expect(normalizeForComparison("don't stop")).toBe('dont stop');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeForComparison('hello   world')).toBe('hello world');
  });

  it('trims leading/trailing whitespace', () => {
    expect(normalizeForComparison('  hello  ')).toBe('hello');
  });

  it('strips inline feat. before a dash', () => {
    const result = normalizeForComparison('Artist feat. Other - Title');
    expect(result).not.toContain('feat');
  });
});

describe('normalizeBasic', () => {
  it('lowercases', () => {
    expect(normalizeBasic('Deadmau5')).toBe('deadmau5');
  });

  it('replaces punctuation with spaces', () => {
    expect(normalizeBasic("don't")).toBe('don t');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeBasic('a   b')).toBe('a b');
  });

  it('preserves word characters and digits', () => {
    expect(normalizeBasic('track123')).toBe('track123');
  });

  it('trims result', () => {
    expect(normalizeBasic('  hello  ')).toBe('hello');
  });
});

describe('makeTrackKey', () => {
  it('produces a lowercased artist - title key', () => {
    expect(makeTrackKey('Avicii', 'Levels')).toBe('avicii - levels');
  });

  it('trims whitespace from both fields', () => {
    expect(makeTrackKey('  Daft Punk  ', '  One More Time  ')).toBe('daft punk - one more time');
  });

  it('handles empty strings', () => {
    expect(makeTrackKey('', 'Title')).toBe(' - title');
    expect(makeTrackKey('Artist', '')).toBe('artist - ');
  });

  it('is consistent regardless of original casing', () => {
    expect(makeTrackKey('AVICII', 'LEVELS')).toBe(makeTrackKey('avicii', 'levels'));
  });
});
