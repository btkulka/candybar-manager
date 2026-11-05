// Locks the free-source matcher behind Lossless Upgrades. The SoundCloud
// tracks and Bandcamp pages are trimmed from what api-v2, Bandcamp's search
// and its track pages returned on 2026-11-03.

import { describe, it, expect } from 'vitest';
import {
  FREE_MATCH_FLOOR, scoreFreeCandidate, pickSoundCloudFree, rankBandcampResults, parseTralbumHtml, bandcampOffer,
  bandcampHit, bandcampQueries, primaryFree, needsStoreSearch, toFetchRows, upgradeOutcomes,
  reworkTag, wantReadings, rankSoundCloudFree, searchSoundCloudFree, soundCloudQueries, freeHitFromLink,
} from '../freeSources.mjs';

const sc = (o) => ({
  id: o.id ?? 1, title: o.title, user: { username: o.by, id: 99 }, permalink_url: `https://soundcloud.com/x/${o.id ?? 1}`,
  duration: (o.sec ?? 180) * 1000, downloadable: !!o.dl, has_downloads_left: !!o.dl,
  purchase_url: o.pu ?? null, purchase_title: o.pt ?? null, description: o.desc ?? null,
});

const page = (tralbum, currency = 'USD') =>
  `<script data-band-currency="${currency}"></script><div data-tralbum="${JSON.stringify(tralbum).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></div>`;

const tralbum = (o) => ({
  id: o.id ?? 7, item_type: 'track', artist: o.artist ?? null, freeDownloadPage: o.free ?? null,
  current: { title: o.title, minimum_price: o.min, require_email: o.email ?? null },
  trackinfo: [{ duration: o.sec ?? 200, is_downloadable: o.downloadable ?? true, unreleased_track: false }],
});

describe('scoreFreeCandidate', () => {
  it('holds another version under the floor, though the stores would take it', () => {
    const s = scoreFreeCandidate({ artist: 'Marie Vaunt', title: 'That Acid' }, { artist: 'Marie vaunt', title: 'That acid (ANDUJ Edit)' });
    expect(s.versionMismatch).toBe(true);
    expect(s.score).toBeLessThan(FREE_MATCH_FLOOR);
  });

  it('holds a copy of another length under the floor: the cues would land in the wrong place', () => {
    const want = { artist: 'Marie Vaunt', title: 'That Acid (ANDUJ Edit)', duration: 186 };
    expect(scoreFreeCandidate(want, { artist: 'Marie Vaunt', title: 'That Acid (ANDUJ Edit)', duration: 195 }).score).toBe(1);
    const far = scoreFreeCandidate(want, { artist: 'Marie Vaunt', title: 'That Acid (ANDUJ Edit)', duration: 240 });
    expect(far.durationMismatch).toBe(true);
    expect(far.score).toBeLessThan(FREE_MATCH_FLOOR);
  });
});

describe('pickSoundCloudFree', () => {
  const want = { artist: 'Marie Vaunt', title: 'That Acid (ANDUJ Edit)', duration: 186 };

  it('takes the same version with a free download and skips the rest', () => {
    const hit = pickSoundCloudFree(want, [
      sc({ id: 1, title: 'That Acid', by: 'Marie Vaunt', sec: 146 }),
      sc({ id: 2, title: 'MARIE VAUNT - THAT ACID (SONDERLING SCHRANZ REWORK) [FREE DOWNLOAD]', by: 'SONDERLING', sec: 254, pu: 'https://droploud.com/gate/b5bc', pt: 'FREE DOWNLOAD' }),
      sc({ id: 3, title: 'Marie vaunt - That acid (ANDUJ Edit)', by: 'ANDUJ', sec: 186, pu: 'https://hypeddit.com/anduj/marievauntthatacidanduj', pt: 'Free Download' }),
    ]);
    expect(hit).toMatchObject({ source: 'soundcloud', kind: 'gate', uploader: 'ANDUJ', lossless: 'on-arrival', gate: { host: 'hypeddit.com' } });
    expect(hit.fetchRow.scId).toBe(3);
  });

  it('finds nothing when the only free copies are other versions', () => {
    expect(pickSoundCloudFree({ artist: 'Marie Vaunt', title: 'That Acid', duration: 146 }, [
      sc({ id: 1, title: 'That Acid', by: 'Marie Vaunt', sec: 146 }),
      sc({ id: 3, title: 'Marie vaunt - That acid (ANDUJ Edit)', by: 'ANDUJ', sec: 186, pu: 'https://hypeddit.com/a/b', pt: 'Free Download' }),
    ])).toBeNull();
  });

  it('never offers an upload whose title says it is an MP3', () => {
    const w = { artist: 'Sherlock Vs Fatboy Slim', title: 'Star 69 (Sherlocks Gravity Remix)' };
    expect(pickSoundCloudFree(w, [sc({ title: 'Sherlock Vs Fatboy Slim - Star 69 (Sherlocks Gravity Remix) - 192kps', by: 'RULING ELITE', dl: true })])).toBeNull();
    expect(pickSoundCloudFree(w, [sc({ title: 'FREE DOWNLOAD - Sherlock Vs Fatboy Slim - Star 69 (Sherlocks Gravity Remix) - 24bit Wav', by: 'RULING ELITE', dl: true })]))
      .toMatchObject({ kind: 'native' });
  });

  it('prefers the native button over a gate at the same score', () => {
    const w = { artist: 'Fatboy Slim', title: 'Star 69 (Joey Jax Remix)' };
    const hit = pickSoundCloudFree(w, [
      sc({ id: 1, title: 'Fatboy Slim - Star 69 (Joey Jax Remix)', by: 'Reposter', pu: 'https://hypeddit.com/x/y', pt: 'Free Download' }),
      sc({ id: 2, title: 'Fatboy Slim - Star 69 (Joey Jax Remix) [Free Download]', by: 'Joey Jax', dl: true }),
    ]);
    expect(hit).toMatchObject({ kind: 'native', reason: 'SoundCloud download button' });
  });
});

describe('Bandcamp', () => {
  it('searches the bare title, with and without the artist', () => {
    expect(bandcampQueries({ artist: 'The Prodigy', title: 'Voodoo People (Dwaine Whyte Bootleg)' }))
      .toEqual(['prodigy voodoo people', 'voodoo people']);
  });

  it('reads "Artist - Title" out of a bootleg\'s track name', () => {
    const want = { artist: 'The Prodigy', title: 'Voodoo People (Dwaine Whyte Bootleg)' };
    const ranked = rankBandcampResults(want, [
      { type: 't', id: 1, band_name: 'Axyom', name: 'The Prodigy - Voodoo People (Axyom Remix)', item_url_path: 'https://axyom.bandcamp.com/track/a' },
      { type: 't', id: 2, band_name: 'DWAINE WHYTE', name: 'PRODIGY - VOODOO PEOPLE - DWAINE WHYTE BOOTLEG (FREE DOWNLOAD)', item_url_path: 'https://inkriptedrecords.bandcamp.com/track/b' },
    ]);
    expect(ranked.map(r => r.result.id)).toEqual([2]);
  });

  it('reads the offer: free page, name your price (maybe by email), a minimum, or nothing', () => {
    const offer = (t, cur) => bandcampOffer(parseTralbumHtml(page(tralbum(t), cur)));
    expect(offer({ title: 'x', min: 0, free: 'https://bandcamp.com/download?id=1' })).toEqual({ kind: 'free', needsEmail: false, price: null });
    expect(offer({ title: 'x', min: 0, email: 1 })).toEqual({ kind: 'free', needsEmail: true, price: null });
    expect(offer({ title: 'x', min: 2 }, 'GBP')).toEqual({ kind: 'paid', needsEmail: false, price: { amount: 2, currency: 'GBP', label: '£2.00' } });
    expect(offer({ title: 'x', min: 1, downloadable: false })).toBeNull();
  });

  it('only hands a free copy to the downloader; a priced one is the user\'s to buy', () => {
    const want = { artist: 'Fred again..', title: 'Delilah (Computa & Stoneworks Remix)', duration: 233 };
    const url = 'https://computa.bandcamp.com/track/fred-again-delilah-computa-stoneworks-remix';
    const t = { title: 'Fred Again - Delilah (Computa & Stoneworks Remix)', sec: 233.143 };
    const paid = bandcampHit(want, url, parseTralbumHtml(page(tralbum({ ...t, min: 1 }))), { band_name: 'Computa' });
    expect(paid).toMatchObject({ kind: 'paid', reason: '$1.00 or more on Bandcamp', fetchRow: null, lossless: 'source' });
    const free = bandcampHit(want, url, parseTralbumHtml(page(tralbum({ ...t, min: 0, id: 42 }))), { band_name: 'Computa' });
    expect(free.fetchRow).toMatchObject({ scId: 'bandcamp:42', source: 'bandcamp', free: { kind: 'gate', gate: { host: 'bandcamp.com', url } } });
  });

  it('turns down a page whose length says it is another cut', () => {
    const want = { artist: 'Mall Grab', title: 'Love Reigns', duration: 294 };
    const p = parseTralbumHtml(page(tralbum({ title: 'Love Reigns', artist: 'Mall Grab', min: 2, sec: 410 }), 'GBP'));
    expect(bandcampHit(want, 'https://x.bandcamp.com/track/love-reigns', p)).toBeNull();
  });
});

describe('the order: SoundCloud, then Bandcamp, then the stores', () => {
  const scHit = { source: 'soundcloud', fetchRow: { scId: 5 } };
  const bcFree = { source: 'bandcamp', kind: 'free', needsEmail: false, fetchRow: { scId: 'bandcamp:6' } };
  const bcPaid = { source: 'bandcamp', kind: 'paid', fetchRow: null };

  it('goes for SoundCloud first, then Bandcamp', () => {
    expect(primaryFree({ soundcloud: scHit, bandcamp: bcFree })).toBe(scHit);
    expect(primaryFree({ soundcloud: null, bandcamp: bcPaid })).toBe(bcPaid);
    expect(primaryFree({ soundcloud: null, bandcamp: null })).toBeNull();
  });

  it('skips the stores only when Bandcamp gives it away with no email', () => {
    expect(needsStoreSearch({ soundcloud: scHit, bandcamp: null })).toBe(true);
    expect(needsStoreSearch({ soundcloud: null, bandcamp: bcPaid })).toBe(true);
    expect(needsStoreSearch({ soundcloud: null, bandcamp: { ...bcFree, needsEmail: true } })).toBe(true);
    expect(needsStoreSearch({ soundcloud: scHit, bandcamp: bcFree })).toBe(false);
  });

  it('queues SoundCloud before Bandcamp for each track, and never a priced copy', () => {
    const rows = toFetchRows([
      { key: 'rb:1', found: { soundcloud: scHit, bandcamp: bcFree } },
      { key: 'rb:2', found: { soundcloud: null, bandcamp: bcPaid } },
    ]);
    expect(rows.map(r => [r.upgradeKey, r.scId])).toEqual([['rb:1', 5], ['rb:1', 'bandcamp:6']]);
  });
});

describe('upgradeOutcomes', () => {
  const wav = p => ({ path: p, codec: 'pcm_s16le', ext: 'wav', lossless: true });
  const mp3 = p => ({ path: p, codec: 'mp3', ext: 'mp3', lossless: false });

  it('maps each upgrade to the lossless file that landed, with every source tried', () => {
    const out = upgradeOutcomes({
      downloaded: [{ upgradeKey: 'rb:1', source: 'bandcamp', url: 'bc', free: { kind: 'gate' }, outcome: { status: 'downloaded', files: [wav('/in/a.wav')] } }],
      dropped: [{ upgradeKey: 'rb:1', url: 'sc', free: { kind: 'native' }, outcome: { status: 'lossy-dropped', reason: 'MP3 only — deleted by request' } }],
      flagged: [
        { upgradeKey: 'rb:2', url: 'sc2', free: { kind: 'gate' }, outcome: { status: 'needs-email', reason: 'wants an address' } },
        { upgradeKey: 'rb:3', url: 'sc3', free: { kind: 'native' }, outcome: { status: 'downloaded', files: [mp3('/in/lossy/c.mp3')] } },
      ],
    });
    expect(out['rb:1']).toMatchObject({ filePath: '/in/a.wav', source: 'bandcamp' });
    expect(out['rb:1'].attempts.map(a => a.status).sort()).toEqual(['downloaded', 'lossy-dropped']);
    expect(out['rb:2']).toMatchObject({ filePath: null, attempts: [{ status: 'needs-email', reason: 'wants an address' }] });
    expect(out['rb:3']).toMatchObject({ filePath: null, attempts: [{ status: 'lossy' }] });
  });

  it('leaves a stem pack to a person: no file is picked when several arrive', () => {
    const out = upgradeOutcomes({
      flagged: [{ upgradeKey: 'rb:6', url: 'sc6', free: { kind: 'gate' }, outcome: { status: 'downloaded', files: [wav('/in/kick.wav'), wav('/in/full.wav'), mp3('/in/lossy/x.mp3')] } }],
    });
    expect(out['rb:6']).toMatchObject({ filePath: null, attempts: [{ status: 'several-files' }] });
    expect(out['rb:6'].attempts[0].reason).toMatch(/2 lossless files/);
  });

  it('counts a lossless file from an earlier run, never a lossy one', () => {
    const out = upgradeOutcomes({
      alreadyDownloaded: [
        { upgradeKey: 'rb:4', ledger: { files: [wav('/lib/d.wav')] } },
        { upgradeKey: 'rb:5', ledger: { files: [], dropped: [{ codec: 'mp3' }] } },
      ],
    });
    expect(out['rb:4']).toMatchObject({ filePath: '/lib/d.wav', earlier: true });
    expect(out['rb:5']).toBeUndefined();
  });
});

// The Shizz Lo flip of John Summit & Sub Focus' "Go Back" (2026-11-04): no
// buy link, the free WAV behind an Influence Planner link in the description.
const SHIZZ = {
  id: 1862016720, title: 'John Summit & Sub Focus – Go Back (Shizz Lo Flip)', by: 'Shizz Lo', sec: 197,
  desc: 'John Summit & Sub Focus but make it WONKY\n\nFREE DOWNLOAD - https://ipln.io/3IlngjlG\n- FOLLOW HERE -\n@shizzlomusic',
};
const IP_WAV = { host: 'influenceplanner.com', active: true, format: 'WAV', lossless: true, needs: ['email', 'soundcloud-connect', 'comment'], scTrackId: '1862016720' };

describe('rework credits', () => {
  it('reads the reworker and the word from a bracket or a dash', () => {
    expect(reworkTag('Go Back (Shizz Lo Flip)')).toEqual({ tag: 'Shizz Lo Flip', word: 'flip', credit: 'shizz lo' });
    expect(reworkTag('Go Back - Shizz Lo Remix')).toMatchObject({ word: 'remix', credit: 'shizz lo' });
    expect(reworkTag('Go Back (Original Mix)')).toBeNull();
  });

  it('takes the same reworker under another word at the same length, never another reworker', () => {
    const want = { artist: 'John Summit & Sub Focus', title: 'Go Back (Shizz Lo Remix)', duration: 198 };
    expect(scoreFreeCandidate(want, { artist: 'John Summit & Sub Focus', title: 'Go Back (Shizz Lo Flip)', duration: 197 }).score).toBe(1);
    // Another length: not trusted.
    expect(scoreFreeCandidate(want, { artist: 'John Summit & Sub Focus', title: 'Go Back (Shizz Lo Flip)', duration: 240 }).score).toBeLessThan(FREE_MATCH_FLOOR);
    expect(scoreFreeCandidate(want, { artist: 'John Summit & Sub Focus', title: 'Go Back (FloZone Flip)', duration: 197 }).versionMismatch).toBe(true);
    // A VIP is its own thing.
    expect(scoreFreeCandidate({ ...want, title: 'Go Back (Shizz Lo VIP)' }, { artist: 'John Summit & Sub Focus', title: 'Go Back (Shizz Lo Flip)', duration: 197 }).versionMismatch).toBe(true);
  });

  it('turns down the original for a flip, and another flip, even with no length to check', () => {
    const want = { artist: 'John Summit, Sub Focus', title: 'Go Back (Shizz Lo Flip)' };
    expect(pickSoundCloudFree(want, [sc({ title: 'john summit x sub focus - go back (flozone flip)', by: 'Flozone', pu: 'https://hypeddit.com/x', pt: 'Free Download' })])).toBeNull();
    expect(pickSoundCloudFree(want, [sc({ title: 'John Summit & Sub Focus - Go Back', by: 'John Summit', dl: true })])).toBeNull();
  });
});

describe('reading the tags every way Rekordbox might hold them', () => {
  const rows = [sc({ ...SHIZZ, desc: SHIZZ.desc })];

  it('finds the flip whoever is credited', () => {
    for (const want of [
      { artist: 'John Summit & Sub Focus', title: 'Go Back (Shizz Lo Flip)', duration: 197 },
      { artist: 'Shizz Lo', title: 'Go Back (Shizz Lo Flip)', duration: 197 },
      // The reworker as the artist and a bare title.
      { artist: 'Shizz Lo', title: 'Go Back', duration: 197 },
      // The uploader as the artist and the whole SoundCloud listing as the title.
      { artist: 'Shizz Lo', title: 'John Summit & Sub Focus – Go Back (Shizz Lo Flip)', duration: 197 },
    ]) {
      expect(pickSoundCloudFree(want, rows), `${want.artist} / ${want.title}`).toMatchObject({ kind: 'gate', gate: { host: 'ipln.io' }, confidence: 1 });
    }
  });

  it('splits a SoundCloud-style title and searches it that way too', () => {
    const want = { artist: 'Shizz Lo', title: 'John Summit & Sub Focus – Go Back (Shizz Lo Flip)' };
    expect(wantReadings(want)[1]).toMatchObject({ artist: 'John Summit & Sub Focus', title: 'Go Back (Shizz Lo Flip)' });
    expect(soundCloudQueries(want)).toEqual(['Shizz Lo John Summit & Sub Focus – Go Back (Shizz Lo Flip)', 'John Summit & Sub Focus Go Back (Shizz Lo Flip)']);
    expect(soundCloudQueries({ artist: 'A', title: 'B' })).toEqual(['A B', 'B']);
  });
});

describe('near misses: why a close upload was passed over', () => {
  const want = { artist: 'John Summit & Sub Focus', title: 'Go Back (Shizz Lo Flip)', duration: 197 };

  it('says the track itself offers no download before mentioning other versions', () => {
    const { picks, misses } = rankSoundCloudFree(want, [
      sc({ id: 1, title: 'JOHN SUMMIT & SUB FOCUS - GO BACK (FOCUSS Flip)', by: 'FOCUSS', sec: 180 }),
      sc({ id: 2, title: 'John Summit & Sub Focus – Go Back (Shizz Lo Flip)', by: 'Shizz Lo', sec: 197 }),
    ]);
    expect(picks).toEqual([]);
    expect(misses.map(m => m.why.code)).toEqual(['no-download', 'other-version']);
    expect(misses[0]).toMatchObject({ uploader: 'Shizz Lo', why: { text: 'it offers no free download' } });
  });

  it('names another cut by its length', () => {
    const { misses } = rankSoundCloudFree(want, [sc({ title: 'John Summit & Sub Focus – Go Back (Shizz Lo Flip)', by: 'Shizz Lo', sec: 240, dl: true })]);
    expect(misses[0].why).toEqual({ code: 'other-length', text: "it's 43s longer than yours, so another cut" });
  });
});

describe('searchSoundCloudFree: reading the download page before offering it', () => {
  const want = { artist: 'John Summit & Sub Focus', title: 'Go Back (Shizz Lo Flip)', duration: 197 };
  const search = async () => [sc({ ...SHIZZ })];

  it('knows an Influence Planner WAV is full quality and what the page asks for', async () => {
    const { hit } = await searchSoundCloudFree(want, { search, inspect: async () => IP_WAV });
    expect(hit).toMatchObject({ lossless: 'source', gateInfo: { format: 'WAV', needs: ['email', 'soundcloud-connect', 'comment'] } });
    expect(hit.reason).toBe('Free WAV via Influence Planner (asks for your email, a SoundCloud connect and a comment)');
  });

  it('passes over a page that gives an MP3 or is switched off, and says so', async () => {
    const mp3 = await searchSoundCloudFree(want, { search, inspect: async () => ({ ...IP_WAV, format: 'MP3', lossless: false }) });
    expect(mp3.hit).toBeNull();
    expect(mp3.misses[0].why).toEqual({ code: 'gate-lossy', text: 'its download is an MP3' });
    const off = await searchSoundCloudFree(want, { search, inspect: async () => ({ ...IP_WAV, active: false }) });
    expect(off.misses[0].why.code).toBe('gate-off');
  });

  it("keeps the hit when the page can't be read, with a note", async () => {
    const { hit } = await searchSoundCloudFree(want, { search, inspect: async () => { throw new Error('HTTP 503'); } });
    expect(hit).toMatchObject({ lossless: 'on-arrival', gateNote: "Couldn't read the download page (HTTP 503)" });
  });

  it('tries the second query only when the first finds nothing free', async () => {
    const asked = [];
    await searchSoundCloudFree(want, { search: async (q) => { asked.push(q); return [sc({ ...SHIZZ })]; }, inspect: async () => null });
    expect(asked).toHaveLength(1);
  });
});

describe('freeHitFromLink: a link Ben found himself', () => {
  const want = { artist: 'John Summit & Sub Focus', title: 'Go Back (Shizz Lo Flip)', duration: 197 };
  const tracks = { 1862016720: sc({ ...SHIZZ }), 77: sc({ id: 77, title: 'Shizz Lo – Step Back', by: 'Shizz Lo', pu: 'https://fanlink.to/x', pt: 'STREAM HERE' }),
    88: sc({ id: 88, title: 'john summit x sub focus - go back (flozone flip)', by: 'Flozone', sec: 197, pu: 'https://hypeddit.com/f', pt: 'Free Download' }) };
  const resolve = async (u) => tracks[String(u).match(/(\d+)$/)?.[1]] ?? tracks[1862016720];
  const deps = { resolve, inspect: async (g) => (/ipln|influenceplanner/.test(g.host || '') ? IP_WAV : null), follow: async (u) => u.replace('ipln.io', 'gate.influenceplanner.com') };

  it('reads an Influence Planner link through to its SoundCloud upload and checks it', async () => {
    const { hit, warning } = await freeHitFromLink(want, 'https://ipln.io/3IlngjlG', deps);
    expect(warning).toBeNull();
    expect(hit).toMatchObject({ pasted: true, confidence: 1, lossless: 'source', gate: { host: 'influenceplanner.com', url: 'https://ipln.io/3IlngjlG' } });
    expect(hit.fetchRow).toMatchObject({ scId: 1862016720, free: { kind: 'gate', gate: { url: 'https://ipln.io/3IlngjlG' } } });
  });

  it('takes a SoundCloud page and uses its own free link', async () => {
    const { hit } = await freeHitFromLink(want, 'https://soundcloud.com/shizzlomusic/1862016720', deps);
    expect(hit).toMatchObject({ kind: 'gate', gate: { host: 'ipln.io' }, confidence: 1 });
  });

  it('keeps another version but warns about it', async () => {
    const { warning } = await freeHitFromLink(want, 'https://soundcloud.com/flozone/88', deps);
    expect(warning).toMatch(/another version/);
  });

  it("keeps a page it can't see behind, saying it couldn't check", async () => {
    const { hit, warning } = await freeHitFromLink(want, 'https://example-gate.io/abc', deps);
    expect(hit).toMatchObject({ confidence: 0, gate: { host: null, url: 'https://example-gate.io/abc' }, fetchRow: { scId: 'link:https://example-gate.io/abc' } });
    expect(warning).toMatch(/can't check/);
  });

  it('refuses a stream-only upload, an MP3 page and something that is not a link', async () => {
    await expect(freeHitFromLink(want, 'https://soundcloud.com/shizzlomusic/77', deps)).rejects.toThrow(/doesn't offer a free download/);
    await expect(freeHitFromLink(want, 'https://ipln.io/x', { ...deps, inspect: async () => ({ ...IP_WAV, format: 'MP3', lossless: false }) })).rejects.toThrow(/MP3/);
    await expect(freeHitFromLink(want, 'go back flip', deps)).rejects.toThrow(/isn't a link/);
  });
});
