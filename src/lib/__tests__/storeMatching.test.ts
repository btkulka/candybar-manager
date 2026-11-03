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
  chooseStore, bestOwnedMatch, withVersion, classifyQobuzTier, pickQobuzLosslessTier,
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

  it('catches a sped-up or slowed edit of the owned track', () => {
    // Live Qobuz 2026-11-02: an MP3 of "This Feeling [Explicit]" scored the
    // "(Sped Up)" single at 85%, past the auto-select bar.
    const t = track('my!lane', 'This Feeling [Explicit]');
    expect(reworkMismatchPenalty(t.title, 'This Feeling  (Sped Up)')).toBeGreaterThan(0);
    expect(reworkMismatchPenalty(t.title, 'This Feeling (Slowed + Reverb)')).toBeGreaterThan(0);
    expect(storeScore(t, ['my!lane'], 'This Feeling')).toBeGreaterThan(storeScore(t, ['my!lane'], 'This Feeling  (Sped Up)'));
    expect(storeScore(t, ['my!lane'], 'This Feeling  (Sped Up)')).toBeLessThan(0.75);
    expect(reworkMismatchPenalty('This Feeling (Sped Up)', 'This Feeling (Sped Up)')).toBe(0);
  });

  it('penalizes the original when a rework was asked for', () => {
    // Live Qobuz 2026-11-02: a SoundCloud bootleg matched the original album at 100%.
    expect(reworkMismatchPenalty('Thriller (Moonlght Remix)', 'Thriller 25 Super Deluxe Edition')).toBeGreaterThan(0);
    expect(reworkMismatchPenalty('Reconnect - Moore Kismet Remix', 'Reconnect')).toBeGreaterThan(0);
    // A radio/extended request may still be served by the base single.
    expect(reworkMismatchPenalty('Delilah (Radio Edit)', 'Delilah')).toBe(0);
    expect(reworkMismatchPenalty('Delilah (Extended Mix)', 'Delilah')).toBe(0);
  });

  it('does not serve a named mix, edit or dub request with the bare original', () => {
    // A remix request used to tie the original at 100%, and Qobuz (which
    // searches albums) then preferred the single over the remix EP.
    expect(reworkMismatchPenalty('Your Mind (Charles D Epic Mix)', 'Your Mind')).toBeGreaterThan(0);
    expect(reworkMismatchPenalty('Your Mind (Dom Dolla Edit)', 'Your Mind')).toBeGreaterThan(0);
    expect(reworkMismatchPenalty('Your Mind - Dom Dolla Edit', 'Your Mind (Original Mix)')).toBeGreaterThan(0);
    expect(reworkMismatchPenalty('Your Mind (Dub)', 'Your Mind')).toBeGreaterThan(0);
    expect(storeScore(track('Adam Beyer', 'Your Mind (HNTR Remix)'), ['Adam Beyer'], 'Your Mind (HNTR Remix)'))
      .toBeGreaterThan(storeScore(track('Adam Beyer', 'Your Mind (HNTR Remix)'), ['Adam Beyer'], 'Your Mind'));
  });

  it('treats a live take, acapella, acoustic or demo as a different record', () => {
    for (const tag of ['Live', 'Acapella', 'A Cappella', 'Acoustic', 'Demo', 'Live at Printworks']) {
      expect(reworkMismatchPenalty('Your Mind', `Your Mind (${tag})`), tag).toBeGreaterThan(0);
    }
    expect(reworkMismatchPenalty('Your Mind (Live)', 'Your Mind')).toBeGreaterThan(0);
    expect(reworkMismatchPenalty('Your Mind - Live', 'Your Mind (Live)')).toBe(0);
    // In the title body it's just a word.
    expect(reworkMismatchPenalty('Live Your Life', 'Live Your Life')).toBe(0);
  });

  it('reads a remaster as the same recording', () => {
    expect(reworkMismatchPenalty('Glue', 'Glue (2023 Remaster)')).toBe(0);
    expect(reworkMismatchPenalty('Glue (Remastered)', 'Glue')).toBe(0);
  });

  it('does not penalize a version the user asked for', () => {
    expect(reworkMismatchPenalty('Reconnect - Moore Kismet Remix', 'Reconnect (Moore Kismet Remix)')).toBe(0);
    expect(reworkMismatchPenalty('Your Mind Remixes', 'Your Mind Remixes')).toBe(0);
    expect(reworkMismatchPenalty('Innerbloom', 'Innerbloom (Original Mix)')).toBe(0);
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
      [track('my!lane', 'This Feeling [Explicit]'), ['my!lane'], 'This Feeling  (Sped Up)'],
      [track('Michael Jackson', 'Thriller (Moonlght Remix)'), ['Michael Jackson'], 'Thriller 25 Super Deluxe Edition'],
      [track('Adam Beyer', 'Your Mind (Dom Dolla Edit)'), ['Adam Beyer'], 'Your Mind'],
      [track('Adam Beyer', 'Your Mind'), ['Adam Beyer'], 'Your Mind (Live at Printworks)'],
      [track('Adam Beyer', 'Your Mind'), ['Adam Beyer'], 'Your Mind (A Cappella)'],
      [track('Bicep', 'Glue'), ['Bicep'], 'Glue (2023 Remaster)'],
      [track('Fred again..', 'Delilah (Radio Edit)'), ['Fred again..'], 'Delilah'],
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

  it('owning a live take does not mean owning the studio record', () => {
    expect(ownedVersionSatisfies('Innerbloom', 'Innerbloom (Live)')).toBe(false);
  });
});

describe('chooseStore', () => {
  const c = (score: number, lossless = true) => ({ score, lossless });

  it('never lets a lossy hit push out a lossless one', () => {
    expect(chooseStore(c(0.95, false), c(0.80))).toBe('beatport');
    expect(chooseStore(c(0.80), c(0.95, false))).toBe('qobuz');
  });

  it('returns a lossy hit only when nothing lossless clears the floor', () => {
    expect(chooseStore(c(0.95, false), c(0.40))).toBe('qobuz');
    expect(chooseStore(c(0.95, false), null)).toBe('qobuz');
  });

  it('takes the higher score, with Beatport on exact ties', () => {
    expect(chooseStore(c(1), c(0.9))).toBe('qobuz');
    expect(chooseStore(c(0.9), c(0.9))).toBe('beatport');
    expect(chooseStore(c(0.4), c(0.3))).toBeNull();
  });
});

describe('bestOwnedMatch', () => {
  const owned = (artist: string, title: string, id: string) => ({ artist, title, id });

  it('rejects a different song by the same artist', () => {
    expect(bestOwnedMatch(track('Mau P', 'Gimme That Bounce'), [owned('Mau P', 'Gimme Some', 'a')])).toBeNull();
  });

  it('rejects the same title by an artist who only shares a word', () => {
    expect(bestOwnedMatch(track('The Martinez Brothers', 'Home'), [owned('The Chemical Brothers', 'Home', 'a')])).toBeNull();
    expect(bestOwnedMatch(track('DJ Snake', 'Turn Down'), [owned('DJ Koze', 'Turn Down', 'a')])).toBeNull();
  });

  it('takes the best purchase, not the first one past the bar', () => {
    const list = [owned('Mau P', 'Gimme Dat Bounce', 'a'), owned('Mau P', 'Gimme That Bounce', 'b')];
    expect(bestOwnedMatch(track('Mau P', 'Gimme That Bounce'), list)?.id).toBe('b');
  });

  it('accepts credit-list differences and still respects versions', () => {
    expect(bestOwnedMatch(track('Disclosure', 'Latch'), [owned('Disclosure, Sam Smith', 'Latch', 'a')])?.id).toBe('a');
    expect(bestOwnedMatch(track('Adam Beyer', 'Your Mind'), [owned('Adam Beyer', 'Your Mind (HNTR Remix)', 'a')])).toBeNull();
  });

  it('reads a Qobuz version back onto the title', () => {
    expect(withVersion('Your Mind', 'HNTR Remix')).toBe('Your Mind (HNTR Remix)');
    expect(withVersion('Your Mind (HNTR Remix)', 'HNTR Remix')).toBe('Your Mind (HNTR Remix)');
    expect(withVersion('Your Mind', null)).toBe('Your Mind');
  });
});

describe('Qobuz quality tiers', () => {
  it('only counts positively lossless tiers', () => {
    expect(classifyQobuzTier('Hi-Res 24-Bit 96 kHz')).toBe('hires');
    expect(classifyQobuzTier('CD Quality 16-Bit 44.1 kHz')).toBe('cd');
    expect(classifyQobuzTier('MP3 320 kbps')).toBe('lossy');
    expect(classifyQobuzTier('Standard')).toBe('unknown');
    expect(classifyQobuzTier('')).toBe('unknown');
  });

  it('never falls back to an MP3 or an unlabeled option', () => {
    const opts = [
      { text: 'MP3 320 kbps', cartLink: '/add?articleId=1' },
      { text: 'Download', cartLink: '/add?articleId=2' },
    ];
    expect(pickQobuzLosslessTier(opts)).toBeNull();
  });

  it('prefers hi-res, or CD when asked', () => {
    const opts = [
      { text: 'MP3 320 kbps', cartLink: '/a?articleId=1' },
      { text: 'CD Quality 16-Bit', cartLink: '/a?articleId=2' },
      { text: 'Hi-Res 24-Bit 192 kHz', cartLink: '/a?articleId=3' },
    ];
    expect(pickQobuzLosslessTier(opts)?.cartLink).toBe('/a?articleId=3');
    expect(pickQobuzLosslessTier(opts, 'cd')?.cartLink).toBe('/a?articleId=2');
  });
});
