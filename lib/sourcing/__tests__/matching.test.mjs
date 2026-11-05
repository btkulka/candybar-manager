// Locks the sourcing scorer's invariants. Every case here is one that actually
// went wrong against the live catalogs during development.

import { describe, it, expect } from 'vitest';
import {
  storeScore, storeScoreParts, pickStore, libraryConfidence, makeTrackKey,
  reworkMismatchPenalty, extendedMixBoost, sameTitleVersion, withVersion, beatportFallback, titleVersionSignature,
  normalizeTitleForScore, normalizeForComparison,
  STORE_MATCH_FLOOR, UNCERTAIN_THRESHOLD, VERSION_MISMATCH_CAP,
} from '../matching.mjs';

const want = (artist, title) => ({ artist, title, key: makeTrackKey(artist, title) });
const score = (w, artists, title) => storeScore(w, artists, title);

describe('store matching — rejections', () => {
  it('rejects a candidate whose artist barely matches, however well the titles overlap', () => {
    const w = want('Zzzz Nonexistent Artist', 'Totally Fake Song Title 12345');
    // partial_ratio used to score these 0.62 on the artist alone.
    expect(score(w, ['Ten Years After'], 'Stonedhenge')).toBeLessThan(STORE_MATCH_FLOOR);
    expect(score(w, ['The Breeders'], 'Title Tk')).toBeLessThan(STORE_MATCH_FLOOR);
  });

  it('flags the artist floor in the breakdown so a near miss can be explained', () => {
    const parts = storeScoreParts(want('Zzzz', 'Fake'), ['Ten Years After'], 'Stonedhenge');
    expect(parts.artistFloored).toBe(true);
  });
});

describe('store matching — version discipline', () => {
  it('ranks the original above a third-party remix', () => {
    const w = want('Adam Beyer', 'Your Mind');
    expect(score(w, ['Adam Beyer'], 'Your Mind'))
      .toBeGreaterThan(score(w, ['Adam Beyer', 'HNTR'], 'Your Mind (HNTR Remix)'));
  });

  it('catches a rework whose name no keyword list would predict', () => {
    // "Charles D Epic Mix" — any name can precede "Mix".
    const w = want('Adam Beyer', 'Your Mind');
    expect(score(w, ['Adam Beyer'], 'Your Mind'))
      .toBeGreaterThan(score(w, ['Adam Beyer'], 'Your Mind (Charles D Epic Mix)'));
  });

  it('catches a remix compilation named in the title body', () => {
    const w = want('Adam Beyer', 'Your Mind');
    expect(score(w, ['Adam Beyer'], 'Your Mind'))
      .toBeGreaterThan(score(w, ['Adam Beyer'], 'Your Mind Remixes (Extended Mix)'));
  });

  it('does not penalize a version the user explicitly asked for', () => {
    expect(reworkMismatchPenalty('Reconnect - Moore Kismet Remix', 'Reconnect (Moore Kismet Remix)')).toBe(0);
    expect(reworkMismatchPenalty('Your Mind Remixes', 'Your Mind Remixes')).toBe(0);
  });

  it('prefers the extended mix when no version was requested', () => {
    expect(extendedMixBoost('Delilah', 'Delilah (Extended Mix)')).toBeGreaterThan(0);
    expect(extendedMixBoost('Delilah (Radio Edit)', 'Delilah (Extended Mix)')).toBe(0);
  });

  it('never awards the extended bonus to a rework', () => {
    const w = want('Adam Beyer', 'Your Mind');
    expect(score(w, ['Adam Beyer'], 'Your Mind Remixes (Extended Mix)')).toBeLessThan(0.95);
  });
});

describe('store matching — legitimate catalog shapes still pass', () => {
  it.each([
    ['subset artist listing', want('Fred again..', 'Delilah (pull me out of this)'), ['Delilah Montagu', 'Fred again..'], 'Delilah (pull me out of this)'],
    ['collaboration', want('Virtual Riot, Moore Kismet', 'Reconnect - Moore Kismet Remix'), ['Virtual Riot', 'Moore Kismet'], 'Reconnect (Moore Kismet Remix)'],
    ['reordered artist name', want('Beyer, Adam', 'Your Mind'), ['Adam Beyer'], 'Your Mind'],
  ])('%s', (_label, w, artists, title) => {
    expect(score(w, artists, title)).toBeGreaterThanOrEqual(0.9);
  });
});

describe('store preference', () => {
  it('gives Beatport ties and near-ties', () => {
    expect(pickStore({ score: 0.80 }, { score: 0.85 }).store).toBe('beatport');
    expect(pickStore({ score: 0.80 }, { score: 0.80 }).store).toBe('beatport');
  });

  it('lets Qobuz win only when it is clearly better', () => {
    expect(pickStore({ score: 0.70 }, { score: 0.95 }).store).toBe('qobuz');
  });

  it('falls back to Qobuz when Beatport has nothing acceptable', () => {
    expect(pickStore({ score: 0.30 }, { score: 0.82 }).store).toBe('qobuz');
    expect(pickStore(null, { score: 0.82 }).store).toBe('qobuz');
  });

  it('matches nothing when neither store clears the floor', () => {
    expect(pickStore({ score: 0.3 }, { score: 0.4 }).store).toBeNull();
  });

  it('never lets a lossy Qobuz hit push out a lossless Beatport one', () => {
    const r = pickStore({ score: 0.80, lossless: true }, { score: 0.98, lossless: false });
    expect(r.store).toBe('beatport');
    expect(r.runnerUp.score).toBe(0.98);
  });

  it('still reports a lossy hit when nothing lossless clears the floor', () => {
    expect(pickStore({ score: 0.3, lossless: true }, { score: 0.95, lossless: false }).store).toBe('qobuz');
  });
});

describe('Beatport fallback after a Qobuz cart miss', () => {
  const bp = { store: 'beatport', score: 0.8, lossless: true };

  it('buys the lossless Beatport match when Qobuz had no lossless tier or no such track', () => {
    expect(beatportFallback({ cartError: 'no lossless tier offered' }, bp)).toBe(bp);
    expect(beatportFallback({ cartError: "couldn't find \"X\" on the release" }, bp)).toBe(bp);
  });

  it('stays lossless-only and above the floor', () => {
    expect(beatportFallback({ cartError: 'x' }, { ...bp, lossless: false })).toBeNull();
    expect(beatportFallback({ cartError: 'x' }, { ...bp, lossless: undefined })).toBeNull();
    expect(beatportFallback({ cartError: 'x' }, { ...bp, score: STORE_MATCH_FLOOR - 0.01 })).toBeNull();
    expect(beatportFallback({ cartError: 'x' }, null)).toBeNull();
  });

  it('leaves a Qobuz pick that resolved alone', () => {
    expect(beatportFallback({ cartUrl: 'https://www.qobuz.com/v4/ajax/add-cart?articleId=1' }, bp)).toBeNull();
  });
});

describe('store matching — named reworks and performances', () => {
  it('does not serve a named mix or edit request with the bare original', () => {
    expect(reworkMismatchPenalty('Your Mind (Charles D Epic Mix)', 'Your Mind')).toBeGreaterThan(0);
    expect(reworkMismatchPenalty('Your Mind - Dom Dolla Edit', 'Your Mind (Original Mix)')).toBeGreaterThan(0);
    expect(reworkMismatchPenalty('Delilah (Radio Edit)', 'Delilah')).toBe(0);
  });

  it('treats a live take or acapella as a different record', () => {
    expect(reworkMismatchPenalty('Your Mind', 'Your Mind (Live)')).toBeGreaterThan(0);
    expect(reworkMismatchPenalty('Your Mind', 'Your Mind (A Cappella)')).toBeGreaterThan(0);
    expect(reworkMismatchPenalty('Live Your Life', 'Live Your Life')).toBe(0);
  });

  it('reads a remaster as the same recording', () => {
    expect(reworkMismatchPenalty('Glue', 'Glue (2023 Remaster)')).toBe(0);
  });

  it('puts a Qobuz version back on the title', () => {
    expect(withVersion('Your Mind', 'HNTR Remix')).toBe('Your Mind (HNTR Remix)');
    expect(withVersion('Your Mind (HNTR Remix)', 'HNTR Remix')).toBe('Your Mind (HNTR Remix)');
  });
});

describe('library matching', () => {
  it('treats an owned remix and its original as different records', () => {
    const w = want('Rufus Du Sol', 'Innerbloom (Ship Wrek Remix)');
    const owned = want('RUFUS DU SOL', 'Innerbloom');
    expect(libraryConfidence(w, owned)).toBeLessThanOrEqual(VERSION_MISMATCH_CAP);
    expect(libraryConfidence(w, owned)).toBeLessThan(UNCERTAIN_THRESHOLD);
  });

  it('matches the same version exactly', () => {
    const w = want('Rufus Du Sol', 'Innerbloom (Ship Wrek Remix)');
    expect(libraryConfidence(w, want('RUFUS DU SOL', 'Innerbloom (Ship Wrek Remix)'))).toBe(1);
  });

  it('treats "(Original Mix)" as the base version, not a distinct one', () => {
    expect(sameTitleVersion('Innerbloom', 'Innerbloom (Original Mix)')).toBe(true);
  });

  it('does not let a strong artist match pull in an unrelated song', () => {
    const w = want('Bicep', 'Glue');
    expect(libraryConfidence(w, want('Bicep', 'Apricots'))).toBeLessThan(0.60);
  });
});

// 2026-11-04: "Flip" wasn't a version word, so "Go Back (Shizz Lo Flip)" had
// an empty signature and scored 1.00 against the original "Go Back".
describe('store matching — flips, reworks, refixes and mashups are versions', () => {
  const flip = want('John Summit & Sub Focus', 'Go Back (Shizz Lo Flip)');

  it('gives a flip a signature, and tells two flips apart', () => {
    expect(titleVersionSignature('Go Back (Shizz Lo Flip)')).toBe('flip lo shizz');
    expect(titleVersionSignature('Go Back - Shizz Lo Flip')).toBe('flip lo shizz');
    expect(sameTitleVersion('Go Back (Shizz Lo Flip)', 'Go Back (FloZone Flip)')).toBe(false);
    expect(sameTitleVersion('Song (X Rework)', 'Song')).toBe(false);
    expect(sameTitleVersion('Song [X Refix]', 'Song [X Refix]')).toBe(true);
  });

  it('docks the original and another flip, as it does a remix', () => {
    expect(storeScoreParts(flip, ['Sub Focus', 'John Summit'], 'Go Back').penalty).toBeGreaterThan(0);
    expect(storeScoreParts(flip, ['Sub Focus', 'John Summit'], 'Go Back (Original Mix)').penalty).toBeGreaterThan(0);
    expect(storeScoreParts(flip, ['John Summit x Sub Focus'], 'Go Back (FloZone Flip)').penalty).toBeGreaterThan(0);
    expect(storeScore(flip, ['John Summit & Sub Focus'], 'Go Back (Shizz Lo Flip)')).toBe(1);
    expect(storeScoreParts(want('Sub Focus', 'Go Back'), ['Sub Focus'], 'Go Back (Shizz Lo Flip)').penalty).toBeGreaterThan(0);
  });

  it("doesn't let a shared rework credit make two songs look alike", () => {
    // "Jackpot (Shizz Lo Flip)" read 92% like "Go Back (Shizz Lo Flip)" on the credit alone.
    expect(storeScoreParts(want('Shizz Lo', 'Go Back (Shizz Lo Flip)'), ['Shizz Lo'], 'Jackpot (Shizz Lo Flip)').titleScore).toBeLessThan(0.6);
    expect(normalizeTitleForScore('Go Back (Shizz Lo Flip)')).toBe('go back');
    // The relocation/duplicate normalizer is untouched.
    expect(normalizeForComparison('Go Back (Shizz Lo Flip)')).toBe('go back shizz lo flip');
  });
});
