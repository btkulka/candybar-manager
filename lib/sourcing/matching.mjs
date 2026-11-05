// Fuzzy matching for playlist sourcing.
//
// This is a faithful port of the desktop app's scoring so the skill and the
// Sources tab can never bucket the same playlist differently:
//   - library scoring   ← src/lib/musicLibraryCheck.ts
//   - normalization     ← src/lib/stringUtils.ts
//   - store scoring     ← src/lib/qobuzCart.ts
//
// The ONE deliberate divergence is STORE PREFERENCE (see pickStore): the app
// only gives Beatport exact ties, this gives Beatport precedence, because
// Beatport's WAV is RX3-native and needs no conversion.

import { createRequire } from 'module';

// fuzzball ships CJS with named-only ESM interop; createRequire gets the whole
// module object regardless of how the package's exports map is written.
const fuzzball = createRequire(import.meta.url)('fuzzball');

// ---------- thresholds (identical to the app) ----------
export const MATCH_THRESHOLD = 0.60;       // below this = not in library
export const UNCERTAIN_THRESHOLD = 0.90;   // at/above = confirmed in library
export const VERSION_MISMATCH_CAP = UNCERTAIN_THRESHOLD - 0.01; // 0.89
export const TITLE_MATCH_FLOOR = 0.40;
export const STORE_MATCH_FLOOR = 0.50;     // below this a store hit isn't a match
/** A store hit whose ARTIST barely matches is a different record no matter how
 *  well the titles align — store catalogs are full of short, common titles, so
 *  without this "Totally Fake Song Title 12345" happily matches "Title Tk" by
 *  The Breeders on title overlap alone. */
export const STORE_ARTIST_FLOOR = 0.45;

/** How much better Qobuz must score before it beats Beatport. Beatport wins
 *  ties AND near-ties: its WAV drops straight onto the XDJ with no ffmpeg step,
 *  so an equally-good Beatport match is the better buy. */
export const BEATPORT_PRECEDENCE_MARGIN = 0.10;

// ---------- normalization ----------
const DIACRITICS = /[̀-ͯ]/g;
const VERSION_WORDS = 'feat|ft|featuring|remix|edit|mix|version|original|extended|radio|club|instrumental|dub|vip|bootleg|remaster';
// Reworks named like a remix: "(Shizz Lo Flip)", "(X Rework)", "[Y Refix]",
// "- Z Mashup". Only the version signature reads these as a version (via
// normalizeLoose); normalizeForComparison keeps them as title words, because
// duplicate checks and file relocation lean on it and don't all look at the
// version. Without them a flip's signature was empty, so "Go Back (Shizz Lo
// Flip)" scored 1.00 against the original "Go Back" (2026-11-04).
const LOOSE_VERSION_WORDS = `${VERSION_WORDS}|flip|rework|refix|mashup`;

export function normalizeForComparison(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(DIACRITICS, '')
    .replace(new RegExp(`\\s*[\\(\\[].*(${VERSION_WORDS}).*[\\)\\]]`, 'gi'), '')
    .replace(/\b(feat\.?|ft\.?|featuring)\b.*?(?=\s*[-–—]|$)/gi, '')
    .replace(/&/g, 'and')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Rework tags normalizeForComparison leaves in: "(Shizz Lo Flip)", "- X Refix". */
const REWORK_TAG_BRACKET_RE = /\s*[\(\[][^\)\]]*\b(flip|rework|refix|mashup)\b[^\)\]]*[\)\]]/gi;
const REWORK_TAG_DASH_RE = /\s+[-–—]\s+.*\b(flip|rework|refix|mashup)\b.*$/gi;

/** normalizeForComparison with rework tags off too, for scoring a title
 *  against a store or free copy. The version signature judges the rework;
 *  left in, the shared credit read "Jackpot (Shizz Lo Flip)" 92% like "Go
 *  Back (Shizz Lo Flip)". Not for relocation or duplicate checks. */
export function normalizeTitleForScore(str) {
  return normalizeForComparison((str || '').replace(REWORK_TAG_BRACKET_RE, '').replace(REWORK_TAG_DASH_RE, ''));
}

export function normalizeBasic(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(DIACRITICS, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeLoose(str) {
  if (!str) return '';
  return str
    .normalize('NFKD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(new RegExp(`\\s*[\\(\\[].*(${LOOSE_VERSION_WORDS}).*[\\)\\]]`, 'gi'), '')
    .replace(new RegExp(`\\s+[-–—]\\s+.*\\b(${LOOSE_VERSION_WORDS})\\b.*$`, 'gi'), '')
    .replace(/\b(feat\.?|ft\.?|featuring)\b.*?(?=\s*[-–—]|$)/gi, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeTitleKeepVersion(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFKD')
    .replace(DIACRITICS, '')
    .replace(/\s*[\(\[][^)\]]*\b(feat|ft|featuring)\b[^)\]]*[\)\]]/gi, '')
    .replace(/\b(feat\.?|ft\.?|featuring)\b.*?(?=\s*[-–—\(\[]|$)/gi, '')
    .replace(/[\(\[]\s*original(\s+(mix|version|edit))?\s*[\)\]]/gi, ' ')
    .replace(/\boriginal(\s+(mix|version))\b/gi, ' ')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Descriptor tokens that make one version distinct from another. A bare title
 *  and its "(Original Mix)" both yield "" — a remix/extended/radio cut doesn't. */
export function titleVersionSignature(title) {
  if (!title) return '';
  const base = new Set(normalizeLoose(title).split(' ').filter(Boolean));
  return normalizeTitleKeepVersion(title)
    .split(' ')
    .filter(t => t && !base.has(t))
    .sort()
    .join(' ');
}

export function sameTitleVersion(a, b) {
  return titleVersionSignature(a) === titleVersionSignature(b);
}

export function makeTrackKey(artist, title) {
  return `${normalizeBasic(artist)} - ${normalizeBasic(title)}`;
}

export function buildNormalizedKey(artist, title) {
  const a = normalizeForComparison(artist);
  const t = normalizeForComparison(title);
  if (a && t) return `${a} - ${t}`;
  return a || t;
}

// ---------- library scoring ----------
//
// ratio + token_sort_ratio only. partial_ratio and token_set_ratio both score
// 100 when one string's tokens are a subset of the other's, which collapses
// "Home" onto "Home (Nobody Is Not Loved)".
function fieldSimilarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  return Math.max(fuzzball.ratio(a, b), fuzzball.token_sort_ratio(a, b)) / 100;
}

export function libraryConfidence(want, have) {
  if (want.key && want.key === have.key) return 1;

  const artistSim = fieldSimilarity(want.artist.toLowerCase(), have.artist.toLowerCase());
  const titleSim = fieldSimilarity(want.title.toLowerCase(), have.title.toLowerCase());
  const rawScore = artistSim * 0.6 + titleSim * 0.4;

  const wantArtistNorm = normalizeForComparison(want.artist);
  const haveArtistNorm = normalizeForComparison(have.artist);
  const wantTitleNorm = normalizeForComparison(want.title);
  const haveTitleNorm = normalizeForComparison(have.title);

  const normArtistSim = fieldSimilarity(wantArtistNorm, haveArtistNorm);
  const normTitleSim = fieldSimilarity(wantTitleNorm, haveTitleNorm);
  const normScore = normArtistSim * 0.6 + normTitleSim * 0.4;

  let bonus = 0;
  if (wantArtistNorm === haveArtistNorm && wantArtistNorm.length > 0) bonus += 0.1;
  if (wantTitleNorm === haveTitleNorm && wantTitleNorm.length > 0) bonus += 0.15;

  let confidence = Math.min(1, Math.max(rawScore, normScore) + bonus);

  // Unrelated titles can't ride a strong artist match into "maybe owned".
  if (Math.max(titleSim, normTitleSim) < TITLE_MATCH_FLOOR) {
    confidence = Math.min(confidence, MATCH_THRESHOLD - 0.01);
  }

  // Same song, different version = a different track a DJ still needs to buy.
  if (!sameTitleVersion(want.title, have.title)) {
    confidence = Math.min(confidence, VERSION_MISMATCH_CAP);
  }
  return confidence;
}

/** Best library candidates for a wanted track. `index` is the output of
 *  buildLibraryIndex(). Returns up to `count` candidates, best first. */
export function findLibraryMatches(want, index, count = 5) {
  const exact = index.byKey.get(want.key);
  if (exact) return [{ track: exact, confidence: 1 }];

  const normKey = buildNormalizedKey(want.artist, want.title);
  const normMatch = index.byNormKey.get(normKey);
  if (normMatch && sameTitleVersion(want.title, normMatch.title)) {
    return [{ track: normMatch, confidence: 0.98 }];
  }

  const candidates = [];
  for (const have of index.tracks) {
    const confidence = libraryConfidence(want, have);
    if (candidates.length < count) {
      candidates.push({ track: have, confidence });
      if (candidates.length === count) candidates.sort((a, b) => b.confidence - a.confidence);
    } else if (confidence > candidates[count - 1].confidence) {
      candidates[count - 1] = { track: have, confidence };
      candidates.sort((a, b) => b.confidence - a.confidence);
    }
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates;
}

export function buildLibraryIndex(tracks) {
  const byKey = new Map();
  const byNormKey = new Map();
  for (const t of tracks) {
    t.key = t.key || makeTrackKey(t.artist, t.title);
    if (!byKey.has(t.key)) byKey.set(t.key, t);
    const nk = buildNormalizedKey(t.artist, t.title);
    if (!byNormKey.has(nk)) byNormKey.set(nk, t);
  }
  return { tracks, byKey, byNormKey };
}

// ---------- store scoring ----------
//
// Note the weights are FLIPPED relative to library matching: title 0.6 /
// artist 0.4. Store catalogs list collaborators and remixers inconsistently,
// so the title carries more signal there than it does against your own tags.
const EXTENDED_MIX_RE = /\b(extended|club)\s*(mix|version|edit|remix)?\b/i;
const EXPLICIT_NON_EXTENDED_RE = /\b(radio|short|clean|single|album|instrumental|dub|acapella|a\s*cappella|intro|outro)\s*(edit|mix|version|cut)?\b/i;

/** DJ workflow: absent an explicit version in the wanted title, nudge toward
 *  the Extended/Club mix over the radio edit. */
export function extendedMixBoost(wantTitle, candidateTitle) {
  if (!EXTENDED_MIX_RE.test(candidateTitle || '')) return 0;
  if (EXPLICIT_NON_EXTENDED_RE.test(wantTitle || '')) return 0;
  if (EXTENDED_MIX_RE.test(wantTitle || '')) return 0;
  return 0.08;
}

/** A rework by someone else is a DIFFERENT record from the one asked for.
 *  Store catalogs list every version alongside the original and the
 *  subset-tolerant ratios score them identically, so without this a request for
 *  "Your Mind" returns "Your Mind (HNTR Remix)" — or "Your Mind (Charles D Epic
 *  Mix)", which no keyword list would catch, since any name can precede "Mix".
 *
 *  So compare version SIGNATURES instead of hunting for keywords: if the
 *  candidate carries version descriptors the request didn't ask for, it's a
 *  different record. Extended/club markers are exempt — same recording, longer
 *  arrangement — and extendedMixBoost rewards those separately.
 *
 *  The reverse holds too: asked for "Thriller (Moonlght Remix)", the original
 *  "Thriller" is a different record. A bare candidate still gets the benefit of
 *  the doubt for a radio/extended/club request, since Qobuz results are albums
 *  and a single named after the base title often carries those cuts. */
const EXTENDED_ONLY_RE = /^(extended|club|mix|version|edit)(\s+(extended|club|mix|version|edit))*$/i;

// Signatures only see version tags in brackets or after a dash. A remix
// COMPILATION states it in the title body — "Your Mind Remixes" — where
// normalizeLoose folds it into the base and token_set_ratio then reads it as
// the original. This catches that case, and the speed/pitch edits
// ("(Sped Up)", "(Slowed)", "Nightcore") that normalizeLoose keeps as plain
// title words, so their signature reads as the original too.
const BARE_REWORK_RE = /\b(remix(?:es|ed)?|bootleg|vip|rework|flip|mashup|refix|sped\s*up|slowed|nightcore)\b/i;

// A tag naming a different PERFORMANCE — "(Live)", "(Acapella)", "- Acoustic" —
// is a different record too, but none of those words are version words, so the
// signature reads them as part of the title. Read from the tags themselves
// (bracketed, or after a dash), never the title body: "Live Your Life" is a title.
const PERFORMANCE_RE = /\b(live|acapella|a\s*cappella|acoustic|unplugged|demo|reprise|karaoke|stripped|orchestral)\b/gi;

export function performanceTags(title) {
  const t = title || '';
  const tags = [...t.matchAll(/[\(\[]([^\)\]]*)[\)\]]/g)].map(m => m[1]);
  const dashed = t.split(/\s+[-–—]\s+/).slice(1).join(' ');
  if (dashed) tags.push(dashed);
  const words = new Set();
  for (const tag of tags) {
    for (const m of tag.toLowerCase().matchAll(PERFORMANCE_RE)) words.add(m[1].replace(/a\s*cappella/, 'acapella'));
  }
  return [...words].sort().join(' ');
}

// A remaster is the same recording; a year beside it says nothing about the version.
const sigCore = sig => sig.split(' ').filter(t => t && !/^(remaster(ed)?|\d{4})$/.test(t)).join(' ');

// Version tags a bare candidate may still satisfy (Qobuz albums named after the
// base title often carry the radio/extended cuts). A named mix or edit, a dub
// or an instrumental is a different record from the bare original.
const BASE_CUT_OK_RE = /^(?:(?:extended|club|radio|original|mix|version|edit|cut|short|clean|explicit|single|album)(?:\s+|$))+$/i;

export function reworkMismatchPenalty(wantTitle, candidateTitle) {
  const wantSig = sigCore(titleVersionSignature(wantTitle || ''));
  const candSig = sigCore(titleVersionSignature(candidateTitle || ''));

  if (BARE_REWORK_RE.test(normalizeLoose(candidateTitle || ''))
      && !BARE_REWORK_RE.test(normalizeLoose(wantTitle || ''))) {
    return 0.12;
  }
  if (performanceTags(wantTitle) !== performanceTags(candidateTitle)) return 0.12;

  if (candSig === wantSig) return 0;   // same version (including both bare)
  if (!candSig) return BASE_CUT_OK_RE.test(wantSig) ? 0 : 0.12; // base cut: only for a radio/extended ask
  if (!wantSig && EXTENDED_ONLY_RE.test(candSig)) return 0; // extended/club
  return 0.12;
}

/** Full breakdown of a store match, so a weak one can be explained rather than
 *  just rejected. `score` is what pickStore compares. */
export function storeScoreParts(want, candidateArtists, candidateTitle) {
  const wantArtist = normalizeForComparison(want.artist);
  const wantTitle = normalizeTitleForScore(want.title);
  const otherArtists = (Array.isArray(candidateArtists) ? candidateArtists : [candidateArtists])
    .map(a => normalizeForComparison(a)).join(' ');
  const otherTitle = normalizeTitleForScore(candidateTitle);

  // ratio + token_set_ratio only. The app also takes partial_ratio here, but
  // that slides the shorter string across the longer and rewards incidental
  // letter overlap: it scored "zzzz nonexistent artist" against "ten years
  // after" at 0.62, which is enough to buy a stranger's record. token_set_ratio
  // already covers what partial_ratio was there for — subset artists
  // ("Fred again.." inside "Delilah Montagu, Fred again..") and reordered names
  // both still score 100 without it.
  const artistScore = Math.max(
    fuzzball.ratio(wantArtist, otherArtists),
    fuzzball.token_set_ratio(wantArtist, otherArtists)
  ) / 100;

  const titleScore = Math.max(
    fuzzball.ratio(wantTitle, otherTitle),
    fuzzball.token_set_ratio(wantTitle, otherTitle)
  ) / 100;

  const base = titleScore * 0.6 + artistScore * 0.4;
  const penalty = reworkMismatchPenalty(want.title, candidateTitle);
  // A rework never earns the extended-mix bonus — "Your Mind Remixes (Extended
  // Mix)" would otherwise claw back most of its penalty.
  const boost = penalty > 0 ? 0 : extendedMixBoost(want.title, candidateTitle);
  let score = Math.max(0, Math.min(1, base + boost - penalty));

  // Artist floor: hold it below the match floor rather than zeroing it, so the
  // near-miss is still visible when explaining why nothing matched.
  const artistFloored = artistScore < STORE_ARTIST_FLOOR;
  if (artistFloored) score = Math.min(score, STORE_MATCH_FLOOR - 0.01);

  return { score, artistScore, titleScore, boost, penalty, artistFloored };
}

export function storeScore(want, candidateArtists, candidateTitle) {
  return storeScoreParts(want, candidateArtists, candidateTitle).score;
}

/** Pick the winning store for one track.
 *
 *  Beatport takes precedence: it wins unless Qobuz beats it by more than
 *  BEATPORT_PRECEDENCE_MARGIN. Qobuz only carries the track when Beatport has
 *  no acceptable match at all, or when its match is clearly better.
 *
 *  Lossy candidates (`lossless === false`) are set aside first, so a 95% lossy
 *  Qobuz hit can't push out an 80% lossless Beatport one. A lossy pick comes
 *  back only when nothing lossless clears the floor — it is then flagged, never
 *  bought. */
function pickBetween(beatport, qobuz) {
  const bpOk = beatport && beatport.score >= STORE_MATCH_FLOOR;
  const qbOk = qobuz && qobuz.score >= STORE_MATCH_FLOOR;

  if (bpOk && qbOk) {
    return qobuz.score - beatport.score > BEATPORT_PRECEDENCE_MARGIN
      ? { store: 'qobuz', pick: qobuz, runnerUp: beatport }
      : { store: 'beatport', pick: beatport, runnerUp: qobuz };
  }
  if (bpOk) return { store: 'beatport', pick: beatport, runnerUp: qobuz || null };
  if (qbOk) return { store: 'qobuz', pick: qobuz, runnerUp: beatport || null };
  return { store: null, pick: null, runnerUp: null };
}

export function pickStore(beatport, qobuz) {
  const lossless = c => (c && c.lossless !== false ? c : null);
  const clean = pickBetween(lossless(beatport), lossless(qobuz));
  if (clean.store) {
    // Keep the set-aside candidate visible as the runner-up.
    const other = clean.store === 'beatport' ? qobuz : beatport;
    return { ...clean, runnerUp: clean.runnerUp || other || null };
  }
  return pickBetween(beatport, qobuz);
}

/** What to buy when the Qobuz pick fell through at cart resolution — the
 *  release had no lossless tier for the track, or the track wasn't on it
 *  (`cartError`). The Beatport candidate, but only a positively lossless one
 *  that clears the floor; otherwise null and the row stays flagged. Mirrors the
 *  app's search, where an unresolved Qobuz release loses to Beatport. */
export function beatportFallback(resolvedQobuz, beatport) {
  if (!resolvedQobuz?.cartError) return null;
  if (!beatport || beatport.lossless !== true || !(beatport.score >= STORE_MATCH_FLOOR)) return null;
  return beatport;
}

/** "Your Mind" + Qobuz version "HNTR Remix" → "Your Mind (HNTR Remix)". Qobuz
 *  keeps the version apart from the title; dropping it reads a remix as the original. */
export function withVersion(title, version) {
  const v = (version || '').trim();
  if (!v || (title || '').toLowerCase().includes(v.toLowerCase())) return title || '';
  return `${title} (${v})`;
}
