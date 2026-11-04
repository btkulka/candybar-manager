// Fill the real store carts (Qobuz and Beatport) from a sourcing session.
//
// The carts belong to the store accounts signed in to Track Lab (Settings →
// Qobuz / Beatport), so the adds run in the app, through its store bridge
// (lib/storeBridge.mjs), on the first account of each store. Neither store
// takes a cart add from a web page (Qobuz wants an XHR from its own site,
// Beatport's API wants the account's Bearer token), so the review page only
// opens track pages and this does the actual adds.
//
// The app holds the line on lossless: it refuses anything not marked lossless,
// and for Qobuz it re-reads the track's tiers and adds a lossless one only.
// This file keeps the session's bookkeeping: what was added, what the account
// already owns, and what was removed on the review page.

import fs from 'fs';
import path from 'path';
import { callApp } from '../storeBridge.mjs';
import { recordEvent, eventFromCart } from './history.mjs';

const STORE_NAME = { qobuz: 'Qobuz', beatport: 'Beatport' };

/** The article id behind a row's chosen cart tier (the review page's link).
 *  Set only from a lossless tier, so it doubles as "a lossless tier exists". */
function articleIdOf(row) {
  const u = row.match?.cartUrl || '';
  return (u.match(/articleId=(\d+)/) || [])[1] || null;
}

/** Rewrite the session atomically: a crash mid-write must not leave half a file. */
function writeSession(sessionPath, session) {
  const tmp = `${sessionPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 1));
  fs.renameSync(tmp, sessionPath);
}

/**
 * Take the rows removed on the review page out of the buy list. The page can
 * only remember a removal in its own browser, so it hands over the keys as
 * `--skip`; they move to `session.removed`, and stay out of every later run.
 * Returns true when the session changed.
 */
export function applyRemovals(session, skip, log = () => {}) {
  if (!skip || skip.size === 0) return false;
  const keep = [], gone = [];
  for (const r of session.buy || []) (skip.has(r.key) ? gone : keep).push(r);
  if (gone.length === 0) return false;
  const at = new Date().toISOString();
  session.buy = keep;
  (session.removed ||= []).push(...gone.map(r => ({ ...r, removedAt: at })));
  if (session.stats) session.stats.buy = keep.length;
  log(`      cart: left out ${gone.length} row(s) removed on the review page`);
  return true;
}

/** Rows of `store` the cart can take: a positively lossless match. */
function cartable(row, store) {
  if (row.store !== store || row.match?.lossless === false) return false;
  return store === 'qobuz' ? Boolean(articleIdOf(row)) : Boolean(row.match?.id);
}

const names = list => (list || []).map(a => (typeof a === 'string' ? a : a?.name)).filter(Boolean).join(', ');

/** A session row as the app's StoreMatch. `input.key` carries the row key
 *  through the app and back, so results map onto rows exactly. */
export function toStoreMatch(row, store) {
  const m = row.match || {};
  const base = {
    input: { key: row.key, artist: row.artist, title: row.title },
    source: store,
    title: row.title,
    artist: names(m.artists) || row.artist,
    label: m.label || '',
    price: m.price || '',
    confidence: m.score ?? 0,
    url: m.url || '',
    lossless: cartable(row, store),
  };
  return store === 'beatport'
    ? { ...base, trackId: String(m.id), format: 'WAV' }
    // Qobuz search matches a release; the resolved track id rides along when
    // resolveCart found it, and the app looks it up on the release otherwise.
    : { ...base, trackId: m.trackId ? String(m.trackId) : '', albumId: m.id ? String(m.id) : undefined, album: m.title || '', quality: m.cartLabel || '' };
}

/**
 * Add every `store` buy row that hasn't been added yet. Records `cartAdded` on
 * each row and rewrites the session, so a re-run only adds what's missing. A
 * Beatport track the account already owns moves from `buy` to `flagged`: it
 * needs a download and a Rekordbox import, not a second purchase.
 * Returns { added, failed, purchased, signedIn } (keys of rows).
 */
export async function fillCart(sessionPath, store, { log = () => {}, only = null, skip = null, force = false, call = callApp } = {}) {
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  if (applyRemovals(session, skip, log)) writeSession(sessionPath, session);
  const rows = (session.buy || []).filter(r => cartable(r, store)
    && (force || !r.cartAdded) && (!only || only.has(r.key)));
  const added = [], failed = [], purchased = [];
  if (!rows.length) {
    log(`      cart: no ${STORE_NAME[store]} rows to add`);
    return { added, failed, purchased, signedIn: null };
  }

  log(`      cart: adding ${rows.length} ${STORE_NAME[store]} track(s) through Track Lab…`);
  let result;
  try {
    result = await call('cartAdd', { store, matches: rows.map(r => toStoreMatch(r, store)) }, {
      onProgress: m => log(`      cart: ${m}`),
      timeoutMs: 30 * 60_000,
    });
  } catch (err) {
    log(`      cart: ${err.message} — nothing added`);
    return { added, failed: rows.map(r => ({ key: r.key, reason: err.message })), purchased, signedIn: false };
  }

  const byKey = new Map(rows.map(r => [r.key, r]));
  const at = new Date().toISOString();
  const origin = { origin: session.playlist?.name, session: path.basename(sessionPath) };
  for (const m of result.added || []) {
    const r = byKey.get(m.input?.key);
    if (!r) continue;
    r.cartAdded = r.cartAdded || at;
    added.push(r.key);
    recordEvent(eventFromCart(r, store, origin));
    log(`      cart: added ${r.artist} - ${r.title}${m.price ? ` (${m.price})` : ''}`);
  }
  for (const f of result.failed || []) {
    const r = byKey.get(f.match?.input?.key);
    if (!r) continue;
    if (store === 'beatport' && /^Already purchased/i.test(f.error || '')) {
      session.buy = session.buy.filter(x => x !== r);
      (session.flagged ||= []).push({ ...r, flag: 'already purchased on Beatport — download it from your Beatport library and import it; it isn\'t in Rekordbox' });
      purchased.push(r.key);
      log(`      cart: ALREADY PURCHASED ${r.artist} - ${r.title} — moved to flagged`);
    } else {
      failed.push({ key: r.key, reason: f.error });
      log(`      cart: FAILED ${r.artist} - ${r.title}: ${f.error}`);
    }
  }
  if (session.stats) {
    session.stats.buy = session.buy.length;
    session.stats.flagged = (session.flagged || []).length;
  }
  writeSession(sessionPath, session);
  log(`      cart: ${STORE_NAME[store]} ${added.length} in cart, ${purchased.length} already owned, ${failed.length} failed`);
  return { added, failed, purchased, signedIn: true };
}

export const fillQobuzCart = (sessionPath, opts) => fillCart(sessionPath, 'qobuz', opts);
export const fillBeatportCart = (sessionPath, opts) => fillCart(sessionPath, 'beatport', opts);

// CLI: node lib/sourcing/cart.mjs <session.json> [--store beatport|qobuz] [--force]
//                                   [--skip key,key…] [--only key,key…]
// --skip is what the review page's "Removed from the buy list" box hands over.
if (process.argv[1] && process.argv[1].endsWith('cart.mjs')) {
  const [, , sessionPath, ...flags] = process.argv;
  if (!sessionPath) {
    console.error('usage: node lib/sourcing/cart.mjs <session.json> [--store beatport|qobuz] [--force] [--skip key,key…] [--only key,key…]');
    process.exit(1);
  }
  const flag = name => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : null);
  const keys = v => (v ? new Set(v.split(',').map(k => k.trim()).filter(Boolean)) : null);
  const store = flag('--store');
  const opts = { log: m => console.error(m), force: flags.includes('--force'), skip: keys(flag('--skip')), only: keys(flag('--only')) };
  const out = {};
  if (!store || store === 'beatport') out.beatport = await fillBeatportCart(sessionPath, opts);
  if (!store || store === 'qobuz') out.qobuz = await fillQobuzCart(sessionPath, opts);
  console.log(JSON.stringify(out));
}
