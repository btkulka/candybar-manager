// The cart queue: Beatport tracks picked on the phone wait for Track Lab's
// Beatport sign-in, then go in the cart; refused ones are set aside with why.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { emptyCartQueue, enqueueCart, settleCartQueue, removeFromCartQueue, queueKey, readCartQueue, writeCartQueue } from '../cartQueue';
import type { StoreMatch } from '../../types';

const bp = (id: string, over: Partial<StoreMatch> = {}): StoreMatch => ({
  input: { key: `k${id}`, artist: 'A', title: `T${id}` }, trackId: id, title: `T${id}`, artist: 'A', album: '', label: '',
  price: '$1.49', quality: '', format: 'lossless', lossless: true, rx3Compatible: false, confidence: 1, url: '', source: 'beatport', ...over,
});

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartqueue-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('cart queue', () => {
  it('queues lossless Beatport matches once each', () => {
    let { state, queued } = enqueueCart(emptyCartQueue(), 'beatport', [bp('1'), bp('2'), bp('1')], 10);
    expect(queued.map(m => m.trackId)).toEqual(['1', '2']);
    ({ state, queued } = enqueueCart(state, 'beatport', [bp('2'), bp('3')], 20));
    expect(queued.map(m => m.trackId)).toEqual(['3']);
    expect(state.pending.map(q => [q.match.trackId, q.queuedAt])).toEqual([['1', 10], ['2', 10], ['3', 20]]);
  });

  it('never queues a lossy match or another store\'s', () => {
    const { queued } = enqueueCart(emptyCartQueue(), 'beatport', [bp('1', { lossless: false }), bp('2', { source: 'qobuz' })]);
    expect(queued).toEqual([]);
  });

  it('moves added tracks out, sets refused ones aside, keeps ones that only lacked a sign-in', () => {
    const { state } = enqueueCart(emptyCartQueue(), 'beatport', [bp('1'), bp('2'), bp('3')]);
    const next = settleCartQueue(state, 'beatport', {
      added: [bp('1')],
      failed: [
        { match: bp('2'), error: 'Already purchased' },
        { match: bp('3'), error: 'Not logged in to Beatport — open Beatport Cart once to complete login' },
      ],
    }, 99);
    expect(next.pending.map(q => q.match.trackId)).toEqual(['3']);
    expect(next.added.map(q => [q.match.trackId, q.addedAt])).toEqual([['1', 99]]);
    expect(next.failed.map(q => [q.match.trackId, q.error])).toEqual([['2', 'Already purchased']]);
  });

  it('can queue a refused track again, and remove by key', () => {
    let { state } = enqueueCart(emptyCartQueue(), 'beatport', [bp('1'), bp('2')]);
    state = settleCartQueue(state, 'beatport', { added: [], failed: [{ match: bp('1'), error: 'Gone' }] });
    expect(state.failed).toHaveLength(1);
    ({ state } = enqueueCart(state, 'beatport', [bp('1')]));
    expect(state.failed).toHaveLength(0);
    expect(state.pending).toHaveLength(2);
    state = removeFromCartQueue(state, [queueKey('beatport', bp('2'))]);
    expect(state.pending.map(q => q.match.trackId)).toEqual(['1']);
  });

  it('keeps the queue in the profile folder', () => {
    expect(readCartQueue(dir)).toEqual(emptyCartQueue());
    const { state } = enqueueCart(emptyCartQueue(), 'beatport', [bp('7')]);
    writeCartQueue(dir, state);
    expect(readCartQueue(dir).pending.map(q => q.match.trackId)).toEqual(['7']);
    fs.writeFileSync(path.join(dir, 'cart-queue.json'), '{not json');
    expect(readCartQueue(dir)).toEqual(emptyCartQueue());
  });
});
