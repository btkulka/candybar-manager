/**
 * Batch store search for the Sources and Upgrades tabs: Qobuz and Beatport
 * side by side, one winning store per track.
 *
 * Qobuz search answers with releases, so a winning Qobuz hit is pinned to the
 * one track on that release that is the record asked for, and to its best
 * positively-lossless tier, before it's trusted. Cart adds happen in
 * storePurchase.ts from the user's own signed-in session.
 */

import { searchQobuzTracks, getQobuzReleaseTracks, getQobuzLosslessTier, QobuzTrack } from './qobuz';
import { searchBeatportTracks, BeatportTrack } from './beatport';
import { createScopedLogger } from './logger';
import { getErrorMessage } from './errorUtils';
import {
  storeScoreParts, chooseStore, pickReleaseTrack, STORE_MATCH_FLOOR,
  type StoreScoreParts, type StoreCandidate,
} from './storeMatching';

const log = createScopedLogger('QobuzCart');

// ========== Types ==========

export type QobuzCartTrackInput = {
  key: string;
  artist: string;
  title: string;
  album?: string;
  duration?: number;
};

export type QobuzCartMatch = {
  trackInput: QobuzCartTrackInput;
  qobuzTrack: QobuzTrack | null;
  beatportTrack: BeatportTrack | null;
  confidence: number;
  /** Breakdown behind `confidence` (artist/title similarity, extended-mix
   *  boost, rework penalty, whether the artist floor fired). Lets the UI say
   *  WHY a confident-looking match may still be the wrong record. */
  scoreParts?: import('./storeMatching').StoreScoreParts;
  source: 'qobuz' | 'beatport' | null;
  /** True iff we're confident the store offers a lossless version of this
   *  specific track. The user's library is DJ-grade; lossy matches must be
   *  flagged in the UI and excluded from cart-add. */
  lossless: boolean;
  status: 'matched' | 'no_match' | 'error';
  error?: string;
  /** True when a track with this artist+title already exists in the user's
   *  local music library (per the most recent cached Check scan). The UI uses
   *  this to skip auto-select and surface an "IN LIBRARY" badge so we don't
   *  nudge the user to re-buy what they already own on disk.
   *
   *  @deprecated Prefer `libraryStatus === 'confirmed'`. Kept for one release
   *  while renderer code transitions. */
  inLibrary?: boolean;
  /** Result of the library-match pre-pass. `confirmed` = high-confidence local
   *  file (≥0.90 fuzzy score), `probable` = uncertain (0.60-0.89 — store match
   *  still runs but the UI surfaces an amber "probable library match" chip),
   *  `missing` = not in library. Unset when the sourcing flow didn't do a
   *  library pre-pass. */
  libraryStatus?: 'confirmed' | 'probable' | 'missing';
  /** Path to the suspected library file (for `confirmed` and `probable`
   *  statuses). Used by the UI to show which file a probable match thinks it
   *  hit, so the user can decide whether to treat the row as missing. */
  libraryMatchPath?: string;
  /** Fuzzy score of the best library match (0..1). Only set when
   *  libraryStatus is 'confirmed' or 'probable'. */
  libraryMatchConfidence?: number;
  /** A Qobuz match that is still a whole release: search couldn't pin it to
   *  the requested track or read that track's tiers. Offered, never
   *  pre-selected; the cart add resolves it again or fails with a reason. */
  albumLevel?: boolean;
  /** Why a match needs a second look (release not resolved, lossy-only tier). */
  note?: string;
};

// ========== Batch Search ==========

/** Parse a quality string into a comparable numeric score (bit_depth * sampling_rate).
 *  Handles both "24/96" (search results: bitDepth/samplingRate) and "24bit/96kHz"
 *  (album API) — the search path feeds the former, so the bit/kHz-only regex never matched. */
function parseQualityScore(quality: string | null): number {
  if (!quality) return 0;
  const match = quality.match(/(\d+)\s*(?:bit)?\s*\/\s*([\d.]+)\s*(?:khz)?/i);
  if (!match) return 0;
  return Number(match[1]) * Number(match[2]);
}

type QobuzResolution = {
  track: QobuzTrack;
  parts?: StoreScoreParts;
  lossless: boolean;
  note?: string;
};

/** Pin a Qobuz release hit to the requested track and its best lossless tier.
 *  When that can't be done the hit comes back unchanged (still release-level)
 *  with a note saying why. */
async function resolveQobuzHit(hit: QobuzTrack, want: QobuzCartTrackInput): Promise<QobuzResolution> {
  const albumGuess = Boolean(hit.quality);
  let pick: ReturnType<typeof pickReleaseTrack<{ id: string; title: string; artist: string }>>;
  try {
    pick = pickReleaseTrack(want, await getQobuzReleaseTracks(hit.albumId, hit.url), hit.artists);
  } catch (err) {
    log.warn('Qobuz release lookup failed for', hit.url, err);
    return { track: hit, lossless: albumGuess, note: `Couldn't read the Qobuz release: ${getErrorMessage(err)}` };
  }
  if (!pick) {
    return { track: hit, lossless: albumGuess, note: `Couldn't find "${want.title}" on the Qobuz release "${hit.album}" — check it before buying` };
  }

  let tier: Awaited<ReturnType<typeof getQobuzLosslessTier>>;
  try {
    tier = await getQobuzLosslessTier(pick.track.id);
  } catch (err) {
    log.warn('Qobuz quality options unreadable for track', pick.track.id, err);
    return { track: hit, lossless: albumGuess, note: `Couldn't read Qobuz's quality options: ${getErrorMessage(err)}` };
  }

  const asTrack: QobuzTrack = {
    ...hit,
    id: pick.track.id,
    name: pick.track.title,
    artists: pick.track.artist ? [pick.track.artist] : hit.artists,
    trackResolved: true,
    price: tier?.price ?? hit.price,
    quality: tier ? (tier.kind === 'hires' ? (hit.quality ?? 'Hi-Res') : '16/44.1') : 'lossy only',
    cartLink: tier?.cartLink,
    articleId: tier?.articleId,
  };
  return tier
    ? { track: asTrack, parts: pick.parts, lossless: true }
    : { track: asTrack, parts: pick.parts, lossless: false, note: 'Qobuz sells this track only in a lossy format' };
}

export async function batchSearchQobuz(
  tracks: QobuzCartTrackInput[],
  onProgress?: (current: number, total: number, currentTrack: string) => void,
  onMatch?: (match: QobuzCartMatch) => void
): Promise<QobuzCartMatch[]> {
  const results: QobuzCartMatch[] = [];

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    const label = `${track.artist} - ${track.title}`;
    onProgress?.(i + 1, tracks.length, label);

    try {
      const query = `${track.artist} ${track.title}`;

      // Query Qobuz and Beatport in parallel — we need to compare both to avoid
      // locking in a mediocre Qobuz match when Beatport has a better one (common
      // for EDM releases Beatport carries but Qobuz doesn't). One store failing
      // doesn't stop the other, but it's remembered: with no match, a store we
      // couldn't search may well carry the track, so that's an error, not a miss.
      const storeErrors: string[] = [];
      const [qobuzTracks, beatportTracks] = await Promise.all([
        searchQobuzTracks(query).catch(err => {
          log.warn('Qobuz search failed for', label, err);
          storeErrors.push(`Qobuz search failed: ${getErrorMessage(err)}`);
          return [] as QobuzTrack[];
        }),
        searchBeatportTracks(query).catch(err => {
          log.warn('Beatport search failed for', label, err);
          storeErrors.push(`Beatport search failed: ${getErrorMessage(err)}`);
          return [] as BeatportTrack[];
        }),
      ]);

      let bestQobuzMatch: QobuzTrack | null = null;
      let bestQobuzScore = 0;
      let bestQobuzParts: StoreScoreParts | null = null;
      for (const qt of qobuzTracks) {
        const parts = storeScoreParts(track, qt.artists, qt.name);
        const score = parts.score;
        const quality = parseQualityScore(qt.quality);
        if (score > bestQobuzScore || (score === bestQobuzScore && quality > (bestQobuzMatch ? parseQualityScore(bestQobuzMatch.quality) : 0))) {
          bestQobuzScore = score;
          bestQobuzMatch = qt;
          bestQobuzParts = parts;
        }
      }

      let bestBeatportMatch: BeatportTrack | null = null;
      let bestBeatportScore = 0;
      let bestBeatportParts: StoreScoreParts | null = null;
      for (const bt of beatportTracks) {
        const parts = storeScoreParts(track, bt.artists, bt.name);
        if (parts.score > bestBeatportScore) {
          bestBeatportScore = parts.score;
          bestBeatportMatch = bt;
          bestBeatportParts = parts;
        }
      }

      // Beatport sells WAV/AIFF/FLAC on every purchasable track. Qobuz's search
      // payload carries bitDepth/samplingRate only for lossless editions — a
      // release-level guess until the track's own tier is read below.
      const beatportCand: StoreCandidate | null = bestBeatportMatch ? { score: bestBeatportScore, lossless: true } : null;
      let qobuzCand: StoreCandidate | null = bestQobuzMatch
        ? { score: bestQobuzScore, lossless: Boolean(bestQobuzMatch.quality) }
        : null;
      let store = chooseStore(qobuzCand, beatportCand);

      let qobuzNote: string | undefined;
      if (store === 'qobuz' && bestQobuzMatch) {
        const r = await resolveQobuzHit(bestQobuzMatch, track);
        bestQobuzMatch = r.track;
        if (r.parts) { bestQobuzParts = r.parts; bestQobuzScore = r.parts.score; }
        qobuzNote = r.note;
        qobuzCand = { score: bestQobuzScore, lossless: r.lossless };
        // A release that couldn't be pinned to the track loses to any
        // acceptable Beatport match — that one already is a track.
        const beatportOk = !!beatportCand && beatportCand.score >= STORE_MATCH_FLOOR;
        store = chooseStore(!r.track.trackResolved && beatportOk ? null : qobuzCand, beatportCand);
      }

      if (store === 'qobuz' && bestQobuzMatch) {
        results.push({
          trackInput: track,
          qobuzTrack: bestQobuzMatch,
          beatportTrack: null,
          confidence: bestQobuzScore,
          scoreParts: bestQobuzParts ?? undefined,
          source: 'qobuz',
          lossless: qobuzCand?.lossless ?? false,
          status: 'matched',
          albumLevel: !bestQobuzMatch.trackResolved,
          note: qobuzNote,
        });
      } else if (store === 'beatport' && bestBeatportMatch) {
        results.push({
          trackInput: track,
          qobuzTrack: null,
          beatportTrack: bestBeatportMatch,
          confidence: bestBeatportScore,
          scoreParts: bestBeatportParts ?? undefined,
          source: 'beatport',
          lossless: true,
          status: 'matched'
        });
      } else {
        results.push({
          trackInput: track,
          qobuzTrack: bestQobuzMatch,
          beatportTrack: bestBeatportMatch,
          confidence: Math.max(bestQobuzScore, bestBeatportScore),
          source: null,
          lossless: false,
          status: storeErrors.length > 0 ? 'error' : 'no_match',
          error: storeErrors.length > 0 ? storeErrors.join('; ') : undefined,
        });
      }
    } catch (err) {
      log.error('Batch search failed for track:', label, err);
      results.push({
        trackInput: track,
        qobuzTrack: null,
        beatportTrack: null,
        confidence: 0,
        source: null,
        lossless: false,
        status: 'error',
        error: getErrorMessage(err, 'Search failed')
      });
    }

    // Fire per-match event so the UI can render progress as tracks resolve
    // (running counts, preview art, etc.) rather than waiting for the full
    // batch.
    try { onMatch?.(results[results.length - 1]); } catch { /* non-fatal */ }

    // Rate-limit between requests
    if (i < tracks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return results;
}
