#!/usr/bin/env node
// SoundCloud likes / sets sourcing — one command, four phases.
//
//   node bin/source-soundcloud-likes.mjs                 # your likes, via the signed-in Chrome profile
//   node bin/source-soundcloud-likes.mjs --user <name>   # a public profile's likes, no browser to read
//   node bin/source-soundcloud-likes.mjs --set <url>     # a set (playlist): public ones need no browser,
//                                                        # your own private ones go through the session
//   node bin/source-soundcloud-likes.mjs --tracks <json> # rows already matched elsewhere (Lossless Upgrades)
//
// Options:
//   --set URL            source a set instead of likes (repeatable; tracks from every set are pooled)
//   --tracks PATH        JSON { name, tracks } of rows from lib/sourcing/freeSources.mjs toFetchRows():
//                        SoundCloud and free Bandcamp copies, tried in file order per upgradeKey until one
//                        lands a lossless file. No library check: these replace copies already owned
//   --limit N            newest N likes only, or the first N tracks of each set (smoke tests)
//   --since DATE         likes made on/after DATE (ISO, e.g. 2026-09-01); no effect on a set
//   --list-only          classify and report; download nothing
//   --no-gates           native SoundCloud downloads only; gates are listed, not walked
//   --drop-lossy         delete lossy files (MP3 &c) the moment they arrive instead of parking them under
//                        lossy/; the ledger remembers them, so the gate is never walked again for them
//   --dest DIR           where files land (default: <organizeSourceDir>)
//   --out PATH           session JSON destination (default: sourcing-sessions/)
//   --resume PATH        reuse an earlier session's rows; pending rows are fetched, and gates that
//                        stalled (needs-you / stalled / failed, plus needs-email once --email is given) are retried
//   --assist SECONDS     when a gate stalls, wait this long for you to finish it in Chrome (default 0)
//   --gate-timeout SEC   per-gate automation budget (default 90)
//   --email ADDR         fill gates that demand an email address (default: the one saved in
//                        Track Lab's Settings → SoundCloud)
//   --no-email           give gates no email this run, even if one is saved
//   --postcode ZIP       the zip code Bandcamp asks for alongside the address
//   --sc-actions LIST    account actions a gate may do for real: follow,like,comment[,repost] | none (default follow,like,comment)
//   --first-name / --last-name   the name for gates that ask (default: the one saved with the email)
//   --comment TEXT       the comment left when a gate asks for one (default: the one saved in
//                        Settings → SoundCloud; none saved, gates that insist on one are left for you)
//   --sc-account NAME    refuse to run unless the signed-in SoundCloud account is NAME (its
//                        permalink, e.g. nhi-dj) — for runs done on someone else's behalf
//   --login-timeout SEC  when the profile is signed out, wait this long for you to sign in on the window (default 300; 0 = fail instead)
//   --headless           try headless Chrome (fine for reading likes; gates may not like it)
//   --no-library         skip the Rekordbox check — every track is wanted (sourcing for someone else)
//   --ledger PATH        use this download ledger instead of the shared one, so a run for someone
//                        else neither skips Ben's past downloads nor writes into his ledger
//
// Progress goes to stderr; the session JSON path goes to stdout. The session is
// rewritten after every row and a ledger of downloaded track ids persists
// across runs, so re-running is a sync: only new free downloads are fetched.

import fs from 'fs';
import path from 'path';
import { sessionDir, loadConfig } from '../lib/sourcing/config.mjs';
import { loadLibrary, bucketTracks } from '../lib/sourcing/library.mjs';
import {
  openSoundCloud, captureSession, waitForSoundCloudLogin, fetchLikesViaSession, fetchLikesPublic, resolveNativeDownload,
  fetchSetPublic, fetchSetViaSession, isSetUrl, isOwnTrack,
} from '../lib/sourcing/soundcloud.mjs';
import { downloadUrlToFile, fileDownload, defaultDestDir, tmpDir, DownloadLedger } from '../lib/sourcing/downloads.mjs';
import { runGate } from '../lib/sourcing/gates/index.mjs';
import { recordEvent, eventFromRow } from '../lib/sourcing/history.mjs';

const log = (...m) => console.error(...m);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RATE_LIMIT_MS = 400;
const MIN_FREE_BYTES = 1024 * 1024 * 1024; // gate zips of 200 MB+ unpack to more than that

function parseArgs(argv) {
  const args = { scActions: ['follow', 'like', 'comment'], assist: 0, gateTimeout: 90, comment: undefined, loginTimeout: 300 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user') args.user = argv[++i];
    else if (a === '--set') (args.sets ||= []).push(argv[++i]);
    else if (a === '--tracks') args.tracks = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--since') args.since = argv[++i];
    else if (a === '--list-only') args.listOnly = true;
    else if (a === '--no-gates') args.noGates = true;
    else if (a === '--drop-lossy') args.dropLossy = true;
    else if (a === '--dest') args.dest = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--resume') args.resume = argv[++i];
    else if (a === '--assist') args.assist = Number(argv[++i]);
    else if (a === '--gate-timeout') args.gateTimeout = Number(argv[++i]);
    else if (a === '--email') args.email = argv[++i];
    else if (a === '--no-email') args.noEmail = true;
    else if (a === '--postcode') args.postcode = argv[++i];
    else if (a === '--sc-account') args.scAccount = argv[++i];
    else if (a === '--comment') args.comment = argv[++i];
    else if (a === '--first-name') (args.name ??= { first: '', last: '' }).first = argv[++i];
    else if (a === '--last-name') (args.name ??= { first: '', last: '' }).last = argv[++i];
    else if (a === '--login-timeout') args.loginTimeout = Number(argv[++i]);
    else if (a === '--sc-actions') {
      const v = argv[++i];
      args.scActions = v === 'none' ? [] : v.split(',').map(s => s.trim()).filter(Boolean);
    }
    else if (a === '--headless') args.headless = true;
    else if (a === '--no-library') args.noLibrary = true;
    else if (a === '--ledger') args.ledger = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  // Saving an email in Settings is the go-ahead for every run; --email
  // overrides it and --no-email holds it back for this one.
  if (args.noEmail) delete args.email;
  else if (!args.email) args.email = loadConfig().gateEmail || undefined;
  // The comment saved in Settings, unless --comment gives one for this run.
  if (args.comment === undefined) args.comment = loadConfig().gateComment || null;
  // The name saved with the email, for gates that ask for one.
  { const c = loadConfig(); args.name ??= { first: c.gateFirstName || '', last: c.gateLastName || '' }; }
  return args;
}

const dedupe = tracks => {
  const seen = new Set();
  return tracks.filter(t => (seen.has(t.scId) ? false : (seen.add(t.scId), true)));
};

/** Split rows by outcome into the buckets the report reads. Every row lands in
 *  exactly one bucket, so nothing can disappear. */
function splitRows(rows) {
  const downloaded = [], flagged = [], queue = [], notFree = [], dropped = [], byHand = [], covered = [];
  for (const r of rows) {
    const o = r.outcome;
    if (r.free.kind === 'none') notFree.push(r);
    else if (!o || o.status === 'pending') queue.push(r);
    else if (o.status === 'downloaded' && o.files?.every(f => f.lossless === true)) downloaded.push(r);
    else if (o.status === 'lossy-dropped' || o.status === 'duplicate') dropped.push(r);
    // Finished outside the run (an emailed link, a gate done in the browser):
    // done, but no file of ours to point at.
    else if (o.status === 'by-hand') byHand.push(r);
    // --tracks: another source for the same upgrade already landed lossless.
    else if (o.status === 'covered') covered.push(r);
    else flagged.push(r);
  }
  return { downloaded, flagged, queue, notFree, dropped, byHand, covered };
}

/** --tracks: one lossless file is a usable upgrade. Several (a stem pack)
 *  isn't, so the next source for that track still gets its turn. */
const landedOne = files => (files || []).filter(f => f.lossless === true).length === 1;

/** --tracks: the upgrades that already have a lossless file, from this
 *  session's rows or an earlier run's ledger entry. */
function landedKeys(rows, alreadyDownloaded) {
  return new Set([
    ...rows.filter(r => r.upgradeKey && r.outcome?.status === 'downloaded' && landedOne(r.outcome.files)),
    ...alreadyDownloaded.filter(r => r.upgradeKey && landedOne(r.ledger?.files)),
  ].map(r => r.upgradeKey));
}

function flagText(r) {
  const o = r.outcome || {};
  if (o.status === 'downloaded') {
    const bad = (o.files || []).filter(f => f.lossless !== true);
    return bad.length ? `lossy (${bad.map(f => f.codec || f.ext).join(', ')}) — kept under lossy/, not for the collection` : null;
  }
  return o.reason || o.status;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    log('usage: source-soundcloud-likes.mjs [--user NAME] [--set URL]... [--tracks PATH] [--limit N] [--since DATE] [--list-only] [--no-gates] [--drop-lossy] [--dest DIR] [--out PATH] [--resume PATH] [--assist SEC] [--gate-timeout SEC] [--email ADDR | --no-email] [--first-name X --last-name Y] [--postcode ZIP] [--sc-account NAME] [--comment TEXT] [--sc-actions follow,like,comment,repost|none] [--headless] [--no-library] [--ledger PATH]');
    process.exit(0);
  }
  const fromSets = !!args.sets?.length;
  const mode = args.tracks ? 'upgrade' : fromSets ? 'set' : 'likes';
  const outPath = args.out ? path.resolve(args.out) : path.join(sessionDir(), `soundcloud-${mode}-${Date.now()}.json`);
  const destDir = path.resolve(args.dest || defaultDestDir({ upgrade: 'upgrades', set: 'soundcloud-sets', likes: 'soundcloud-likes' }[mode]));
  const ledger = new DownloadLedger(args.ledger ? path.resolve(args.ledger) : undefined);
  const sinceMs = args.since ? Date.parse(args.since) : null;
  if (args.since && !Number.isFinite(sinceMs)) throw new Error(`--since is not a date: ${args.since}`);

  let browser = null, sess = null;
  const openBrowser = async () => {
    if (browser) return browser;
    browser = await openSoundCloud({ headless: !!args.headless });
    log(browser.ctx.attached
      ? `      attached to the Chrome you already have open (${browser.ctx.endpoint})`
      : '      opened Chrome on the SoundCloud profile');
    return browser;
  };
  const ensureSession = async () => {
    if (sess) return sess;
    const b = await openBrowser();
    sess = await captureSession(b.page);
    if (!sess.signedIn && args.loginTimeout > 0 && !args.headless) {
      // Same window, no second launch: sign in here and the run carries on.
      log(`      SoundCloud is signed out — sign in on the Chrome window that just opened (waiting up to ${Math.round(args.loginTimeout / 60)} min)…`);
      const ok = await waitForSoundCloudLogin(b.page, { timeoutMs: args.loginTimeout * 1000, onTick: left => log(`      still waiting for sign-in (${Math.round(left / 60)} min left)…`) });
      if (ok) sess = await captureSession(b.page);
    }
    // Follows, likes, comments and gate connects all act as this account.
    if (sess.signedIn && args.scAccount && sess.me?.permalink !== args.scAccount) {
      throw new Error(`SoundCloud profile is signed in as ${sess.me?.permalink || sess.meId}, not ${args.scAccount} — sign in as ${args.scAccount} on the profile window and re-run`);
    }
    log(`      SoundCloud session: ${sess.signedIn ? `signed in as ${sess.me?.username || sess.meId} (token via ${sess.tokenSource})` : `signed out — ${sess.diagnostic || ''}`}`);
    return sess;
  };

  /** One or more sets → the same {source, tracks} shape the likes readers
   *  return. Public first (no browser); a 401/403/404 means the set is
   *  private to the account, so it is read again through the session. */
  const readSets = async (urls) => {
    const parts = [];
    for (const u of urls) {
      if (!isSetUrl(u)) log(`      WARNING ${u} does not look like a set link (…/sets/…) — trying anyway`);
      const progress = (n, total) => log(`      fetched ${n}/${total}`);
      let r;
      try {
        r = await fetchSetPublic(u, { limit: args.limit, onProgress: progress });
      } catch (err) {
        if (![401, 403, 404].includes(err.status)) throw err;
        log(`      ${u}: not public (HTTP ${err.status}) — reading it through the signed-in session`);
        const s = await ensureSession();
        if (!s.signedIn) throw new Error(`${u} is private and the SoundCloud profile is signed out — run the store_login tool for soundcloud and re-run`);
        r = await fetchSetViaSession(browser.page, s, u, { limit: args.limit, onProgress: progress });
      }
      log(`      "${r.source.set}"${r.source.user ? ` by ${r.source.user}` : ''}: ${r.source.fetchedCount}/${r.source.trackCount} track(s) via ${r.source.via}${r.source.unavailable?.length ? ` · ${r.source.unavailable.length} unavailable (deleted/blocked)` : ''}`);
      parts.push(r);
    }
    if (parts.length === 1) return parts[0];
    return {
      source: {
        ...parts[0].source,
        set: parts.map(p => p.source.set).join(' + '),
        trackCount: parts.reduce((n, p) => n + (p.source.trackCount || 0), 0),
        fetchedCount: parts.reduce((n, p) => n + p.source.fetchedCount, 0),
        unavailable: parts.flatMap(p => p.source.unavailable || []),
        sets: parts.map(p => p.source),
      },
      tracks: parts.flatMap(p => p.tracks),
    };
  };

  let source, rows, lib, owned = [], probable = [], skipped = [], alreadyDownloaded = [], mine = [], sourceStats = {};

  try {
    if (args.resume) {
      // ---------- resume: the rows are already classified ----------
      const prior = JSON.parse(fs.readFileSync(args.resume, 'utf8'));
      source = prior.source;
      sourceStats = prior.stats?.library || {};
      mine = prior.mine || [];
      owned = prior.owned || []; probable = prior.probable || []; skipped = prior.ignored || []; alreadyDownloaded = prior.alreadyDownloaded || [];
      rows = [...(prior.downloaded || []), ...(prior.flagged || []), ...(prior.queue || []), ...(prior.notFree || []), ...(prior.dropped || []), ...(prior.byHand || []), ...(prior.covered || [])];
      // A gate that stalled last time is worth another go — the Hypeddit
      // rating game clears once a human plays it, a host without a walker can
      // be finished by hand with --assist, and a needs-email row becomes
      // doable the moment an address is supplied.
      const retry = new Set(['needs-you', 'stalled', 'failed', ...(args.email ? ['needs-email'] : [])]);
      let retried = 0;
      for (const r of rows) {
        if (r.free.kind !== 'none' && r.outcome && retry.has(r.outcome.status)) { r.priorOutcome = r.outcome; r.outcome = { status: 'pending' }; retried++; }
      }
      const pendingNow = rows.filter(r => r.free.kind !== 'none' && (!r.outcome || r.outcome.status === 'pending')).length;
      log(`[1/4] Resuming ${args.resume} — ${rows.length} row(s), ${pendingNow} pending${retried ? ` (${retried} stalled gate(s) retried)` : ''}`);
      log('[2/4] Library check reused from the session.');
      log('[3/4] Classification reused from the session.');
    } else {
      // ---------- phase 1: likes (or sets) ----------
      let likes;
      if (args.tracks) {
        log('[1/4] Reading the track list…');
        const list = JSON.parse(fs.readFileSync(args.tracks, 'utf8'));
        const tracks = (list.tracks || []).slice(0, args.limit || undefined);
        likes = { source: { kind: 'tracks', name: list.name || 'track list', fetchedCount: tracks.length, via: 'list' }, tracks };
      } else if (fromSets) {
        log(`[1/4] Reading ${args.sets.length === 1 ? 'set' : `${args.sets.length} sets`}…`);
        likes = await readSets(args.sets);
      } else if (args.user) {
        log('[1/4] Reading likes…');
        likes = await fetchLikesPublic(args.user, { limit: args.limit, onProgress: (n, total) => log(`      fetched ${n}${total ? `/${total}` : ''}`) });
      } else {
        log('[1/4] Reading likes…');
        const s = await ensureSession();
        if (!s.signedIn) {
          throw new Error('SoundCloud profile is signed out — run the store_login tool for soundcloud (or pass --user <name> for a public profile) and re-run');
        }
        likes = await fetchLikesViaSession(browser.page, s, { limit: args.limit, onProgress: (n, total) => log(`      fetched ${n}${total ? `/${total}` : ''}`) });
      }
      source = likes.source;
      let tracks = dedupe(likes.tracks);
      if (sinceMs) {
        if (fromSets) log('      NOTE --since filters by liked-at date; a set has none, so it is ignored here');
        else tracks = tracks.filter(t => !t.likedAt || Date.parse(t.likedAt) >= sinceMs);
      }
      log(args.tracks ? `      "${source.name}": ${tracks.length} row(s)`
        : fromSets
        ? `      ${tracks.length} track(s) to consider${args.limit ? ` (first ${args.limit} of each set)` : ''}`
        : `      ${source.user}: ${tracks.length} liked track(s)${args.limit ? ` (newest ${args.limit})` : ''}${args.since ? ` since ${args.since}` : ''}`);

      // Already fetched on an earlier run — nothing to do for these.
      const fresh = [];
      for (const t of tracks) {
        const e = ledger.get(t.scId);
        if (e) alreadyDownloaded.push({ ...t, ledger: e }); else fresh.push(t);
      }
      if (alreadyDownloaded.length) log(`      ${alreadyDownloaded.length} already downloaded on an earlier run`);

      // ---------- phase 2: library ----------
      let b;
      if (args.noLibrary || args.tracks) {
        log(`[2/4] Library check skipped (${args.tracks ? 'these replace copies already owned' : '--no-library'}) — every track is wanted`);
        sourceStats = { skipped: true };
        b = { owned: [], probable: [], skipped: [], missing: fresh.map(t => ({ ...t, libraryStatus: 'missing', libraryConfidence: 0, libraryMatch: null })) };
      } else {
        log('[2/4] Checking library (Rekordbox + candybar reflection)…');
        lib = await loadLibrary();
        sourceStats = lib.stats;
        if (lib.stats.errors?.length) for (const e of lib.stats.errors) log(`      WARNING ${e}`);
        log(`      index: ${lib.stats.rekordbox} in Rekordbox, ${lib.stats.disk_only} on disk only`);
        b = bucketTracks(fresh, lib);
      }
      owned = b.owned; probable = b.probable; skipped = b.skipped;
      log(`      owned ${owned.length} · probable ${probable.length} · missing ${b.missing.length}${skipped.length ? ` · ignored ${skipped.length}` : ''}`);

      // ---------- phase 3: classify ----------
      log('[3/4] Classifying free downloads…');
      rows = [...probable, ...b.missing];
      const kinds = rows.reduce((acc, r) => ({ ...acc, [r.free.kind]: (acc[r.free.kind] || 0) + 1 }), {});
      const hosts = rows.filter(r => r.free.kind === 'gate').reduce((acc, r) => { const h = r.free.gate.host || 'unknown'; acc[h] = (acc[h] || 0) + 1; return acc; }, {});
      log(`      native ${kinds.native || 0} · gate ${kinds.gate || 0}${Object.keys(hosts).length ? ` (${Object.entries(hosts).map(([h, n]) => `${h} ${n}`).join(', ')})` : ''} · not free ${kinds.none || 0}`);
    }

    // The account's own uploads are never fetched and never followed/liked.
    const meId = source.kind !== 'set' && source.via === 'browser' ? source.userId : sess?.meId;
    mine.push(...rows.filter(r => isOwnTrack(r, meId)));
    rows = rows.filter(r => !isOwnTrack(r, meId));
    probable = probable.filter(r => !isOwnTrack(r, meId));
    if (mine.length) log(`      skipping ${mine.length} of your own track(s)`);

    const buildSession = (partial) => {
      const { downloaded, flagged, queue, notFree, dropped, byHand, covered } = splitRows(rows);
      return {
        kind: 'soundcloud-likes',
        createdAt: new Date().toISOString(),
        complete: !partial,
        source,
        destDir,
        stats: {
          total: rows.length + owned.length + skipped.length + alreadyDownloaded.length + mine.length,
          mine: mine.length,
          owned: owned.length,
          probable: probable.length,
          ignored: skipped.length,
          alreadyDownloaded: alreadyDownloaded.length,
          free: rows.reduce((acc, r) => ({ ...acc, [r.free.kind]: (acc[r.free.kind] || 0) + 1 }), { native: 0, gate: 0, none: 0 }),
          downloaded: downloaded.length,
          flagged: flagged.length,
          dropped: dropped.length,
          byHand: byHand.length,
          covered: covered.length,
          pending: queue.length,
          notFree: notFree.length,
          listOnly: !!args.listOnly,
          dropLossy: !!args.dropLossy,
          gatesSkipped: !!args.noGates,
          signedIn: sess ? sess.signedIn : null,
          scActions: args.scActions,
          library: sourceStats,
        },
        owned, probable, ignored: skipped, alreadyDownloaded, mine,
        downloaded, flagged, dropped, byHand, covered, queue, notFree,
      };
    };
    // Written beside the target and renamed, so a full disk can never leave a
    // half-written session in its place.
    const save = partial => {
      const tmp = `${outPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(buildSession(partial), null, 2));
      fs.renameSync(tmp, outPath);
    };
    save(true);

    // ---------- phase 4: download ----------
    const pending = rows.filter(r => r.free.kind !== 'none' && (!r.outcome || r.outcome.status === 'pending'));
    if (args.listOnly) {
      log(`[4/4] List only — ${pending.length} free download(s) queued, nothing fetched.`);
    } else if (pending.length === 0) {
      log('[4/4] Nothing to download.');
    } else {
      fs.mkdirSync(destDir, { recursive: true });
      log(`[4/4] Downloading ${pending.length} track(s) → ${destDir}`);
      const tmp = tmpDir();
      // A Bandcamp name-your-price needs no SoundCloud account.
      const needSession = pending.some(r => r.free.kind === 'native')
        || (args.scActions.length > 0 && pending.some(r => r.free.kind === 'gate' && r.free.gate?.host !== 'bandcamp.com'));
      const landed = landedKeys(rows, alreadyDownloaded);
      if (needSession) await ensureSession();
      if (pending.some(r => r.free.kind === 'gate') && !args.noGates) await openBrowser();

      /** Shape a downloaded outcome. With --drop-lossy, lossy files are deleted
       *  on the spot and listed as dropped so the ledger can remember them. */
      const filed = (files, extra) => {
        if (!args.dropLossy) return { status: 'downloaded', files, ...extra };
        const kept = [], dropped = [];
        for (const f of files) {
          if (f.lossless === false) {
            try { fs.unlinkSync(f.path); } catch { /* already gone */ }
            dropped.push({ original: f.original, codec: f.codec, ext: f.ext });
          } else kept.push(f);
        }
        if (dropped.length) { try { fs.rmdirSync(path.join(destDir, 'lossy')); } catch { /* not empty, or never made */ } }
        if (kept.length) return { status: 'downloaded', files: kept, dropped, ...extra };
        return { status: 'lossy-dropped', reason: `${dropped.map(d => (d.codec || d.ext || '?').toUpperCase()).join(', ')} only — deleted by request`, files: [], dropped, ...extra };
      };

      for (let i = 0; i < pending.length; i++) {
        // Stop before the disk fills: unfinished rows stay pending for --resume.
        const free = Math.min(...[destDir, tmp].map(d => { const v = fs.statfsSync(d); return v.bavail * v.bsize; }));
        if (free < MIN_FREE_BYTES) {
          log(`      STOPPED: only ${Math.round(free / 1048576)} MB free; ${pending.length - i} track(s) left pending. Free some space or pass --dest, then --resume.`);
          break;
        }
        const row = pending[i];
        if (row.upgradeKey && landed.has(row.upgradeKey)) {
          row.outcome = { status: 'covered', reason: 'an earlier source for this track already landed a lossless file' };
          save(true);
          continue;
        }
        const label = `${row.artist} - ${row.title}`;
        log(`      (${i + 1}/${pending.length}) ${label} [${row.free.kind}${row.free.gate?.host ? ` · ${row.free.gate.host}` : ''}]`);
        let outcome;
        try {
          if (row.free.kind === 'native') {
            const { url, reason } = await resolveNativeDownload(browser.page, sess, row);
            if (!url) outcome = { status: 'failed', reason };
            else {
              const dl = await downloadUrlToFile(url, tmp);
              const files = await fileDownload(dl.tmpPath, row, destDir, { originalName: dl.filename });
              outcome = filed(files, { via: 'native', original: dl.filename, bytes: dl.bytes });
            }
          } else if (args.noGates) {
            outcome = { status: 'skipped', reason: 'gates skipped by flag' };
          } else {
            const r = await runGate(browser.ctx, row, {
              log, tmpDir: tmp, email: args.email || null, postcode: args.postcode || null, comment: args.comment, scActions: args.scActions, dropLossy: !!args.dropLossy, name: args.name,
              assistMs: args.assist * 1000, gateTimeoutMs: args.gateTimeout * 1000,
              sc: { page: browser.page, sess },
            });
            if (r.status === 'downloaded') {
              const files = await fileDownload(r.tmpPath, row, destDir, { originalName: r.filename });
              outcome = filed(files, { via: r.via, original: r.filename });
            } else {
              outcome = { status: r.status, reason: r.reason };
            }
          }
        } catch (err) {
          outcome = { status: 'failed', reason: err.message };
        }
        // The gate turned out to sell or stream (a store picker, a priced
        // Bandcamp release, a dead link): it belongs with the not-free rows.
        if (outcome.status === 'not-free') {
          row.free = { ...row.free, kind: 'none', reason: outcome.reason };
          outcome = { status: 'not-free', reason: outcome.reason };
        }
        row.outcome = outcome;
        if (row.upgradeKey && outcome.status === 'downloaded' && landedOne(outcome.files)) landed.add(row.upgradeKey);
        if (outcome.status === 'downloaded' || outcome.status === 'lossy-dropped') {
          ledger.record(row.scId, { artist: row.artist, title: row.title, url: row.url, via: outcome.via, files: outcome.files, dropped: outcome.dropped || [] });
          const origin = source.kind === 'set' ? source.set : source.kind === 'tracks' ? source.name : 'likes';
          const ev = eventFromRow(row, outcome, { origin, session: path.basename(outPath) });
          if (ev) { const h = recordEvent(ev); if (h.error) log(`          WARNING history not written: ${h.error}`); }
        }
        if (outcome.status === 'downloaded') {
          const f = outcome.files.map(x => `${path.basename(x.path)} (${x.codec || x.ext}${x.lossless ? '' : ' — LOSSY'})`).join(', ');
          log(`          saved: ${f}${outcome.dropped?.length ? ` · deleted ${outcome.dropped.length} lossy file(s)` : ''}`);
        } else {
          log(`          ${outcome.status}: ${outcome.reason || ''}`);
        }
        save(true);
        if (i < pending.length - 1) await sleep(RATE_LIMIT_MS);
      }
    }

    save(false);
    const s = buildSession(false);
    log(`      downloaded ${s.stats.downloaded} · flagged ${s.stats.flagged}${s.stats.dropped ? ` · lossy deleted ${s.stats.dropped}` : ''} · pending ${s.stats.pending} · not free ${s.stats.notFree} · owned ${s.stats.owned} · probable ${s.stats.probable}`);
    for (const r of s.flagged) log(`      flagged: ${r.artist} - ${r.title} — ${flagText(r)}`);
    // What only a person can finish, one line each, beside the session.
    const human = s.flagged.filter(r => r.outcome?.status !== 'downloaded');
    const humanPath = outPath.replace(/\.json$/, '') + '.human-needed.txt';
    fs.writeFileSync(humanPath, human.map(r => `${r.outcome?.status}\t${r.artist} - ${r.title}\t${r.free?.gate?.url || r.url}\t${r.outcome?.reason || ''}`).join('\n') + '\n');
    log(`      ${human.length} row(s) need a human: ${humanPath}`);
    console.log(outPath);
  } finally {
    if (browser) await browser.close();
  }
}

main().catch(err => {
  console.error('FAILED:', err.stack || err.message);
  process.exit(1);
});
