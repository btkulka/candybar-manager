/**
 * Claude as the store matcher for Find & buy.
 *
 * The plain search (qobuzCart.ts) scores store results by string similarity.
 * It's fast and usually right, but it can't tell the remix asked for from a
 * bootleg with the same words, or try a second query when the first finds
 * nothing. So once it has run, small headless Claude Code sessions (the
 * claude-store-finder job) read each track's candidates, search again through
 * the search_store_catalog tool when none fit, and name the record wanted, or
 * say neither store sells it.
 *
 * Claude only names a candidate by its ref. The app turns that into a match
 * under its own rules: a Qobuz release is pinned to the track and its lossless
 * tier, and a compressed-only copy never becomes buyable. A track Claude
 * didn't answer for keeps the plain search's match, and so does every track
 * when Claude Code isn't installed or signed in to a subscription.
 *
 * No Electron imports, so it can be tested on plain Node; main passes in the
 * Qobuz resolver.
 */

import type { BeatportTrack } from '../beatport';
import type { QobuzTrack } from '../qobuz';
import type { QobuzCartMatch, QobuzCartTrackInput, QobuzResolution, StoreCandidates } from '../qobuzCart';
import { storeScoreParts, type StoreScoreParts } from '../storeMatching';
import type { FinderCandidate, FinderPick, FinderTrack, MatchFinder } from '../../types';

type Store = 'beatport' | 'qobuz';
type Registered = { store: 'beatport'; track: BeatportTrack } | { store: 'qobuz'; track: QobuzTrack };

// ---------- Candidate registry ----------

/** Every store result a search has handed out lately, by ref, so a pick can
 *  be turned back into the full listing (the plain search's candidates and
 *  whatever Claude found through search_store_catalog). */
const registry = new Map<string, Registered>();
/** Enough for several long playlists; the oldest refs go first. */
const REGISTRY_MAX = 20000;

/** A Qobuz result is a release until resolved, so its ref is the release id,
 *  which stays put when the match is later pinned to a track. */
export function refOf(store: Store, track: BeatportTrack | QobuzTrack): string {
  return store === 'beatport' ? `bp:${track.id}` : `qz:${(track as QobuzTrack).albumId || track.id}`;
}

export function registerCandidate(entry: Registered): string {
  const ref = refOf(entry.store, entry.track);
  registry.delete(ref); // re-insert as newest
  registry.set(ref, entry);
  while (registry.size > REGISTRY_MAX) registry.delete(registry.keys().next().value as string);
  return ref;
}

export function lookupCandidate(ref: string): Registered | null {
  return registry.get(ref) ?? null;
}

/** Test hook. */
export function clearCandidates(): void {
  registry.clear();
}

// ---------- What a session sees ----------

/** Candidates per store in a prompt: enough to hold the right version, few
 *  enough to keep a small model's sessions short. */
const BEATPORT_PER_TRACK = 6;
const QOBUZ_PER_TRACK = 4;

const round2 = (n: number) => Math.round(n * 100) / 100;

function artistsOf(track: BeatportTrack | QobuzTrack): string[] {
  return track.artists ?? [];
}

/** One result as the prompt lists it, registered so a pick can name it. */
export function toFinderCandidate(entry: Registered, want?: { artist: string; title: string }): FinderCandidate {
  const ref = registerCandidate(entry);
  const score = want ? round2(storeScoreParts(want, artistsOf(entry.track), entry.track.name).score) : undefined;
  if (entry.store === 'beatport') {
    const t = entry.track;
    return {
      ref, store: 'beatport', artists: t.artists.join(', '), title: t.name,
      ...(t.remixers.length ? { remixers: t.remixers.join(', ') } : {}),
      ...(t.label ? { label: t.label } : {}),
      ...(t.release_date ? { released: t.release_date.slice(0, 10) } : {}),
      ...(t.bpm ? { bpm: t.bpm } : {}),
      price: t.price,
      ...(score !== undefined ? { score } : {}),
    };
  }
  const t = entry.track;
  return {
    ref, store: 'qobuz', artists: t.artists.join(', '), title: t.album || t.name,
    quality: t.quality, price: t.price,
    ...(score !== undefined ? { score } : {}),
  };
}

/** The best-scoring few of one store's results, highest first. */
function topCandidates(store: Store, tracks: Array<BeatportTrack | QobuzTrack>, want: QobuzCartTrackInput, n: number): FinderCandidate[] {
  return tracks
    .map(track => toFinderCandidate({ store, track } as Registered, want))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, n);
}

/** The plain search's pick as a ref, or null when it had none. */
export function searchPickRef(m: QobuzCartMatch): string | null {
  if (m.status !== 'matched') return null;
  if (m.source === 'beatport' && m.beatportTrack) return refOf('beatport', m.beatportTrack);
  if (m.source === 'qobuz' && m.qobuzTrack) return refOf('qobuz', m.qobuzTrack);
  return null;
}

/** The finder's input for each match, in the same order. The plain search's
 *  own pick is always among the candidates, even when a store returned more
 *  results than a prompt holds. */
export function buildFinderTracks(matches: QobuzCartMatch[], candidatesByKey: Map<string, StoreCandidates>): FinderTrack[] {
  return matches.map((m) => {
    const want = m.trackInput;
    const found = candidatesByKey.get(want.key) ?? { qobuz: [], beatport: [] };
    const candidates = [
      ...topCandidates('beatport', found.beatport, want, BEATPORT_PER_TRACK),
      ...topCandidates('qobuz', found.qobuz, want, QOBUZ_PER_TRACK),
    ];
    const pick = searchPickRef(m);
    if (pick && !candidates.some(c => c.ref === pick)) {
      const entry: Registered | null = m.source === 'beatport' && m.beatportTrack ? { store: 'beatport', track: m.beatportTrack }
        : m.source === 'qobuz' && m.qobuzTrack ? { store: 'qobuz', track: m.qobuzTrack } : null;
      if (entry) candidates.unshift(toFinderCandidate(entry, want));
    }
    return {
      key: want.key,
      artist: want.artist,
      title: want.title,
      ...(want.album ? { album: want.album } : {}),
      ...(want.duration ? { durationSec: want.duration } : {}),
      searchPick: pick,
      candidates,
    };
  });
}

// ---------- Picks → matches ----------

export type QobuzResolver = (hit: QobuzTrack, want: QobuzCartTrackInput) => Promise<QobuzResolution>;

/** The match with no store record attached, keeping the wanted track, its
 *  library status and its free download. */
function bare(m: QobuzCartMatch): QobuzCartMatch {
  return {
    ...m,
    qobuzTrack: null,
    beatportTrack: null,
    scoreParts: undefined,
    source: null,
    lossless: false,
    albumLevel: undefined,
    note: undefined,
    error: undefined,
  };
}

const finderOf = (pick: FinderPick, verdict: 'kept' | 'changed' | 'found' | 'none'): MatchFinder =>
  ({ by: 'claude', verdict, confidence: pick.confidence, note: pick.note.trim() });

/**
 * Apply Claude's pick to one match. A pick naming a ref the app never handed
 * out (or a store it can't read) leaves the plain search's match as it was.
 */
export async function applyFinderPick(m: QobuzCartMatch, pick: FinderPick, resolveQobuz: QobuzResolver): Promise<QobuzCartMatch> {
  const was = searchPickRef(m);
  const ref = pick.ref.trim();

  if (!ref) {
    // Claude says neither store sells this record. The plain search's pick,
    // if any, stays on the row (under Not found, never ticked) so the user
    // can still take it with "Use it anyway".
    return { ...m, status: m.status === 'error' ? 'error' : 'no_match', finder: finderOf(pick, 'none') };
  }
  if (ref === was) return { ...m, finder: finderOf(pick, 'kept') };

  const entry = lookupCandidate(ref);
  if (!entry) return m;
  const verdict = was ? 'changed' : 'found';
  const want = m.trackInput;

  if (entry.store === 'beatport') {
    const parts = storeScoreParts(want, entry.track.artists, entry.track.name);
    return {
      ...bare(m),
      beatportTrack: entry.track,
      confidence: parts.score,
      scoreParts: parts,
      source: 'beatport',
      lossless: true,
      status: 'matched',
      finder: finderOf(pick, verdict),
    };
  }

  let r: QobuzResolution;
  try {
    r = await resolveQobuz(entry.track, want);
  } catch {
    return m;
  }
  const parts: StoreScoreParts = r.parts ?? storeScoreParts(want, r.track.artists, r.track.name);
  return {
    ...bare(m),
    qobuzTrack: r.track,
    confidence: parts.score,
    scoreParts: parts,
    source: 'qobuz',
    lossless: r.lossless,
    status: 'matched',
    albumLevel: !r.track.trackResolved,
    note: r.note,
    finder: finderOf(pick, verdict),
  };
}

/** Apply every pick; matches without one are tagged as the plain search's. */
export async function applyFinderPicks(matches: QobuzCartMatch[], picks: FinderPick[], resolveQobuz: QobuzResolver): Promise<QobuzCartMatch[]> {
  const byKey = new Map(picks.map(p => [p.key, p]));
  const out: QobuzCartMatch[] = [];
  for (const m of matches) {
    const pick = byKey.get(m.trackInput.key);
    out.push(pick ? await applyFinderPick(m, pick, resolveQobuz) : { ...m, finder: { by: 'search' } });
  }
  return out;
}

// ---------- The summary line ----------

/** What Claude did over a whole check, in a sentence. */
export function finderSummary(matches: QobuzCartMatch[], unchecked: number, firstError: string | null): string {
  const count = (v: string) => matches.filter(m => m.finder?.by === 'claude' && m.finder.verdict === v).length;
  const checked = matches.filter(m => m.finder?.by === 'claude').length;
  const tracks = (n: number) => `${n.toLocaleString()} track${n === 1 ? '' : 's'}`;
  const parts: string[] = [];
  const changed = count('changed');
  const found = count('found');
  const none = count('none');
  if (changed) parts.push(`picked a better record for ${tracks(changed)}`);
  if (found) parts.push(`found ${tracks(found)} the plain search missed`);
  if (none) parts.push(`says ${none === 1 ? "one isn't" : `${none.toLocaleString()} aren't`} sold in either store`);
  let s = checked === 0
    ? 'Claude didn\'t check any tracks'
    : `Claude checked ${tracks(checked)}${parts.length ? ` and ${joinAnd(parts)}` : ' and agreed with every match'}`;
  if (unchecked > 0) {
    s += `. ${tracks(unchecked)} kept the plain search's match${firstError ? ` (${firstError.replace(/\.$/, '')})` : ''}`;
  }
  return `${s}.`;
}

function joinAnd(parts: string[]): string {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
