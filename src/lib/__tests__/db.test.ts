import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test-candybar') },
}));

vi.mock('electron-log', () => ({
  default: {
    transports: { console: { level: 'info' } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    scope: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
}));

import { makeDuplicatePairKey } from '../db';

describe('makeDuplicatePairKey', () => {
  it('produces a canonical key from two tracks', () => {
    const key = makeDuplicatePairKey('Avicii', 'Levels', 'Deadmau5', 'Strobe');
    expect(key).toBe('avicii - levels||deadmau5 - strobe');
  });

  it('is order-independent (same key regardless of which is track1/track2)', () => {
    const key1 = makeDuplicatePairKey('Avicii', 'Levels', 'Deadmau5', 'Strobe');
    const key2 = makeDuplicatePairKey('Deadmau5', 'Strobe', 'Avicii', 'Levels');
    expect(key1).toBe(key2);
  });

  it('normalizes casing', () => {
    const key1 = makeDuplicatePairKey('AVICII', 'LEVELS', 'deadmau5', 'strobe');
    const key2 = makeDuplicatePairKey('avicii', 'levels', 'DEADMAU5', 'STROBE');
    expect(key1).toBe(key2);
  });

  it('trims surrounding whitespace', () => {
    const key1 = makeDuplicatePairKey('  Avicii  ', '  Levels  ', 'Deadmau5', 'Strobe');
    const key2 = makeDuplicatePairKey('Avicii', 'Levels', 'Deadmau5', 'Strobe');
    expect(key1).toBe(key2);
  });

  it('uses || as separator between the two track keys', () => {
    const key = makeDuplicatePairKey('Artist A', 'Title A', 'Artist B', 'Title B');
    expect(key).toContain('||');
    const parts = key.split('||');
    expect(parts).toHaveLength(2);
  });

  it('each part uses " - " format (artist - title)', () => {
    const key = makeDuplicatePairKey('Daft Punk', 'One More Time', 'Daft Punk', 'Harder Better Faster Stronger');
    const parts = key.split('||');
    expect(parts[0]).toMatch(/^.+ - .+$/);
    expect(parts[1]).toMatch(/^.+ - .+$/);
  });

  it('same track paired with itself produces a single-segment key sorted with itself', () => {
    const key = makeDuplicatePairKey('Avicii', 'Levels', 'Avicii', 'Levels');
    // Both halves are the same, sorted "same||same"
    expect(key).toBe('avicii - levels||avicii - levels');
  });
});
