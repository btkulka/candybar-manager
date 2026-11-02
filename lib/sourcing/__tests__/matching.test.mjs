// Locks the sourcing scorer's invariants. Every case here is one that actually
// went wrong against the live catalogs during development.

import { describe, it, expect } from 'vitest';
import {
  storeScore, storeScoreParts, pickStore, libraryConfidence, makeTrackKey,
  reworkMismatchPenalty, extendedMixBoost, sameTitleVersion,
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
