#!/usr/bin/env node
// Apply review verdicts to a playlist-sourcing session, so the buckets, the
// stats and the review page all say what the human decided.
//
//   node apply-review.mjs <session.json> <decisions.json> [--dry-run]
//
// decisions.json:
//   {
//     "note": "one line on the review as a whole",
//     "rows": [
//       { "key": "tate mcrae moore kismet - slower moore kismet remix",
//         "verdict": "skip",  "note": "same remix is already in Rekordbox" },
//       { "key": "Jai Wolf - All Your Love",
//         "verdict": "skip",  "note": "you own the Extended Mix, which covers this" },
//       { "key": "pitchblack - confessions",
//         "verdict": "buy",   "note": "the 63% library hit was Usher's Confessions" },
//       { "key": "lafaye - hidden",
//         "verdict": "wrong", "library": "missing",
//         "note": "store and library both matched Dylan Fogarty's Hidden, a different track" },
//       { "key": "some artist - some title",
//         "verdict": "flag",  "note": "listen before buying — two edits with this name" }
//     ]
//   }
//
// `key` is the row's `key` field, or "Artist - Title" as the playlist spells it.
//
// Verdicts (what happens to the row):
//   skip   already owned. Leaves buy/flagged/notFound; probable → owned.
//   buy    confirmed purchase. Stays in (or returns to) buy with a reviewNote;
//          leaves probable. Refused for a lossy match — that rule has no override.
//          Add "match": {store,title,artists,url,price,lossless:true} to supply a
//          store hit found by hand for a row the run never matched.
//   wrong  the store linked the wrong record. buy/flagged → notFound, with the
//          rejected match kept on the row as `rejectedMatch`.
//   flag   keep it, but for a human: buy → flagged with the note as the flag.
//
// "library": "owned" | "missing" overrides the library side for any verdict
// (skip implies owned, buy implies missing, the others leave it alone).
//
// All-or-nothing: an unknown key or a refused move writes nothing. The first
// run keeps a copy of the untouched session beside it as *.pre-review.json.

import fs from 'fs';

const USAGE = 'usage: node apply-review.mjs <session.json> <decisions.json> [--dry-run]';
const STORE_BUCKETS = ['buy', 'flagged', 'notFound'];
const LIB_BUCKETS = ['owned', 'probable'];
const STORE_FIELDS = ['store', 'match', 'runnerUp', 'status', 'candidates', 'searchErrors', 'flag', 'cartAdded', 'previewPath', 'previewSource', 'rejectedMatch'];

const norm = s => String(s || '')
  .toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

function main() {
  const [, , sessionPath, decisionsPath, ...flags] = process.argv;
  if (!sessionPath || !decisionsPath) { console.error(USAGE); process.exit(1); }
  const dryRun = flags.includes('--dry-run');

  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  if (session.kind === 'soundcloud-likes') {
    console.error('apply-review: this is a SoundCloud-likes session. Its buckets are outcomes, not judgments — nothing to move.');
    process.exit(1);
  }
  const decisions = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));
  const rows = Array.isArray(decisions.rows) ? decisions.rows : [];
  if (!rows.length) { console.error('apply-review: decisions.rows is empty'); process.exit(1); }
  for (const b of [...LIB_BUCKETS, ...STORE_BUCKETS, 'ignored']) session[b] ||= [];

  const find = ref => {
    const want = norm(ref);
    const hits = [];
    for (const bucket of [...LIB_BUCKETS, ...STORE_BUCKETS]) {
      for (const row of session[bucket]) {
        if (row.key === ref || norm(`${row.artist} ${row.title}`) === want) hits.push({ bucket, row });
      }
    }
    return hits;
  };
  const remove = (bucket, row) => { session[bucket] = session[bucket].filter(r => r !== row); };
  const libraryCopy = row => {
    const copy = { ...row };
    for (const f of STORE_FIELDS) delete copy[f];
    return copy;
  };

  const applied = [];
  const errors = [];
  for (const d of rows) {
    const hits = find(d.key);
    if (!hits.length) { errors.push(`no row matches "${d.key}"`); continue; }
    const note = String(d.note || '').trim();
    const verdict = d.verdict;
    const libHit = hits.find(h => LIB_BUCKETS.includes(h.bucket));
    const storeHit = hits.find(h => STORE_BUCKETS.includes(h.bucket));
    const base = (storeHit || libHit).row;
    const label = `${base.artist} - ${base.title}`;
    const library = d.library || (verdict === 'skip' ? 'owned' : verdict === 'buy' ? 'missing' : null);
    if (library && !['owned', 'missing'].includes(library)) { errors.push(`"${label}": library must be owned or missing`); continue; }

    if (verdict === 'skip') {
      for (const h of hits) if (STORE_BUCKETS.includes(h.bucket)) remove(h.bucket, h.row);
    } else if (verdict === 'buy') {
      let target = storeHit?.row;
      if (d.match) {
        const m = d.match;
        if (!m.store || !m.title || !m.url) { errors.push(`"${label}": match needs store, title and url`); continue; }
        if (m.lossless !== true) { errors.push(`"${label}": a hand-supplied match must say lossless: true — lossy never reaches the buy list`); continue; }
        if (!target) { target = libraryCopy(base); session.buy.push(target); storeHitBucket(target); }
        target.store = m.store;
        target.match = { ...m, artists: Array.isArray(m.artists) ? m.artists : [m.artists || base.artist], score: m.score ?? null, byHand: true };
        target.status = 'matched';
      }
      if (!target) { errors.push(`"${label}" was never searched (it sat in ${libHit.bucket}); add a "match" found by hand, or re-run the search`); continue; }
      if (target.match?.lossless === false) { errors.push(`"${label}" is a lossy store match — it cannot be moved to the buy list`); continue; }
      if (!target.match) { errors.push(`"${label}" has no store match to buy (it is in notFound); add a "match" found by hand`); continue; }
      const bucketNow = STORE_BUCKETS.find(b => session[b].includes(target));
      if (bucketNow !== 'buy') { if (bucketNow) remove(bucketNow, target); session.buy.push(target); }
      delete target.flag;
      target.status = 'matched';
      target.reviewNote = note;
    } else if (verdict === 'wrong') {
      if (!storeHit) { errors.push(`"${label}" has no store row to reject (it is in ${libHit.bucket})`); continue; }
      const t = storeHit.row;
      if (storeHit.bucket !== 'notFound') { remove(storeHit.bucket, t); session.notFound.push(t); }
      if (t.match) t.rejectedMatch = { store: t.store, title: t.match.title, artists: t.match.artists, url: t.match.url, score: t.match.score ?? null };
      t.match = null; t.store = null; t.status = 'not_found';
      delete t.flag; delete t.cartAdded; delete t.previewPath; delete t.previewSource;
      t.reason = note; t.reviewNote = note;
    } else if (verdict === 'flag') {
      if (!storeHit) { errors.push(`"${label}" has no store row to flag (it is in ${libHit.bucket})`); continue; }
      const t = storeHit.row;
      if (storeHit.bucket !== 'flagged') { remove(storeHit.bucket, t); session.flagged.push(t); }
      t.flag = note || 'flagged in review'; t.reviewNote = note;
    } else {
      errors.push(`"${label}": unknown verdict "${verdict}" (skip | buy | wrong | flag)`);
      continue;
    }

    if (library === 'owned') {
      const r = libHit ? libHit.row : libraryCopy(base);
      if (libHit) remove(libHit.bucket, r);
      r.libraryStatus = 'owned'; r.reason = note; r.reviewNote = note;
      session.owned.push(r);
      for (const h of hits) if (STORE_BUCKETS.includes(h.bucket)) h.row.libraryStatus = 'owned';
    } else if (library === 'missing') {
      if (libHit) remove(libHit.bucket, libHit.row);
      for (const h of hits) if (STORE_BUCKETS.includes(h.bucket)) { h.row.libraryStatus = 'missing'; if (note) h.row.reason = note; }
    }
    applied.push(`${verdict.padEnd(5)}  ${label}${note ? `  — ${note}` : ''}`);
  }

  for (const line of applied) console.error(`  ${line}`);
  if (errors.length) {
    console.error(`\napply-review: ${errors.length} problem(s), nothing written:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const s = session.stats ||= {};
  s.owned = session.owned.length;
  s.probable = session.probable.length;
  s.ignored = session.ignored.length;
  if (typeof s.total === 'number') s.missing = Math.max(0, s.total - s.owned - s.probable - s.ignored);
  s.buy = session.buy.length;
  s.flagged = session.flagged.length;
  s.notFound = session.notFound.length;
  s.reviewed = { at: new Date().toISOString(), by: 'playlist-sourcing review', note: String(decisions.note || ''), applied: applied.length };

  const summary = `owned ${s.owned} · probable ${s.probable} · buy ${s.buy} · flagged ${s.flagged} · notFound ${s.notFound}`;
  if (dryRun) { console.error(`\n(dry run) would write: ${summary}`); return; }

  const backup = sessionPath.replace(/\.json$/i, '') + '.pre-review.json';
  if (!fs.existsSync(backup)) fs.copyFileSync(sessionPath, backup);
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
  console.error(`\napplied ${applied.length} verdict(s): ${summary}`);
  console.error(`untouched copy: ${backup}`);
  console.error('re-render the page: node <repo>/lib/sourcing/review.mjs ' + sessionPath + ' <out.html>');
  console.log(sessionPath);
}

// A row created from a library-only row has no store bucket yet; nothing to do
// beyond pushing it, kept as a named step so the intent reads.
function storeHitBucket() {}

main();
