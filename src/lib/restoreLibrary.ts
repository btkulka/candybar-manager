/**
 * Restore Library orchestrator.
 *
 * Given a Rekordbox XML and a library root, computes what's missing and attempts recovery
 * from the available sources in order: USB (free, fast) → Beatport → Qobuz → SoundCloud (opt-in).
 *
 * Output: per-track report with source attribution, plus a staging dir of recovered files ready
 * for Organize-by-Artist to sort into Library/.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import fuzzball from 'fuzzball';
import { createScopedLogger } from './logger';
import { walkAudioDir, isPathUnder } from './fileUtils';
import { isTrackDeleted } from './db';
import { normalizeForComparison } from './stringUtils';
import { parseRekordboxXml, rewriteLocations, type RekordboxTrack } from './rekordboxXml';
import {
  listExternalVolumes, buildUsbIndex, matchAgainstUsbIndex, usbMatchDurationOk,
  type UsbVolume, type UsbMatch,
} from './usbScan';
import {
  fetchAllBeatportPurchases, downloadBeatportPurchases,
  fetchAllQobuzPurchases, downloadQobuzPurchases,
  matchesOwnedTrack,
  LEGACY_ACCOUNT_ID,
  type OwnedTrack,
} from './storePurchase';
import type { StoreMatch, StoreTrackInput, StoreAccount } from '../types';

const log = createScopedLogger('Restore');

export type RestoreSourceToggles = {
  usb: boolean;
  beatport: boolean;
  qobuz: boolean;
  soundcloud: boolean; // reserved — not yet wired
};

export type RestoreOptions = {
  xmlPath: string;
  libraryRoot: string;
  stageDir: string;
  sources: RestoreSourceToggles;
  concurrency: number;
  /** Optional: only include these specific volumes for the USB pass. Empty = all detected. */
  usbVolumesAllowlist?: string[];
  beatportAccounts?: StoreAccount[];
  qobuzAccounts?: StoreAccount[];
  /**
   * Read audio tags during USB indexing to enable artist+title match in addition to
   * path/folder-based matching. Slower but finds tracks whose paths have changed.
   */
  usbTagMatching?: boolean;
  /**
   * After recovery, rewrite Location attributes in the Rekordbox XML to point at staged files.
   * Creates a timestamped backup alongside the original. Opt-in (destructive for Rekordbox DB caches).
   */
  rewriteXml?: boolean;
};

export type RestoreTrackStatus =
  | 'pending' | 'in_progress' | 'recovered' | 'still_missing' | 'failed';

export type RestoreFailureCategory =
  | 'no_match'   // no source matched this track
  | 'login'      // store login blocked the attempt
  | 'download'   // download attempt failed
  | 'copy'       // USB copy failed
  | 'rewrite'    // XML rewrite failed for this track id
  | 'other';

export type RestoreTrackResult = {
  track: RekordboxTrack;
  status: RestoreTrackStatus;
  source: 'usb' | 'beatport' | 'qobuz' | 'soundcloud' | null;
  /** Which configured account produced the match (store recoveries only). */
  sourceAccountId?: string;
  destPath?: string;
  detail?: string; // method, score, error message
  failureCategory?: RestoreFailureCategory;
};

export type RestorePhase =
  | 'init' | 'parsing' | 'scanning_library' | 'computing_missing'
  | 'usb_scan' | 'beatport_fetch' | 'beatport_download'
  | 'qobuz_fetch' | 'qobuz_download' | 'xml_rewrite' | 'complete';

export type RestorePhaseStatus = 'start' | 'update' | 'end' | 'skipped';

export type RestoreLogLevel = 'info' | 'warn' | 'error';

export type RestoreLogEntry = {
  level: RestoreLogLevel;
  phase: RestorePhase;
  message: string;
  timestamp: number;
  currentTrack?: string;
};

export type RestorePerAccountCounter = {
  accountId: string;
  service: 'qobuz' | 'beatport';
  label?: string;
  email?: string;
  ownedCount?: number;
  matchedCount?: number;
  downloadedCount?: number;
  failedCount?: number;
};

export type RestoreProgress = {
  phase: RestorePhase;
  phaseStatus?: RestorePhaseStatus;
  message: string;
  currentTrack?: string;
  totals: {
    totalXmlTracks: number;
    alreadyInLibrary: number;
    missing: number;
    recovered: number;
    stillMissing: number;
    /** Missing on disk but deliberately left out: tracks the user deleted. */
    deletedSkipped: number;
  };
  /** Seconds since the restore job started. */
  elapsedSec: number;
  /** Estimated seconds remaining based on recovery rate, or undefined if unknown. */
  estRemainingSec?: number;
  /** Tracks recovered per second over the last sampling window. */
  rate?: number;
  /** Snapshot of per-account counters — only included when the value changed. */
  perAccount?: RestorePerAccountCounter[];
  /** One log line, appended as-is to the UI log stream. */
  log?: RestoreLogEntry;
};

export type XmlRewriteSummary = {
  backupPath: string | null;
  updated: number;
  notFound: number;
};

/** A track restore left out on purpose (never a failure or "still missing"). */
export type RestoreSkippedTrack = { trackId: string; artist: string; title: string; reason: string };

export type RestoreReport = {
  options: RestoreOptions;
  totals: RestoreProgress['totals'];
  bySource: Record<string, number>;
  results: RestoreTrackResult[];
  /** Tracks the user deleted: listed separately, not counted as missing or failed. */
  deletedSkipped: RestoreSkippedTrack[];
  /** Store accounts whose purchase history couldn't be read ("couldn't check", not "owns nothing"). */
  storeErrors: string[];
  /** Populated when options.rewriteXml is true. */
  xmlRewrite?: XmlRewriteSummary;
  startedAt: string;
  finishedAt: string;
  durationSec: number;
};

// ---------- helpers ----------

function sanitizeFilename(s: string): string {
  return s.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim();
}

function fuzzTitle(a: string, b: string): number {
  const aN = normalizeForComparison(a);
  const bN = normalizeForComparison(b);
  if (!aN || !bN) return 0;
  return Math.max(fuzzball.ratio(aN, bN), fuzzball.token_set_ratio(aN, bN)) / 100;
}

/** Accent- and normalization-insensitive lowercase fold for filename comparisons
 *  (exFAT keeps NFC or NFD as written; Rekordbox may hold the other form). */
function foldName(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Decide which Rekordbox tracks have no file in the library. This one stays a
 * filesystem check on purpose: restore is about files missing on disk. Throws
 * rather than reporting the whole collection missing when the library can't be
 * read (unmounted drive, wrong root, "Candy Bar 1" remount).
 */
async function computeMissing(xmlTracks: RekordboxTrack[], libraryRoot: string): Promise<RekordboxTrack[]> {
  if (!fs.existsSync(libraryRoot)) {
    throw new Error(`Library directory not found: ${libraryRoot}`);
  }
  const failedDirs: string[] = [];
  const libFiles = await walkAudioDir(libraryRoot, { failedDirs });
  if (libFiles.length === 0 && xmlTracks.length > 0) {
    throw new Error(
      `Library scan found no audio files under ${libraryRoot}; refusing to treat all ` +
      `${xmlTracks.length} Rekordbox tracks as missing. Check the drive is mounted and the library root is right.`
    );
  }
  if (failedDirs.length > 0) {
    log.warn(`computeMissing: ${failedDirs.length} unreadable folder(s); tracks under them are treated as present`);
  }

  const byBasename = new Set<string>();
  // Fuzzy fallback index: top-level (artist) folder -> folded file names in it.
  const byFolder = new Map<string, string[]>();
  for (const f of libFiles) {
    byBasename.add(foldName(path.basename(f)));
    const folder = foldName(path.relative(libraryRoot, f).split(path.sep)[0] || '');
    const list = byFolder.get(folder);
    if (list) list.push(foldName(path.basename(f)));
    else byFolder.set(folder, [foldName(path.basename(f))]);
  }
  const folders = Array.from(byFolder.keys());

  const missing: RekordboxTrack[] = [];
  for (const t of xmlTracks) {
    const origBase = foldName(path.basename(t.origPath || ''));
    if (origBase && byBasename.has(origBase)) continue;
    if (t.origPath && isPathUnder(t.origPath, failedDirs)) continue; // can't tell; don't re-fetch

    // Fuzzy fallback: artist folder contains all tokens + >=60% of title tokens in filename.
    const firstArtist = (t.artist || '').split(/[,&]/)[0].trim();
    const artistTokens = normalizeForComparison(firstArtist).split(' ').filter(Boolean);
    const titleTokens = normalizeForComparison(t.title).split(' ').filter(Boolean);
    if (titleTokens.length === 0 || artistTokens.length === 0) { missing.push(t); continue; }

    let found = false;
    for (const folder of folders) {
      if (!artistTokens.every(w => folder.includes(w))) continue;
      found = byFolder.get(folder)!.some(fname =>
        titleTokens.filter(w => fname.includes(w)).length / titleTokens.length >= 0.6);
      if (found) break;
    }
    if (!found) missing.push(t);
  }
  return missing;
}

async function copyUsbMatch(match: UsbMatch, stageDir: string): Promise<string> {
  const ext = path.extname(match.sourcePath);
  const destName = sanitizeFilename(`${match.rekordboxTrack.artist} - ${match.rekordboxTrack.title}${ext}`);
  const destPath = path.join(stageDir, destName);
  const srcSize = (await fsp.stat(match.sourcePath)).size;
  const existing = await fsp.stat(destPath).catch(() => null);
  // Reuse an earlier copy only when it's complete; a short file is a partial
  // copy from an interrupted run and must not be reported as recovered.
  if (existing && existing.size === srcSize) return destPath;
  // Copy via a hidden partial so an interrupted copy never sits at destPath.
  const partial = path.join(stageDir, `.${destName}.partial-${Date.now()}`);
  try {
    await fsp.copyFile(match.sourcePath, partial);
    const copied = await fsp.stat(partial);
    if (copied.size !== srcSize) throw new Error(`copy incomplete (${copied.size} of ${srcSize} bytes)`);
    await fsp.rename(partial, destPath);
  } catch (err) {
    await fsp.unlink(partial).catch(() => {});
    throw err;
  }
  return destPath;
}

/** Build a StoreMatch object from an OwnedTrack + the Rekordbox track that matched it. */
function buildStoreMatch(
  rbx: RekordboxTrack, owned: OwnedTrack, source: 'beatport' | 'qobuz'
): StoreMatch {
  return {
    input: { key: rbx.trackId, artist: rbx.artist, title: rbx.title, album: rbx.album },
    trackId: owned.trackId,
    // Preserve orderItemDownloadId for Beatport (critical for re-download endpoint).
    ...(owned.orderItemDownloadId ? { orderItemDownloadId: owned.orderItemDownloadId } : {}),
    // Route the download through the account that actually owns this track.
    ...(owned.sourceAccountId ? { sourceAccountId: owned.sourceAccountId } : {}),
    title: owned.title,
    artist: owned.artist,
    album: '', label: '', price: '',
    quality: source === 'beatport' ? 'AIFF' : 'FLAC',
    format: source === 'beatport' ? 'AIFF' : 'FLAC',
    lossless: true,
    rx3Compatible: source === 'beatport',
    confidence: 1,
    url: '',
    source,
  };
}

// ---------- main ----------

export async function restoreLibrary(
  options: RestoreOptions,
  onProgress?: (p: RestoreProgress) => void,
  signal?: AbortSignal
): Promise<RestoreReport> {
  const startedAt = new Date();
  // Cooperative cancellation: throw at phase boundaries (and crucially before the
  // destructive XML rewrite) when the user aborts. Downloads already in flight
  // finish, but no new phase starts.
  const checkAbort = () => {
    if (signal?.aborted) throw new Error('Restore aborted by user');
  };
  await fsp.mkdir(options.stageDir, { recursive: true });

  const totals: RestoreProgress['totals'] = {
    totalXmlTracks: 0, alreadyInLibrary: 0, missing: 0, recovered: 0, stillMissing: 0, deletedSkipped: 0,
  };
  const results = new Map<string, RestoreTrackResult>();
  const deletedSkipped: RestoreSkippedTrack[] = [];
  const storeErrors: string[] = [];

  // Per-account counters keyed by `${service}:${accountId}` so we can serialize
  // them on every emit without allocating a new list unnecessarily.
  const perAccountMap = new Map<string, RestorePerAccountCounter>();
  const bumpPerAccount = (key: string, service: 'qobuz' | 'beatport', accountId: string, patch: Partial<RestorePerAccountCounter>) => {
    const existing = perAccountMap.get(key) ?? { accountId, service };
    perAccountMap.set(key, { ...existing, ...patch });
  };
  const perAccountSnapshot = () => Array.from(perAccountMap.values());

  const emit = (opts: {
    phase: RestorePhase;
    message: string;
    currentTrack?: string;
    phaseStatus?: RestorePhaseStatus;
    log?: { level: RestoreLogLevel; message: string };
    withPerAccount?: boolean;
  }) => {
    const elapsedMs = Date.now() - startedAt.getTime();
    const elapsedSec = elapsedMs / 1000;
    // Recovery rate over the job so far, used for a rough ETA. We only project
    // once at least a couple of tracks have been recovered so the first tracks'
    // ramp-up time doesn't skew the estimate wildly.
    const rate = elapsedSec > 0 && totals.recovered > 0 ? totals.recovered / elapsedSec : undefined;
    const estRemainingSec = (rate && rate > 0 && totals.stillMissing > 0)
      ? totals.stillMissing / rate
      : undefined;

    const payload: RestoreProgress = {
      phase: opts.phase,
      phaseStatus: opts.phaseStatus,
      message: opts.message,
      currentTrack: opts.currentTrack,
      totals: { ...totals },
      elapsedSec,
      estRemainingSec,
      rate,
    };
    if (opts.withPerAccount) payload.perAccount = perAccountSnapshot();
    if (opts.log) {
      payload.log = {
        level: opts.log.level,
        phase: opts.phase,
        message: opts.log.message,
        timestamp: Date.now(),
        currentTrack: opts.currentTrack,
      };
    }
    onProgress?.(payload);
  };

  const phaseStart = (phase: RestorePhase, message: string) =>
    emit({ phase, phaseStatus: 'start', message, log: { level: 'info', message } });
  const phaseEnd = (phase: RestorePhase, message: string) =>
    emit({ phase, phaseStatus: 'end', message, log: { level: 'info', message } });
  const phaseSkipped = (phase: RestorePhase, message: string) =>
    emit({ phase, phaseStatus: 'skipped', message, log: { level: 'info', message: `${message} — skipped` } });

  phaseStart('parsing', `Parsing ${path.basename(options.xmlPath)}`);
  const xmlTracks = await parseRekordboxXml(options.xmlPath);
  totals.totalXmlTracks = xmlTracks.length;
  log.info(`Parsed ${xmlTracks.length} tracks from Rekordbox XML`);
  phaseEnd('parsing', `Parsed ${xmlTracks.length} tracks from Rekordbox XML`);

  phaseStart('scanning_library', `Scanning library at ${options.libraryRoot}`);
  // walkAudioDir is used inside computeMissing — no sub-progress for now.
  phaseEnd('scanning_library', 'Library scan complete');

  phaseStart('computing_missing', 'Computing missing tracks');
  const missingOnDisk = await computeMissing(xmlTracks, options.libraryRoot);
  // Anything the user deleted stays deleted: never restore a tombstoned track.
  const missing: RekordboxTrack[] = [];
  for (const t of missingOnDisk) {
    if (isTrackDeleted({ artist: t.artist, title: t.title })) {
      deletedSkipped.push({ trackId: t.trackId, artist: t.artist, title: t.title, reason: 'you deleted this track' });
    } else {
      missing.push(t);
    }
  }
  totals.deletedSkipped = deletedSkipped.length;
  if (deletedSkipped.length > 0) {
    log.info(`Skipping ${deletedSkipped.length} missing track(s) the user deleted`);
    emit({ phase: 'computing_missing', message: `Skipping ${deletedSkipped.length} track(s) you deleted`,
      log: { level: 'info', message: `Skipping ${deletedSkipped.length} deleted track(s); deleted tracks are never restored` } });
  }
  totals.alreadyInLibrary = xmlTracks.length - missingOnDisk.length;
  totals.missing = missing.length;
  totals.stillMissing = missing.length;
  for (const t of missing) results.set(t.trackId, { track: t, status: 'pending', source: null });
  log.info(`Missing: ${missing.length} tracks`);
  phaseEnd('computing_missing', `${missing.length} tracks missing from library`);

  // Working set of tracks still to recover
  let remaining = [...missing];

  /** A store download declined this track because the user deleted it: drop it
   *  from the results (it is neither missing nor failed) and list it separately. */
  const skipDeleted = (track: RekordboxTrack, reason: string) => {
    if (!results.delete(track.trackId)) return;
    totals.missing--; totals.stillMissing--; totals.deletedSkipped++;
    deletedSkipped.push({ trackId: track.trackId, artist: track.artist, title: track.title, reason });
  };
  /** Record purchase-history read failures: they mean "couldn't check", not "not owned". */
  const noteStoreErrors = (phase: RestorePhase, errors: string[] | undefined) => {
    for (const e of errors ?? []) {
      storeErrors.push(e);
      log.warn(`Couldn't check ${e}`);
      emit({ phase, message: `Couldn't check ${e}`, log: { level: 'warn', message: `Couldn't check ${e}` } });
    }
  };
  const findSkipped = (dl: { skipped?: { trackId: string; artist: string; title: string; reason: string }[] }, m: StoreMatch) =>
    dl.skipped?.find(x => x.trackId === m.trackId) ?? dl.skipped?.find(x => x.artist === m.artist && x.title === m.title);

  // ---------- Stage 1: USB ----------
  if (options.sources.usb && remaining.length > 0) {
    phaseStart('usb_scan', 'Looking for mounted volumes');
    let volumes = await listExternalVolumes();
    if (options.usbVolumesAllowlist?.length) {
      const allow = new Set(options.usbVolumesAllowlist);
      volumes = volumes.filter(v => allow.has(v.name) || allow.has(v.mountPath));
    }
    log.info(`USB volumes detected: ${volumes.length}`);
    emit({ phase: 'usb_scan', message: `Scanning ${volumes.length} volume(s)`,
      log: { level: 'info', message: `USB volumes: ${volumes.map(v => v.name).join(', ') || 'none'}` } });

    for (const vol of volumes) {
      emit({ phase: 'usb_scan', message: `Indexing ${vol.name}${options.usbTagMatching ? ' (reading tags)' : ''}`,
        log: { level: 'info', message: `Indexing ${vol.name}` } });
      const index = await buildUsbIndex(vol, {
        readTags: options.usbTagMatching === true,
        onProgress: options.usbTagMatching
          ? (done, total) => emit({ phase: 'usb_scan', message: `Reading tags on ${vol.name}: ${done}/${total}` })
          : undefined,
      });
      const nextRemaining: RekordboxTrack[] = [];
      let volRecovered = 0;
      for (const t of remaining) {
        const hit = matchAgainstUsbIndex(t, index);
        if (!hit) { nextRemaining.push(t); continue; }
        if (!(await usbMatchDurationOk(hit))) {
          nextRemaining.push(t);
          const r = results.get(t.trackId)!;
          r.detail = (r.detail ? r.detail + '; ' : '') + `usb ${hit.method} match rejected: length differs from Rekordbox (${path.basename(hit.sourcePath)})`;
          continue;
        }
        try {
          const destPath = await copyUsbMatch(hit, options.stageDir);
          const r = results.get(t.trackId)!;
          r.status = 'recovered'; r.source = 'usb'; r.destPath = destPath;
          r.detail = hit.method === 'fuzzy'
            ? `fuzzy (folder=${hit.folderScore}, file=${hit.fileScore}): ${vol.name}`
            : `exact path: ${vol.name}`;
          totals.recovered++; totals.stillMissing--;
          volRecovered++;
          emit({ phase: 'usb_scan', message: `Recovered from ${vol.name}`, currentTrack: `${t.artist} — ${t.title}`,
            log: { level: 'info', message: `USB recovery: ${t.artist} — ${t.title} (${vol.name})` } });
        } catch (err) {
          nextRemaining.push(t);
          const r = results.get(t.trackId)!;
          const errMsg = err instanceof Error ? err.message : String(err);
          r.detail = (r.detail ? r.detail + '; ' : '') + `usb copy failed: ${errMsg}`;
          r.failureCategory = 'copy';
          emit({ phase: 'usb_scan', message: `USB copy failed: ${errMsg}`, currentTrack: `${t.artist} — ${t.title}`,
            log: { level: 'error', message: `USB copy failed for ${t.artist} — ${t.title}: ${errMsg}` } });
        }
      }
      remaining = nextRemaining;
      emit({ phase: 'usb_scan', message: `${vol.name}: ${volRecovered} recovered`,
        log: { level: 'info', message: `${vol.name}: ${volRecovered} tracks recovered, ${nextRemaining.length} still missing` } });
    }
    phaseEnd('usb_scan', `USB scan complete — ${remaining.length} still missing`);
  } else if (!options.sources.usb) {
    phaseSkipped('usb_scan', 'USB source disabled');
  }

  // ---------- Stage 2: Beatport ----------
  const beatportAccounts = options.beatportAccounts ?? [];
  if (options.sources.beatport && remaining.length > 0 && beatportAccounts.length > 0) {
    // Seed per-account rows so the dashboard can render them before any data lands.
    for (const a of beatportAccounts) {
      const key = `beatport:${a.id}`;
      bumpPerAccount(key, 'beatport', a.id, { label: a.label, email: a.email });
    }
    phaseStart('beatport_fetch', `Fetching purchases from ${beatportAccounts.length} Beatport account(s)`);
    const owned = await fetchAllBeatportPurchases(beatportAccounts);
    noteStoreErrors('beatport_fetch', owned.errors);
    // Attribute owned counts back to each account.
    const beatportOwnedByAccount = new Map<string, number>();
    for (const o of owned) {
      const acct = o.sourceAccountId ?? beatportAccounts[0]?.id;
      if (!acct) continue;
      beatportOwnedByAccount.set(acct, (beatportOwnedByAccount.get(acct) ?? 0) + 1);
    }
    for (const a of beatportAccounts) {
      const key = `beatport:${a.id}`;
      bumpPerAccount(key, 'beatport', a.id, { ownedCount: beatportOwnedByAccount.get(a.id) ?? 0 });
    }
    log.info(`Beatport: ${owned.length} tracks owned across ${beatportAccounts.length} account(s)`);
    phaseEnd('beatport_fetch', `${owned.length} tracks owned on Beatport${owned.errors?.length ? ` (${owned.errors.length} account(s) couldn't be checked)` : ''}`);
    emit({ phase: 'beatport_fetch', message: `${owned.length} total purchases fetched`, withPerAccount: true });

    const toDownload: StoreMatch[] = [];
    const matchedTrackIds: string[] = [];
    for (const t of remaining) {
      const input: StoreTrackInput = { key: t.trackId, artist: t.artist, title: t.title, album: t.album };
      const match = matchesOwnedTrack(input, owned);
      if (match) {
        toDownload.push(buildStoreMatch(t, match, 'beatport'));
        matchedTrackIds.push(t.trackId);
        // Pre-record the match attribution so matchedCount shows up even if download later fails.
        const acct = match.sourceAccountId ?? beatportAccounts[0]?.id;
        if (acct) {
          const key = `beatport:${acct}`;
          const prev = perAccountMap.get(key)?.matchedCount ?? 0;
          bumpPerAccount(key, 'beatport', acct, { matchedCount: prev + 1 });
        }
      }
    }
    log.info(`Beatport matches: ${toDownload.length}`);
    emit({ phase: 'beatport_fetch', message: `${toDownload.length} of ${remaining.length} missing tracks matched Beatport purchases`, withPerAccount: true });

    if (toDownload.length > 0) {
      checkAbort();
      phaseStart('beatport_download', `Downloading ${toDownload.length} tracks from Beatport`);
      const dl = await downloadBeatportPurchases(
        beatportAccounts[0]?.id ?? LEGACY_ACCOUNT_ID,
        toDownload, options.stageDir,
        (p) => emit({ phase: 'beatport_download', message: p.message, currentTrack: p.currentTrack }),
        options.concurrency,
      );
      // Match by basename-without-extension so we survive `.aif` vs `.aiff`
      // or the converter choosing a different extension than we expected.
      const stripExt = (p: string) => path.basename(p, path.extname(p)).toLowerCase();
      const recoveredBases = new Set(dl.downloaded.map(stripExt));
      const nextRemaining: RekordboxTrack[] = [];
      for (let i = 0; i < toDownload.length; i++) {
        const rbxId = matchedTrackIds[i];
        const rbx = results.get(rbxId)!;
        const skip = findSkipped(dl, toDownload[i]);
        if (skip) { skipDeleted(rbx.track, skip.reason); continue; }
        const expectedBase = sanitizeFilename(`${toDownload[i].artist} - ${toDownload[i].title}`).toLowerCase();
        const matchAccountId = toDownload[i].sourceAccountId ?? beatportAccounts[0]?.id;
        rbx.sourceAccountId = matchAccountId;
        if (recoveredBases.has(expectedBase)) {
          rbx.status = 'recovered'; rbx.source = 'beatport';
          rbx.destPath = dl.downloaded.find(p => stripExt(p) === expectedBase);
          rbx.detail = 'beatport purchase-download';
          totals.recovered++; totals.stillMissing--;
          if (matchAccountId) {
            const key = `beatport:${matchAccountId}`;
            const prev = perAccountMap.get(key)?.downloadedCount ?? 0;
            bumpPerAccount(key, 'beatport', matchAccountId, { downloadedCount: prev + 1 });
          }
        } else {
          const tid = toDownload[i].trackId;
          const failure = dl.failed.find(f => f.trackId === tid)
            ?? dl.failed.find(f => f.artist === toDownload[i].artist && f.title === toDownload[i].title);
          const failMsg = failure?.error || 'unknown failure (no matching failure entry — see logs)';
          rbx.detail = `beatport: ${failMsg}`;
          rbx.failureCategory = /login|auth|unauthori|401|403/i.test(failMsg) ? 'login' : 'download';
          if (matchAccountId) {
            const key = `beatport:${matchAccountId}`;
            const prev = perAccountMap.get(key)?.failedCount ?? 0;
            bumpPerAccount(key, 'beatport', matchAccountId, { failedCount: prev + 1 });
          }
        }
      }
      for (const t of remaining) {
        const r = results.get(t.trackId);
        // Deleted-and-skipped tracks are gone from results: not "still to recover".
        if (r && r.status !== 'recovered') nextRemaining.push(t);
      }
      remaining = nextRemaining;
      phaseEnd('beatport_download', `Beatport download complete — ${dl.downloaded.length} succeeded, ${dl.failed.length} failed${dl.skipped?.length ? `, ${dl.skipped.length} skipped (you deleted them)` : ''}`);
      emit({ phase: 'beatport_download', message: 'Beatport complete', withPerAccount: true });
    } else {
      phaseEnd('beatport_download', 'No Beatport downloads needed');
    }
  } else if (!options.sources.beatport) {
    phaseSkipped('beatport_fetch', 'Beatport source disabled');
  } else if (beatportAccounts.length === 0) {
    phaseSkipped('beatport_fetch', 'No Beatport accounts configured');
  }

  // ---------- Stage 3: Qobuz ----------
  const qobuzAccounts = options.qobuzAccounts ?? [];
  if (options.sources.qobuz && remaining.length > 0 && qobuzAccounts.length > 0) {
    for (const a of qobuzAccounts) {
      const key = `qobuz:${a.id}`;
      bumpPerAccount(key, 'qobuz', a.id, { label: a.label, email: a.email });
    }
    phaseStart('qobuz_fetch', `Fetching purchases from ${qobuzAccounts.length} Qobuz account(s)`);
    const owned = await fetchAllQobuzPurchases(qobuzAccounts);
    noteStoreErrors('qobuz_fetch', owned.errors);
    const qobuzOwnedByAccount = new Map<string, number>();
    for (const o of owned) {
      const acct = o.sourceAccountId ?? qobuzAccounts[0]?.id;
      if (!acct) continue;
      qobuzOwnedByAccount.set(acct, (qobuzOwnedByAccount.get(acct) ?? 0) + 1);
    }
    for (const a of qobuzAccounts) {
      const key = `qobuz:${a.id}`;
      bumpPerAccount(key, 'qobuz', a.id, { ownedCount: qobuzOwnedByAccount.get(a.id) ?? 0 });
    }
    log.info(`Qobuz: ${owned.length} tracks owned across ${qobuzAccounts.length} account(s)`);
    phaseEnd('qobuz_fetch', `${owned.length} tracks owned on Qobuz${owned.errors?.length ? ` (${owned.errors.length} account(s) couldn't be checked)` : ''}`);
    emit({ phase: 'qobuz_fetch', message: `${owned.length} total purchases fetched`, withPerAccount: true });

    const toDownload: StoreMatch[] = [];
    const matchedTrackIds: string[] = [];
    for (const t of remaining) {
      const input: StoreTrackInput = { key: t.trackId, artist: t.artist, title: t.title, album: t.album };
      const match = matchesOwnedTrack(input, owned);
      if (match) {
        toDownload.push(buildStoreMatch(t, match, 'qobuz'));
        matchedTrackIds.push(t.trackId);
        const acct = match.sourceAccountId ?? qobuzAccounts[0]?.id;
        if (acct) {
          const key = `qobuz:${acct}`;
          const prev = perAccountMap.get(key)?.matchedCount ?? 0;
          bumpPerAccount(key, 'qobuz', acct, { matchedCount: prev + 1 });
        }
      }
    }
    log.info(`Qobuz matches: ${toDownload.length}`);
    emit({ phase: 'qobuz_fetch', message: `${toDownload.length} of ${remaining.length} missing tracks matched Qobuz purchases`, withPerAccount: true });

    if (toDownload.length > 0) {
      checkAbort();
      phaseStart('qobuz_download', `Downloading ${toDownload.length} tracks from Qobuz`);
      const dl = await downloadQobuzPurchases(
        qobuzAccounts[0]?.id ?? LEGACY_ACCOUNT_ID,
        toDownload, options.stageDir,
        (p) => emit({ phase: 'qobuz_download', message: p.message, currentTrack: p.currentTrack }),
        options.concurrency,
      );
      const stripExt = (p: string) => path.basename(p, path.extname(p)).toLowerCase();
      const recoveredBases = new Set(dl.downloaded.map(stripExt));
      for (let i = 0; i < toDownload.length; i++) {
        const rbxId = matchedTrackIds[i];
        const rbx = results.get(rbxId)!;
        const skip = findSkipped(dl, toDownload[i]);
        if (skip) { skipDeleted(rbx.track, skip.reason); continue; }
        const expectedBase = sanitizeFilename(`${toDownload[i].artist} - ${toDownload[i].title}`).toLowerCase();
        const matchAccountId = toDownload[i].sourceAccountId ?? qobuzAccounts[0]?.id;
        rbx.sourceAccountId = matchAccountId;
        if (recoveredBases.has(expectedBase)) {
          rbx.status = 'recovered'; rbx.source = 'qobuz';
          rbx.destPath = dl.downloaded.find(p => stripExt(p) === expectedBase);
          rbx.detail = 'qobuz track/getFileUrl';
          totals.recovered++; totals.stillMissing--;
          if (matchAccountId) {
            const key = `qobuz:${matchAccountId}`;
            const prev = perAccountMap.get(key)?.downloadedCount ?? 0;
            bumpPerAccount(key, 'qobuz', matchAccountId, { downloadedCount: prev + 1 });
          }
        } else {
          const tid = toDownload[i].trackId;
          const failure = dl.failed.find(f => f.trackId === tid)
            ?? dl.failed.find(f => f.artist === toDownload[i].artist && f.title === toDownload[i].title);
          const failMsg = failure?.error || 'unknown failure (no matching failure entry — see logs)';
          rbx.detail = `qobuz: ${failMsg}`;
          rbx.failureCategory = /login|auth|unauthori|401|403/i.test(failMsg) ? 'login' : 'download';
          if (matchAccountId) {
            const key = `qobuz:${matchAccountId}`;
            const prev = perAccountMap.get(key)?.failedCount ?? 0;
            bumpPerAccount(key, 'qobuz', matchAccountId, { failedCount: prev + 1 });
          }
        }
      }
      phaseEnd('qobuz_download', `Qobuz download complete — ${dl.downloaded.length} succeeded, ${dl.failed.length} failed${dl.skipped?.length ? `, ${dl.skipped.length} skipped (you deleted them)` : ''}`);
      emit({ phase: 'qobuz_download', message: 'Qobuz complete', withPerAccount: true });
    } else {
      phaseEnd('qobuz_download', 'No Qobuz downloads needed');
    }
  } else if (!options.sources.qobuz) {
    phaseSkipped('qobuz_fetch', 'Qobuz source disabled');
  } else if (qobuzAccounts.length === 0) {
    phaseSkipped('qobuz_fetch', 'No Qobuz accounts configured');
  }

  // ---------- Finalize ----------
  const resultsList = Array.from(results.values());
  for (const r of resultsList) {
    if (r.status === 'pending') {
      r.status = 'still_missing';
      if (!r.failureCategory && storeErrors.length > 0) {
        // Some purchase history couldn't be read, so "no match" isn't proven.
        r.failureCategory = storeErrors.some(e => /login|auth|unauthori|401|403|sign.?in/i.test(e)) ? 'login' : 'other';
        r.detail = (r.detail ? r.detail + '; ' : '') + `not found in the purchases that could be read; couldn't check: ${storeErrors.join('; ')}`;
      }
      // If we never matched it and don't have a more specific reason, mark as no_match.
      if (!r.failureCategory) r.failureCategory = 'no_match';
    }
  }

  const bySource: Record<string, number> = {};
  for (const r of resultsList) {
    if (r.source) bySource[r.source] = (bySource[r.source] || 0) + 1;
  }

  // Collision check: if multiple recovered tracks landed at the same destPath,
  // leave the XML Location untouched for the losers — we can't tell which one
  // should claim the file. Kept as 'recovered' (the file IS staged) but flagged
  // in detail so the UI can surface it.
  const pathCounts = new Map<string, number>();
  for (const r of resultsList) {
    if (r.status === 'recovered' && r.destPath) {
      pathCounts.set(r.destPath, (pathCounts.get(r.destPath) || 0) + 1);
    }
  }
  const collidingPaths = new Set(
    Array.from(pathCounts.entries()).filter(([, n]) => n > 1).map(([p]) => p),
  );

  // ---------- Optional XML rewrite ----------
  let xmlRewrite: XmlRewriteSummary | undefined;
  if (options.rewriteXml) {
    checkAbort(); // last safe point before the destructive rewrite
    const updates = resultsList
      .filter(r => r.status === 'recovered' && r.destPath && !collidingPaths.has(r.destPath))
      .map(r => ({ trackId: r.track.trackId, newPath: r.destPath! }));
    phaseStart('xml_rewrite', `Rewriting ${updates.length} Location entries in XML`);
    const res = await rewriteLocations(options.xmlPath, updates);
    xmlRewrite = { backupPath: res.backupPath, updated: res.updated.length, notFound: res.notFound.length };
    log.info(`XML rewrite: ${res.updated.length} updated, ${res.notFound.length} notFound, backup ${res.backupPath}`);
    const notFoundIds = new Set(res.notFound);
    for (const r of resultsList) {
      if (notFoundIds.has(r.track.trackId)) {
        r.detail = (r.detail ? r.detail + '; ' : '') + 'xml rewrite: TrackID not found in XML';
        r.failureCategory = r.failureCategory ?? 'rewrite';
      }
    }
    for (const r of resultsList) {
      if (r.destPath && collidingPaths.has(r.destPath)) {
        r.detail = (r.detail ? r.detail + '; ' : '') + `xml rewrite skipped: ${pathCounts.get(r.destPath)} tracks map to same file`;
      }
    }
    phaseEnd('xml_rewrite', `XML rewrite: ${res.updated.length} updated${res.notFound.length ? `, ${res.notFound.length} not found` : ''}`);
  } else {
    phaseSkipped('xml_rewrite', 'XML rewrite disabled');
  }

  const finishedAt = new Date();
  emit({
    phase: 'complete', phaseStatus: 'end',
    message: `Done — recovered ${totals.recovered} / ${totals.missing}`,
    log: { level: 'info', message: `Restore complete — ${totals.recovered} of ${totals.missing} recovered in ${Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000)}s` },
    withPerAccount: true,
  });

  return {
    options, totals, bySource, results: resultsList,
    deletedSkipped,
    storeErrors,
    xmlRewrite,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationSec: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
  };
}
