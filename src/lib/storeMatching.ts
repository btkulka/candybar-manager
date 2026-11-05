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
import { normalizeForComparison, normalizeLoose, normalizeTitleForScore, sameTitleVersion, titleVersionSignature } from './stringUtils';

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
// as the original. This catches that case, and the speed/pitch edits
// ("(Sped Up)", "(Slowed)", "Nightcore") that normalizeLoose keeps as plain
// title words, so their signature reads as the original too.
const BARE_REWORK_RE = /\b(remix(?:es|ed)?|bootleg|vip|rework|flip|mashup|refix|sped\s*up|slowed|nightcore)\b/i;

// A tag naming a different PERFORMANCE — "(Live)", "(Acapella)", "- Acoustic" —
// is a different record too, but none of those words are version words, so the
// signature reads them as part of the title and scores them as the original.
// They're read from the tags themselves (bracketed, or after a dash), never the
// title body, so "Live Your Life" is still just a title.
const PERFORMANCE_RE = /\b(live|acapella|a\s*cappella|acoustic|unplugged|demo|reprise|karaoke|stripped|orchestral)\b/gi;

export function performanceTags(title: string): string {
  const t = title || '';
  const tags = [...t.matchAll(/[\(\[]([^\)\]]*)[\)\]]/g)].map(m => m[1]);
  const dashed = t.split(/\s+[-–—]\s+/).slice(1).join(' ');
  if (dashed) tags.push(dashed);
  const words = new Set<string>();
  for (const tag of tags) {
    for (const m of tag.toLowerCase().matchAll(PERFORMANCE_RE)) words.add(m[1].replace(/a\s*cappella/, 'acapella'));
  }
  return [...words].sort().join(' ');
}

// A remaster is the same recording, and a year next to it says nothing about
// the version either.
const sigCore = (sig: string): string => sig.split(' ').filter(t => t && !/^(remaster(ed)?|\d{4})$/.test(t)).join(' ');

// Version tags a bare candidate may still satisfy: Qobuz results are albums,
// and a single named after the base title often carries its radio and extended
// cuts. A named mix or edit ("Charles D Epic Mix", "Dom Dolla Edit"), a dub or
// an instrumental is a different record from the bare original.
const BASE_CUT_OK_RE = /^(?:(?:extended|club|radio|original|mix|version|edit|cut|short|clean|explicit|single|album)(?:\s+|$))+$/i;

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
 *
 * The reverse holds too: asked for "Thriller (Moonlght Remix)", the original
 * "Thriller" is a different record. A bare candidate still gets the benefit of
 * the doubt for a radio/extended/club request, since Qobuz results are albums
 * and a single named after the base title often carries those cuts.
 */
export function reworkMismatchPenalty(inputTitle: string, candidateTitle: string): number {
  const wantSig = sigCore(titleVersionSignature(inputTitle || ''));
  const candSig = sigCore(titleVersionSignature(candidateTitle || ''));

  if (BARE_REWORK_RE.test(normalizeLoose(candidateTitle || ''))
      && !BARE_REWORK_RE.test(normalizeLoose(inputTitle || ''))) {
    return 0.12;
  }
  if (performanceTags(inputTitle) !== performanceTags(candidateTitle)) return 0.12;

  if (candSig === wantSig) return 0;                                  // same version (or both bare)
  if (!candSig) return BASE_CUT_OK_RE.test(wantSig) ? 0 : 0.12;       // base cut: only for a radio/extended ask
  if (!wantSig && EXTENDED_ONLY_RE.test(candSig)) return 0;            // extended/club variant
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
  const trackTitle = normalizeTitleForScore(track.title);
  const otherArtists = (Array.isArray(candidateArtists) ? candidateArtists : [candidateArtists])
    .map(a => normalizeForComparison(a)).join(' ');
  const otherTitle = normalizeTitleForScore(candidateTitle);

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
 * Deliberately stricter than reworkMismatchPenalty, which still forgives a
 * candidate with no version tag when a radio/extended cut was asked for.
 * Ownership has to hold in both directions.
 */
export function ownedVersionSatisfies(wantTitle: string, ownedTitle: string): boolean {
  // An owned live take or acapella isn't the studio record, whatever the signature says.
  if (performanceTags(wantTitle) !== performanceTags(ownedTitle)) return false;
  if (sameTitleVersion(wantTitle || '', ownedTitle || '')) return true;
  const wantSig = titleVersionSignature(wantTitle || '');
  const ownedSig = titleVersionSignature(ownedTitle || '');
  return !wantSig && EXTENDED_ONLY_RE.test(ownedSig);
}

// ---------- store choice ----------

export type StoreCandidate = { score: number; lossless: boolean };

/**
 * Which store a track should come from. Lossy candidates are set aside first:
 * a 95% lossy Qobuz hit must not push out an 80% lossless Beatport one, or the
 * track ends up "excluded: lossy" with a buyable copy thrown away. Only when no
 * lossless candidate clears the floor does a lossy one come back, so the UI can
 * show it as found-but-excluded. Between two of the same kind, the higher score
 * wins and Beatport takes exact ties (its WAV needs no conversion).
 */
export function chooseStore(
  qobuz: StoreCandidate | null,
  beatport: StoreCandidate | null
): 'qobuz' | 'beatport' | null {
  const ok = (c: StoreCandidate | null): c is StoreCandidate => !!c && c.score >= STORE_MATCH_FLOOR;
  const pick = (q: StoreCandidate | null, b: StoreCandidate | null) => {
    if (ok(b) && (!ok(q) || b.score >= q.score)) return 'beatport' as const;
    return ok(q) ? 'qobuz' as const : null;
  };
  return pick(qobuz?.lossless ? qobuz : null, beatport?.lossless ? beatport : null) ?? pick(qobuz, beatport);
}

// ---------- release → track ----------

/** Within one release every track shares the artist, which is 40% of the
 *  score — so the title has to clear its own bar, or a different song on the
 *  same EP passes the store floor on the artist alone. */
export const RELEASE_TITLE_FLOOR = 0.75;

/**
 * The track on a release that is the record asked for, or null when none
 * clears the store floor. Scored against the REQUEST, never the release title:
 * on an EP called "Your Mind", the release title picks the original for a
 * remix request. Never defaults to the first track. On equal scores the
 * extended-mix bonus decides, so an unversioned request lands on the club cut.
 */
export function pickReleaseTrack<T extends { id: string; title: string; artist: string }>(
  want: { artist: string; title: string },
  tracks: T[],
  releaseArtists: string[] = []
): { track: T; parts: StoreScoreParts } | null {
  let best: { track: T; parts: StoreScoreParts } | null = null;
  for (const t of tracks) {
    if (!t.title) continue;
    const parts = storeScoreParts(want, t.artist ? [t.artist] : releaseArtists, t.title);
    if (!best || parts.score > best.parts.score
        || (parts.score === best.parts.score && parts.boost > best.parts.boost)) {
      best = { track: t, parts };
    }
  }
  return best && best.parts.score >= STORE_MATCH_FLOOR && best.parts.titleScore >= RELEASE_TITLE_FLOOR ? best : null;
}

// ---------- ownership against purchase history ----------

/** Title and artist must each clear these before a purchase counts as the
 *  wanted record. Purchase lists are full of same-artist singles and of
 *  same-titled records by other artists; a blended score let "Gimme Some"
 *  stand in for "Gimme That Bounce" and "Chemical Brothers" for "Martinez
 *  Brothers". */
export const OWNED_TITLE_FLOOR = 0.85;
export const OWNED_ARTIST_FLOOR = 0.80;

/** The best purchase that is the same record as `track`, or null. Scans every
 *  candidate: the first one past the bar is not necessarily the right one. */
export function bestOwnedMatch<T extends { artist: string; title: string }>(
  track: { artist: string; title: string },
  owned: T[]
): T | null {
  const trackArtist = normalizeForComparison(track.artist);
  const trackTitle = normalizeTitleForScore(track.title);
  let best: T | null = null;
  let bestScore = 0;
  for (const o of owned) {
    if (!ownedVersionSatisfies(track.title, o.title)) continue;
    const oTitle = normalizeTitleForScore(o.title);
    const oArtist = normalizeForComparison(o.artist);
    const titleScore = Math.max(fuzzball.ratio(trackTitle, oTitle), fuzzball.token_set_ratio(trackTitle, oTitle)) / 100;
    if (titleScore < OWNED_TITLE_FLOOR) continue;
    const artistScore = Math.max(fuzzball.ratio(trackArtist, oArtist), fuzzball.token_set_ratio(trackArtist, oArtist)) / 100;
    if (artistScore < OWNED_ARTIST_FLOOR) continue;
    const combined = titleScore * 0.6 + artistScore * 0.4;
    if (combined > bestScore) { bestScore = combined; best = o; }
  }
  return best;
}

/** "Your Mind" + version "HNTR Remix" → "Your Mind (HNTR Remix)". Qobuz keeps
 *  the version apart from the title; dropping it makes a purchased remix read as
 *  the original. */
export function withVersion(title: string, version?: string | null): string {
  const v = (version || '').trim();
  if (!v || (title || '').toLowerCase().includes(v.toLowerCase())) return title || '';
  return `${title} (${v})`;
}

// ---------- Qobuz quality tiers ----------

export type QobuzTierKind = 'hires' | 'cd' | 'lossy' | 'unknown';

/** What a Qobuz add-to-cart option sells, from its label/text/attributes. Only
 *  a positive hi-res or CD/FLAC reading counts as lossless; anything the text
 *  doesn't name is 'unknown', and unknown never goes in a cart. */
export function classifyQobuzTier(text: string): QobuzTierKind {
  const t = (text || '').toLowerCase();
  const mp3 = /\bmp3\b|\baac\b|\b(320|256|192|128)\s*k(bps)?\b|lossy/.test(t);
  if (/hi[\s-]?res|hires|hi-resolution|24[\s-]?bit|studio master/.test(t)) return mp3 ? 'unknown' : 'hires';
  if (/cd[\s-]?quality|\bcd\b|16[\s-]?bit|lossless|\bflac\b/.test(t)) return mp3 ? 'unknown' : 'cd';
  return mp3 ? 'lossy' : 'unknown';
}

export type QobuzTierOption = { text: string; cartLink: string; price?: string; articleId?: string };

/** The best positively-lossless option (hi-res over CD), or null when none is.
 *  There is deliberately no fallback to the store's own ordering: Qobuz often
 *  ranks MP3 first. */
export function pickQobuzLosslessTier<T extends QobuzTierOption>(
  options: T[],
  prefer: 'hires' | 'cd' = 'hires'
): (T & { kind: 'hires' | 'cd' }) | null {
  const lossless = options
    .map(o => ({ ...o, kind: classifyQobuzTier(o.text) }))
    .filter((o): o is T & { kind: 'hires' | 'cd' } => (o.kind === 'hires' || o.kind === 'cd') && !!o.cartLink);
  if (lossless.length === 0) return null;
  const want = lossless.find(o => o.kind === prefer);
  return want ?? lossless[0];
}
