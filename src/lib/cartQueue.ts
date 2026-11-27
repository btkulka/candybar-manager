// ============================================================
// The cart queue: store tracks Ben picked (on the phone, through the
// web app) that wait for Track Lab to be signed in to the store before
// they go in the cart. Beatport is the reason: its session token comes
// through beatport.com, behind Cloudflare, so a Track Lab running with
// no window can read it only just after a sign-in on the Mac. The
// queue is filled whenever a Beatport token turns up (main.ts,
// drainCartQueue): the store panel, a login window, any sign-in.
//
// One JSON file per profile (cart-queue.json beside config.json).
// Pure apart from reading and writing it.
// ============================================================

import fs from 'fs';
import path from 'path';
import type { StoreMatch } from '../types';

export type CartQueueStore = 'beatport' | 'qobuz';
export type QueuedTrack = { store: CartQueueStore; match: StoreMatch; queuedAt: number };
export type CartQueueState = {
  /** Waiting for the store's sign-in, oldest first. */
  pending: QueuedTrack[];
  /** Put in the cart from the queue, newest last (the last KEEP). */
  added: Array<QueuedTrack & { addedAt: number }>;
  /** Refused by the store (already bought, not lossless, gone): left out, with why (the last KEEP). */
  failed: Array<QueuedTrack & { error: string; at: number }>;
};

const FILE = 'cart-queue.json';
const KEEP = 100;

/** Errors that mean "not signed in yet": the track stays queued. */
const NOT_SIGNED_IN = /not (?:logged|signed) in|session token|sign-?in|authenticat/i;

export const emptyCartQueue = (): CartQueueState => ({ pending: [], added: [], failed: [] });

/** One entry per store track: a resolved track by its id, a whole release by release and request. */
export function queueKey(store: CartQueueStore, m: StoreMatch): string {
  return m.trackId ? `${store}:${m.trackId}` : `${store}:album:${m.albumId ?? ''}:${m.input.key}`;
}

export function readCartQueue(dir: string): CartQueueState {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')) as Partial<CartQueueState>;
    return {
      pending: Array.isArray(raw.pending) ? raw.pending : [],
      added: Array.isArray(raw.added) ? raw.added : [],
      failed: Array.isArray(raw.failed) ? raw.failed : [],
    };
  } catch {
    return emptyCartQueue();
  }
}

export function writeCartQueue(dir: string, state: CartQueueState): void {
  const file = path.join(dir, FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

/** Queue matches for a store. Only lossless matches, and none already
 *  waiting; one put in the cart before can be queued again (it may have
 *  been bought or taken out since). */
export function enqueueCart(state: CartQueueState, store: CartQueueStore, matches: StoreMatch[], now = Date.now()): { state: CartQueueState; queued: StoreMatch[] } {
  const waiting = new Set(state.pending.map(q => queueKey(q.store, q.match)));
  const queued: StoreMatch[] = [];
  for (const m of matches) {
    if (m?.lossless !== true || m.source !== store) continue;
    const key = queueKey(store, m);
    if (waiting.has(key)) continue;
    waiting.add(key);
    queued.push(m);
  }
  const fresh = new Set(queued.map(m => queueKey(store, m)));
  return {
    queued,
    state: {
      pending: [...state.pending, ...queued.map(match => ({ store, match, queuedAt: now }))],
      added: state.added,
      failed: state.failed.filter(f => !fresh.has(queueKey(f.store, f.match))),
    },
  };
}

/** What a cart add of the queued tracks did: added ones leave the queue for
 *  `added`, refused ones for `failed`, and ones that only lacked a sign-in
 *  stay queued. */
export function settleCartQueue(
  state: CartQueueState,
  store: CartQueueStore,
  result: { added: StoreMatch[]; failed: Array<{ match: StoreMatch; error: string }> },
  now = Date.now(),
): CartQueueState {
  const addedKeys = new Set(result.added.map(m => queueKey(store, m)));
  const refused = new Map(result.failed
    .filter(f => !NOT_SIGNED_IN.test(f.error))
    .map(f => [queueKey(store, f.match), f.error] as const));
  const pending: QueuedTrack[] = [];
  const added = [...state.added];
  const failed = [...state.failed];
  for (const q of state.pending) {
    const key = queueKey(q.store, q.match);
    if (q.store === store && addedKeys.has(key)) added.push({ ...q, addedAt: now });
    else if (q.store === store && refused.has(key)) failed.push({ ...q, error: refused.get(key)!, at: now });
    else pending.push(q);
  }
  return { pending, added: added.slice(-KEEP), failed: failed.slice(-KEEP) };
}

/** Take tracks out of the queue (and out of the refused list) by queueKey. */
export function removeFromCartQueue(state: CartQueueState, keys: string[]): CartQueueState {
  const drop = new Set(keys);
  return {
    pending: state.pending.filter(q => !drop.has(queueKey(q.store, q.match))),
    added: state.added,
    failed: state.failed.filter(f => !drop.has(queueKey(f.store, f.match))),
  };
}
