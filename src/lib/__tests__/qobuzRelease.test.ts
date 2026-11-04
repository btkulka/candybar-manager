/**
 * Qobuz release → track → tier. Search hands over releases; the cart takes one
 * track's lossless tier. Every case is one that put the wrong thing in a cart:
 * the release title picking the original for a remix request, "the first
 * track" standing in for a track that couldn't be read, an MP3 tier winning on
 * Qobuz's own ordering.
 */

import { describe, it, expect } from 'vitest';
import { parseQobuzAlbumPage, parseQobuzPopin, readQobuzCartPage } from '../qobuz';
import { pickReleaseTrack, pickQobuzLosslessTier } from '../storeMatching';
import { sniffAudio, extFromUrlOrType } from '../audioSniff';

const EP = [
  { id: '100', title: 'Your Mind (Original Mix)', artist: 'Adam Beyer' },
  { id: '101', title: 'Your Mind (HNTR Remix)', artist: 'Adam Beyer' },
  { id: '102', title: 'Your Mind (Extended Mix)', artist: 'Adam Beyer' },
];

describe('pickReleaseTrack', () => {
  it('scores the request, not the release title', () => {
    expect(pickReleaseTrack({ artist: 'Adam Beyer', title: 'Your Mind (HNTR Remix)' }, EP)?.track.id).toBe('101');
  });

  it('lands an unversioned request on the extended cut', () => {
    expect(pickReleaseTrack({ artist: 'Adam Beyer', title: 'Your Mind' }, EP)?.track.id).toBe('102');
  });

  it('returns nothing rather than the first track when nothing matches', () => {
    expect(pickReleaseTrack({ artist: 'Adam Beyer', title: 'Something Else Entirely' }, EP)).toBeNull();
    expect(pickReleaseTrack({ artist: 'Adam Beyer', title: 'Your Mind' }, [])).toBeNull();
  });

  it('uses the release artists for rows that carry none', () => {
    const rows = [{ id: '1', title: 'Glue', artist: '' }];
    expect(pickReleaseTrack({ artist: 'Bicep', title: 'Glue' }, rows, ['Bicep'])?.track.id).toBe('1');
    expect(pickReleaseTrack({ artist: 'Bicep', title: 'Glue' }, rows, [])).toBeNull();
  });
});

describe('album page parsing', () => {
  it('reads each row and skips one without a readable title', () => {
    const html = `<ul>
      <li class="track"><span class="track__title">Your Mind (HNTR Remix)</span><span class="track__artist">Adam Beyer</span>
        <button data-url="/v4/ajax/popin-add-cart/track/101">Buy</button></li>
      <li class="track"><button data-url="/v4/ajax/popin-add-cart/track/999">Buy</button></li>
    </ul>`;
    expect(parseQobuzAlbumPage(html)).toEqual([{ id: '101', title: 'Your Mind (HNTR Remix)', artist: 'Adam Beyer' }]);
  });
});

describe('popin tiers', () => {
  const popin = `<div>
    <button class="store-modal__quality" data-label="MP3 320 kbps" data-price="1.29" data-id="1" data-cart-link="/v4/ajax/add-cart?articleId=1">MP3</button>
    <button class="store-modal__quality" data-label="CD Quality 16-Bit 44.1 kHz" data-price="1.49" data-id="2" data-cart-link="/v4/ajax/add-cart?articleId=2">CD</button>
    <button class="store-modal__quality" data-label="Hi-Res 24-Bit 96 kHz" data-price="1.99" data-id="3" data-cart-link="/v4/ajax/add-cart?articleId=3">Hi-Res</button>
  </div>`;

  it('picks the best lossless tier with its own price', () => {
    const tier = pickQobuzLosslessTier(parseQobuzPopin(popin));
    expect(tier?.articleId).toBe('3');
    expect(tier?.price).toBe('$1.99');
  });

  it('offers nothing when only MP3 is sold', () => {
    const mp3Only = `<button data-label="MP3 320 kbps" data-cart-link="/v4/ajax/add-cart?articleId=1">MP3</button>`;
    expect(pickQobuzLosslessTier(parseQobuzPopin(mp3Only))).toBeNull();
  });
});

describe('downloaded file format', () => {
  const bytes = (s: string, at = 0) => { const b = new Uint8Array(16); for (let i = 0; i < s.length; i++) b[at + i] = s.charCodeAt(i); return b; };

  it('reads the container from the bytes, not the name', () => {
    const wav = bytes('RIFF'); wav.set(bytes('WAVE').subarray(0, 4), 8);
    expect(sniffAudio(wav)).toEqual({ ext: 'wav', lossless: true });
    const aiff = bytes('FORM'); aiff.set(bytes('AIFF').subarray(0, 4), 8);
    expect(sniffAudio(aiff)).toEqual({ ext: 'aiff', lossless: true });
    expect(sniffAudio(bytes('fLaC'))).toEqual({ ext: 'flac', lossless: true });
    expect(sniffAudio(bytes('ID3'))).toEqual({ ext: 'mp3', lossless: false });
    expect(sniffAudio(new Uint8Array(16))).toEqual({ ext: null, lossless: null });
  });

  it('reads a signed URL by its path, then by Content-Type', () => {
    expect(extFromUrlOrType('https://dl.example.com/a/track.wav?Expires=1&Signature=x')).toBe('wav');
    expect(extFromUrlOrType('https://dl.example.com/a/track.aif?sig=1')).toBe('aiff');
    expect(extFromUrlOrType('https://dl.example.com/a/download?id=9', 'audio/flac; charset=binary')).toBe('flac');
    expect(extFromUrlOrType('https://dl.example.com/a/download', null)).toBeNull();
  });
});

describe('readQobuzCartPage', () => {
  const items = [{ trackId: '111', articleId: 'a-9' }, { trackId: '222' }];

  it('reads an empty cart from the redirect to the shop', () => {
    expect(readQobuzCartPage('https://www.qobuz.com/us-en/shop', '<p>Your basket is empty</p>', items))
      .toEqual({ signedOut: false, empty: true, present: [] });
  });
  it('reads a signed-out session from the redirect to /signin', () => {
    expect(readQobuzCartPage('https://www.qobuz.com/signin?url=x', '', items)).toEqual({ signedOut: true });
  });
  it('finds the tracks still in the cart by track or article id', () => {
    expect(readQobuzCartPage('https://www.qobuz.com/shopping-cart', '<a data-id="a-9">x</a>', items))
      .toEqual({ signedOut: false, empty: false, present: ['111'] });
  });
  it("won't call tracks gone when the page names none of them", () => {
    expect(readQobuzCartPage('https://www.qobuz.com/shopping-cart', '<div class="cart">3 items</div>', items))
      .toEqual({ signedOut: false, empty: false, present: null });
  });
});
