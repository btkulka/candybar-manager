import { describe, it, expect } from 'vitest';
import { findDuplicates, type TrackForDuplicateCheck } from '../duplicateDetection';

function makeTrack(overrides: Partial<TrackForDuplicateCheck> & { filePath: string; artist: string; title: string }): TrackForDuplicateCheck {
  return {
    format: 'AIFF',
    bitRate: 1411,
    duration: 300,
    album: null,
    year: null,
    genre: null,
    hasAlbumArt: true,
    tagCompleteness: 1,
    dateAdded: null,
    ...overrides,
  };
}

describe('findDuplicates', () => {
  it('returns empty array for a single track', () => {
    const tracks = [makeTrack({ filePath: '/music/a.aif', artist: 'Avicii', title: 'Levels' })];
    expect(findDuplicates(tracks)).toEqual([]);
  });

  it('returns empty array for completely different tracks', () => {
    const tracks = [
      makeTrack({ filePath: '/music/a.aif', artist: 'Avicii', title: 'Levels' }),
      makeTrack({ filePath: '/music/b.aif', artist: 'Deadmau5', title: 'Strobe' }),
    ];
    expect(findDuplicates(tracks)).toHaveLength(0);
  });

  it('detects exact duplicates (same artist and title)', () => {
    const tracks = [
      makeTrack({ filePath: '/music/a.aif', artist: 'Avicii', title: 'Levels' }),
      makeTrack({ filePath: '/music/b.aif', artist: 'Avicii', title: 'Levels' }),
    ];
    const dupes = findDuplicates(tracks, 0.85);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].similarity).toBe(1.0);
    expect(dupes[0].reason).toContain('Exact match');
  });

  it('detects duplicates across Original Mix vs no suffix', () => {
    const tracks = [
      makeTrack({ filePath: '/music/a.aif', artist: 'Eric Prydz', title: 'Opus' }),
      makeTrack({ filePath: '/music/b.aif', artist: 'Eric Prydz', title: 'Opus (Original Mix)' }),
    ];
    const dupes = findDuplicates(tracks, 0.85);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].similarity).toBeGreaterThanOrEqual(0.85);
  });

  it('does not count the same file as a duplicate of itself', () => {
    const tracks = [
      makeTrack({ filePath: '/music/a.aif', artist: 'Avicii', title: 'Levels' }),
      makeTrack({ filePath: '/music/a.aif', artist: 'Avicii', title: 'Levels' }),
    ];
    expect(findDuplicates(tracks)).toHaveLength(0);
  });

  it('applies duration bonus when durations are within 1 second', () => {
    const tracks = [
      makeTrack({ filePath: '/music/a.aif', artist: 'Deadmau5', title: 'Strobe', duration: 600.0 }),
      makeTrack({ filePath: '/music/b.aif', artist: 'Deadmau5', title: 'Strobe', duration: 600.4 }),
    ];
    const dupes = findDuplicates(tracks, 0.85);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].similarity).toBe(1.0);
  });

  it('applies smaller duration bonus when durations differ by 1-5 seconds', () => {
    // Use tracks where the base similarity is just below 1.0 so the bonus matters
    const tracks = [
      makeTrack({ filePath: '/music/a.aif', artist: 'Artist', title: 'Same Title', duration: 300.0 }),
      makeTrack({ filePath: '/music/b.aif', artist: 'Artist', title: 'Same Title', duration: 303.0 }),
    ];
    const dupes = findDuplicates(tracks, 0.85);
    expect(dupes).toHaveLength(1);
    // Exact match + 0.05 duration bonus → capped at 1.0
    expect(dupes[0].similarity).toBe(1.0);
  });

  it('sorts results by similarity descending', () => {
    const tracks = [
      makeTrack({ filePath: '/music/a.aif', artist: 'Artist', title: 'Track One' }),
      makeTrack({ filePath: '/music/b.aif', artist: 'Artist', title: 'Track One' }),
      makeTrack({ filePath: '/music/c.aif', artist: 'Artist', title: 'Track 0ne' }), // slight typo
      makeTrack({ filePath: '/music/d.aif', artist: 'Artist', title: 'Track 0ne' }),
    ];
    const dupes = findDuplicates(tracks, 0.80);
    for (let i = 1; i < dupes.length; i++) {
      expect(dupes[i - 1].similarity).toBeGreaterThanOrEqual(dupes[i].similarity);
    }
  });

  it('respects custom threshold', () => {
    // "Track A" vs "Track B" — same artist, 1-char title diff.
    // Weighted sim ≈ 0.914. duration: null prevents the duration bonus.
    const tracks = [
      makeTrack({ filePath: '/music/a.aif', artist: 'Artist', title: 'Track A', duration: null }),
      makeTrack({ filePath: '/music/b.aif', artist: 'Artist', title: 'Track B', duration: null }),
    ];
    expect(findDuplicates(tracks, 0.99)).toHaveLength(0);
    expect(findDuplicates(tracks, 0.85).length).toBeGreaterThan(0);
  });

  it('uses filename as the basis for fileName in output', () => {
    const tracks = [
      makeTrack({ filePath: '/music/artists/avicii/levels.aif', artist: 'Avicii', title: 'Levels' }),
      makeTrack({ filePath: '/music/artists/avicii/levels-copy.aif', artist: 'Avicii', title: 'Levels' }),
    ];
    const dupes = findDuplicates(tracks, 0.85);
    expect(dupes[0].track1.fileName).toBe('levels.aif');
    expect(dupes[0].track2.fileName).toBe('levels-copy.aif');
  });

  it('does not double-count a pair', () => {
    const tracks = [
      makeTrack({ filePath: '/music/a.aif', artist: 'Daft Punk', title: 'One More Time' }),
      makeTrack({ filePath: '/music/b.aif', artist: 'Daft Punk', title: 'One More Time' }),
    ];
    const dupes = findDuplicates(tracks, 0.85);
    expect(dupes).toHaveLength(1);
  });

  // --- Version-aware dedupe (guards against deleting a distinct remix) ---

  it('does NOT collapse an original and a differently-lengthed remix into a duplicate', () => {
    const tracks = [
      makeTrack({ filePath: '/music/a.aif', artist: 'RUFUS DU SOL', title: 'Innerbloom (Original Mix)', duration: 431 }),
      makeTrack({ filePath: '/music/b.aif', artist: 'RUFUS DU SOL', title: 'Innerbloom (Ship Wrek Remix)', duration: 210 }),
    ];
    // Different versions with clearly different lengths must not surface as a duplicate.
    expect(findDuplicates(tracks, 0.85)).toHaveLength(0);
  });

  it('flags a version-tag difference as "likely same", never a 1.0 exact match', () => {
    const tracks = [
      makeTrack({ filePath: '/music/a.aif', artist: 'Eric Prydz', title: 'Opus', duration: 540 }),
      makeTrack({ filePath: '/music/b.aif', artist: 'Eric Prydz', title: 'Opus (Extended Mix)', duration: 540 }),
    ];
    const dupes = findDuplicates(tracks, 0.85);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].similarity).toBeLessThan(1.0);
    expect(dupes[0].reason).not.toContain('Exact match');
  });

  it('does not treat two different non-Latin titles as a duplicate (empty-normalization guard)', () => {
    const tracks = [
      makeTrack({ filePath: '/music/a.aif', artist: '未来', title: '夜明け' }),
      makeTrack({ filePath: '/music/b.aif', artist: '未来', title: '星空' }),
    ];
    expect(findDuplicates(tracks, 0.85)).toHaveLength(0);
  });

  it('still treats an accented and unaccented spelling as the same (diacritic folding)', () => {
    const tracks = [
      makeTrack({ filePath: '/music/a.aif', artist: 'Tiësto', title: 'Adagio for Strings' }),
      makeTrack({ filePath: '/music/b.aif', artist: 'Tiesto', title: 'Adagio for Strings' }),
    ];
    const dupes = findDuplicates(tracks, 0.85);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].similarity).toBe(1.0);
  });

  it('does not call two same-titled tracks of clearly different length an exact duplicate', () => {
    const tracks = [
      makeTrack({ filePath: '/music/a.aif', artist: 'Artist', title: 'Intro', duration: 90 }),
      makeTrack({ filePath: '/music/b.aif', artist: 'Artist', title: 'Intro', duration: 185 }),
    ];
    expect(findDuplicates(tracks, 0.85)).toHaveLength(0);
  });

  it('matches artist credit variants ("The X" vs "X", feat. credits)', () => {
    const tracks = [
      makeTrack({ filePath: '/music/a.aif', artist: 'The Martinez Brothers', title: 'Debbie Downer' }),
      makeTrack({ filePath: '/music/b.aif', artist: 'Martinez Brothers', title: 'Debbie Downer' }),
      makeTrack({ filePath: '/music/c.aif', artist: 'Four Tet', title: 'Baby' }),
      makeTrack({ filePath: '/music/d.aif', artist: 'Four Tet feat. Ellie Goulding', title: 'Baby' }),
    ];
    const pairs = findDuplicates(tracks, 0.85).map(d => [d.track1.filePath, d.track2.filePath].sort().join(' + '));
    expect(pairs).toContain('/music/a.aif + /music/b.aif');
    expect(pairs).toContain('/music/c.aif + /music/d.aif');
  });

  it('finds the same song across distant artist spellings via the title-sorted pass', () => {
    // 60 unrelated tracks by "M..." artists sit between the two spellings when
    // sorted by artist, pushing them outside a 50-wide window.
    const filler = Array.from({ length: 60 }, (_, i) =>
      makeTrack({ filePath: `/music/f${i}.aif`, artist: `M Artist ${String(i).padStart(2, '0')}`, title: `Filler ${i}` }));
    const tracks = [
      makeTrack({ filePath: '/music/x.aif', artist: 'Adam Beyer', title: 'Your Mind' }),
      ...filler,
      makeTrack({ filePath: '/music/y.aif', artist: 'Zadam Beyer', title: 'Your Mind' }),
    ];
    const pairs = findDuplicates(tracks, 0.85).map(d => [d.track1.filePath, d.track2.filePath].sort().join(' + '));
    expect(pairs).toContain('/music/x.aif + /music/y.aif');
  });
});
