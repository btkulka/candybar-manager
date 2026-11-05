// Locks the SoundCloud-likes classifier and title parser. The title cases are
// real strings returned by api-v2 on 2026-09-23; the free-download cases are
// the field combinations the same probe returned.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseSoundCloudTitle, stripMarkers, classifyFreeDownload, findGateLinks, findFreeLines, freeOffers, knownGateHost, normalizeLikedTrack,
  normalizeSetUrl, isSetUrl, orderSetTracks, isOwnTrack, recordSessionStatus, readSessionStatus,
} from '../soundcloud.mjs';
import { sniffFormat, safeFilename } from '../downloads.mjs';

describe('SoundCloud title parsing', () => {
  it('splits "Artist - Title" and drops the free-download tag, keeping the remix credit', () => {
    const r = parseSoundCloudTitle('Pitbull - Hotel Room Service (ILYAA Remix)[FREE DOWNLOAD] [TECH HOUSE REMIX]', { uploader: 'ILYAA' });
    expect(r.artist).toBe('Pitbull');
    expect(r.title).toBe('Hotel Room Service (ILYAA Remix) [TECH HOUSE REMIX]');
    expect(r.source).toBe('title');
  });

  it('strips a "Genre |" prefix and a *FREE DOWNLOAD* marker', () => {
    const r = parseSoundCloudTitle('House | Falamensia & Centric - OHLALA *FREE DOWNLOAD*', { uploader: 'Tech House Music', publisherArtist: 'Falamensia & Centric' });
    expect(r.artist).toBe('Falamensia & Centric');
    expect(r.title).toBe('OHLALA');
  });

  it('falls back to the publisher artist, then the uploader, when there is no dash', () => {
    expect(parseSoundCloudTitle('Ooh baby [UK TECH HOUSE FREE DOWNLOAD]', { uploader: 'Stonkeh' }))
      .toEqual({ artist: 'Stonkeh', title: 'Ooh baby', source: 'uploader' });
    expect(parseSoundCloudTitle('Luna (Tech House Edit)*FREE DOWNLOAD*', { uploader: 'Diex', publisherArtist: 'FEID' }))
      .toEqual({ artist: 'FEID', title: 'Luna (Tech House Edit)', source: 'publisher' });
  });

  it('drops a PREMIERE prefix and "Out Now" tags but keeps version brackets', () => {
    const r = parseSoundCloudTitle('PREMIERE: Adam Beyer - Your Mind (Extended Mix) [Out Now]', { uploader: 'Some Blog' });
    expect(r).toMatchObject({ artist: 'Adam Beyer', title: 'Your Mind (Extended Mix)' });
    expect(stripMarkers('Track (Free DL)')).toBe('Track');
    expect(stripMarkers('Track (Someone Remix) FREE DL!')).toBe('Track (Someone Remix)');
  });

  it('handles en/em dashes as the separator', () => {
    expect(parseSoundCloudTitle('Fred again.. – Marea (we’ve lost dancing)', {}).artist).toBe('Fred again..');
    expect(parseSoundCloudTitle('Bicep — Glue', {}).title).toBe('Glue');
  });
});

describe('free-download classification', () => {
  const base = { downloadable: false, hasDownloadsLeft: false, purchaseUrl: null, purchaseTitle: null, description: null };

  it('native when SoundCloud offers the file and downloads remain', () => {
    expect(classifyFreeDownload({ ...base, downloadable: true, hasDownloadsLeft: true }).kind).toBe('native');
    expect(classifyFreeDownload({ ...base, downloadable: true, hasDownloadsLeft: false })).toMatchObject({ kind: 'none', reason: expect.stringMatching(/limit/) });
  });

  it('gate for a Free Download link on a known host', () => {
    const r = classifyFreeDownload({ ...base, purchaseUrl: 'https://hypeddit.com/ilyaa/x', purchaseTitle: 'Free Download' });
    expect(r.kind).toBe('gate');
    expect(r.gate).toMatchObject({ host: 'hypeddit.com', url: 'https://hypeddit.com/ilyaa/x' });
  });

  it('gate on a known gate host even when the button text is odd', () => {
    expect(classifyFreeDownload({ ...base, purchaseUrl: 'https://hitsdistrict.com/access', purchaseTitle: 'DL EXTENDED VERSION' }).kind).toBe('gate');
    expect(classifyFreeDownload({ ...base, purchaseUrl: 'https://sicktaste.com/d/crvrww', purchaseTitle: 'DOWNLOAD 🔥' }).kind).toBe('gate');
  });

  it('gate with an unknown host when the label says free', () => {
    const r = classifyFreeDownload({ ...base, purchaseUrl: 'https://example-gate.io/abc', purchaseTitle: 'FREE DOWNLOAD' });
    expect(r.kind).toBe('gate');
    expect(r.gate.host).toBeNull();
  });

  it('not free when the link is a buy / stream / video link', () => {
    expect(classifyFreeDownload({ ...base, purchaseUrl: 'https://fanlink.tv/wqgn', purchaseTitle: 'Create Video Stream' }).kind).toBe('none');
    expect(classifyFreeDownload({ ...base, purchaseUrl: 'https://www.beatport.com/track/x/1', purchaseTitle: 'Buy on Beatport' }).kind).toBe('none');
    expect(classifyFreeDownload({ ...base, purchaseUrl: 'https://open.spotify.com/track/x', purchaseTitle: 'Stream' }).kind).toBe('none');
    expect(classifyFreeDownload(base)).toMatchObject({ kind: 'none', reason: 'no download offered' });
  });

  it('falls back to a gate link in the description', () => {
    const r = classifyFreeDownload({ ...base, description: 'Grab it here: https://hypeddit.com/some/track. Enjoy!' });
    expect(r.kind).toBe('gate');
    expect(r.gate.url).toBe('https://hypeddit.com/some/track');
  });

  it('recognises subdomains of gate hosts and ignores the rest', () => {
    expect(knownGateHost('https://www.toneden.io/x/post/y')).toBe('toneden.io');
    expect(knownGateHost('https://artist.bandcamp.com/track/y')).toBe('bandcamp.com');
    expect(knownGateHost('https://soundcloud.com/x')).toBeNull();
    expect(findGateLinks('a https://toneden.io/a and https://drive.google.com/file/d/1 and https://x.com/y')).toEqual([
      { host: 'toneden.io', url: 'https://toneden.io/a' },
      { host: 'drive.google.com', url: 'https://drive.google.com/file/d/1' },
    ]);
  });
});

// Descriptions as api-v2 returned them on 2026-11-04, from a 514-upload
// sample of free-download searches and the Shizz Lo flip that started it.
describe('free downloads offered in the description', () => {
  const base = { downloadable: false, hasDownloadsLeft: false, purchaseUrl: null, purchaseTitle: null, description: null, scTitle: '' };

  it('reads an Influence Planner link on a FREE DOWNLOAD line, with no buy link at all', () => {
    const r = classifyFreeDownload({ ...base, scTitle: 'John Summit & Sub Focus – Go Back (Shizz Lo Flip)',
      description: 'John Summit & Sub Focus but make it WONKY\n\nFREE DOWNLOAD - https://ipln.io/3IlngjlG\n-----------------------\n- FOLLOW HERE -\n@shizzlomusic \ninstagram.com/shizzlomusic \nopen.spotify.com/artist/2jrgjupkBfW8QzFQonRZVG' });
    expect(r).toMatchObject({ kind: 'gate', gate: { host: 'ipln.io', url: 'https://ipln.io/3IlngjlG' } });
    expect(knownGateHost('https://gate.influenceplanner.com/3IlngjlG')).toBe('influenceplanner.com');
  });

  it('takes a link written without https:// and an unknown host on a free line', () => {
    expect(classifyFreeDownload({ ...base, description: 'FREE DL: gaterush.me/0Exo03' }).gate).toMatchObject({ host: 'gaterush.me', url: 'https://gaterush.me/0Exo03' });
    const r = classifyFreeDownload({ ...base, description: 'Download Link: http://bit.ly/EminemCRaymak' });
    expect(r).toMatchObject({ kind: 'gate', gate: { host: null, url: 'http://bit.ly/EminemCRaymak' } });
    expect(r.reason).toMatch(/unknown host bit\.ly/);
  });

  it('follows a header line to the links listed under it, and goes for the lossless one', () => {
    const description = 'Reviving a classic!\nDownload Link\nMP3 - https://pumpyoursound.com/f/pys/aaj-ki-raat-saikat-afro-house-edit/187212\nWAV - https://saikat.bandcamp.com/track/aaj-ki-raat-saikat-afro-house-edit-extended-mix';
    // The buy-link slot holds the MP3 gate; the description says so.
    const r = classifyFreeDownload({ ...base, description, purchaseUrl: 'https://pumpyoursound.com/f/pys/aaj-ki-raat-saikat-afro-house-edit/187212' });
    expect(r.gate).toMatchObject({ host: 'bandcamp.com', url: 'https://saikat.bandcamp.com/track/aaj-ki-raat-saikat-afro-house-edit-extended-mix' });
    expect(r.reason).toMatch(/lossless/);
    expect(findFreeLines(description).map(l => l.host)).toEqual(['bandcamp.com']);
  });

  it('never counts a link labelled MP3', () => {
    expect(classifyFreeDownload({ ...base, description: 'Free Download MP3 - https://hypeddit.com/dm223x' }).kind).toBe('none');
  });

  it('prefers a gate Track Lab can walk over one it cannot', () => {
    const r = classifyFreeDownload({ ...base, purchaseUrl: 'https://www.valorizd.app/gates/gloria-gaynor-i-will-survive',
      description: 'Free Download \n👉https://www.valorizd.app/gates/gloria-gaynor-i-will-survive\n👉 http://hypeddit.com/track/sc/9kz1ft\n\n👉SoundCloud Free Download : https://soundcloud.com/federfunkmusic' });
    expect(r.gate.host).toBe('hypeddit.com');
    expect(freeOffers({ ...base, description: '👉SoundCloud Free Download : https://soundcloud.com/federfunkmusic' })).toEqual([]);
  });

  it('reads "Stream/DL" and bare link pages as stream pickers', () => {
    expect(classifyFreeDownload({ ...base, purchaseTitle: 'Stream/DL', description: 'Stream/DL: bssrush.co/prophecy14\nConnect with Bassrush Records\nlinktr.ee/bassrush' }).kind).toBe('none');
    const stepBack = { ...base, purchaseUrl: 'https://fanlink.to/shizzlomusic', purchaseTitle: 'STREAM HERE', description: 'Stream on Spotify: https://open.spotify.com/track/4Y2\n\nhttps://fanlink.to/Step' };
    expect(classifyFreeDownload(stepBack).kind).toBe('none');
    // The same link page counts when the upload's own title offers a download.
    expect(classifyFreeDownload({ ...stepBack, scTitle: 'Step Back [FREE DL]' }).gate.host).toBe('fanlink.to');
  });

  it('takes a file host from anywhere in the description unless its line streams or sells', () => {
    expect(classifyFreeDownload({ ...base, description: 'https://drive.google.com/file/d/1CDIk/view?usp=sharing' }).gate.host).toBe('drive.google.com');
    expect(classifyFreeDownload({ ...base, description: 'Buy it on Bandcamp: https://x.bandcamp.com/track/y' }).kind).toBe('none');
  });
});

describe('normalizeLikedTrack', () => {
  it('turns a like wrapper into a row with a library key and a classification', () => {
    const row = normalizeLikedTrack({
      kind: 'like', created_at: '2026-07-10T21:57:19Z',
      track: { id: 1, title: 'Bill Withers - Just The Two Of Us (LUK Edit) [FREE DL]', permalink_url: 'https://soundcloud.com/luk/x', duration: 245000,
        user: { id: 9, username: 'LUK', permalink_url: 'https://soundcloud.com/luk' }, downloadable: true, has_downloads_left: true, artwork_url: 'https://i1.sndcdn.com/artworks-x-large.jpg' },
    });
    expect(row).toMatchObject({ scId: 1, artist: 'Bill Withers', title: 'Just The Two Of Us (LUK Edit)', uploader: 'LUK', likedAt: '2026-07-10T21:57:19Z', duration: 245 });
    expect(row.key).toBe('bill withers - just the two of us luk edit');
    expect(row.free.kind).toBe('native');
    expect(row.image).toBe('https://i1.sndcdn.com/artworks-x-t200x200.jpg');
  });
});

describe('file identification', () => {
  const b = (s, pad = 16) => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.alloc(Math.max(0, pad - s.length))]);
  it('reads the container from magic bytes', () => {
    expect(sniffFormat(b('RIFF\0\0\0\0WAVEfmt '))).toEqual({ ext: 'wav', lossless: true });
    expect(sniffFormat(b('FORM\0\0\0\0AIFFCOMM'))).toEqual({ ext: 'aiff', lossless: true });
    expect(sniffFormat(b('fLaC\0\0\0"'))).toEqual({ ext: 'flac', lossless: true });
    expect(sniffFormat(b('ID3\x04\0\0\0\0\0\0'))).toEqual({ ext: 'mp3', lossless: false });
    expect(sniffFormat(Buffer.from([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]))).toEqual({ ext: 'mp3', lossless: false });
    expect(sniffFormat(b('\0\0\0\x20ftypM4A '))).toEqual({ ext: 'm4a', lossless: null });
    expect(sniffFormat(b('PK\x03\x04'))).toEqual({ ext: 'zip', lossless: null });
    expect(sniffFormat(b('nonsense'))).toEqual({ ext: null, lossless: null });
  });
  it('makes a filename the filesystem accepts', () => {
    expect(safeFilename('AC/DC - Back: In "Black"?')).toBe('AC-DC - Back- In -Black--');
    expect(safeFilename('   ')).toBe('untitled');
  });
});

describe('sets (playlists)', () => {
  it('cleans a pasted set link: query junk off, mobile host folded, secret token kept', () => {
    expect(normalizeSetUrl('https://m.soundcloud.com/corlem/sets/free-download?si=abc&utm_source=clipboard'))
      .toBe('https://soundcloud.com/corlem/sets/free-download');
    expect(normalizeSetUrl('https://soundcloud.com/me/sets/secret/s-AbC123/')).toBe('https://soundcloud.com/me/sets/secret/s-AbC123');
    expect(() => normalizeSetUrl('https://open.spotify.com/playlist/x')).toThrow(/not a SoundCloud link/);
    expect(() => normalizeSetUrl('nonsense')).toThrow(/not a SoundCloud set link/);
  });

  it('tells a set link from a track or profile link', () => {
    expect(isSetUrl('https://soundcloud.com/corlem/sets/free-download')).toBe(true);
    expect(isSetUrl('https://on.soundcloud.com/abc')).toBe(true);
    expect(isSetUrl('https://soundcloud.com/corlem/some-track')).toBe(false);
    expect(isSetUrl('https://soundcloud.com/corlem')).toBe(false);
  });

  it('restores the set order after hydration and reports what never hydrated', () => {
    // api-v2 hands back the first few tracks whole and the rest as stubs; the
    // batch hydrate answers in arbitrary order.
    const stubs = [{ id: 1, kind: 'track', title: 'A' }, { id: 2, kind: 'track', policy: 'ALLOW' }, { id: 3, kind: 'track', policy: 'BLOCK' }, { id: 4, kind: 'track', policy: 'ALLOW' }];
    const hydrated = new Map([[1, stubs[0]], [4, { id: 4, title: 'D' }], [2, { id: 2, title: 'B' }]]);
    const r = orderSetTracks(stubs, hydrated);
    expect(r.tracks.map(t => t.id)).toEqual([1, 2, 4]);
    expect(r.unavailable).toEqual([{ scId: 3, policy: 'BLOCK' }]);
  });

  it('normalizes a bare set track (no like wrapper): no likedAt, same classification', () => {
    const row = normalizeLikedTrack({ id: 7, title: 'X - Y [FREE DL]', user: { id: 1, username: 'X' }, purchase_url: 'https://hypeddit.com/x/y', purchase_title: 'Free Download' });
    expect(row).toMatchObject({ scId: 7, artist: 'X', title: 'Y', likedAt: null });
    expect(row.free.kind).toBe('gate');
  });
});

describe('isOwnTrack', () => {
  it('goes by uploader id, not by a name in the title', () => {
    expect(isOwnTrack({ uploaderId: 1436223944 }, '1436223944')).toBe(true);
    expect(isOwnTrack({ uploaderId: 5, scTitle: 'X [NHI Flip]' }, '1436223944')).toBe(false);
    expect(isOwnTrack({ uploaderId: 5 }, null)).toBe(false);
  });
});

describe('session status note', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-status-'));
  const file = path.join(dir, 'soundcloud-session.json');

  it('records who is signed in and never the token', () => {
    recordSessionStatus({ signedIn: true, token: 'OAuth secret-token', clientId: 'cid', me: { username: 'NHI', permalink: 'nhi-dj', url: 'https://soundcloud.com/nhi-dj' } }, file);
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain('secret-token');
    expect(raw).not.toContain('cid');
    expect(readSessionStatus(file)).toMatchObject({ signedIn: true, username: 'NHI', permalink: 'nhi-dj' });
  });

  it('records a signed-out check with its reason', () => {
    recordSessionStatus({ signedIn: false, diagnostic: 'no OAuth header and no session cookie' }, file);
    expect(readSessionStatus(file)).toMatchObject({ signedIn: false, username: null, reason: 'no OAuth header and no session cookie' });
  });

  it('reads nothing from a missing or broken note', () => {
    expect(readSessionStatus(path.join(dir, 'missing.json'))).toBeNull();
    fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
    expect(readSessionStatus(path.join(dir, 'broken.json'))).toBeNull();
  });
});

describe('account actions', () => {
  it('posts a comment the way the web app does: body and timestamp in the query string', async () => {
    const { commentTrack } = await import('../soundcloud.mjs');
    let seen;
    const page = { evaluate: async (_fn, arg) => { seen = arg; return { status: 200, body: {} }; } };
    const r = await commentTrack(page, { clientId: 'CID', token: 'OAuth T' }, 2134617336, 'dis shit nasty', { timestampMs: 30000.4 });
    expect(r).toEqual({ ok: true, status: 200 });
    const u = new URL(seen.url);
    expect(u.pathname).toBe('/tracks/2134617336/comments');
    expect(Object.fromEntries(u.searchParams)).toEqual({ body: 'dis shit nasty', timestamp: '30000', client_id: 'CID' });
    expect(seen.method).toBe('POST');
    expect(seen.json).toBeUndefined(); // a JSON body is refused with 400
  });
});

describe('account action pacing', () => {
  it('stops sending actions after the first 403, and paces the rest', async () => {
    const { likeTrack, repostTrack } = await import('../soundcloud.mjs');
    const calls = [];
    const page = { evaluate: async (_fn, arg) => { calls.push(arg.url); return { status: calls.length === 1 ? 200 : 403, body: {} }; } };
    const sess = { clientId: 'C', token: 'T', meId: 1, noActionSpacing: true };
    expect((await likeTrack(page, sess, 10)).ok).toBe(true);
    const r = await repostTrack(page, sess, 10);
    expect(r).toMatchObject({ ok: false, status: 403, blocked: true });
    const after = await likeTrack(page, sess, 11);
    expect(after.blocked).toBe(true);
    expect(calls).toHaveLength(2); // the third action was never sent
  });
});
