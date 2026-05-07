import { describe, it, expect } from 'vitest';
import { normalizeTrackKey, makeTagKey } from '../stringUtils';

describe('normalizeTrackKey', () => {
  it('lowercases and strips non-alphanumerics', () => {
    expect(normalizeTrackKey('Hello, World!')).toBe('helloworld');
  });

  it('strips diacritics', () => {
    expect(normalizeTrackKey('RÜFÜS DU SOL')).toBe('rufusdusol');
  });

  it('preserves bracketed version info (distinct keys for different mixes)', () => {
    const a = normalizeTrackKey('Innerbloom (Original Mix)');
    const b = normalizeTrackKey('Innerbloom (Ship Wrek Remix)');
    expect(a).not.toBe(b);
    expect(a).toContain('originalmix');
    expect(b).toContain('shipwrekremix');
  });

  it('returns empty string for empty/nullish input', () => {
    expect(normalizeTrackKey('')).toBe('');
  });
});

describe('makeTagKey', () => {
  it('combines normalized artist and title with a pipe separator', () => {
    expect(makeTagKey('Beyoncé', 'Halo')).toBe('beyonce|halo');
  });

  it('returns "|" when both inputs are empty (matches nothing)', () => {
    expect(makeTagKey('', '')).toBe('|');
  });
});
