// The lasting record of what playlist sourcing acquired, across every run.
//
// Sessions describe one run and the SoundCloud ledger only answers "skip
// this?", so this is the one place that answers "what did I get, when, from
// where". It is an append-only JSON Lines file beside the app's other data:
// one event per line, never rewritten, so a crash costs at most the last line.
//
// Events:
//   downloaded     a free file landed in the intake folder
//   lossy-dropped  a free file arrived lossy and was deleted by request
//   lossy-kept     a free file arrived lossy and was parked under lossy/
//   duplicate-removed  a fetched copy was deleted because Rekordbox already has it
//   cart-added     a store track went into a cart (not yet a purchase)
//   purchased      the store reports the track as bought (list_purchases)
//
// Each (event, source, id) is recorded once, so re-runs and backfills are safe.
//
//   node lib/sourcing/history.mjs                    # newest first
//   node lib/sourcing/history.mjs --event purchased --source beatport --since 2026-10-01
//   node lib/sourcing/history.mjs --search murph --json
//   node lib/sourcing/history.mjs --backfill         # fold in the ledger and SoundCloud sessions

import fs from 'fs';
import path from 'path';
import { USER_DATA_DIR, REPO_ROOT, sessionDir } from './config.mjs';

export const HISTORY_PATH = process.env.CANDYBAR_SOURCING_HISTORY || path.join(USER_DATA_DIR, 'sourcing-history.jsonl');

const keyOf = e => `${e.event}|${e.source}|${e.id ?? `${e.artist} - ${e.title}`}`.toLowerCase();

export function readHistory(file = HISTORY_PATH) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  // A torn last line from a crash is skipped, not fatal.
  for (const line of text.split('\n')) { if (line.trim()) { try { out.push(JSON.parse(line)); } catch { /* torn */ } } }
  return out;
}

/** Append events not recorded yet. Never throws: a full disk or a bad path must
 *  not stop a download, so failures come back as `error`. */
export function recordEvents(events, file = HISTORY_PATH) {
  try {
    const seen = new Set(readHistory(file).map(keyOf));
    const fresh = [];
    for (const e of events) {
      const entry = { at: new Date().toISOString(), ...e };
      const k = keyOf(entry);
      if (seen.has(k)) continue;
      seen.add(k);
      fresh.push(Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined && v !== null)));
    }
    if (fresh.length) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, fresh.map(e => JSON.stringify(e)).join('\n') + '\n');
    }
    return { added: fresh.length };
  } catch (err) {
    return { added: 0, error: err.message };
  }
}

export const recordEvent = (event, file) => recordEvents([event], file);

/** One finished SoundCloud row → its history event, or null. */
export function eventFromRow(row, outcome, { origin = 'likes', session = null, at } = {}) {
  // A duplicate was deleted for already being owned, not for being lossy, and
  // has its own duplicate-removed event.
  if (outcome.status === 'duplicate') return null;
  const kept = outcome.files || [];
  const dropped = (outcome.dropped || []).filter(d => d.reason !== 'already in library');
  const lossless = kept.filter(f => f.lossless === true);
  const event = lossless.length ? 'downloaded'
    : kept.length ? 'lossy-kept'
      : dropped.length ? 'lossy-dropped' : null;
  if (!event) return null;
  return {
    at, event, source: row.source || 'soundcloud', id: row.scId, artist: row.artist, title: row.title, url: row.url,
    origin, via: outcome.via, gate: row.free?.gate?.host, session,
    files: kept.map(f => ({ path: f.path, codec: f.codec || f.ext, lossless: f.lossless })),
    deleted: dropped.length ? dropped.map(d => ({ codec: d.codec || d.ext, original: d.original })) : undefined,
  };
}

export const eventFromCart = (row, store, { origin = null, session = null } = {}) => ({
  at: row.cartAdded, event: 'cart-added', source: store, id: row.match?.id, artist: row.artist, title: row.title,
  url: row.match?.url, origin, session, price: row.match?.price, format: row.match?.cartLabel,
});

export const eventFromPurchase = t => ({
  at: t.purchasedAt, event: 'purchased', source: t.store || t.source, id: t.id ?? t.trackId, artist: t.artist, title: t.title,
  url: t.url, format: t.format, price: t.price,
});

export function queryHistory({ event, source, since, search, file } = {}) {
  const cutoff = since ? Date.parse(since) : null;
  const needle = search?.toLowerCase();
  return readHistory(file)
    .filter(e => (!event || e.event === event) && (!source || e.source === source)
      && (!cutoff || Date.parse(e.at) >= cutoff)
      && (!needle || `${e.artist} ${e.title}`.toLowerCase().includes(needle)))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** Fold in everything recorded before this file existed. */
export function backfill(file = HISTORY_PATH) {
  const events = [];
  const dirs = [sessionDir(), path.join(REPO_ROOT, 'sourcing-sessions')];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { continue; }
    for (const name of names) {
      let s;
      try { s = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
      if (s.kind === 'soundcloud-likes') {
        const origin = s.source?.kind === 'set' ? s.source.set : 'likes';
        for (const r of [...(s.downloaded || []), ...(s.flagged || []), ...(s.dropped || [])]) {
          if (r.outcome) { const e = eventFromRow(r, r.outcome, { origin, session: name, at: s.createdAt }); if (e) events.push(e); }
        }
      } else {
        for (const r of [...(s.buy || []), ...(s.flagged || [])]) {
          if (r.cartAdded) events.push(eventFromCart(r, r.match?.source || r.match?.store, { origin: s.playlist?.name, session: name }));
        }
      }
    }
  }
  // Ledger last: it knows entries whose session has since been lost.
  try {
    const ledger = JSON.parse(fs.readFileSync(path.join(sessionDir(), 'soundcloud-downloads.json'), 'utf8'));
    for (const [id, e] of Object.entries(ledger)) {
      const ev = eventFromRow({ scId: Number(id), artist: e.artist, title: e.title, url: e.url }, e, { at: e.at });
      if (ev) events.push(ev);
    }
  } catch { /* no ledger yet */ }
  return recordEvents(events, file);
}

function cli(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--json') a.json = true;
    else if (k === '--backfill') a.backfill = true;
    else if (k.startsWith('--')) a[k.slice(2)] = argv[++i];
  }
  if (a.backfill) { console.log(JSON.stringify(backfill())); return; }
  const rows = queryHistory(a);
  if (a.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  for (const e of rows) {
    console.log([String(e.at).slice(0, 10), e.event.padEnd(13), e.source.padEnd(10), `${e.artist} - ${e.title}`, e.price || '', e.files?.[0]?.codec || ''].join('  ').trimEnd());
  }
  console.error(`${rows.length} event(s) in ${HISTORY_PATH}`);
}

if (process.argv[1] && process.argv[1].endsWith('history.mjs')) cli(process.argv);
