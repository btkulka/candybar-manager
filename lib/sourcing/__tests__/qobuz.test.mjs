// Locks the Qobuz release → track → tier reading the CLI cart depends on.
// Markup is the shape the TS app parses (store-modal__quality buttons with
// data-* attributes, track rows with track__title), cut down.

import { describe, it, expect } from 'vitest';
import { parseCartOptions, parseAlbumPageTracks, classifyTier } from '../qobuz.mjs';

const button = (label, price, articleId) =>
  `<button class="store-modal__quality" data-label="${label}" data-price="${price}" data-cart-link="/v4/ajax/add-cart?articleId=${articleId}">${label} <span>$${price}</span></button>`;

describe('Qobuz quality tiers', () => {
  it('never lets an MP3 option borrow the next button\'s Hi-Res label', () => {
    const html = `<div>${button('MP3 320 kbps', '1.29', 1)}${button('Hi-Res 24-Bit 96 kHz', '1.99', 2)}</div>`;
    const opts = parseCartOptions(html);
    const mp3 = opts.find(o => o.cartUrl.endsWith('articleId=1'));
    const hires = opts.find(o => o.cartUrl.endsWith('articleId=2'));
    expect(mp3.lossless).toBe(false);
    expect(hires.lossless).toBe(true);
    expect(opts[0]).toBe(hires);
    expect(hires.price).toBe('$1.99');
  });

  it('counts an unlabeled option as not lossless', () => {
    expect(parseCartOptions(`<a data-cart-link="/v4/ajax/add-cart?articleId=9">Buy</a>`)[0].lossless).toBe(false);
    expect(classifyTier('CD Quality 16-Bit 44.1 kHz')).toBe('cd');
    expect(classifyTier('Standard')).toBe('unknown');
  });
});

describe('Qobuz release tracks', () => {
  it('reads each row\'s own title, not a neighbour\'s', () => {
    const row = (title, id) =>
      `<div class="track"><span class="track__title">${title}</span><span class="track__artist">Adam Beyer</span>${' '.repeat(300)}<button data-url="/v4/ajax/popin-add-cart/track/${id}">Buy</button></div>`;
    const html = row('Your Mind (Original Mix)', 100) + row('Your Mind (HNTR Remix)', 101) + row('Your Mind (Extended Mix)', 102);
    expect(parseAlbumPageTracks(html).map(t => [t.id, t.title])).toEqual([
      ['100', 'Your Mind (Original Mix)'],
      ['101', 'Your Mind (HNTR Remix)'],
      ['102', 'Your Mind (Extended Mix)'],
    ]);
  });

  it('leaves out a row whose title it can\'t read', () => {
    expect(parseAlbumPageTracks('<li><button data-url="/v4/ajax/popin-add-cart/track/5">Buy</button></li>')).toEqual([]);
  });
});
