// cart.mjs hands buy rows to Track Lab's cart code and keeps the session's
// books. `call` stands in for the app, so this runs without it.

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// history.mjs reads this once at import: set it first, so cart adds made here
// never land in the real sourcing history.
process.env.CANDYBAR_SOURCING_HISTORY = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cart-history-')), 'history.jsonl');
const { fillCart, toStoreMatch } = await import('../cart.mjs');

const qobuzRow = {
  key: 'q1', store: 'qobuz', artist: 'Chris Lake', title: 'Turn Off The Lights',
  match: { id: 'alb9', trackId: 123, title: 'Turn Off The Lights EP', artists: ['Chris Lake'], url: 'https://www.qobuz.com/album/x', price: '$1.99', cartUrl: 'https://www.qobuz.com/v4/ajax/add-cart?articleId=555', cartLabel: 'CD', lossless: true },
};
const qobuzNoTier = { ...qobuzRow, key: 'q2', match: { ...qobuzRow.match, cartUrl: '' } };
const beatportRow = {
  key: 'b1', store: 'beatport', artist: 'Fisher', title: 'Losing It',
  match: { id: 987, artists: [{ name: 'Fisher' }], url: 'https://www.beatport.com/track/x/987', price: '$1.49', lossless: true },
};
const beatportOwned = { ...beatportRow, key: 'b2', title: 'You Little Beauty', match: { ...beatportRow.match, id: 654 } };

let sessionPath;
const read = () => JSON.parse(fs.readFileSync(sessionPath, 'utf8'));

beforeEach(() => {
  sessionPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cart-')), 'session.json');
  fs.writeFileSync(sessionPath, JSON.stringify({ playlist: { name: 'Test' }, buy: [qobuzRow, qobuzNoTier, beatportRow, beatportOwned], stats: { buy: 4 } }));
});

describe('toStoreMatch', () => {
  it('carries the row key through the app and keeps the release for Qobuz', () => {
    const m = toStoreMatch(qobuzRow, 'qobuz');
    expect(m).toMatchObject({ input: { key: 'q1' }, source: 'qobuz', trackId: '123', albumId: 'alb9', artist: 'Chris Lake', lossless: true });
  });

  it('marks a Qobuz row with no lossless tier as not lossless', () => {
    expect(toStoreMatch(qobuzNoTier, 'qobuz').lossless).toBe(false);
  });

  it('reads Beatport artist objects', () => {
    expect(toStoreMatch(beatportRow, 'beatport')).toMatchObject({ trackId: '987', artist: 'Fisher', lossless: true });
  });
});

describe('fillCart', () => {
  it('sends only lossless rows of the store and records what went in', async () => {
    let sent;
    const call = async (method, params) => {
      sent = { method, params };
      return { added: params.matches, failed: [], totalCost: '$1.99' };
    };
    const r = await fillCart(sessionPath, 'qobuz', { call });
    expect(sent.method).toBe('cartAdd');
    expect(sent.params.matches.map(m => m.input.key)).toEqual(['q1']);
    expect(r.added).toEqual(['q1']);
    expect(read().buy.find(x => x.key === 'q1').cartAdded).toBeTruthy();
  });

  it('moves a Beatport track the account already owns to flagged', async () => {
    const call = async (_m, params) => ({
      added: [params.matches[0]],
      failed: [{ match: params.matches[1], error: 'Already purchased — you own this track' }],
    });
    const r = await fillCart(sessionPath, 'beatport', { call });
    expect(r).toMatchObject({ added: ['b1'], purchased: ['b2'], failed: [] });
    const s = read();
    expect(s.buy.map(x => x.key)).not.toContain('b2');
    expect(s.flagged.map(x => x.key)).toEqual(['b2']);
  });

  it('adds nothing and says why when Track Lab can\'t do it', async () => {
    const call = async () => { throw new Error('No Beatport account in Track Lab yet'); };
    const r = await fillCart(sessionPath, 'beatport', { call });
    expect(r.signedIn).toBe(false);
    expect(r.failed.map(f => f.key)).toEqual(['b1', 'b2']);
    expect(read().buy.every(x => !x.cartAdded)).toBe(true);
  });

  it('skips rows already added unless forced, and leaves removed rows out', async () => {
    const calls = [];
    const call = async (_m, params) => { calls.push(params.matches.map(m => m.input.key)); return { added: params.matches, failed: [] }; };
    await fillCart(sessionPath, 'beatport', { call, skip: new Set(['b2']) });
    await fillCart(sessionPath, 'beatport', { call });
    expect(calls).toEqual([['b1']]);
    expect(read().removed.map(x => x.key)).toEqual(['b2']);
  });
});
