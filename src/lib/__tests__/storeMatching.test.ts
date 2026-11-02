/**
 * Store scoring invariants. Every case here is one that actually went wrong
 * against the live Qobuz/Beatport catalogs.
 *
 * Mirrors lib/sourcing/__tests__/matching.test.mjs — the sourcing skill runs the
 * same rules from its own engine, and the two must not drift.
 */

import { describe, it, expect } from 'vitest';
import {
  storeScore, storeScoreParts, extendedMixBoost, reworkMismatchPenalty, ownedVersionSatisfies,
  STORE_MATCH_FLOOR,
} from '../storeMatching';

const track = (artist: string, title: string) => ({ artist, title });

describe('artist floor', () => {
  it('rejects a candidate whose artist barely matches, however well the titles overlap', () => {
    const t = track('Zzzz Nonexistent Artist', 'Totally Fake Song Title 12345');
    // partial_ratio used to score the artist pair 0.62 on incidental overlap.
    expect(storeScore(t, ['Ten Years After'], 'Stonedhenge')).toBeLessThan(STORE_MATCH_FLOOR);
    expect(storeScore(t, ['The Breeders'], 'Title Tk')).toBeLessThan(STORE_MATCH_FLOOR);
  });

  it('reports the floor in the breakdown so a near miss can be explained', () => {
    expect(storeScoreParts(track('Zzzz', 'Fake'), ['Ten Years After'], 'Stonedhenge').artistFloored).toBe(true);
  });
});

describe('version discipline', () => {
  it('ranks the original above a third-party remix', () => {
    const t = track('Adam Beyer', 'Your Mind');
    expect(storeScore(t, ['Adam Beyer'], 'Your Mind'))
      .toBeGreaterThan(storeScore(t, ['Adam Beyer', 'HNTR'], 'Your Mind (HNTR Remix)'));
  });

  it('catches a rework no keyword list would predict', () => {
    // Any name can precede "Mix".
    const t = track('Adam Beyer', 'Your Mind');
    expect(storeScore(t, ['Adam Beyer'], 'Your Mind'))
      .toBeGreaterThan(storeScore(t, ['Adam Beyer'], 'Your Mind (Charles D Epic Mix)'));
  });

  it('catches a remix compilation named in the title body', () => {
    const t = track('Adam Beyer', 'Your Mind');
    expect(storeScore(t, ['Adam Beyer'], 'Your Mind'))
      .toBeGreaterThan(storeScore(t, ['Adam Beyer'], 'Your Mind Remixes (Extended Mix)'));
  });

  it('does not penalize a version the user asked for', () => {
    expect(reworkMismatchPenalty('Reconnect - Moore Kismet Remix', 'Reconnect (Moore Kismet Remix)')).toBe(0);
    expect(reworkMismatchPenalty('Your Mind Remixes', 'Your Mind Remixes')).toBe(0);
  });

  it('never awards the extended bonus to a rework', () => {
    expect(storeScoreParts(track('Adam Beyer', 'Your Mind'), ['Adam Beyer'], 'Your Mind Remixes (Extended Mix)').boost).toBe(0);
  });

  it('still prefers the extended mix when no version was requested', () => {
    expect(extendedMixBoost('Delilah', 'Delilah (Extended Mix)')).toBeGreaterThan(0);
    expect(extendedMixBoost('Delilah (Radio Edit)', 'Delilah (Extended Mix)')).toBe(0);
    expect(extendedMixBoost('Delilah (Extended Mix)', 'Delilah (Extended Mix)')).toBe(0);
  });
});

describe('legitimate catalog shapes still match', () => {
  it.each([
    ['subset artist listing', track('Fred again..', 'Delilah (pull me out of this)'), ['Delilah Montagu', 'Fred again..'], 'Delilah (pull me out of this)'],
    ['collaboration', track('Virtual Riot, Moore Kismet', 'Reconnect - Moore Kismet Remix'), ['Virtual Riot', 'Moore Kismet'], 'Reconnect (Moore Kismet Remix)'],
    ['reordered artist name', track('Beyer, Adam', 'Your Mind'), ['Adam Beyer'], 'Your Mind'],
  ])('%s', (_label, t, artists, title) => {
    expect(storeScore(t, artists, title)).toBeGreaterThanOrEqual(0.9);
  });

  it('accepts a single artist string as well as an array', () => {
    const t = track('Bicep', 'Glue');
    expect(storeScore(t, 'Bicep', 'Glue')).toBe(storeScore(t, ['Bicep'], 'Glue'));
  });
});

describe('parity with the sourcing engine', () => {
  // The playlist-sourcing skill scores with lib/sourcing/matching.mjs. Two
  // copies of a scorer is exactly how the previous drift happened (only one
  // applied the extended-mix boost), so assert they agree rather than trusting
  // that they were edited together.
  it('produces identical scores to lib/sourcing/matching.mjs', async () => {
    // The sourcing engine is untyped ESM; this is a runtime parity check, and
    // node10 module resolution can't map a .mjs import to declarations.
    // @ts-expect-error - no type declarations for the .mjs engine
    const engine = await import('../../../lib/sourcing/matching.mjs');

    const cases: Array<[{ artist: string; title: string }, string[], string]> = [
      [track('Fred again..', 'Delilah (pull me out of this)'), ['Delilah Montagu', 'Fred again..'], 'Delilah (pull me out of this)'],
      [track('Adam Beyer', 'Your Mind'), ['Adam Beyer'], 'Your Mind'],
      [track('Adam Beyer', 'Your Mind'), ['Adam Beyer'], 'Your Mind (Charles D Epic Mix)'],
      [track('Adam Beyer', 'Your Mind'), ['Adam Beyer'], 'Your Mind Remixes (Extended Mix)'],
      [track('Adam Beyer', 'Your Mind'), ['Adam Beyer', 'HNTR'], 'Your Mind (HNTR Remix)'],
      [track('Zzzz Nonexistent Artist', 'Totally Fake Song Title 12345'), ['Ten Years After'], 'Stonedhenge'],
      [track('Zzzz Nonexistent Artist', 'Totally Fake Song Title 12345'), ['The Breeders'], 'Title Tk'],
      [track('Virtual Riot, Moore Kismet', 'Reconnect - Moore Kismet Remix'), ['Virtual Riot', 'Moore Kismet'], 'Reconnect (Moore Kismet Remix)'],
      [track('Fred again..', 'Delilah'), ['Fred again..'], 'Delilah (Extended Mix)'],
      [track('Beyer, Adam', 'Your Mind'), ['Adam Beyer'], 'Your Mind'],
      [track('Bicep', 'Glue'), ['Bicep'], 'Glue'],
      [track('RUFUS DU SOL', 'Innerbloom'), ['RUFUS DU SOL'], 'Innerbloom (Original Mix)'],
    ];

    for (const [t, artists, title] of cases) {
      expect(storeScore(t, artists, title), `${t.title} -> ${title}`)
        .toBeCloseTo(engine.storeScore(t, artists, title), 10);
    }
  });

  it('shares the same thresholds', async () => {
    // The sourcing engine is untyped ESM; this is a runtime parity check, and
    // node10 module resolution can't map a .mjs import to declarations.
    // @ts-expect-error - no type declarations for the .mjs engine
    const engine = await import('../../../lib/sourcing/matching.mjs');
    expect(STORE_MATCH_FLOOR).toBe(engine.STORE_MATCH_FLOOR);
  });
});

describe('ownedVersionSatisfies', () => {
  it('owning the original does not mean owning the remix', () => {
    expect(ownedVersionSatisfies('Your Mind (HNTR Remix)', 'Your Mind')).toBe(false);
  });

  it('owning a remix does not mean owning the original', () => {
    expect(ownedVersionSatisfies('Your Mind', 'Your Mind (HNTR Remix)')).toBe(false);
  });

  it('owning the extended mix satisfies an unversioned request', () => {
    expect(ownedVersionSatisfies('Your Mind', 'Your Mind (Extended Mix)')).toBe(true);
  });

  it('matches the same version, however it is written', () => {
    expect(ownedVersionSatisfies('Reconnect - Moore Kismet Remix', 'Reconnect (Moore Kismet Remix)')).toBe(true);
  });

  it('treats "(Original Mix)" as the base version', () => {
    expect(ownedVersionSatisfies('Innerbloom', 'Innerbloom (Original Mix)')).toBe(true);
  });
});
