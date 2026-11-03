#!/usr/bin/env node
// Playlist sourcing — one command, four phases.
//
//   node bin/source-playlist.mjs --playlist <spotify-url> [options]
//   node bin/source-playlist.mjs --csv <path> [options]
//
// Options:
//   --limit N        only source the first N tracks (smoke tests)
//   --prefer cd      cheaper CD-quality Qobuz tier instead of Hi-Res
//   --out PATH       session JSON destination (default: sourcing-sessions/)
//   --resume PATH    reuse store results from an earlier session file
//   --skip-beatport  Qobuz only; no browser launch
//   --headless       try headless Chrome (Cloudflare usually blocks this)
//   --no-library     skip the Rekordbox check — every track is wanted (buying for someone else)
//
// Progress goes to stderr; the session JSON path goes to stdout. The session
// file is rewritten after every track, so an interrupted run keeps everything
// it had already resolved and `--resume` picks up from there.

import fs from 'fs';
import path from 'path';
import { loadPlaylist } from '../lib/sourcing/playlist.mjs';
import { loadLibrary, bucketTracks } from '../lib/sourcing/library.mjs';
import { bestQobuzMatch, resolveCart } from '../lib/sourcing/qobuz.mjs';
import { openBeatport, getAccessToken, makeSearcher, bestBeatportMatch } from '../lib/sourcing/beatport.mjs';
import { pickStore, beatportFallback, STORE_MATCH_FLOOR } from '../lib/sourcing/matching.mjs';
import { sessionDir } from '../lib/sourcing/config.mjs';

const RATE_LIMIT_MS = 500;

function parseArgs(argv) {
  const args = { prefer: 'hires' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--playlist') args.playlistUrl = argv[++i];
    else if (a === '--csv') args.csvPath = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--prefer') args.prefer = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--resume') args.resume = argv[++i];
    else if (a === '--skip-beatport') args.skipBeatport = true;
    else if (a === '--headless') args.headless = true;
    else if (a === '--no-library') args.noLibrary = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const log = (...m) => console.error(...m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Drop repeats before any network work — a playlist with the same track twice
 *  would otherwise be searched twice and appear twice in the buy list. */
function dedupe(tracks) {
  const seen = new Map();
  const duplicates = [];
  for (const t of tracks) {
    if (seen.has(t.key)) { duplicates.push(t); continue; }
    seen.set(t.key, t);
  }
  return { unique: [...seen.values()], duplicates };
}

/** Load store results from an earlier run, keyed by track. */
function loadResume(resumePath) {
  try {
    const prior = JSON.parse(fs.readFileSync(resumePath, 'utf8'));
    const byKey = new Map();
    for (const bucket of ['buy', 'flagged', 'notFound']) {
      for (const r of prior[bucket] || []) byKey.set(r.key, r);
    }
    return byKey;
  } catch (err) {
    log(`      WARNING could not resume from ${resumePath}: ${err.message}`);
    return new Map();
  }
}

/** Split resolved results into the buckets the review page reads.
 *  Lossless-only is a hard invariant, not a preference: a lossy match never
 *  reaches the buy list, it lands in `flagged` for a human decision. */
function splitResults(results) {
  const buy = [], flagged = [], notFound = [];
  for (const r of results) {
    if (r.status !== 'matched') notFound.push(r);
    else if (r.match.lossless === false) flagged.push({ ...r, flag: 'lossy match — excluded from buy list' });
    else if (r.match.cartError) flagged.push({ ...r, flag: `no cart link: ${r.match.cartError}` });
    else buy.push(r);
  }
  return { buy, flagged, notFound };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.playlistUrl && !args.csvPath)) {
    log('usage: source-playlist.mjs --playlist <spotify-url> | --csv <path> [--limit N] [--prefer cd] [--out PATH] [--resume PATH] [--skip-beatport]');
    process.exit(args.help ? 0 : 1);
  }

  const outPath = args.out
    ? path.resolve(args.out)
    : path.join(sessionDir(), `session-${Date.now()}.json`);

  // ---------- phase 1: playlist ----------
  log('[1/4] Reading playlist…');
  const { playlist, tracks: allTracks } = await loadPlaylist(args, (n, total) =>
    log(`      fetched ${n}/${total}`)
  );
  const limited = args.limit ? allTracks.slice(0, args.limit) : allTracks;
  const { unique: tracks, duplicates } = dedupe(limited);
  log(`      "${playlist.name}" — ${tracks.length} track(s)${duplicates.length ? `, ${duplicates.length} duplicate(s) dropped` : ''}${args.limit ? ` (limited from ${allTracks.length})` : ''}`);

  // ---------- phase 2: library ----------
  let lib, owned, probable, missing, skipped;
  if (args.noLibrary) {
    log('[2/4] Library check skipped (--no-library) — every track is wanted');
    lib = { stats: { skipped: true } };
    ({ owned, probable, missing, skipped } = { owned: [], probable: [], skipped: [], missing: tracks.map(t => ({ ...t, libraryStatus: 'missing', libraryConfidence: 0, libraryMatch: null })) });
  } else {
    log('[2/4] Checking library (Rekordbox + candybar reflection)…');
    lib = await loadLibrary();
    if (lib.stats.errors?.length) for (const e of lib.stats.errors) log(`      WARNING ${e}`);
    log(`      index: ${lib.stats.rekordbox} in Rekordbox, ${lib.stats.disk_only} on disk only`);
    ({ owned, probable, missing, skipped } = bucketTracks(tracks, lib));
  }
  log(`      owned ${owned.length} · probable ${probable.length} · missing ${missing.length}${skipped.length ? ` · ignored ${skipped.length}` : ''}`);

  // ---------- phase 3: stores ----------
  const toSearch = [...probable, ...missing];
  const resumed = args.resume ? loadResume(args.resume) : new Map();
  if (resumed.size) log(`      resuming: ${resumed.size} track(s) already resolved`);

  const results = [];
  let beatport = null, token = null, search = null;
  let beatportStatus = 'searched';

  if (args.skipBeatport) {
    beatportStatus = 'skipped by flag';
    log('[3/4] Beatport skipped — Qobuz only.');
  } else if (toSearch.length === 0) {
    beatportStatus = 'not needed';
    log('[3/4] Nothing to search — every track is already in the collection.');
  } else {
    log('[3/4] Opening Beatport (real Chrome — Cloudflare blocks everything else)…');
    try {
      beatport = await openBeatport({ headless: !!args.headless });
      token = await getAccessToken(beatport.page);
      log(`      Beatport session: ${token ? 'logged in (API path, fast)' : 'signed out (page scrape; cart-add unavailable)'}`);
      search = makeSearcher({ page: beatport.page, token });
    } catch (err) {
      // No Chrome, or Chrome refused to start. That costs Beatport coverage,
      // not the run — the library work is already done and Qobuz still answers.
      beatportStatus = `unavailable: ${err.message}`;
      log(`      WARNING Beatport unavailable (${err.message}) — continuing with Qobuz only.`);
      if (beatport) { await beatport.close(); beatport = null; }
    }
  }

  const buildSession = (partial) => {
    const { buy, flagged, notFound } = splitResults(results);
    return {
      createdAt: new Date().toISOString(),
      complete: !partial,
      playlist,
      stats: {
        total: tracks.length,
        duplicatesDropped: duplicates.length,
        owned: owned.length,
        probable: probable.length,
        missing: missing.length,
        ignored: skipped.length,
        searched: results.length,
        toSearch: toSearch.length,
        buy: buy.length,
        flagged: flagged.length,
        notFound: notFound.length,
        beatportStatus,
        beatportLoggedIn: Boolean(token),
        beatportSkipped: beatportStatus !== 'searched',
        library: lib.stats,
        storeMatchFloor: STORE_MATCH_FLOOR,
      },
      owned, probable, ignored: skipped,
      buy, flagged, notFound,
    };
  };
  const save = (partial) => fs.writeFileSync(outPath, JSON.stringify(buildSession(partial), null, 2));

  try {
    for (let i = 0; i < toSearch.length; i++) {
      const want = toSearch[i];
      const label = `${want.artist} - ${want.title}`;

      const prior = resumed.get(want.key);
      if (prior) {
        results.push(prior);
        log(`      (${i + 1}/${toSearch.length}) ${label} — from resume`);
        continue;
      }

      log(`      (${i + 1}/${toSearch.length}) ${label}`);

      const [bpRes, qbRes] = await Promise.allSettled([
        search ? bestBeatportMatch(search, want) : Promise.resolve(null),
        bestQobuzMatch(want),
      ]);
      const bp = bpRes.status === 'fulfilled' ? bpRes.value : null;
      const qb = qbRes.status === 'fulfilled' ? qbRes.value : null;
      if (bpRes.status === 'rejected') log(`          beatport search failed: ${bpRes.reason?.message}`);
      if (qbRes.status === 'rejected') log(`          qobuz search failed: ${qbRes.reason?.message}`);

      const chosen = pickStore(bp, qb);
      let { store, runnerUp } = chosen;
      let match = chosen.pick;

      // Qobuz search returns ALBUM ids; a cart needs a TRACK id + its tiers.
      if (store === 'qobuz' && match) {
        try {
          match = await resolveCart(match, want, { prefer: args.prefer });
        } catch (err) {
          match = { ...match, cartError: err.message };
        }
        // No lossless tier, or not on the release: a lossless Beatport match
        // is the buy instead, and the Qobuz miss stays visible as runner-up.
        const fallback = beatportFallback(match, bp);
        if (fallback) {
          log(`          qobuz: ${match.cartError} — using the Beatport match instead`);
          runnerUp = match;
          match = { ...fallback, fallbackFrom: { store: 'qobuz', reason: match.cartError } };
          store = 'beatport';
        }
      }

      results.push({
        ...want,
        store,
        match: match || null,
        runnerUp: runnerUp ? { store: runnerUp.store, title: runnerUp.title, artists: runnerUp.artists, score: runnerUp.score, url: runnerUp.url, price: runnerUp.price ?? null } : null,
        status: match ? 'matched' : 'not_found',
        candidates: {
          beatport: bp ? { score: bp.score, title: bp.title } : null,
          qobuz: qb ? { score: qb.score, title: qb.title } : null,
        },
        searchErrors: [
          bpRes.status === 'rejected' ? `beatport: ${bpRes.reason?.message}` : null,
          qbRes.status === 'rejected' ? `qobuz: ${qbRes.reason?.message}` : null,
        ].filter(Boolean),
      });

      // Rewrite after every track: an interrupted run keeps its work.
      save(true);
      if (i < toSearch.length - 1) await sleep(RATE_LIMIT_MS);
    }
  } finally {
    if (beatport) await beatport.close();
    save(results.length < toSearch.length);
  }

  // ---------- phase 4: done ----------
  log('[4/4] Writing session…');
  const session = buildSession(false);
  fs.writeFileSync(outPath, JSON.stringify(session, null, 2));

  const byStore = session.buy.reduce((acc, r) => ({ ...acc, [r.store]: (acc[r.store] || 0) + 1 }), {});
  log(`      buy ${session.buy.length} (${Object.entries(byStore).map(([s, n]) => `${s} ${n}`).join(', ') || 'none'}) · flagged ${session.flagged.length} · not found ${session.notFound.length}`);
  console.log(outPath);
}

main().catch(err => {
  console.error('FAILED:', err.stack || err.message);
  process.exit(1);
});
