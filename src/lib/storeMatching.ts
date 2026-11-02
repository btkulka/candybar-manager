/**
 * Store match scoring — one definition, used by every store search.
 *
 * Previously this logic was duplicated in qobuzCart.ts and storePurchase.ts and
 * had already drifted (only one of them applied the extended-mix boost). It is
 * kept in sync with the sourcing skill's engine at `lib/sourcing/matching.mjs`;
 * change both together.
 *
 * Note the weights are FLIPPED relative to library matching (musicLibraryCheck):
 * title 0.6 / artist 0.4. Store catalogs credit collaborators and remixers
 * inconsistently, so the title carries more signal against a store than it does
 * against your own tags.
 */

import * as fuzzball from 'fuzzball';
import { normalizeForComparison, normalizeLoose, sameTitleVersion, titleVersionSignature } from './stringUtils';

/** Below this a store hit isn't a match at all. */
export const STORE_MATCH_FLOOR = 0.50;

/** A store hit whose ARTIST barely matches is a different record no matter how
 *  well the titles align. Store catalogs are full of short, common titles, so
 *  without this "Totally Fake Song Title 12345" matches "Title Tk" by The
 *  Breeders on title overlap alone. */
export const STORE_ARTIST_FLOOR = 0.45;

const EXTENDED_MIX_RE = /\b(extended|club)\s*(mix|version|edit|remix)?\b/i;
const EXPLICIT_NON_EXTENDED_RE = /\b(radio|short|clean|single|album|instrumental|dub|acapella|a\s*cappella|intro|outro)\s*(edit|mix|version|cut)?\b/i;

/** DJ workflow: when the input title doesn't specify a version, prefer the
 *  Extended/Club Mix over the radio edit. A small additive bonus that nudges
 *  ordering without overriding a significantly better base match. */
export function extendedMixBoost(inputTitle: string, candidateTitle: string): number {
  if (!EXTENDED_MIX_RE.test(candidateTitle || '')) return 0;
  // Asked for a radio edit (or another explicit non-extended cut)? Don't reward extended.
  if (EXPLICIT_NON_EXTENDED_RE.test(inputTitle || '')) return 0;
  // Asked for the extended mix explicitly? The base score already covers it.
  if (EXTENDED_MIX_RE.test(inputTitle || '')) return 0;
  return 0.08;
}

const EXTENDED_ONLY_RE = /^(extended|club|mix|version|edit)(\s+(extended|club|mix|version|edit))*$/i;

// Version signatures only see tags in brackets or after a dash. A remix
// COMPILATION states it in the title body — "Your Mind Remixes" — where
// normalizeLoose folds it into the base title and token_set_ratio then reads it
// as the original. This catches that case.
const BARE_REWORK_RE = /\b(remix(?:es|ed)?|bootleg|vip|rework|flip|mashup|refix)\b/i;

/**
 * A rework by someone else is a DIFFERENT record from the one asked for. Store
 * catalogs list every version alongside the original and the subset-tolerant
 * ratios score them identically, so without this a request for "Your Mind"
 * returns "Your Mind (HNTR Remix)" — or "Your Mind (Charles D Epic Mix)", which
 * no keyword list would catch, since any name can precede "Mix".
 *
 * So compare version SIGNATURES rather than hunting for keywords. Extended/club
 * markers are exempt — same recording, longer arrangement — and
 * extendedMixBoost rewards those separately.
 */
export function reworkMismatchPenalty(inputTitle: string, candidateTitle: string): number {
  const wantSig = titleVersionSignature(inputTitle || '');
  const candSig = titleVersionSignature(candidateTitle || '');

  if (BARE_REWORK_RE.test(normalizeLoose(candidateTitle || ''))
      && !BARE_REWORK_RE.test(normalizeLoose(inputTitle || ''))) {
    return 0.12;
  }

  if (candSig === wantSig) return 0;                          // same version (or both bare)
  if (!candSig) return 0;                                     // candidate is the base cut
  if (!wantSig && EXTENDED_ONLY_RE.test(candSig)) return 0;    // extended/club variant
  return 0.12;
}

export type StoreScoreParts = {
  score: number;
  artistScore: number;
  titleScore: number;
  boost: number;
  penalty: number;
  artistFloored: boolean;
};

/** Full breakdown of a store match, so a weak one can be explained rather than
 *  just rejected. `score` is the value callers compare. */
export function storeScoreParts(
  track: { artist: string; title: string },
  candidateArtists: string | string[],
  candidateTitle: string
): StoreScoreParts {
  const trackArtist = normalizeForComparison(track.artist);
  const trackTitle = normalizeForComparison(track.title);
  const otherArtists = (Array.isArray(candidateArtists) ? candidateArtists : [candidateArtists])
    .map(a => normalizeForComparison(a)).join(' ');
  const otherTitle = normalizeForComparison(candidateTitle);

  // ratio + token_set_ratio only. partial_ratio slides the shorter string across
  // the longer and rewards incidental letter overlap: it scored "zzzz
  // nonexistent artist" against "ten years after" at 0.62, enough to put a
  // stranger's record in the cart. token_set_ratio already covers what it was
  // there for — subset artists ("Fred again.." inside "Delilah Montagu, Fred
  // again..") and reordered names both still score 100 without it.
  const artistScore = Math.max(
    fuzzball.ratio(trackArtist, otherArtists),
    fuzzball.token_set_ratio(trackArtist, otherArtists)
  ) / 100;

  const titleScore = Math.max(
    fuzzball.ratio(trackTitle, otherTitle),
    fuzzball.token_set_ratio(trackTitle, otherTitle)
  ) / 100;

  const base = titleScore * 0.6 + artistScore * 0.4;
  const penalty = reworkMismatchPenalty(track.title, candidateTitle);
  // A rework never earns the extended-mix bonus, or "Your Mind Remixes
  // (Extended Mix)" claws back most of its penalty.
  const boost = penalty > 0 ? 0 : extendedMixBoost(track.title, candidateTitle);

  // Cap at 1 so UI percentages don't show 108% for extended-mix winners.
  let score = Math.max(0, Math.min(1, base + boost - penalty));

  // Artist floor: hold it just below the match floor rather than zeroing it, so
  // the near miss stays visible when explaining why nothing matched.
  const artistFloored = artistScore < STORE_ARTIST_FLOOR;
  if (artistFloored) score = Math.min(score, STORE_MATCH_FLOOR - 0.01);

  return { score, artistScore, titleScore, boost, penalty, artistFloored };
}

export function storeScore(
  track: { artist: string; title: string },
  candidateArtists: string | string[],
  candidateTitle: string
): number {
  return storeScoreParts(track, candidateArtists, candidateTitle).score;
}

/**
 * True when a recording you already own satisfies a request for `wantTitle`.
 *
 * The same version always does. An owned Extended/Club variant also satisfies
 * an unversioned request — that IS the record a DJ wanted. Anything else is a
 * different record: owning "Your Mind" does not mean you own "Your Mind (HNTR
 * Remix)", and treating it as though you do is expensive, because a track
 * judged already-owned never reaches the store search at all.
 *
 * Deliberately stricter than reworkMismatchPenalty, which forgives a candidate
 * with no version tag. Ownership has to hold in both directions.
 */
export function ownedVersionSatisfies(wantTitle: string, ownedTitle: string): boolean {
  if (sameTitleVersion(wantTitle || '', ownedTitle || '')) return true;
  const wantSig = titleVersionSignature(wantTitle || '');
  const ownedSig = titleVersionSignature(ownedTitle || '');
  return !wantSig && EXTENDED_ONLY_RE.test(ownedSig);
}
