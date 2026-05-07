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
import { walkAudioDir } from './fileUtils';
import { normalizeForComparison } from './stringUtils';
import { parseRekordboxXml, rewriteLocations, type RekordboxTrack } from './rekordboxXml';
import {
  listExternalVolumes, buildUsbIndex, matchAgainstUsbIndex,
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

export type RestoreReport = {
  options: RestoreOptions;
  totals: RestoreProgress['totals'];
  bySource: Record<string, number>;
  results: RestoreTrackResult[];
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

/** Scan library and decide which Rekordbox tracks are already present (reuses prior logic). */
async function computeMissing(xmlTracks: RekordboxTrack[], libraryRoot: string): Promise<RekordboxTrack[]> {
  const libFiles = await walkAudioDir(libraryRoot);
  const byBasename = new Map<string, string[]>();
  for (const f of libFiles) {
    const base = path.basename(f).toLowerCase();
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base)!.push(f);
  }
  const missing: RekordboxTrack[] = [];
  for (const t of xmlTracks) {
    const origBase = path.basename(t.origPath || '').toLowerCase();
    if (origBase && byBasename.has(origBase)) continue;

    // Fuzzy fallback: artist folder contains all tokens + >=60% of title tokens in filename.
    const firstArtist = (t.artist || '').split(/[,&]/)[0].trim();
    const artistTokens = normalizeForComparison(firstArtist).split(' ').filter(Boolean);
    const titleTokens = normalizeForComparison(t.title).split(' ').filter(Boolean);
    if (titleTokens.length === 0 || artistTokens.length === 0) { missing.push(t); continue; }

    const found = libFiles.find(f => {
      const rel = f.slice(libraryRoot.length + 1);
      const folder = (rel.split('/')[0] || '').toLowerCase();
      const fname = path.basename(f).toLowerCase();
      if (!artistTokens.every(w => folder.includes(w))) return false;
      const hits = titleTokens.filter(w => fname.includes(w)).length / titleTokens.length;
      return hits >= 0.6;
    });
    if (!found) missing.push(t);
  }
  return missing;
}

async function copyUsbMatch(match: UsbMatch, stageDir: string): Promise<string> {
  const ext = path.extname(match.sourcePath);
  const destName = sanitizeFilename(`${match.rekordboxTrack.artist} - ${match.rekordboxTrack.title}${ext}`);
  const destPath = path.join(stageDir, destName);
  if (!fs.existsSync(destPath)) await fsp.copyFile(match.sourcePath, destPath);
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
  onProgress?: (p: RestoreProgress) => void
): Promise<RestoreReport> {
  const startedAt = new Date();
  await fsp.mkdir(options.stageDir, { recursive: true });

  const totals: RestoreProgress['totals'] = {
    totalXmlTracks: 0, alreadyInLibrary: 0, missing: 0, recovered: 0, stillMissing: 0,
  };
  const results = new Map<string, RestoreTrackResult>();

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
  const missing = await computeMissing(xmlTracks, options.libraryRoot);
  totals.alreadyInLibrary = xmlTracks.length - missing.length;
  totals.missing = missing.length;
  totals.stillMissing = missing.length;
  for (const t of missing) results.set(t.trackId, { track: t, status: 'pending', source: null });
  log.info(`Missing: ${missing.length} tracks`);
  phaseEnd('computing_missing', `${missing.length} tracks missing from library`);

  // Working set of tracks still to recover
  let remaining = [...missing];

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
    phaseEnd('beatport_fetch', `${owned.length} tracks owned on Beatport`);
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
        const r = results.get(t.trackId)!;
        if (r.status !== 'recovered') nextRemaining.push(t);
      }
      remaining = nextRemaining;
      phaseEnd('beatport_download', `Beatport download complete — ${dl.downloaded.length} succeeded, ${dl.failed.length} failed`);
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
    phaseEnd('qobuz_fetch', `${owned.length} tracks owned on Qobuz`);
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
      phaseEnd('qobuz_download', `Qobuz download complete — ${dl.downloaded.length} succeeded, ${dl.failed.length} failed`);
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
    xmlRewrite,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationSec: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
  };
}
