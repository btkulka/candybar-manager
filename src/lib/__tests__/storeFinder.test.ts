import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildFinderTracks, applyFinderPick, applyFinderPicks, finderSummary, searchPickRef, toFinderCandidate,
  lookupCandidate, clearCandidates, type QobuzResolver,
} from '../claude/storeFinder';
import { finderBatches, FINDER_BATCH } from '../jobQueue/jobs/claude';
import { buildStoreFinderPrompt } from '../claude/prompts';
import type { BeatportTrack } from '../beatport';
import type { QobuzTrack } from '../qobuz';
import type { QobuzCartMatch, StoreCandidates } from '../qobuzCart';

const bp = (id: string, name: string, artists = ['Fred again..'], extra: Partial<BeatportTrack> = {}): BeatportTrack => ({
  id, name, artists, remixers: [], label: 'Atlantic', genre: 'House', bpm: 126, key: '8A',
  release_date: '2024-05-01', price: '$1.99', url: `https://www.beatport.com/track/x/${id}`, ...extra,
});

const qz = (albumId: string, name: string, artists = ['Fred again..'], quality: string | null = '24/48'): QobuzTrack => ({
  id: albumId, name, artists, album: name, duration_seconds: null, quality, price: '$1.49',
  url: `https://www.qobuz.com/us-en/album/x/${albumId}`, image: null, albumId, trackResolved: false,
});

const want = { key: 'fred again.. - jungle', artist: 'Fred again..', title: 'Jungle' };

function match(over: Partial<QobuzCartMatch> = {}): QobuzCartMatch {
  return {
    trackInput: want, qobuzTrack: null, beatportTrack: null, confidence: 0, source: null,
    lossless: false, status: 'no_match', libraryStatus: 'missing', ...over,
  };
}

const noQobuz: QobuzResolver = async () => { throw new Error('should not resolve'); };

beforeEach(() => clearCandidates());

describe('buildFinderTracks', () => {
  it('lists the best candidates per store, highest score first, and registers them', () => {
    const candidates: StoreCandidates = {
      beatport: [bp('2', 'Jungle (Radio Edit)'), bp('1', 'Jungle (Extended Mix)'), bp('3', 'Jungle', ['Someone Else'])],
      qobuz: [qz('a1', 'Jungle')],
    };
    const m = match({ status: 'matched', source: 'beatport', beatportTrack: candidates.beatport[1], lossless: true, confidence: 0.98 });
    const [t] = buildFinderTracks([m], new Map([[want.key, candidates]]));
    expect(t.searchPick).toBe('bp:1');
    expect(t.candidates.map(c => c.ref)).toContain('qz:a1');
    const bpScores = t.candidates.filter(c => c.store === 'beatport').map(c => c.score ?? 0);
    expect(bpScores).toEqual([...bpScores].sort((a, b) => b - a));
    expect(t.candidates.find(c => c.ref === 'bp:3')!.score!).toBeLessThan(t.candidates.find(c => c.ref === 'bp:1')!.score!);
    expect(lookupCandidate('bp:1')?.track.name).toBe('Jungle (Extended Mix)');
  });

  it('keeps the plain search\'s pick even when the store returned too many to list', () => {
    const many = Array.from({ length: 12 }, (_, i) => bp(String(i), `Jungle (Mix ${i})`));
    const pick = bp('99', 'Totally Different Record', ['Nobody']);
    const m = match({ status: 'matched', source: 'beatport', beatportTrack: pick, lossless: true });
    const [t] = buildFinderTracks([m], new Map([[want.key, { beatport: many, qobuz: [] }]]));
    expect(t.candidates[0].ref).toBe('bp:99');
    expect(t.candidates.filter(c => c.store === 'beatport').length).toBe(7);
  });

  it('names a Qobuz hit by its release, which stays put once pinned to a track', () => {
    const resolved = { ...qz('a1', 'Jungle'), id: 't55', trackResolved: true };
    expect(searchPickRef(match({ status: 'matched', source: 'qobuz', qobuzTrack: resolved, lossless: true }))).toBe('qz:a1');
  });
});

describe('applyFinderPick', () => {
  it('keeps the plain match when Claude agrees, and says so', async () => {
    const pick = bp('1', 'Jungle (Extended Mix)');
    const m = match({ status: 'matched', source: 'beatport', beatportTrack: pick, lossless: true, confidence: 0.98 });
    const out = await applyFinderPick(m, { key: want.key, ref: 'bp:1', confidence: 'high', note: '' }, noQobuz);
    expect(out.beatportTrack).toBe(pick);
    expect(out.finder).toEqual({ by: 'claude', verdict: 'kept', confidence: 'high', note: '' });
  });

  it('switches to the record Claude names, scored against the wanted track', async () => {
    const radio = bp('2', 'Jungle (Radio Edit)');
    const extended = bp('1', 'Jungle (Extended Mix)');
    toFinderCandidate({ store: 'beatport', track: extended });
    const m = match({ status: 'matched', source: 'beatport', beatportTrack: radio, lossless: true, confidence: 0.9 });
    const out = await applyFinderPick(m, { key: want.key, ref: 'bp:1', confidence: 'high', note: 'Picked the Extended Mix.' }, noQobuz);
    expect(out.beatportTrack?.id).toBe('1');
    expect(out.source).toBe('beatport');
    expect(out.lossless).toBe(true);
    expect(out.scoreParts?.score).toBe(out.confidence);
    expect(out.finder).toMatchObject({ verdict: 'changed', note: 'Picked the Extended Mix.' });
    expect(out.libraryStatus).toBe('missing');
  });

  it('marks a track the plain search missed as found', async () => {
    toFinderCandidate({ store: 'beatport', track: bp('7', 'Jungle (Original Mix)') });
    const out = await applyFinderPick(match(), { key: want.key, ref: 'bp:7', confidence: 'medium', note: 'Found under the title alone.' }, noQobuz);
    expect(out.status).toBe('matched');
    expect(out.finder).toMatchObject({ verdict: 'found', confidence: 'medium' });
  });

  it('pins a Qobuz pick to its track and keeps the resolver\'s lossless verdict', async () => {
    toFinderCandidate({ store: 'qobuz', track: qz('a1', 'Jungle') });
    const resolver: QobuzResolver = async (hit) => ({
      track: { ...hit, id: 't55', name: 'Jungle', trackResolved: true, quality: 'lossy only' },
      lossless: false,
      note: 'Qobuz sells this track only in a lossy format',
    });
    const out = await applyFinderPick(match(), { key: want.key, ref: 'qz:a1', confidence: 'high', note: '' }, resolver);
    expect(out.source).toBe('qobuz');
    expect(out.qobuzTrack?.id).toBe('t55');
    expect(out.lossless).toBe(false);
    expect(out.albumLevel).toBe(false);
    expect(out.note).toMatch(/lossy/);
  });

  it('keeps the plain pick on the row, unbuyable, when Claude says neither store sells it', async () => {
    const wrong = bp('3', 'Jungle', ['Someone Else']);
    const m = match({ status: 'matched', source: 'beatport', beatportTrack: wrong, lossless: true, confidence: 0.7 });
    const out = await applyFinderPick(m, { key: want.key, ref: '', confidence: 'high', note: 'Only a same-titled track by another artist.' }, noQobuz);
    expect(out.status).toBe('no_match');
    expect(out.beatportTrack).toBe(wrong);
    expect(out.finder).toMatchObject({ verdict: 'none' });
  });

  it('keeps the plain pick, never to be ticked, when Claude keeps it only as a guess', async () => {
    const m = match({ status: 'matched', source: 'beatport', beatportTrack: bp('1', 'Jungle'), lossless: true, confidence: 0.9 });
    const out = await applyFinderPick(m, { key: want.key, ref: 'bp:1', confidence: 'low', note: 'Beatport search failed.' }, noQobuz);
    expect(out.status).toBe('matched');
    expect(out.finder).toMatchObject({ verdict: 'kept', confidence: 'low' });
  });

  it('ignores a ref the app never handed out', async () => {
    const m = match({ status: 'matched', source: 'beatport', beatportTrack: bp('1', 'Jungle'), lossless: true });
    expect(await applyFinderPick(m, { key: want.key, ref: 'bp:404', confidence: 'high', note: '' }, noQobuz)).toBe(m);
  });

  it('tags tracks Claude didn\'t answer for as the plain search\'s', async () => {
    const [out] = await applyFinderPicks([match()], [], noQobuz);
    expect(out.finder).toEqual({ by: 'search' });
  });
});

describe('finderSummary', () => {
  const claude = (verdict: 'kept' | 'changed' | 'found' | 'none') =>
    match({ finder: { by: 'claude', verdict, confidence: 'high', note: '' } });

  it('says what changed', () => {
    expect(finderSummary([claude('kept'), claude('changed'), claude('found'), claude('found')], 0, null))
      .toBe('Claude checked 4 tracks and picked a better record for 1 track and found 2 tracks the plain search missed.');
  });

  it('says when it agreed with everything, and what it left unchecked', () => {
    expect(finderSummary([claude('kept'), match({ finder: { by: 'search' } })], 1, 'a session ran out of time.'))
      .toBe("Claude checked 1 track and agreed with every match. 1 track kept the plain search's match (a session ran out of time).");
  });
});

describe('finder sessions', () => {
  it('splits tracks into sessions of FINDER_BATCH', () => {
    const batches = finderBatches(Array.from({ length: FINDER_BATCH * 2 + 1 }, (_, i) => i));
    expect(batches.map(b => b.length)).toEqual([FINDER_BATCH, FINDER_BATCH, 1]);
  });

  it('only offers the search tool when it exists', () => {
    const tracks = [{ key: 'k', artist: 'A', title: 'T', searchPick: null, candidates: [] }];
    expect(buildStoreFinderPrompt(tracks, true)).toContain('search_store_catalog');
    expect(buildStoreFinderPrompt(tracks, false)).not.toContain('search_store_catalog');
    expect(buildStoreFinderPrompt(tracks, false)).toContain('"key": "k"');
  });
});
