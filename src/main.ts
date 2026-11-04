import log, { createScopedLogger, enableFileLog } from './lib/logger';
import { app, BrowserWindow, webContents, ipcMain, dialog, nativeImage, Tray, Menu, protocol, net, shell, session, type OpenDialogOptions } from 'electron';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { spawn, execFile } from 'child_process';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { initOpLog, getOpLogDir, currentOp, withOp, startOp, runInOp, recordEvent, flushOpLog, flushOpLogSync, type Op, type OpSource } from './lib/opLog';
import { createIpcRegistry } from './lib/ipcOps';
import { windowOnlyReason } from './lib/mcpParity';

const mainLog = createScopedLogger('Main');

// Logs Claude can read back (and the MCP server's log tools serve):
//   logs/main.log  everything logged, debug and up, each line tagged with its operation
//   logs/ops/      every operation: what was asked, by whom, its progress, output and outcome
// Set up first, so startup itself is on record.
const LOGS_DIR = path.join(app.getPath('userData'), 'logs');
enableFileLog(LOGS_DIR, 'main');
initOpLog(app.getPath('userData'), { proc: 'app' });

// Process-level error handlers
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error);
  flushOpLogSync();
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason);
});

/** Reads the window makes all the time (album art per row, polling): kept in
 *  the operations log only when they fail or are slow. */
const QUIET_CHANNELS: ReadonlySet<string> = new Set([
  'get-track-album-art', 'get-track-info', 'list-volumes', 'store-panel-status', 'job-list', 'claude-status',
  'get-config', 'get-config-path', 'get-library-root', 'get-cache-status', 'get-ignored-tracks', 'get-dismissed-issues',
  'saved-sources:list', 'store-login-status', 'soundcloud-sign-in-status', 'splice-login-status',
  'get-organize-state', 'update-organize-state', 'update-check-result', 'update-health-result',
  'restore-list-volumes', 'diagnose-aiff-header',
]);

// Every IPC handler goes through here: recorded in the operations log, and
// runnable by Claude's MCP tools over the app's socket (bridge `invoke`).
const ipcOps = createIpcRegistry(ipcMain, { quiet: QUIET_CHANNELS });
const handleIpc = ipcOps.handle;
import { organizeTracks, OrganizeResult } from './lib/organizeByArtist';
import { cartUrl } from './lib/storeUrls';
import { spotifyTracksToTrackRecords, CheckResult, ProgressUpdate, previewCsv, CsvPreview, type TrackRecord } from './lib/musicLibraryCheck';
import {
  toOwnershipInput, bucketsToCheckResult, rekordboxReadError, csvRecordsToTrackRecords, collectionPathKey,
  type OwnershipBuckets, type OwnershipStats, type OwnershipUncertainMatch,
} from './lib/libraryOwnership';
import {
  isStorePartition, isAllowedWebviewSrc, isAllowedGuestNavigation, isAllowedExternalUrl,
  isStoreCheckoutUrl, isStoreSignInUrl, plainChromeUserAgent, PLACE_ORDER_RE, ADVANCE_RE, scrapeItemCount, resyncRefusal,
} from './lib/mainGuards';
import { readConfig, writeConfig, AppConfig, DEFAULT_LIBRARY_ROOT, getDefaultArchivePath, getDefaultRestoreStageDir, setSecretsPath, getConfigWarnings, resolveRekordboxBackupDir } from './lib/config';
import { searchSpotify, testSpotifyConnection, SpotifySearchResult, getPlaylistTracks, getSpotifyTracksByIds } from './lib/spotify';
import { fetchSoundCloudSet } from './lib/soundcloudSets';
import { readSoundCloudSignIn, signInToSoundCloud } from './lib/soundcloudSession';
import { startStoreBridge, type BridgeHandler, type BridgeMeta } from './lib/storeBridge';
import { randomUUID } from 'crypto';
import { listRekordboxPlaylists, readRekordboxPlaylist } from './lib/rekordboxPlaylists';
import {
  toUpgradeRow, spotifyIdToResolve, applySpotifyTrack, buildLosslessIndex, findLosslessCopy, needsStoreSearch
} from './lib/losslessUpgrade';
import { searchFreeSources, writeFetchList, readUpgradeOutcomes, runFreeFetch, type FreeFetchRow } from './lib/freeSources';
import { preflightUpgradeSwap, planUpgradeSwap, applyUpgradeSwap } from './lib/rekordboxUpgradeSwap';
import {
  searchSoundCloud,
  searchSoundCloudPublicTracks,
  SoundCloudSearchResult
} from './lib/soundcloud';
import { searchBeatport, searchBeatportTracks, BeatportSearchResult } from './lib/beatport';
import { searchQobuz, searchQobuzTracks, QobuzSearchResult } from './lib/qobuz';
import { batchSearchQobuz, resolveQobuzHit, QobuzCartTrackInput, type QobuzCartMatch, type StoreCandidates } from './lib/qobuzCart';
import { buildFinderTracks, applyFinderPicks, finderSummary, toFinderCandidate } from './lib/claude/storeFinder';
import {
  loginQobuz, loginBeatport, logoutQobuz, logoutBeatport, isQobuzLoggedIn, isBeatportLoggedIn,
  fetchAllQobuzPurchases, fetchAllBeatportPurchases,
  downloadBeatportPurchases, downloadQobuzPurchases,
  setBeatportToken, getBeatportAccessToken, readBeatportSessionToken,
  addToQobuzCart, addToBeatportCart, checkQobuzCart, checkBeatportCart,
  probeQobuzLoginForPartition, invalidateQobuzAuthCache,
  qobuzPartition, beatportPartition,
  keepStoreSessionCookies, flushStoreCookies,
  LEGACY_ACCOUNT_ID,
} from './lib/storePurchase';
import { closeStoreBrowsers } from './lib/storeBrowser';
import { restoreLibrary, type RestoreOptions, type RestoreReport, type RestoreProgress } from './lib/restoreLibrary';
import { listExternalVolumes } from './lib/usbScan';
import type { StoreMatch, StoreAccount, StoreCartCheck, SoundCloudSignIn, UpdateState } from './types';
import { scanTracks, updateTags, getAlbumArtFromFile, TrackInfo, UpdateTagsParams } from './lib/trackScanner';
import { readDjTags } from './lib/djTags';
import { diagnoseAiffHeader, repairAiffHeader, type AiffHeaderDiagnosis } from './lib/aiffRepair';
import { scanMissingAlbumArt, type AlbumArtScanProgress } from './lib/albumArtScan';
import { convertToAiff, reencodeToMp3, createMp3PreviewResponse, ConversionResult } from './lib/trackConverter';
import { scanLibraryHealth, LibraryHealthResult, archiveTrackFile, ArchiveResult } from './lib/libraryHealthScan';
import {
  initCachePath,
  loadCache,
  getCacheStatus,
  clearCache,
  updateCachedCheckResult
} from './lib/scanCache';
import {
  getHealthSnapshot,
  replaceLibraryFromResult,
  getOrganizeState,
  saveOrganizeState,
  migrateFromJsonCacheIfNeeded,
  clearLibraryRoot
} from './lib/libraryStore';
import { exportCatalog } from './lib/catalogExport';
import { safeMove } from './lib/fileUtils';
import { initWriteJournal, getWriteJournalDir, recordWrite, statBytes, flushWriteJournal } from './lib/writeJournal';
import { safeDelete, setTrashHandler } from './lib/safeDelete';
import { listUsbVolumes } from './lib/usbHealthScan';
import { normalizeForComparison, stringSimilarity } from './lib/stringUtils';
import { initJobQueue, getJobManager } from './lib/jobQueue';
import { getClaudeStatus, openClaudeLogin } from './lib/claude/claudeCode';
import { AUTOPOPULATE_CONCURRENCY, AUDIO_EXTENSIONS } from './lib/constants';
import { initDatabase, closeDatabase, ignoreTrack, unignoreTrack, getIgnoredTracks, getIgnoredTrackKeys, dismissDuplicate, getDismissedDuplicateKeys, makeDuplicatePairKey, dismissHealthIssue, undismissHealthIssue, getDismissedIssues, markTrackAutopopulated, getAutopopulatedPaths, recordDeletedTrack, updateDownloadedTrackPath, getDatabase } from './lib/db';
import { listSavedSources, saveSavedSource, renameSavedSource, removeSavedSource } from './lib/db';
import { parseRekordboxXml, findMissingFiles, importRekordboxToLibrary, type MissingFile, type RekordboxImportSummary } from './lib/rekordbox';
import { checkForUpdate, checkForRelease, oneClickBlocker, UPDATE_BRANCH, type ReleaseUpdate, type UpdateStatus } from './lib/updateCheck';
import { ensureSharedVenv } from './lib/rbxPython';

type ScriptStream = 'stdout' | 'stderr' | 'status';

type LogFn = (text: string, stream?: ScriptStream) => void;

// Register media:// scheme for audio preview (must be before app.whenReady)
// corsEnabled + the Access-Control-Allow-Origin header added in the handler let
// the player's sound wave read the audio through Web Audio; without them the
// stream counts as cross-origin and the analyser only ever sees silence.
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, stream: true, supportFetchAPI: true, corsEnabled: true } }
]);

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
// `app.getAppPath()` returns the repo root in dev and the unpacked app dir
// in production — robust to Vite's code-splitting moving main.js around.
const CONFIG_DEFAULTS_PATH = path.join(app.getAppPath(), 'config.json');
// Secrets (API keys, store accounts) live in userData beside config.json, 0600,
// so a second profile or a test run never reads or rewrites another profile's
// credentials. They used to sit in the repo checkout; the first launch after the
// move copies that file across once and leaves the original where it was.
const LEGACY_SECRETS_PATH = path.join(app.getAppPath(), 'secrets.json');
const SECRETS_PATH = path.join(app.getPath('userData'), 'secrets.json');
setSecretsPath(migrateSecretsFile(LEGACY_SECRETS_PATH, SECRETS_PATH));

/** One-time copy of the repo-checkout secrets.json into userData. Returns the
 *  path to use: the userData file, or the legacy one if the copy couldn't be
 *  made (so credentials never silently vanish). */
function migrateSecretsFile(legacyPath: string, targetPath: string): string {
  try {
    if (fs.existsSync(targetPath)) {
      fs.chmodSync(targetPath, 0o600);
      return targetPath;
    }
    if (!fs.existsSync(legacyPath)) return targetPath;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(legacyPath, targetPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(targetPath, 0o600);
    log.info(`Copied secrets.json into userData (${targetPath}); the repo copy was left in place`);
    return targetPath;
  } catch (err) {
    log.error('Could not move secrets.json into userData; still using the repo copy:', err);
    return fs.existsSync(targetPath) ? targetPath : legacyPath;
  }
}

async function getLibraryRoot(): Promise<string> {
  const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
  return config.libraryRoot || DEFAULT_LIBRARY_ROOT;
}

/**
 * Write a captured/probe/debug artifact to a private scratch dir under userData
 * (0700) with 0600 perms. These captures can contain auth tokens/cookies, so they
 * must NOT land in world-readable /tmp. Returns the absolute path written.
 */
async function writeScratchFile(name: string, contents: string): Promise<string> {
  const dir = path.join(app.getPath('userData'), 'scratch');
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const outPath = path.join(dir, name);
  await fs.promises.writeFile(outPath, contents, { mode: 0o600 });
  return outPath;
}

function resolveIconPath() {
  const candidates = [
    path.join(app.getAppPath(), 'assets', 'app-icon.icns'),
    path.join(app.getAppPath(), 'assets', 'app-icon.png')
  ];

  return candidates.find((candidate) => fs.existsSync(candidate));
}

function resolveTrayIconPath() {
  const candidates = [
    path.join(app.getAppPath(), 'assets', 'tray-icon.png'),
    path.join(__dirname, '..', '..', 'assets', 'tray-icon.png') // Dev mode fallback
  ];

  return candidates.find((candidate) => fs.existsSync(candidate));
}

let tray: Tray | null = null;

/** Send to a renderer that may be gone. Long jobs keep running after the window
 *  closes (macOS keeps the app alive) or reloads, and a send to destroyed
 *  contents throws — which would abort the job mid-operation. */
function safeSend(target: Electron.WebContents | BrowserWindow | null | undefined, channel: string, payload?: unknown): void {
  recordSend(channel, payload);
  if (!target) return;
  try {
    const wc = target instanceof BrowserWindow
      ? (target.isDestroyed() ? null : target.webContents)
      : target;
    if (!wc || wc.isDestroyed()) return;
    wc.send(channel, payload);
  } catch (err) {
    mainLog.debug(`safeSend(${channel}) dropped:`, err);
  }
}

/** What the window is shown about the running operation goes in its record
 *  too: log-panel lines as output, everything else as (throttled) progress. */
function recordSend(channel: string, payload: unknown): void {
  const op = currentOp();
  if (!op) return;
  if (channel === 'script-output' && payload && typeof payload === 'object') {
    const p = payload as { text?: unknown; stream?: unknown };
    op.output(String(p.text ?? ''), typeof p.stream === 'string' ? p.stream : 'stdout');
  } else {
    op.progress(channel, payload);
  }
}

function createLogger(sender: Electron.WebContents, id: string): LogFn {
  return (text, stream = 'stdout') => {
    safeSend(sender, 'script-output', { id, stream, text });
  };
}

// ---------- Long-running work (for quit / update confirmation) ----------
//
// Job-queue jobs are tracked by the JobManager; IPC handlers that move, delete,
// download or convert files outside the queue register here, so quitting can
// ask first and then wait for them before the database closes.
const activeOps = new Map<number, string>();
let nextOpId = 1;

async function trackOp<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const id = nextOpId++;
  activeOps.set(id, label);
  currentOp()?.label(label);
  try {
    return await fn();
  } finally {
    activeOps.delete(id);
  }
}

function runningQueueJobs(): import('./types').JobInfo[] {
  try {
    return getJobManager().getAllJobs().filter(j => j.status === 'running' || j.status === 'queued');
  } catch {
    return []; // queue not initialised (startup failed)
  }
}

/** Human labels for everything still running, de-duplicated. */
function describeRunningWork(): string[] {
  const labels = [...activeOps.values(), ...runningQueueJobs().map(j => jobLabel(j.type))];
  return [...new Set(labels)];
}

function jobLabel(type: string): string {
  const labels: Record<string, string> = {
    'library-scan': 'Library scan',
    'library-check': 'Library check',
    'library-health': 'Library health scan',
    'album-art-scan': 'Album art scan',
    'catalog-export': 'Catalog export',
    'organize-tracks': 'Organize',
    'usb-health-scan': 'USB health scan',
  };
  return labels[type] ?? type;
}

/** Cancel queued/running jobs, abort a restore, then wait (bounded) for the
 *  in-flight file operations to settle so nothing is cut off mid-copy and no
 *  handler writes to a closed database. */
async function drainRunningWork(timeoutMs = 15_000): Promise<void> {
  restoreAbortController?.abort();
  for (const job of runningQueueJobs()) {
    try { getJobManager().cancel(job.id); } catch { /* already settled */ }
  }
  const deadline = Date.now() + timeoutMs;
  while ((activeOps.size > 0 || runningQueueJobs().length > 0) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (activeOps.size > 0) {
    mainLog.warn(`Quitting with work still running after ${timeoutMs}ms: ${describeRunningWork().join(', ')}`);
  }
}

/** Ask before cutting running work short. Returns true to go ahead. */
async function confirmInterruptWork(action: 'quit' | 'update'): Promise<boolean> {
  const running = describeRunningWork();
  if (running.length === 0) return true;
  const win = getMainWindow();
  const opts: Electron.MessageBoxOptions = {
    type: 'warning',
    title: action === 'quit' ? 'Quit Track Lab?' : 'Update Track Lab?',
    message: `Track Lab is still working: ${running.join(', ')}.`,
    detail: action === 'quit'
      ? 'Quitting now cancels it. Files already moved stay moved; a copy in progress is finished or abandoned cleanly first.'
      : 'Updating restarts the app, which cancels it. You can update after it finishes — the check runs again on the next launch.',
    buttons: [action === 'quit' ? 'Quit Anyway' : 'Update Anyway', 'Keep Working'],
    defaultId: 1,
    cancelId: 1,
  };
  const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return response === 0;
}

/** The renderer's warnings and errors, and crashes or hangs, go in the main log
 *  (the renderer has no log file of its own). */
function recordWindowTrouble(win: BrowserWindow): void {
  const rendererLog = createScopedLogger('Renderer');
  win.webContents.on('console-message', (event) => {
    const { level, message, sourceId, lineNumber } = event as unknown as { level: string; message: string; sourceId: string; lineNumber: number };
    if (level !== 'warning' && level !== 'error') return;
    const where = sourceId ? ` (${sourceId.replace(/^.*\/(?=[^/]+$)/, '')}:${lineNumber})` : '';
    if (level === 'error') rendererLog.error(`${message}${where}`);
    else rendererLog.warn(`${message}${where}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    rendererLog.error('Window process gone:', details);
    recordEvent('window:crashed', { source: 'app', args: details, error: details.reason });
  });
  win.on('unresponsive', () => {
    rendererLog.warn('Window stopped responding');
    recordEvent('window:unresponsive', { source: 'app', outcome: 'error', error: 'Window stopped responding' });
  });
  win.on('responsive', () => rendererLog.info('Window responding again'));
}

/** Each queue job is an operation of its own (job:<type>), started by
 *  whatever enqueued it; its progress, log lines and outcome go in it. */
function recordJobOps(): void {
  const manager = getJobManager();
  const ops = new Map<string, Op>();
  manager.on('job-queued', (info: import('./types').JobInfo) => {
    const parent = currentOp();
    ops.set(info.id, startOp(`job:${info.type}`, {
      source: parent?.source ?? 'app',
      parent: parent?.id,
      meta: { jobId: info.id },
    }));
  });
  manager.runWrapper = (info, run) => {
    const op = ops.get(info.id);
    return op ? runInOp(op, run) : run();
  };
  manager.on('job-started', (info: import('./types').JobInfo) => ops.get(info.id)?.state('running'));
  manager.on('job-progress', (p: import('./types').JobProgress) => ops.get(p.jobId)?.progress('job-progress', p));
  manager.on('job-log', (e: { jobId: string; text: string; stream: string }) => ops.get(e.jobId)?.output(e.text, e.stream));
  const finish = (outcome: 'ok' | 'error') => (info: import('./types').JobInfo, result?: unknown) => {
    const op = ops.get(info.id);
    if (!op) return;
    ops.delete(info.id);
    op.end(outcome, outcome === 'ok' ? { result } : { error: info.status === 'cancelled' ? `Cancelled: ${info.error ?? ''}`.trim() : info.error });
  };
  manager.on('job-completed', finish('ok'));
  manager.on('job-failed', finish('error'));
  manager.on('job-cancelled', finish('error'));
}

function createWindow() {
  const iconPath = resolveIconPath();
  const win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 860,
    minHeight: 640,
    backgroundColor: '#0d1116',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Enables the in-DOM <webview> the store cart is embedded in. The guest is
      // hardened in `will-attach-webview` below (no node, isolated, store-origin
      // src only) so flipping this on doesn't widen the app's attack surface.
      webviewTag: true,
    },
    icon: iconPath,
    show: false
  });
  appWindow = win;
  win.on('closed', () => {
    if (appWindow === win) appWindow = null;
  });
  recordWindowTrouble(win);

  // Harden every <webview> guest before it attaches: strip any preload, force
  // an isolated, sandboxed no-node context, bind it only to a store session
  // partition, and only let it start on a known store origin (the renderer sets
  // src to the qobuz/beatport cart). Its navigation and popups are policed in
  // the app-level `web-contents-created` hook.
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    // The partition carries the store login. Anything else (the app's own
    // default session, an arbitrary persist: jar) is refused outright.
    const expected = storePanelOpen && storePanelStore && storePanelAccountId
      ? storePanelPartition(storePanelStore, storePanelAccountId)
      : null;
    if (!isStorePartition(params.partition) || (expected && params.partition !== expected)) {
      mainLog.warn(`Blocked <webview> on partition "${params.partition}" (expected ${expected ?? 'a store partition'})`);
      event.preventDefault();
      return;
    }
    const src = params.src ?? '';
    if (!isAllowedWebviewSrc(src)) {
      mainLog.warn(`Blocked disallowed <webview> src, redirecting to about:blank: ${src}`);
      params.src = 'about:blank';
    }
  });

  // The app window itself never navigates away or opens child windows: https
  // links (e.g. "Open on Splice") go to the system browser, everything else is
  // refused. A dropped file would otherwise replace the whole app.
  const appUrl = process.env.NODE_ENV === 'development'
    ? 'http://localhost:5173'
    : pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).href;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url, ['https:'])) void shell.openExternal(url);
    else mainLog.warn(`Refused window.open from the app window: ${url}`);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(appUrl)) return; // reload / HMR
    event.preventDefault();
    if (isAllowedExternalUrl(url, ['https:'])) void shell.openExternal(url);
    else mainLog.warn(`Refused navigation of the app window to: ${url}`);
  });

  // Maximize and show window when ready
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });

  // In development, use Vite dev server; in production, load the built file
  if (process.env.NODE_ENV === 'development') {
    void win.loadURL(appUrl);
  } else {
    void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
  return win;
}

// Popups opened by the store-cart <webview> guest (3DS/SCA bank prompts, an
// interactive login) must open as real windows so the user can complete them —
// but hardened, and in the guest's own session so OAuth/3DS cookies land in the
// account's jar (without `session` they'd go to the default one and the panel
// would never see the login). The guest itself may only navigate over https.
// Anything the app's own web-contents opens is not affected.
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedGuestNavigation(url) || url === 'about:blank') return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, session: contents.session },
      },
    };
  });
  const guard = (event: Electron.Event, url: string) => {
    if (isAllowedGuestNavigation(url)) return;
    mainLog.warn(`Blocked store panel navigation to: ${url}`);
    event.preventDefault();
  };
  contents.on('will-navigate', (event, url) => guard(event, url));
  contents.on('will-redirect', (event, url) => guard(event, url));
});

// Deny-by-default permissions on every session (the app's, each store
// partition, the login windows'). Electron otherwise grants every request —
// camera, mic, location, notifications, clipboard reads — to any page,
// including the stores' third-party scripts. Only writing to the clipboard
// (the app's copy buttons) and fullscreen are allowed.
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);
const policedSessions = new WeakSet<Electron.Session>();
function applyPermissionPolicy(ses: Electron.Session): void {
  if (policedSessions.has(ses)) return;
  policedSessions.add(ses);
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    const ok = ALLOWED_PERMISSIONS.has(permission);
    if (!ok) mainLog.debug(`Denied permission request: ${permission}`);
    callback(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
}
/** A store partition's session, told apart by where it keeps its data
 *  (`<userData>/Partitions/<name>`). The <webview>, the login windows and the
 *  hidden store pages all reach these jars, so they're caught here as created. */
function isStoreSession(ses: Electron.Session): boolean {
  const dir = ses.storagePath;
  return !!dir && path.basename(path.dirname(dir)) === 'Partitions' && isStorePartition(`persist:${path.basename(dir)}`);
}
app.on('session-created', (ses) => {
  applyPermissionPolicy(ses);
  if (isStoreSession(ses)) {
    keepStoreSessionCookies(ses);
    // Plain Chrome to the stores: an agent naming the app and Electron gets
    // Cloudflare's "Verify you are human" page on beatport.com far more often.
    ses.setUserAgent(plainChromeUserAgent(app.userAgentFallback, app.getName()));
  }
});

// One Track Lab at a time: opening it again (the Applications shortcut, the
// Dock) brings the open window forward instead of starting a second copy.
// The lock is per user-data folder, so scratch runs with --user-data-dir have
// their own; e2e tests (NODE_ENV=test) share the real one and skip it.
if (process.env.NODE_ENV !== 'test' && !app.requestSingleInstanceLock()) {
  app.exit(0);
}
app.on('second-instance', () => {
  const win = getMainWindow();
  if (!win) {
    if (app.isReady()) createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

/**
 * The clickable "Track Lab" in Applications (scripts/_common.sh,
 * candybar_make_app). install.sh makes it; this makes it once for installs
 * from before it existed (their update.sh predates it), then only refreshes
 * it, so a shortcut someone deleted stays deleted. Never for scratch runs.
 */
function ensureAppShortcut(): void {
  if (process.platform !== 'darwin' || process.env.NODE_ENV === 'test' || app.commandLine.hasSwitch('user-data-dir')) return;
  const repoDir = app.getAppPath();
  if (!fs.existsSync(path.join(repoDir, 'scripts', '_common.sh')) || !fs.existsSync(path.join(repoDir, '.git'))) return;
  const marker = path.join(app.getPath('userData'), 'app-shortcut-made');
  const refreshOnly = fs.existsSync(marker);
  execFile(
    '/bin/bash',
    ['-c', `. "$1/scripts/_common.sh" && REPO_DIR="$1" candybar_make_app${refreshOnly ? ' --refresh-only' : ''}`, 'bash', repoDir],
    { timeout: 30_000 },
    (err, stdout) => {
      if (err) {
        mainLog.warn('Could not add Track Lab to Applications:', err);
        return;
      }
      if (stdout.trim()) mainLog.info(stdout.trim());
      if (!refreshOnly) fs.writeFile(marker, new Date().toISOString(), () => {});
    },
  );
}

app.whenReady().then(async () => {
  ensureAppShortcut();
  const iconPath = resolveIconPath();
  if (iconPath && app.dock) {
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  }

  // Create tray icon
  const trayIconPath = resolveTrayIconPath();
  if (trayIconPath) {
    const trayIcon = nativeImage.createFromPath(trayIconPath);
    if (!trayIcon.isEmpty()) {
      tray = new Tray(trayIcon);
      tray.setToolTip('Track Lab');

      const contextMenu = Menu.buildFromTemplate([
        {
          label: 'Show Track Lab',
          click: () => {
            const win = getMainWindow();
            if (win) {
              win.show();
              win.focus();
            } else {
              createWindow();
            }
          }
        },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() }
      ]);
      tray.setContextMenu(contextMenu);

      // Click on tray icon shows the window, recreating it if it was closed
      tray.on('click', () => {
        const win = getMainWindow();
        if (win) {
          win.show();
          win.focus();
        } else {
          createWindow();
        }
      });
    }
  }

  mainLog.info('App ready, initializing...');
  applyPermissionPolicy(session.defaultSession);

  // Register media:// protocol for audio preview playback. AIFF files are
  // transcoded to MP3 on the fly because Chromium's bundled FFmpeg can't
  // demux 24-bit PCM AIFF. Everything else passes through as-is.
  protocol.handle('media', async (request) => {
    try {
      // Strip scheme+authority prefix directly to avoid URL parser quirks with custom schemes
      const encoded = request.url.replace(/^media:\/\/localhost/, '');
      const filePath = decodeURIComponent(encoded);
      // The media:// protocol exists only to preview audio. Refuse anything that
      // isn't a known audio file so it can't be used to read arbitrary local files.
      if (!AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
        mainLog.warn(`Media protocol: refusing non-audio path "${filePath}"`);
        return new Response('Forbidden', { status: 403 });
      }
      if (/\.aif[fc]?$/i.test(filePath)) {
        mainLog.info(`Media protocol: transcoding "${filePath}" to MP3`);
        return withCors(await createMp3PreviewResponse(filePath, request.headers.get('range')));
      }
      mainLog.info(`Media protocol: serving "${filePath}"`);
      const fileUrl = pathToFileURL(filePath).href;
      return withCors(await net.fetch(fileUrl));
    } catch (err) {
      mainLog.error(`Media protocol error for ${request.url}:`, err);
      return new Response('File not found', { status: 404 });
    }
  });

  // Startup init. Any failure here (a locked or corrupt candybar.db, a native
  // module built for another Electron) leaves nothing usable, so say so and
  // quit instead of idling with no window.
  try {
    // Append-only journal of destructive file operations (for recovery tracing).
    // First, so even the database migrations below are traceable.
    initWriteJournal(app.getPath('userData'));
    // Route user-audio deletes through the OS Trash (recoverable) instead of a
    // permanent unlink. The lib layer stays Electron-free; we inject the handler.
    setTrashHandler((filePath) => shell.trashItem(filePath));

    // Initialize database
    initDatabase();
    mainLog.info('Database initialized');

    // One-shot migration of legacy scan-cache.json data into SQLite
    migrateFromJsonCacheIfNeeded(app.getPath('userData'));

    // Load cache on startup (with file persistence for dev HMR survival)
    initCachePath(app.getPath('userData'));
    await loadCache();
    mainLog.info('Cache loaded');

    // Initialize job queue. Claude jobs read the token, model and folders at
    // run time, so a change saved in Settings applies to the next job.
    initJobQueue({
      appRoot: app.getAppPath(),
      getSettings: async () => {
        const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
        return {
          oauthToken: config.claudeOauthToken ?? '',
          model: config.claudeModel ?? '',
          libraryRoot: config.libraryRoot || DEFAULT_LIBRARY_ROOT,
          organizeSourceDir: config.organizeSourceDir ?? '',
          profile: config.claudeProfile ?? null,
        };
      },
      storeBridgePath: path.join(app.getPath('userData'), 'store-bridge.sock'),
      scratchDir: (() => {
        const dir = path.join(app.getPath('userData'), 'claude-scratch');
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      })(),
    });
    recordJobOps();
    mainLog.info('Job queue initialized');
  } catch (error) {
    mainLog.error('Startup failed:', error);
    recordEvent('app:start', { source: 'app', args: { version: app.getVersion(), userData: app.getPath('userData') }, error });
    flushOpLogSync();
    dialog.showErrorBox(
      'Track Lab couldn’t start',
      `${error instanceof Error ? error.message : String(error)}\n\n` +
      `The app's data lives in ${app.getPath('userData')}. ` +
      'If this followed an update, run "npm install" in the app folder and try again.'
    );
    startupFailed = true;
    app.quit();
    return;
  }

  // (The old 10-minute background library-check refresh is gone: nothing reads
  // that cache any more, and it re-parsed every tag in the library each time.)

  // Claude's store tools and the sourcing CLI reach the store accounts through
  // here. Without it they can't, but the app itself is unaffected.
  startStoreBridge(path.join(app.getPath('userData'), 'store-bridge.sock'), loggedBridgeHandlers(STORE_BRIDGE_HANDLERS))
    .then((stop) => { stopStoreBridge = stop; mainLog.info('Store bridge listening'); })
    .catch((err) => mainLog.warn('Store bridge not started:', err));

  createWindow();
  mainLog.info('App startup complete');
  recordEvent('app:start', {
    source: 'app',
    args: { version: app.getVersion(), electron: process.versions.electron, platform: process.platform, userData: app.getPath('userData'), appPath: app.getAppPath() },
  });

  // A corrupt config.json is backed up and replaced with defaults by readConfig;
  // say so once, or settings would just silently "reset".
  void showConfigWarnings();

  // Advisory: never awaited, never blocks startup.
  void promptForUpdate(false);

  // The packaged app builds its Rekordbox helper's Python environment in
  // userData (a checkout has .venv-rbx from install.sh). Background, best effort.
  if (app.isPackaged && process.platform === 'darwin') void ensureSharedVenv(app.getAppPath());

  app.on('activate', () => {
    // A login window can outlive the app window, so look for the app window itself.
    if (!getMainWindow()) createWindow();
  });
});

app.on('child-process-gone', (_event, details) => {
  if (details.reason === 'clean-exit') return;
  mainLog.error('Child process gone:', details);
  recordEvent('app:child-process-gone', { source: 'app', args: details, error: details.reason });
});

app.on('window-all-closed', () => {
  mainLog.info('All windows closed');
  if (process.platform !== 'darwin') app.quit();
});

let startupFailed = false;
/** Set once the user has agreed to cut running work short (or nothing was running). */
let quitConfirmed = false;
let quitting = false;

// Ask before quitting over running work (Cmd+Q, the tray's Quit, the last
// window closing on Windows/Linux).
app.on('before-quit', (event) => {
  if (quitConfirmed || startupFailed) return;
  if (describeRunningWork().length === 0) {
    quitConfirmed = true;
    return;
  }
  event.preventDefault();
  void confirmInterruptWork('quit').then((ok) => {
    if (!ok) return;
    quitConfirmed = true;
    app.quit();
  });
});

app.on('will-quit', (event) => {
  if (quitting) return;
  quitting = true;
  mainLog.info('App will quit, cleaning up...');
  recordEvent('app:quit', { source: 'app', args: { stillRunning: describeRunningWork() } });
  event.preventDefault();
  closeStorePanel();
  void stopStoreBridge?.(); // no new store requests from Claude or the CLI
  closeStoreBrowsers(); // the hidden per-partition windows that read store sessions
  // Cancel and drain running work first, so no handler is left writing to a
  // closed database or cut off mid-copy; then make sure the write journal's
  // in-flight appends (the recovery trail) land before exit.
  void (async () => {
    try {
      await drainRunningWork();
    } catch (err) {
      mainLog.warn('Draining running work failed:', err);
    }
    closeDatabase();
    await flushStoreCookies(); // store sign-ins: app.exit doesn't wait for Chromium's cookie batch
    try {
      await flushWriteJournal();
      await flushOpLog();
    } finally {
      app.exit(0);
    }
  })();
});

// ========== Startup update check ==========
//
// From a git checkout (`npm start`) the repo dir is the app path: if
// origin/main has commits we don't, offer to pull + rebuild + relaunch via
// scripts/update.sh, which runs detached after we quit (the rebuild replaces
// dist/ and native modules this process has loaded). The packaged app (a .dmg
// from GitHub Releases) instead offers the latest release's .dmg.

async function showConfigWarnings(): Promise<void> {
  try {
    await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
  } catch (err) {
    mainLog.warn('Config read at startup failed:', err);
  }
  const warnings = getConfigWarnings();
  if (warnings.length === 0) return;
  const win = getMainWindow();
  const opts: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Settings problem',
    message: 'Some of Track Lab’s settings couldn’t be read.',
    detail: `${warnings.join('\n\n')}\n\nCheck Settings before running anything that moves or deletes files.`,
    buttons: ['OK'],
  };
  if (win) await dialog.showMessageBox(win, opts);
  else await dialog.showMessageBox(opts);
}

// The origin/main commit (or, packaged, the release tag) the user last dismissed
// the prompt for. Kept in its own file so it never rides along with config writes.
const UPDATE_STATE_PATH = path.join(app.getPath('userData'), 'update-check.json');

function readDismissedUpdateSha(): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(UPDATE_STATE_PATH, 'utf8')) as { dismissedSha?: unknown };
    return typeof data.dismissedSha === 'string' ? data.dismissedSha : null;
  } catch {
    return null;
  }
}

function rememberDismissedUpdate(sha: string): void {
  try {
    fs.writeFileSync(UPDATE_STATE_PATH, JSON.stringify({ dismissedSha: sha, dismissedAt: new Date().toISOString() }, null, 2));
  } catch (err) {
    mainLog.warn('Could not record the dismissed update:', err);
  }
}

/** origin/main's commit after checkForUpdate's fetch, or null if git can't say. */
function originHeadSha(repoDir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', `origin/${UPDATE_BRANCH}`], { cwd: repoDir, timeout: 10_000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });
}

// What the top-bar update button shows: what the last successful check found,
// or null when up to date. A failed check (offline) leaves it alone rather than
// hiding a known update.
let lastUpdateAvailable: string | null = null;
let updateFetch: Promise<UpdateStatus | null> | null = null;
let releaseFetch: Promise<ReleaseUpdate | null | Error> | null = null;
let updatePromptOpen = false;

function publishUpdateState(available: string | null): void {
  lastUpdateAvailable = available;
  safeSend(getMainWindow(), 'update-state', { available } satisfies UpdateState);
}

/** One fetch at a time: a top-bar click during the launch check shares it. */
function refreshUpdateStatus(repoDir: string): Promise<UpdateStatus | null> {
  updateFetch ??= checkForUpdate(repoDir)
    .then((status) => {
      if (status) publishUpdateState(status.behind > 0 ? `${status.behind} change${status.behind === 1 ? '' : 's'} on GitHub` : null);
      return status;
    })
    .finally(() => { updateFetch = null; });
  return updateFetch;
}

/** The packaged app's check, against GitHub Releases. An Error means GitHub couldn't be reached. */
function refreshRelease(): Promise<ReleaseUpdate | null | Error> {
  releaseFetch ??= checkForRelease(app.getVersion(), process.arch)
    .then((release) => {
      publishUpdateState(release ? `Track Lab ${release.version}` : null);
      return release;
    }, (err: unknown) => {
      mainLog.warn('Release check failed:', err);
      return err instanceof Error ? err : new Error(String(err));
    })
    .finally(() => { releaseFetch = null; });
  return releaseFetch;
}

function showUpdateMessage(opts: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const win = getMainWindow();
  return win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
}

function showNoUpdate(reached: boolean): Promise<Electron.MessageBoxReturnValue> {
  return showUpdateMessage(reached
    ? { type: 'info', title: 'No updates', message: 'Track Lab is up to date.', detail: 'There’s nothing newer on GitHub.', buttons: ['OK'] }
    : { type: 'warning', title: 'Couldn’t check for updates', message: 'Track Lab couldn’t reach GitHub.', detail: 'Check your internet connection and try again.', buttons: ['OK'] });
}

/**
 * At launch (manual = false) this speaks up only when GitHub has something
 * newer that wasn't dismissed before. From the top-bar button it always
 * answers, "up to date" and "couldn't check" included.
 */
async function promptForUpdate(manual: boolean): Promise<void> {
  if (!manual && (process.env.NODE_ENV === 'development' || process.env.CANDYBAR_SKIP_UPDATE_CHECK)) return;
  const repoDir = app.getAppPath();
  const offer = app.isPackaged
    ? await refreshRelease().then((release) => () => offerRelease(release, manual))
    : await refreshUpdateStatus(repoDir).then((status) => () => offerUpdate(repoDir, status, manual));
  if (updatePromptOpen) return;
  updatePromptOpen = true;
  try {
    await offer();
  } finally {
    updatePromptOpen = false;
  }
}

async function offerUpdate(repoDir: string, status: UpdateStatus | null, manual: boolean): Promise<void> {
  if (!status || status.behind === 0) {
    if (manual) await showNoUpdate(!!status);
    return;
  }

  // Dismissed this exact remote state before? Then stay quiet until new commits land.
  const originSha = await originHeadSha(repoDir);
  if (!manual && originSha && originSha === readDismissedUpdateSha()) {
    mainLog.info(`Update prompt skipped: ${originSha.slice(0, 7)} was already dismissed`);
    return;
  }

  const n = status.behind;
  const changes = status.incoming.map((s) => `• ${s}`).join('\n')
    + (n > status.incoming.length ? `\n…and ${n - status.incoming.length} more` : '');
  // update.sh is bash; on Windows show the manual steps instead.
  const blocker = process.platform === 'win32'
    ? 'One-click update is macOS-only for now.'
    : oneClickBlocker(status);

  const opts: Electron.MessageBoxOptions = {
    type: 'info',
    title: 'Update available',
    message: `Track Lab is ${n} update${n === 1 ? '' : 's'} behind GitHub.`,
    detail: blocker
      ? `${changes}\n\n${blocker} Update by hand:\n  cd "${repoDir}"\n  git pull origin ${UPDATE_BRANCH} && npm install && npm start`
        + (manual ? '' : `\n\nYou won't be asked again until more changes arrive.`)
      : `${changes}\n\nUpdating pulls the latest code, rebuilds, and restarts the app (about a minute).`,
    buttons: blocker ? ['OK'] : ['Update & Restart', 'Later'],
    defaultId: 0,
    cancelId: blocker ? 0 : 1,
  };
  const { response } = await showUpdateMessage(opts);
  if (blocker || response !== 0) {
    if (originSha) rememberDismissedUpdate(originSha);
    return;
  }
  // Restarting cancels whatever is running; ask before cutting it short.
  if (!(await confirmInterruptWork('update'))) return;
  quitConfirmed = true;

  const script = path.join(repoDir, 'scripts', 'update.sh');
  if (!fs.existsSync(script)) {
    dialog.showErrorBox('Update script missing', `${script} wasn't found, so the app can't update itself. Update by hand:\n  cd "${repoDir}"\n  git pull origin ${UPDATE_BRANCH} && npm install && npm start`);
    quitConfirmed = false;
    return;
  }
  const logDir = app.getPath('logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFd = fs.openSync(path.join(logDir, 'update.log'), 'a');
  mainLog.info(`Launching updater: ${script}`);
  spawn('/bin/bash', [script, '--wait-pid', String(process.pid), '--relaunch'], {
    cwd: repoDir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  }).unref();
  app.quit();
}

/** The packaged app's prompt: the new version's .dmg, downloaded and opened. */
async function offerRelease(release: ReleaseUpdate | null | Error, manual: boolean): Promise<void> {
  if (!release || release instanceof Error) {
    if (manual) await showNoUpdate(!release);
    return;
  }
  const tag = `v${release.version}`;
  if (!manual && tag === readDismissedUpdateSha()) {
    mainLog.info(`Update prompt skipped: ${tag} was already dismissed`);
    return;
  }
  const buttons = release.dmg ? ['Download', 'What’s New', 'Later'] : ['Open GitHub', 'Later'];
  const { response } = await showUpdateMessage({
    type: 'info',
    title: 'Update available',
    message: `Track Lab ${release.version} is available. You have ${app.getVersion()}.`,
    detail: release.dmg
      ? 'Downloading opens the new version in Finder. Drag it onto Applications to replace this one.'
      : 'Download it from its page on GitHub.',
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  });
  const choice = buttons[response];
  if (choice === 'Later') {
    rememberDismissedUpdate(tag);
  } else if (choice === 'Download' && release.dmg) {
    await downloadRelease(release.dmg, release.pageUrl);
  } else {
    void shell.openExternal(release.pageUrl);
  }
}

/** Into Downloads with the Dock icon's progress bar, then opened in Finder, then
 *  an offer to quit: Finder won't replace an app that's still running. */
async function downloadRelease(dmg: NonNullable<ReleaseUpdate['dmg']>, pageUrl: string): Promise<void> {
  const dest = path.join(app.getPath('downloads'), dmg.name);
  const partial = `${dest}.download`;
  const win = getMainWindow();
  try {
    const res = await net.fetch(dmg.url);
    if (!res.ok || !res.body) throw new Error(`GitHub answered ${res.status} ${res.statusText}`);
    let received = 0;
    const progress = new Transform({
      transform(chunk: Buffer, _enc, done) {
        received += chunk.length;
        win?.setProgressBar(dmg.size ? Math.min(received / dmg.size, 1) : 2);
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as import('stream/web').ReadableStream), progress, fs.createWriteStream(partial));
    fs.renameSync(partial, dest);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    mainLog.warn('Update download failed:', err);
    const { response } = await showUpdateMessage({
      type: 'warning',
      title: 'Download failed',
      message: 'Track Lab couldn’t download the update.',
      detail: `${err instanceof Error ? err.message : String(err)}\n\nYou can download it from GitHub instead.`,
      buttons: ['Open GitHub', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) void shell.openExternal(pageUrl);
    return;
  } finally {
    win?.setProgressBar(-1);
  }

  const openError = await shell.openPath(dest);
  if (openError) mainLog.warn(`Couldn't open ${dest}: ${openError}`);
  const { response } = await showUpdateMessage({
    type: 'info',
    title: 'Update downloaded',
    message: 'Drag Track Lab onto Applications to replace this version.',
    detail: `${openError ? `Open ${dest} first. ` : 'It’s open in Finder. '}Track Lab has to quit before it can be replaced.`,
    buttons: ['Quit Track Lab', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0 || !(await confirmInterruptWork('update'))) return;
  quitConfirmed = true;
  app.quit();
}

// Top-bar update button: what the last check found, and a check on demand.
handleIpc('get-update-state', (): UpdateState => ({ available: lastUpdateAvailable }));
handleIpc('check-for-updates', async () => {
  try {
    await promptForUpdate(true);
  } catch (error) {
    mainLog.error('IPC check-for-updates failed:', error);
    throw error;
  }
});

// ========== Store Panel (embedded <webview>) ==========
//
// The store cart lives in an in-DOM <webview> the renderer owns (see
// src/renderer/storePanel.ts + index.html). The main process no longer manages a
// native view, its bounds, resize, or zoom — the renderer does all of that as
// normal DOM. Main keeps only the parts that must run here: session pre-warm,
// auth-token polling (session-based), the scripted-checkout injection (needs the
// guest's webContents), and status. The guest's webContents id is registered by
// the renderer on attach (`store-panel-attach`).

let storePanelStore: 'qobuz' | 'beatport' | null = null;
/** Account id whose session partition the current panel is bound to. Must match
 *  the account used by `store-cart-add` so the cart page shows the cart we just
 *  populated (cookies live in the account-scoped partition, not the legacy one). */
let storePanelAccountId: string | null = null;
/** True from open until close — guards the session-based auth polls (which can
 *  run before the guest webContents has attached). */
let storePanelOpen = false;
/** webContents id of the attached <webview> guest, registered by the renderer on
 *  attach. Used to inject the scripted-checkout flow. Null when detached. */
let storePanelContentsId: number | null = null;
/** Latest URL the guest navigated to (reported by the renderer), for status +
 *  the purchase-success broadcast the app watches to auto-download. */
let storePanelUrl: string | null = null;
let storePanelTokenPollTimer: NodeJS.Timeout | null = null;
// The window that owns the panel, captured when it opens, so every state send
// for this panel goes to the renderer that showed it.
let storePanelWin: BrowserWindow | null = null;

/** Resolve the attached store-panel guest's webContents, or null if none is
 *  attached / it has been destroyed. */
function getStorePanelContents(): Electron.WebContents | null {
  if (storePanelContentsId == null) return null;
  const wc = webContents.fromId(storePanelContentsId);
  return wc && !wc.isDestroyed() ? wc : null;
}

/** The <webview> guest only reports its webContents id on `dom-ready`, which
 *  lands a beat after the panel opens. Scripted checkout must not hard-fail in
 *  that window (the old native view existed synchronously), so wait briefly for
 *  the guest to attach. Returns the contents once available, or null if it never
 *  attaches within the timeout / the panel closes first. */
async function awaitStorePanelContents(timeoutMs = 8000): Promise<Electron.WebContents | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const wc = getStorePanelContents();
    if (wc) return wc;
    if (!storePanelOpen || Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Resolve the account id whose partition the store panel should bind to.
 *  Mirrors the choice made by `store-cart-add` (first configured account, or
 *  the legacy fallback) so cart-add cookies and panel cookies share a jar. */
async function resolveStorePanelAccountId(store: 'qobuz' | 'beatport'): Promise<string> {
  const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
  const accounts = store === 'qobuz' ? config.qobuzAccounts : config.beatportAccounts;
  return accounts[0]?.id ?? LEGACY_ACCOUNT_ID;
}

function storePanelPartition(store: 'qobuz' | 'beatport', accountId: string): string {
  return store === 'qobuz' ? qobuzPartition(accountId) : beatportPartition(accountId);
}

/** The app's own window (not a store login / sniff / popup window). Set in
 *  createWindow; getAllWindows()[0] can be a login window that happens to be
 *  older, and events sent there never reach the app. */
let appWindow: BrowserWindow | null = null;

function getMainWindow(): BrowserWindow | null {
  return appWindow && !appWindow.isDestroyed() ? appWindow : null;
}

/** Tell the renderer that owns the store panel the store's session is signed in. */
function sendStorePanelAuth(store: 'qobuz' | 'beatport'): void {
  safeSend(storePanelWin ?? getMainWindow(), 'store-panel-auth', { store, loggedIn: true });
}

async function openStorePanel(store: 'qobuz' | 'beatport', url: string): Promise<void> {
  const win = getMainWindow();
  if (!win) return;
  storePanelWin = win; // canonical owner window for all subsequent state sends

  // No sign-in window first: the panel is the store's own page, so a signed-out
  // cart lands on its sign-in page right there (the renderer says so), and a
  // lapsed Qobuz shop session renews itself on that first real page load —
  // which the hidden login probe can't do, so it used to pop a window that
  // wasn't needed. The auth polls below pick up a sign-in made in the panel.
  const accountId = await resolveStorePanelAccountId(store);

  // Switching stores rebinds the guest to a different session partition, so the
  // renderer rebuilds the <webview> and the old contents id is stale.
  if (storePanelOpen && storePanelStore !== store) storePanelContentsId = null;

  storePanelStore = store;
  storePanelAccountId = accountId;
  storePanelOpen = true;
  storePanelUrl = url;
  const partition = storePanelPartition(store, accountId);

  // Tell the renderer to mount/point the in-DOM <webview> at this store's cart on
  // the account's session partition, and reveal the panel. All view mechanics
  // (bounds, resize, zoom, back/forward, horizontal-scroll) are the renderer's
  // job now — see src/renderer/storePanel.ts.
  safeSend(win, 'store-panel-state', { open: true, store, url, partition });

  // Poll the session (not the view) for the auth token so cart-add works.
  if (store === 'beatport') startBeatportTokenPoll();
  else startQobuzAuthPoll();
}

function closeStorePanel(): void {
  const win = storePanelWin ?? getMainWindow();

  stopStorePanelAuthPoll();
  storePanelOpen = false;
  storePanelStore = null;
  storePanelAccountId = null;
  storePanelContentsId = null;
  storePanelUrl = null;

  // Tell the owning renderer to unmount the <webview> and release the reflow,
  // then forget the window.
  safeSend(win, 'store-panel-state', { open: false });
  storePanelWin = null;
}

// ========== Auth Detection ==========

/** Read the persisted Beatport session and refresh the in-memory access token.
 *  Independent of whether the store panel is open — used on demand before
 *  cart-add so stale in-memory state doesn't block a user who logged in
 *  earlier.
 *
 *  The token is read the way Beatport's own front-end reads it: a page on the
 *  partition calls `/api/auth/session` with its own cookies (storeBrowser.ts).
 *  No cookie is ever copied out into a Node request. readBeatportSessionToken
 *  only returns a token that authenticates a user-scoped call — an anonymous
 *  next-auth session also gets a well-formed JWT, which 401s on `/v4/my/*`.
 *
 *  Both partitions are tried: the account-scoped one (where the store panel and
 *  login window sign in now) first, then the legacy `persist:beatport`, which
 *  may still hold a session from before accounts existed. */
async function refreshBeatportTokenFromSession(accountId: string): Promise<boolean> {
  for (const partition of [beatportPartition(accountId), 'persist:beatport']) {
    try {
      const cookies = await session.fromPartition(partition).cookies.get({ url: 'https://www.beatport.com' });
      if (!cookies.some(c => c.name.includes('next-auth.session-token'))) {
        mainLog.info(`Beatport[${accountId}]: partition ${partition} has no session-token cookie — skipping`);
        continue;
      }
      const signedIn = await readBeatportSessionToken(partition);
      if (!signedIn) {
        mainLog.info(`Beatport[${accountId}]: ${partition} has no signed-in session token — skipping`);
        continue;
      }
      setBeatportToken(accountId, signedIn.token, signedIn.expiresIn);
      mainLog.info(`Beatport[${accountId}]: verified authenticated token from ${partition}`);
      return true;
    } catch (err) {
      mainLog.warn(`Failed to refresh Beatport token from ${partition}:`, err);
    }
  }
  return false;
}

async function extractBeatportTokenFromPanel(): Promise<boolean> {
  if (!storePanelOpen || storePanelStore !== 'beatport' || !storePanelAccountId) return false;
  const accountId = storePanelAccountId;

  try {
    const partition = beatportPartition(accountId);
    const cookies = await session.fromPartition(partition).cookies.get({ url: 'https://www.beatport.com' });
    if (!cookies.some(c => c.name.includes('next-auth.session-token'))) return false;

    // Read in-page and verified against a user-scoped call before caching.
    const signedIn = await readBeatportSessionToken(partition);
    if (!signedIn) return false;

    setBeatportToken(accountId, signedIn.token, signedIn.expiresIn);
    mainLog.info(`Beatport[${accountId}]: verified authenticated token from panel session`);
    safeSend(storePanelWin ?? getMainWindow(), 'store-panel-auth', { store: 'beatport', loggedIn: true });
    return true;
  } catch (err) {
    mainLog.warn('Failed to extract Beatport token from panel:', err);
    return false;
  }
}

async function detectQobuzLoginFromPanel(): Promise<boolean> {
  if (!storePanelOpen || storePanelStore !== 'qobuz' || !storePanelAccountId) return false;
  const accountId = storePanelAccountId;

  try {
    const loggedIn = await probeQobuzLoginForPartition(qobuzPartition(accountId));
    if (!loggedIn) return false;

    mainLog.info(`Qobuz[${accountId}]: login detected from panel session`);
    invalidateQobuzAuthCache(accountId);
    sendStorePanelAuth('qobuz');
    return true;
  } catch (err) {
    mainLog.warn('Failed to detect Qobuz login from panel:', err);
    return false;
  }
}

function startBeatportTokenPoll(): void {
  stopStorePanelAuthPoll();
  if (storePanelAccountId && getBeatportAccessToken(storePanelAccountId)) {
    sendStorePanelAuth('beatport');
    return;
  }
  storePanelTokenPollTimer = setInterval(async () => {
    const got = await extractBeatportTokenFromPanel();
    if (got) stopStorePanelAuthPoll();
  }, 3000);
}

function startQobuzAuthPoll(): void {
  stopStorePanelAuthPoll();
  const accountId = storePanelAccountId;
  // Check if already logged in
  detectQobuzLoginFromPanel().then(loggedIn => {
    if (loggedIn) return;
    // The panel may have been closed while this initial probe was in flight —
    // stopStorePanelAuthPoll() already ran, so installing the interval now would
    // leak it. Only start polling if the same Qobuz panel is still open.
    if (storePanelStore !== 'qobuz' || storePanelAccountId !== accountId) return;
    storePanelTokenPollTimer = setInterval(async () => {
      const got = await detectQobuzLoginFromPanel();
      if (got) stopStorePanelAuthPoll();
    }, 3000);
  });
}

function stopStorePanelAuthPoll(): void {
  if (storePanelTokenPollTimer) {
    clearInterval(storePanelTokenPollTimer);
    storePanelTokenPollTimer = null;
  }
}

// Store panel IPC handlers
handleIpc('store-panel-open', async (_event, { store, url }: { store: 'qobuz' | 'beatport'; url: string }) => {
  await openStorePanel(store, url);
  return { success: true };
});

handleIpc('store-panel-close', () => {
  closeStorePanel();
  return { success: true };
});

// The renderer registers the <webview> guest's webContents id once it attaches,
// so the scripted-checkout injection below can reach the live cart page.
handleIpc('store-panel-attach', (_event, { contentsId }: { contentsId: number | null }) => {
  storePanelContentsId = typeof contentsId === 'number' ? contentsId : null;
  return { success: true };
});

// The renderer reports each guest navigation. We remember the URL for status and
// re-broadcast it as `store-panel-navigated` so the app's purchase-success watcher
// (auto-download) keeps working now that nav events originate in the renderer.
handleIpc('store-panel-nav', (_event, { url }: { url: string }) => {
  if (typeof url === 'string' && url) storePanelUrl = url;
  safeSend(storePanelWin ?? getMainWindow(), 'store-panel-navigated', { url });
  return { success: true };
});

handleIpc('store-panel-status', () => {
  return {
    open: storePanelOpen,
    store: storePanelStore,
    url: storePanelUrl,
  };
});

// ========== Store Panel: Scripted Checkout ==========
//
// Drives the visible cart/checkout flow by injecting JS into the panel. We
// intentionally stop *before* committing a purchase — the final Place Order
// click is a separate IPC that only runs after the user confirms in the app.
// 3DS/SCA bank prompts stay interactive: the panel is always visible.
//
// Both scripts refuse to run anywhere but the store's own cart/checkout pages
// (isStoreCheckoutUrl), and the advance step's button pattern (ADVANCE_RE) is
// anchored and contains no commit verbs — the patterns live in mainGuards.ts
// with their tests and are spliced in here.

const regexLiteral = (re: RegExp) => `new RegExp(${JSON.stringify(re.source)}, ${JSON.stringify(re.flags)})`;

const CHECKOUT_ADVANCE_SCRIPT = `
(async () => {
  const visible = (el) => !!el && el.offsetParent !== null && !el.disabled && window.getComputedStyle(el).visibility !== 'hidden';
  const ctas = () => Array.from(document.querySelectorAll('button, a, input[type="submit"], [role="button"]')).filter(visible);
  const text = (el) => ((el.innerText || el.value || el.getAttribute('aria-label') || '').trim());
  const match = (re) => ctas().filter(el => re.test(text(el)));
  const scrapeItemCount = (${scrapeItemCount.toString()});

  // "Place order" / final-commit patterns — if we see one, this is the commit page.
  // We do NOT click it from this advance step; we report readiness instead.
  const placeRe = ${regexLiteral(PLACE_ORDER_RE)};
  // Intermediate "advance to next step" patterns. Never a commit verb.
  const advanceRe = ${regexLiteral(ADVANCE_RE)};

  const placeBtns = match(placeRe);
  if (placeBtns.length > 0) {
    // Pull a plausible order total and item count from the page text.
    const body = document.body.innerText || '';
    const totalMatch = body.match(/(?:grand\\s+total|order\\s+total|total(?:\\s+to\\s+pay)?)[^\\d$€£¥]{0,40}([\\$€£¥]\\s*\\d+[.,]\\d{2})/i);
    return {
      phase: 'place-order-ready',
      total: totalMatch ? totalMatch[1].replace(/\\s+/g, '') : null,
      itemCount: scrapeItemCount(body),
      buttonText: text(placeBtns[0]),
    };
  }

  const advanceBtns = match(advanceRe);
  if (advanceBtns.length > 0) {
    advanceBtns[0].click();
    return { phase: 'advanced', clickedText: text(advanceBtns[0]) };
  }

  return { phase: 'unknown' };
})();
`;

const CHECKOUT_PLACE_ORDER_SCRIPT = `
(async () => {
  const visible = (el) => !!el && el.offsetParent !== null && !el.disabled && window.getComputedStyle(el).visibility !== 'hidden';
  const ctas = () => Array.from(document.querySelectorAll('button, a, input[type="submit"], [role="button"]')).filter(visible);
  const text = (el) => ((el.innerText || el.value || el.getAttribute('aria-label') || '').trim());
  const placeRe = ${regexLiteral(PLACE_ORDER_RE)};

  const btns = ctas().filter(el => placeRe.test(text(el)));
  if (btns.length === 0) return { success: false, error: 'Place Order button not visible on this page.' };
  btns[0].click();
  return { success: true, clickedText: text(btns[0]) };
})();
`;

type CheckoutAdvanceResult =
  | { phase: 'place-order-ready'; total: string | null; itemCount: number | null; buttonText: string }
  | { phase: 'advanced'; clickedText: string }
  | { phase: 'unknown' };

/** The attached guest, if it's on this store's cart/checkout pages; otherwise
 *  an error the renderer shows. Nothing is clicked on any other page. */
async function checkoutContents(store: 'qobuz' | 'beatport'): Promise<{ wc: Electron.WebContents } | { error: string }> {
  const label = store === 'qobuz' ? 'Qobuz' : 'Beatport';
  if (!storePanelOpen || storePanelStore !== store) {
    return { error: `The ${label} panel isn't open.` };
  }
  // Tolerate the brief post-open window before the guest reports its id.
  const wc = await awaitStorePanelContents();
  if (!wc) {
    return { error: `The ${label} panel is still loading. Try again in a moment.` };
  }
  const url = wc.getURL();
  if (isStoreSignInUrl(url)) {
    return { error: `Sign in to ${label} in the panel first, then choose Fill in checkout for me again.` };
  }
  if (!isStoreCheckoutUrl(store, url)) {
    mainLog.warn(`checkout[${store}] refused: guest is not on a cart/checkout page (${url})`);
    return { error: `The ${label} panel isn't on the cart or checkout page, so nothing was clicked. Go back to the cart and try again.` };
  }
  return { wc };
}

handleIpc('store-panel-checkout-advance', async (_event, { store }: { store: 'qobuz' | 'beatport' }) => {
  const target = await checkoutContents(store);
  if ('error' in target) return { success: false, error: target.error };
  const { wc } = target;
  try {
    const result = await wc.executeJavaScript(CHECKOUT_ADVANCE_SCRIPT) as CheckoutAdvanceResult;
    return { success: true, result };
  } catch (err) {
    mainLog.error(`checkout-advance[${store}] failed:`, err);
    return { success: false, error: err instanceof Error ? err.message : 'Script injection failed' };
  }
});

handleIpc('store-panel-place-order', async (_event, { store }: { store: 'qobuz' | 'beatport' }) => {
  const target = await checkoutContents(store);
  if ('error' in target) return { success: false, error: target.error };
  const { wc } = target;
  try {
    const result = await wc.executeJavaScript(CHECKOUT_PLACE_ORDER_SCRIPT) as { success: boolean; clickedText?: string; error?: string };
    return result;
  } catch (err) {
    mainLog.error(`place-order[${store}] failed:`, err);
    return { success: false, error: err instanceof Error ? err.message : 'Script injection failed' };
  }
});

handleIpc('select-path', async (_event, { type }: { type: 'file' | 'dir' }) => {
  try {
    const options: OpenDialogOptions = {
      properties: type === 'file' ? ['openFile'] : ['openDirectory']
    };

    const focusedWindow = BrowserWindow.getFocusedWindow();
    const result = focusedWindow
      ? await dialog.showOpenDialog(focusedWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  } catch (error) {
    mainLog.error('IPC select-path failed:', error);
    throw error;
  }
});

handleIpc('get-config', async () => {
  try {
    return await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
  } catch (error) {
    mainLog.error('IPC get-config failed:', error);
    throw error;
  }
});

handleIpc('get-config-path', () => CONFIG_PATH);

handleIpc('get-library-root', async () => {
  try {
    return await getLibraryRoot();
  } catch (error) {
    mainLog.error('IPC get-library-root failed:', error);
    throw error;
  }
});

// Every config write in main goes through this one chain, and read-modify-write
// cycles read INSIDE it, so two writers (Settings saving while a volume is
// excluded, an account is connected, the tour finishes…) can never interleave
// and drop each other's change.
let configWriteChain: Promise<unknown> = Promise.resolve();

function mutateConfig(mutate: (current: AppConfig) => AppConfig): Promise<AppConfig> {
  const run = configWriteChain.then(async () => {
    const current = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    return writeConfig(CONFIG_PATH, mutate(current));
  });
  configWriteChain = run.catch(() => {}); // keep the chain alive across failures
  return run;
}

handleIpc('set-config', async (_event, config: AppConfig) => {
  try {
    return await mutateConfig(() => config);
  } catch (error) {
    mainLog.error('IPC set-config failed:', error);
    throw error;
  }
});

// Partial update: merge just these fields into the current config. Prefer this
// over set-config, which replaces the whole thing with the renderer's copy.
handleIpc('update-config', async (_event, partial: Partial<AppConfig>) => {
  try {
    if (!partial || typeof partial !== 'object') throw new Error('update-config needs an object of fields to change');
    return await mutateConfig((current) => ({ ...current, ...partial }));
  } catch (error) {
    mainLog.error('IPC update-config failed:', error);
    throw error;
  }
});

// ---------- Ownership: Rekordbox + candybar.db ----------
//
// "Do I already own this?" is answered by lib/sourcing/library.mjs — the
// Rekordbox collection plus candybar.db's reflection of it, read by
// read_library.py — never by walking the library folder. Same engine as the
// MCP check_library_for_tracks tool and the sourcing CLI, so all three agree.

type SourcingLibraryTrack = { file_path?: string; in_rekordbox?: boolean };
type SourcingLibrary = { index: { tracks: SourcingLibraryTrack[] }; ignored: Set<string>; stats: OwnershipStats };
type SourcingLibraryModule = {
  loadLibrary: (opts?: { candybarDbPath?: string | null }) => Promise<SourcingLibrary>;
  bucketTracks: (
    wanted: unknown[],
    lib: { index: unknown; ignored: Set<string> },
    onProgress?: (done: number, total: number, counts: { owned: number; probable: number; missing: number }) => void
  ) => OwnershipBuckets;
};

let sourcingLibraryModule: Promise<SourcingLibraryModule> | null = null;
function sourcingLibrary(): Promise<SourcingLibraryModule> {
  if (!sourcingLibraryModule) {
    const url = pathToFileURL(path.join(app.getAppPath(), 'lib', 'sourcing', 'library.mjs')).href;
    sourcingLibraryModule = (import(url) as Promise<SourcingLibraryModule>).catch((err) => {
      sourcingLibraryModule = null;
      throw err;
    });
  }
  return sourcingLibraryModule;
}

/** Read the collection. When Rekordbox is in use (the default) and couldn't be
 *  read, refuse: every track would look missing and the user would be offered
 *  everything they own. */
async function loadOwnershipLibrary(): Promise<SourcingLibrary> {
  const [mod, config] = await Promise.all([sourcingLibrary(), readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH)]);
  // The DB this app writes (its own userData), not whatever the reader defaults to.
  const lib = await mod.loadLibrary({ candybarDbPath: path.join(app.getPath('userData'), 'candybar.db') });
  for (const e of lib.stats?.errors ?? []) mainLog.warn(`Library reader: ${e}`);
  if (config.rekordboxEnabled !== false) {
    const err = rekordboxReadError(lib.stats);
    if (err) {
      throw new Error(`Couldn't read your Rekordbox collection (${err}), so there's no way to tell which tracks you already own. Nothing was searched.`);
    }
  }
  return lib;
}

/** Bucket tracks into owned / probable / missing against the collection, as the
 *  CheckResult shape the sourcing handlers have always worked with. */
async function checkOwnership(tracks: TrackRecord[], onProgress?: (p: ProgressUpdate) => void): Promise<CheckResult> {
  onProgress?.({ phase: 'scanning', current: 0, total: 0, message: 'Reading your Rekordbox collection…' });
  const mod = await sourcingLibrary();
  const lib = await loadOwnershipLibrary();
  const buckets = mod.bucketTracks(toOwnershipInput(tracks), { index: lib.index, ignored: new Set() }, (done, total, c) => {
    onProgress?.({ phase: 'matching', current: done, total, message: `Matching: ${c.owned} in Rekordbox, ${c.probable} to check, ${c.missing} missing` });
  });
  const result = bucketsToCheckResult(tracks, buckets, lib.index.tracks.length);
  onProgress?.({
    phase: 'complete', current: tracks.length, total: tracks.length,
    message: `Complete: ${result.matchedCount} in Rekordbox, ${result.uncertainCount} to check, ${result.missingCount} missing`,
  });
  return result;
}

/** CSV → TrackRecords via the same parser the CSV preview uses. */
async function readCsvTracks(csvPath: string): Promise<TrackRecord[]> {
  const preview = await previewCsv(csvPath, Infinity);
  const tracks = csvRecordsToTrackRecords(preview.rows);
  if (tracks.length === 0) throw new Error('No track data found in CSV.');
  return tracks;
}

// Paths in the Rekordbox collection, for the "never trash a file Rekordbox
// points at" guard on conversions. Cached briefly: a bulk fix converts many
// files back to back and each read of the collection takes a few seconds.
let rekordboxPathCache: { at: number; paths: Promise<Set<string>> } | null = null;
function rekordboxCollectionPaths(): Promise<Set<string>> {
  if (!rekordboxPathCache || Date.now() - rekordboxPathCache.at > 60_000) {
    const paths = loadOwnershipLibrary().then(lib => new Set(
      lib.index.tracks.filter(t => t.in_rekordbox && t.file_path).map(t => collectionPathKey(t.file_path!))
    ));
    const entry = { at: Date.now(), paths };
    rekordboxPathCache = entry;
    paths.catch(() => { if (rekordboxPathCache === entry) rekordboxPathCache = null; });
  }
  return rekordboxPathCache.paths;
}

/** True when Rekordbox references this file, so deleting it would orphan the
 *  entry (and lose its Date Added, cues and play history). Unknown counts as
 *  referenced: the original is kept when the collection can't be read. */
async function isReferencedByRekordbox(filePath: string): Promise<boolean> {
  const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
  if (config.rekordboxEnabled === false) return false;
  try {
    return (await rekordboxCollectionPaths()).has(collectionPathKey(filePath));
  } catch (err) {
    mainLog.warn(`Couldn't read the Rekordbox collection, keeping the original to be safe: ${filePath}`, err);
    return true;
  }
}

handleIpc(
  'check-library',
  async (event, { csvPath, spotifyPlaylistUrl, cacheOnly = false }: { csvPath?: string; spotifyPlaylistUrl?: string; useCache?: boolean; cacheOnly?: boolean }) => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      // Results used to be cached from folder scans; ownership is now read
      // fresh from Rekordbox each time, so there's nothing to serve cache-only.
      if (cacheOnly) {
        return { id: runId, success: false, cacheOnly: true };
      }

      const progress = (p: ProgressUpdate) => safeSend(event.sender, 'check-progress', { id: runId, ...p });
      let tracks: TrackRecord[];
      if (spotifyPlaylistUrl) {
        const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
        if (!config.spotifyClientId || !config.spotifyClientSecret) {
          return { id: runId, success: false, error: 'Spotify credentials not configured. Go to Settings to add your Spotify Client ID and Secret.' };
        }
        progress({ phase: 'playlist', current: 0, total: 1, message: 'Fetching Spotify playlist…' });
        const { tracks: spotifyTracks } = await getPlaylistTracks(
          spotifyPlaylistUrl,
          { clientId: config.spotifyClientId, clientSecret: config.spotifyClientSecret },
          (loaded, total) => progress({ phase: 'playlist', current: loaded, total, message: `Fetching playlist: ${loaded}/${total}` })
        );
        tracks = spotifyTracksToTrackRecords(spotifyTracks);
      } else if (csvPath) {
        progress({ phase: 'csv', current: 0, total: 1, message: 'Reading CSV file…' });
        tracks = await readCsvTracks(csvPath);
      } else {
        return { id: runId, success: false, error: 'Provide a CSV or a Spotify playlist.' };
      }

      const result = await checkOwnership(tracks, progress);

      // Annotate with ignored state
      const ignoredKeys = getIgnoredTrackKeys();
      for (const track of result.missingTracks) {
        track.ignored = ignoredKeys.has(track.key);
      }
      for (const match of (result.uncertainMatches || [])) {
        match.csvTrack.ignored = ignoredKeys.has(match.csvTrack.key);
      }

      return { id: runId, success: true, result, fromCache: false };
    } catch (error) {
      mainLog.error('IPC check-library failed:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { id: runId, success: false, error: message };
    }
  }
);

// Ignored tracks handlers
handleIpc('ignore-track', async (_event, { key, artist, title }: { key: string; artist: string; title: string }) => {
  try {
    ignoreTrack(key, artist, title);
    return { success: true };
  } catch (error) {
    mainLog.error('IPC ignore-track failed:', error);
    throw error;
  }
});

handleIpc('unignore-track', async (_event, { key }: { key: string }) => {
  try {
    unignoreTrack(key);
    return { success: true };
  } catch (error) {
    mainLog.error('IPC unignore-track failed:', error);
    throw error;
  }
});

handleIpc('get-ignored-tracks', async () => {
  try {
    return getIgnoredTracks();
  } catch (error) {
    mainLog.error('IPC get-ignored-tracks failed:', error);
    throw error;
  }
});

// Dismissed duplicates handler
handleIpc('dismiss-duplicate', async (_event, {
  track1Artist, track1Title, track2Artist, track2Title
}: { track1Artist: string; track1Title: string; track2Artist: string; track2Title: string }) => {
  try {
    const key = makeDuplicatePairKey(track1Artist, track1Title, track2Artist, track2Title);
    dismissDuplicate(key, track1Artist, track1Title, track2Artist, track2Title);
    return { success: true };
  } catch (error) {
    mainLog.error('IPC dismiss-duplicate failed:', error);
    throw error;
  }
});

// Dismissed health issues handlers
handleIpc('dismiss-health-issue', async (_event, {
  libraryRoot, filePath, issueCode
}: { libraryRoot: string; filePath: string; issueCode: string }) => {
  try {
    dismissHealthIssue(libraryRoot, filePath, issueCode);
    return { success: true };
  } catch (error) {
    mainLog.error('IPC dismiss-health-issue failed:', error);
    throw error;
  }
});

handleIpc('undismiss-health-issue', async (_event, {
  libraryRoot, filePath, issueCode
}: { libraryRoot: string; filePath: string; issueCode: string }) => {
  try {
    undismissHealthIssue(libraryRoot, filePath, issueCode);
    return { success: true };
  } catch (error) {
    mainLog.error('IPC undismiss-health-issue failed:', error);
    throw error;
  }
});

handleIpc('get-dismissed-issues', async (_event, { libraryRoot }: { libraryRoot: string }) => {
  try {
    return getDismissedIssues(libraryRoot);
  } catch (error) {
    mainLog.error('IPC get-dismissed-issues failed:', error);
    throw error;
  }
});

// Rekordbox XML repair handlers
handleIpc('rekordbox-scan', async (): Promise<{ total: number; missing: MissingFile[]; libraryRoot: string; xmlPath: string }> => {
  const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
  const xmlPath = config.rekordboxXmlPath;
  const libraryRoot = config.libraryRoot || DEFAULT_LIBRARY_ROOT;
  if (!xmlPath) throw new Error('Rekordbox XML path is not set. Configure it in Settings.');
  try {
    const tracks = await parseRekordboxXml(xmlPath);
    const missing = await findMissingFiles(tracks, libraryRoot);
    return { total: tracks.length, missing, libraryRoot, xmlPath };
  } catch (error) {
    mainLog.error('IPC rekordbox-scan failed:', error);
    throw error;
  }
});

handleIpc('rekordbox-import', async (): Promise<RekordboxImportSummary> => {
  const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
  const xmlPath = config.rekordboxXmlPath;
  const libraryRoot = config.libraryRoot || DEFAULT_LIBRARY_ROOT;
  if (!xmlPath) throw new Error('Rekordbox XML path is not set. Configure it in Settings.');
  try {
    const tracks = await parseRekordboxXml(xmlPath);
    return await importRekordboxToLibrary(tracks, libraryRoot);
  } catch (error) {
    mainLog.error('IPC rekordbox-import failed:', error);
    throw error;
  }
});

handleIpc('rekordbox-resync', async (): Promise<RekordboxImportSummary> => trackOp('Rekordbox resync', async () => {
  const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
  const xmlPath = config.rekordboxXmlPath;
  const libraryRoot = config.libraryRoot || DEFAULT_LIBRARY_ROOT;
  if (!xmlPath) throw new Error('Rekordbox XML path is not set. Configure it in Settings.');
  try {
    // Parse & validate the XML BEFORE wiping the DB — a failed, empty or
    // mis-pathed XML must never leave the library index emptied. Count what the
    // import would actually put back (it only takes tracks under the root).
    const tracks = await parseRekordboxXml(xmlPath);
    const inRoot = tracks.filter(t => t.filePath.startsWith(libraryRoot)).length;
    const db = getDatabase();
    const existing = (db.prepare('SELECT COUNT(*) AS n FROM library_tracks WHERE library_root = ?').get(libraryRoot) as { n: number }).n;
    const refusal = resyncRefusal(inRoot, existing, tracks.length, libraryRoot);
    if (refusal) throw new Error(refusal);

    mainLog.info(`Resync: ${inRoot}/${tracks.length} XML tracks under root=${libraryRoot} (index has ${existing}); replacing library_tracks/issues/duplicates/scan_runs`);
    // Clear + import as one transaction: if the import fails, the old index is
    // still there. (The import's own transaction nests as a savepoint. Writes
    // other handlers make while it checks file existence join this transaction.)
    db.exec('BEGIN IMMEDIATE');
    try {
      clearLibraryRoot(libraryRoot);
      const summary = await importRekordboxToLibrary(tracks, libraryRoot);
      db.exec('COMMIT');
      return summary;
    } catch (err) {
      if (db.inTransaction) db.exec('ROLLBACK');
      throw err;
    }
  } catch (error) {
    mainLog.error('IPC rekordbox-resync failed:', error);
    throw error;
  }
}));

// CSV Preview handler
handleIpc('preview-csv', async (_event, { csvPath }: { csvPath: string }): Promise<CsvPreview> => {
  try {
    return previewCsv(csvPath);
  } catch (error) {
    mainLog.error('IPC preview-csv failed:', error);
    throw error;
  }
});

// Cache status handler
handleIpc('get-cache-status', async () => {
  try {
    return getCacheStatus();
  } catch (error) {
    mainLog.error('IPC get-cache-status failed:', error);
    throw error;
  }
});

// Clear cache handler
handleIpc('clear-cache', async () => {
  try {
    await clearCache();
    return { success: true };
  } catch (error) {
    mainLog.error('IPC clear-cache failed:', error);
    throw error;
  }
});

// Sync mutated state from renderer back to main process store
handleIpc('update-check-result', async (_event, { result }: { result: any }) => {
  try {
    updateCachedCheckResult(result);
    return { success: true };
  } catch (error) {
    mainLog.error('IPC update-check-result failed:', error);
    throw error;
  }
});

handleIpc('update-health-result', async (_event, { result }: { result: LibraryHealthResult }) => {
  try {
    replaceLibraryFromResult(result);
    return { success: true };
  } catch (error) {
    mainLog.error('IPC update-health-result failed:', error);
    throw error;
  }
});

// Organize state persistence (survives renderer HMR)
handleIpc('get-organize-state', async () => {
  return getOrganizeState();
});

handleIpc('update-organize-state', async (_event, { state }: { state: any }) => {
  try {
    saveOrganizeState(state);
    return { success: true };
  } catch (error) {
    mainLog.error('IPC update-organize-state failed:', error);
    throw error;
  }
});

// Storage stats handler
handleIpc('get-storage-stats', async () => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    const libraryRoot = config.libraryRoot || DEFAULT_LIBRARY_ROOT;
    const archivePath = config.archivePath || getDefaultArchivePath(libraryRoot);
    // For mounted volumes like /Volumes/Candy Bar, use the volume mount point
    const pathParts = libraryRoot.split(path.sep);
    const volumeRoot = pathParts[1] === 'Volumes' && pathParts[2]
      ? path.join('/', pathParts[1], pathParts[2])
      : path.parse(libraryRoot).root || '/';

    // Get volume stats
    const volumeStats = await (fs.promises as any).statfs(volumeRoot);
    const blockSize = volumeStats.bsize;
    const totalSpace = volumeStats.blocks * blockSize;
    const freeSpace = volumeStats.bavail * blockSize;

    const [musicSize, archiveSize] = await Promise.all([
      getDirSize(libraryRoot),
      getDirSize(archivePath)
    ]);

    const usedSpace = totalSpace - freeSpace;
    const otherSpace = Math.max(0, usedSpace - musicSize - archiveSize);

    return {
      volumePath: volumeRoot,
      totalSpace,
      freeSpace,
      musicSize,
      archiveSize,
      otherSpace
    };
  } catch (error) {
    mainLog.error('IPC get-storage-stats failed:', error);
    throw error;
  }
});

async function getDirSize(dirPath: string): Promise<number> {
  try {
    const stat = await fs.promises.lstat(dirPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 0;
  } catch {
    return 0;
  }
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const visible = entries.filter((e) => !e.name.startsWith('.') && !e.isSymbolicLink());
  const subdirEntries = visible.filter((e) => e.isDirectory());
  const fileEntries = visible.filter((e) => e.isFile());

  const [subdirSizes, fileSizes] = await Promise.all([
    Promise.all(subdirEntries.map((e) => getDirSize(path.join(dirPath, e.name)))),
    Promise.all(fileEntries.map((e) =>
      fs.promises.lstat(path.join(dirPath, e.name)).then((s) => s.size).catch(() => 0)
    ))
  ]);

  return subdirSizes.reduce((a, b) => a + b, 0) + fileSizes.reduce((a, b) => a + b, 0);
}

// Export tracks to CSV
handleIpc(
  'export-tracks-csv',
  async (_event, { tracks, filePath }: { tracks: Array<{ artist: string; title: string; album?: string; genre?: string }>; filePath: string }) => {
    try {
      const headers = ['Artist', 'Title', 'Album', 'Genre'];
      const rows = tracks.map((t) => [
        `"${(t.artist || '').replace(/"/g, '""')}"`,
        `"${(t.title || '').replace(/"/g, '""')}"`,
        `"${(t.album || '').replace(/"/g, '""')}"`,
        `"${(t.genre || '').replace(/"/g, '""')}"`
      ].join(','));

      const csvContent = [headers.join(','), ...rows].join('\n');
      await fs.promises.writeFile(filePath, csvContent, 'utf8');
      return { success: true, filePath };
    } catch (error) {
      mainLog.error('IPC export-tracks-csv failed:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  }
);

// Export tracks as M3U8 playlist (organized by artist)
handleIpc(
  'export-playlist-m3u8',
  async (_event, { tracks, filePath }: { tracks: Array<{ artist: string; title: string; filePath?: string }>; filePath: string }) => {
    try {
      // Group tracks by artist
      const byArtist = new Map<string, Array<{ artist: string; title: string; filePath: string }>>();
      for (const t of tracks) {
        if (!t.filePath) continue;
        const artist = t.artist || 'Unknown Artist';
        if (!byArtist.has(artist)) byArtist.set(artist, []);
        byArtist.get(artist)!.push({ artist, title: t.title, filePath: t.filePath });
      }

      // Sort artists alphabetically, tracks within each artist by title
      const sortedArtists = [...byArtist.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

      const lines: string[] = ['#EXTM3U'];
      for (const artist of sortedArtists) {
        const artistTracks = byArtist.get(artist)!;
        artistTracks.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
        for (const t of artistTracks) {
          lines.push(`#EXTINF:-1,${t.artist} - ${t.title}`);
          lines.push(t.filePath);
        }
      }

      await fs.promises.writeFile(filePath, lines.join('\n'), 'utf8');
      const trackCount = tracks.filter(t => t.filePath).length;
      return { success: true, filePath, trackCount };
    } catch (error) {
      mainLog.error('IPC export-playlist-m3u8 failed:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  }
);

// Export tracks as Rekordbox XML playlist
handleIpc(
  'export-playlist-rekordbox',
  async (_event, { tracks, filePath, playlistName }: { tracks: Array<{ artist: string; title: string; filePath?: string; duration?: number }>; filePath: string; playlistName: string }) => {
    try {
      const validTracks = tracks.filter(t => t.filePath);
      if (validTracks.length === 0) {
        return { success: false, error: 'No tracks with file paths to export' };
      }

      const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;');

      const collectionEntries: string[] = [];
      const playlistEntries: string[] = [];

      for (let i = 0; i < validTracks.length; i++) {
        const t = validTracks[i];
        const trackId = i + 1;
        const location = `file://localhost${encodeURI(t.filePath!).replace(/#/g, '%23')}`;
        const ext = path.extname(t.filePath!).replace('.', '').toUpperCase();

        collectionEntries.push(
          `    <TRACK TrackID="${trackId}" Name="${escXml(t.title)}" Artist="${escXml(t.artist)}" Location="${escXml(location)}"${t.duration ? ` TotalTime="${Math.round(t.duration)}"` : ''} Kind="${ext}" />`
        );
        playlistEntries.push(`        <TRACK Key="${trackId}" />`);
      }

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="Track Lab" Version="1.0.0" Company="Candy Bar" />
  <COLLECTION Entries="${validTracks.length}">
${collectionEntries.join('\n')}
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="1">
      <NODE Name="${escXml(playlistName)}" Type="1" KeyType="0" Entries="${validTracks.length}">
${playlistEntries.join('\n')}
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>`;

      await fs.promises.writeFile(filePath, xml, 'utf8');
      return { success: true, filePath, trackCount: validTracks.length };
    } catch (error) {
      mainLog.error('IPC export-playlist-rekordbox failed:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  }
);

// Show save dialog for M3U8 export
handleIpc('show-save-dialog-m3u8', async (_event, { defaultName }: { defaultName: string }) => {
  try {
    const result = await dialog.showSaveDialog({
      defaultPath: defaultName,
      filters: [{ name: 'M3U8 Playlist', extensions: ['m3u8'] }]
    });

    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  } catch (error) {
    mainLog.error('IPC show-save-dialog-m3u8 failed:', error);
    throw error;
  }
});

// Show save dialog for Rekordbox XML export
handleIpc('show-save-dialog-rekordbox', async (_event, { defaultName }: { defaultName: string }) => {
  try {
    const result = await dialog.showSaveDialog({
      defaultPath: defaultName,
      filters: [{ name: 'Rekordbox XML', extensions: ['xml'] }]
    });

    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  } catch (error) {
    mainLog.error('IPC show-save-dialog-rekordbox failed:', error);
    throw error;
  }
});

// Show save dialog for CSV export
handleIpc('show-save-dialog', async (_event, { defaultName }: { defaultName: string }) => {
  try {
    const result = await dialog.showSaveDialog({
      defaultPath: defaultName,
      filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    });

    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  } catch (error) {
    mainLog.error('IPC show-save-dialog failed:', error);
    throw error;
  }
});

// Show save dialog for JSON export
handleIpc('show-save-dialog-json', async (_event, { defaultName }: { defaultName: string }) => {
  try {
    const result = await dialog.showSaveDialog({
      defaultPath: defaultName,
      filters: [{ name: 'JSON Files', extensions: ['json'] }]
    });

    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  } catch (error) {
    mainLog.error('IPC show-save-dialog-json failed:', error);
    throw error;
  }
});

// Export library catalog as JSON
handleIpc('export-catalog', async (event, { outputPath }: { outputPath: string }) => {
  const libraryRoot = await getLibraryRoot();

  // Use job queue for concurrent execution and shared library scan
  const jm = getJobManager();
  const { jobId, promise } = jm.enqueue('catalog-export', {
    libraryRoot,
    outputPath,
    contextKey: libraryRoot
  }, libraryRoot);

  try {
    const result = await promise as { total: number; exported: number; skipped: number };
    return { id: jobId, success: true, ...result };
  } catch (error) {
    mainLog.error('IPC export-catalog failed:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { id: jobId, success: false, error: message };
  }
});

// Music search handlers
type MusicSearchSource = 'spotify' | 'soundcloud' | 'beatport' | 'qobuz';

type MusicSearchResult = {
  spotify: SpotifySearchResult | null;
  soundcloud: SoundCloudSearchResult | null;
  beatport: BeatportSearchResult | null;
  qobuz: QobuzSearchResult | null;
  errors: { source: string; message: string }[];
};

handleIpc(
  'search-music',
  async (
    _event,
    { query, sources }: { query: string; sources: MusicSearchSource[] }
  ): Promise<MusicSearchResult> => {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    const result: MusicSearchResult = {
      spotify: null,
      soundcloud: null,
      beatport: null,
      qobuz: null,
      errors: []
    };

    // Search provider registry: maps source name to its search function
    const providers: Record<MusicSearchSource, () => Promise<unknown>> = {
      spotify: async () => {
        if (!config.spotifyClientId || !config.spotifyClientSecret) {
          throw new Error('Spotify credentials not configured');
        }
        return searchSpotify(query, {
          clientId: config.spotifyClientId,
          clientSecret: config.spotifyClientSecret
        });
      },
      soundcloud: () => {
        // Prefer OAuth when creds are configured (returns users too); fall
        // back to the public V2 endpoint so album-art suggestions still work
        // without credentials.
        if (config.soundcloudClientId && config.soundcloudClientSecret) {
          return searchSoundCloud(query, {
            clientId: config.soundcloudClientId,
            clientSecret: config.soundcloudClientSecret
          });
        }
        return searchSoundCloudPublicTracks(query, 20);
      },
      beatport: () => searchBeatport(query),
      qobuz: () => searchQobuz(query)
    };

    const tasks = sources.map(async (source) => {
      try {
        result[source] = await providers[source]() as never;
      } catch (error) {
        mainLog.warn(`Music search failed for ${source}:`, error);
        result.errors.push({
          source,
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    await Promise.all(tasks);
    return result;
  }
);

// ========== Autopopulate Tracks ==========

type AutopopulateResult = {
  filePath: string;
  updated: boolean;
  fieldsPopulated: string[];
  error?: string;
};

function scoreBeatportMatch(
  trackTitle: string,
  trackArtist: string,
  bt: { name: string; artists: string[] }
): number {
  const titleSim = stringSimilarity(
    normalizeForComparison(trackTitle),
    normalizeForComparison(bt.name)
  );
  const artistSim = stringSimilarity(
    normalizeForComparison(trackArtist),
    normalizeForComparison(bt.artists.join(' '))
  );
  return titleSim * 0.7 + artistSim * 0.3;
}

function scoreSpotifyMatch(
  trackTitle: string,
  trackArtist: string,
  st: { name: string; artists: string[] }
): number {
  const titleSim = stringSimilarity(
    normalizeForComparison(trackTitle),
    normalizeForComparison(st.name)
  );
  const artistSim = stringSimilarity(
    normalizeForComparison(trackArtist),
    normalizeForComparison(st.artists.join(' '))
  );
  return titleSim * 0.7 + artistSim * 0.3;
}

// Infer artist/title from a "Artist - Title" string when the artist tag is
// missing. Handles hyphen, en-dash, and em-dash separators. Also strips the
// trailing " (Remix)" / " [Label]" clutter that would confuse a split.
function extractArtistFromTitle(raw: string): { artist: string; title: string } | null {
  if (!raw) return null;
  const match = raw.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (!match) return null;
  const artist = match[1].trim();
  const title = match[2].trim();
  if (!artist || !title) return null;
  return { artist, title };
}

async function fetchImageAsBase64(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

type AutopopulateTrackInput = { filePath: string; title: string; artist: string; album: string; year: string; genre: string; label: string; key: string; bpm: string; remixer: string; hasAlbumArt: boolean };

async function processOneAutopopulateTrack(
  track: AutopopulateTrackInput,
  config: AppConfig,
  log?: LogFn
): Promise<AutopopulateResult> {
  const MIN_MATCH_SCORE = 0.6;
  const trackLabel = path.basename(track.filePath);

  // Re-read tags from disk so the "only fill missing" guard is ground-truth,
  // regardless of which fields the caller populated on the input.
  let existing: {
    artist: string; title: string; album: string; year: string; genre: string;
    label: string; key: string; bpm: string; remixer: string; hasAlbumArt: boolean;
  };
  try {
    const mm = await import('music-metadata');
    const meta = await mm.parseFile(track.filePath, { duration: false });
    const common = meta.common as unknown as Record<string, unknown>;
    existing = {
      artist: meta.common.artist || meta.common.artists?.[0] || '',
      title: meta.common.title || '',
      album: meta.common.album || '',
      year: meta.common.year ? String(meta.common.year) : '',
      genre: meta.common.genre?.[0] || '',
      label: meta.common.label?.[0] || '',
      ...readDjTags(meta),
      hasAlbumArt: !!(meta.common.picture && meta.common.picture.length > 0)
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log?.(`Autopopulate: could not read tags for ${trackLabel}: ${message}\n`, 'stderr');
    return { filePath: track.filePath, updated: false, fieldsPopulated: [], error: message };
  }

  // If artist tag is empty but the title follows the "Artist - Title" pattern
  // common for DJ sources, split it so Beatport/Spotify scoring has something
  // to match the artist against. Remember the inference so we can write the
  // proper tags to disk at the end — otherwise the track stays "missing
  // artist" even when autopopulate succeeds at filling everything else.
  let inferredArtist: { artist: string; title: string } | null = null;
  if (!existing.artist) {
    inferredArtist =
      extractArtistFromTitle(existing.title) ||
      extractArtistFromTitle(path.basename(track.filePath, path.extname(track.filePath)));
    if (inferredArtist) {
      existing.artist = inferredArtist.artist;
      existing.title = inferredArtist.title;
      log?.(`Autopopulate: inferred artist "${inferredArtist.artist}" from title for ${trackLabel}\n`);
    }
  }

  // Include the remixer in the query. For remixes, the remixer's name is what
  // drives SoundCloud uploads (remixer's profile hosts the art) and often
  // differentiates Spotify hits for official-remix releases.
  const queryParts = [existing.artist, existing.title];
  if (existing.remixer) queryParts.push(existing.remixer);
  const query = queryParts.filter(Boolean).join(' ').trim();
  if (!query) {
    log?.(`Autopopulate: no artist/title for ${trackLabel}\n`, 'stderr');
    return { filePath: track.filePath, updated: false, fieldsPopulated: [] };
  }

  const needsAlbumArt = !existing.hasAlbumArt;

      try {
        // Search Beatport, Spotify, and SoundCloud in parallel. SoundCloud is
        // primarily used as an album-art fallback — remix-heavy libraries often
        // find their only matching cover there.
        const [beatportResult, spotifyResult, soundcloudResult] = await Promise.allSettled([
          searchBeatport(query),
          config.spotifyClientId && config.spotifyClientSecret
            ? searchSpotify(query, { clientId: config.spotifyClientId, clientSecret: config.spotifyClientSecret })
            : Promise.resolve(null),
          config.soundcloudClientId && config.soundcloudClientSecret
            ? searchSoundCloud(query, { clientId: config.soundcloudClientId, clientSecret: config.soundcloudClientSecret }, { type: ['track'], limit: 10 })
            : searchSoundCloudPublicTracks(query, 10)
        ]);

        const tagUpdates: UpdateTagsParams = { filePath: track.filePath };
        const fieldsPopulated: string[] = [];

        // Find best Beatport match for DJ metadata
        if (beatportResult.status === 'fulfilled' && beatportResult.value) {
          const beatportTracks = beatportResult.value.tracks;
          let bestBt = null;
          let bestScore = 0;
          for (const bt of beatportTracks) {
            const score = scoreBeatportMatch(existing.title, existing.artist, bt);
            if (score > bestScore) {
              bestScore = score;
              bestBt = bt;
            }
          }
          if (bestBt && bestScore >= MIN_MATCH_SCORE) {
            if (!existing.genre && bestBt.genre) { tagUpdates.genre = bestBt.genre; fieldsPopulated.push('genre'); }
            if (!existing.label && bestBt.label) { tagUpdates.label = bestBt.label; fieldsPopulated.push('label'); }
            if (!existing.key && bestBt.key) { tagUpdates.key = bestBt.key; fieldsPopulated.push('key'); }
            if (!existing.bpm && bestBt.bpm) { tagUpdates.bpm = String(bestBt.bpm); fieldsPopulated.push('bpm'); }
            if (!existing.remixer && bestBt.remixers?.length > 0) { tagUpdates.remixer = bestBt.remixers.join(', '); fieldsPopulated.push('remixer'); }
            if (!existing.year && bestBt.release_date) {
              const yearMatch = bestBt.release_date.match(/(\d{4})/);
              if (yearMatch) { tagUpdates.year = yearMatch[1]; fieldsPopulated.push('year'); }
            }
          }
        }

        // Find best Spotify match for album art, album name, and year
        if (spotifyResult.status === 'fulfilled' && spotifyResult.value) {
          const spotifyTracks = spotifyResult.value.tracks;
          let bestSt = null;
          let bestScore = 0;
          for (const st of spotifyTracks) {
            const score = scoreSpotifyMatch(existing.title, existing.artist, st);
            if (score > bestScore) {
              bestScore = score;
              bestSt = st;
            }
          }
          if (bestSt && bestScore >= MIN_MATCH_SCORE) {
            if (!existing.album && tagUpdates.album === undefined && bestSt.album) {
              tagUpdates.album = bestSt.album;
              fieldsPopulated.push('album');
            }
            if (!existing.year && tagUpdates.year === undefined && bestSt.release_year) {
              tagUpdates.year = bestSt.release_year;
              fieldsPopulated.push('year');
            }
          }

          // Album art from the BEST Spotify match, gated on the match threshold so
          // we never embed an unrelated cover into an irreplaceable file.
          if (needsAlbumArt && tagUpdates.albumArt === undefined &&
              bestSt && bestScore >= MIN_MATCH_SCORE && bestSt.album_image_url) {
            const dataUrl = await fetchImageAsBase64(bestSt.album_image_url);
            if (dataUrl) {
              tagUpdates.albumArt = dataUrl;
              fieldsPopulated.push('album_art');
            }
          }
        }

        // SoundCloud album-art fallback — remix uploads (and a lot of
        // remix-heavy labels) have their only cover art here. SoundCloud
        // artwork URLs default to -large (100×100); bump to -t500x500 so the
        // embedded cover is actually usable on a DJ controller screen.
        if (needsAlbumArt && tagUpdates.albumArt === undefined &&
            soundcloudResult.status === 'fulfilled' && soundcloudResult.value) {
          // Only use art from a SoundCloud track whose title/artist reasonably
          // matches, so an unrelated cover isn't embedded into the file.
          let bestSc: (typeof soundcloudResult.value.tracks)[number] | null = null;
          let bestScScore = 0;
          for (const sc of soundcloudResult.value.tracks) {
            if (!sc.artwork_url) continue;
            const titleSim = stringSimilarity(normalizeForComparison(existing.title), normalizeForComparison(sc.title));
            const artistSim = stringSimilarity(normalizeForComparison(existing.artist), normalizeForComparison(sc.user || ''));
            const score = titleSim * 0.7 + artistSim * 0.3;
            if (score > bestScScore) { bestScScore = score; bestSc = sc; }
          }
          if (bestSc?.artwork_url && bestScScore >= MIN_MATCH_SCORE) {
            const hiRes = bestSc.artwork_url.replace('-large.', '-t500x500.');
            const dataUrl = await fetchImageAsBase64(hiRes) || await fetchImageAsBase64(bestSc.artwork_url);
            if (dataUrl) {
              tagUpdates.albumArt = dataUrl;
              fieldsPopulated.push('album_art');
            }
          }
        }

        // Persist the artist/title split we inferred from the old title tag,
        // so tracks whose only problem was "Artist - Title packed into title"
        // actually land in a healthy state on the re-scan.
        if (inferredArtist) {
          tagUpdates.artist = inferredArtist.artist;
          tagUpdates.title = inferredArtist.title;
          fieldsPopulated.push('artist', 'title');
        }

        if (fieldsPopulated.length > 0) {
          await updateTags(tagUpdates);
          log?.(`Autopopulate: ${trackLabel} → +${fieldsPopulated.join(', ')}\n`);
          return { filePath: track.filePath, updated: true, fieldsPopulated };
        }
        log?.(`Autopopulate: no confident match for ${trackLabel}\n`);
        return { filePath: track.filePath, updated: false, fieldsPopulated: [] };
    } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    mainLog.warn(`Autopopulate failed for ${track.filePath}:`, message);
    log?.(`Autopopulate error for ${trackLabel}: ${message}\n`, 'stderr');
    return { filePath: track.filePath, updated: false, fieldsPopulated: [], error: message };
  }
}

handleIpc(
  'autopopulate-tracks',
  async (
    event,
    { tracks: inputTracks, force = false }: { tracks: AutopopulateTrackInput[]; force?: boolean }
  ): Promise<AutopopulateResult[]> => trackOp('Filling in tags', async () => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const log = createLogger(event.sender, runId);
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);

    // Skip tracks we've already processed; the DB remembers every file path
    // we've run through autopopulate so repeat scans never re-query.
    // `force` bypasses the skip for explicit per-track user actions.
    const alreadyDone = force
      ? new Set<string>()
      : getAutopopulatedPaths(inputTracks.map(t => t.filePath));
    const toProcess = inputTracks.filter(t => !alreadyDone.has(t.filePath));
    const skippedResults: AutopopulateResult[] = inputTracks
      .filter(t => alreadyDone.has(t.filePath))
      .map(t => ({ filePath: t.filePath, updated: false, fieldsPopulated: [] }));

    if (alreadyDone.size > 0) {
      log(`Autopopulate: skipping ${alreadyDone.size} already-processed track${alreadyDone.size === 1 ? '' : 's'}\n`);
    }

    const total = toProcess.length;
    const results: AutopopulateResult[] = [];

    if (total === 0) {
      log(`Autopopulate: nothing to do\n`, 'status');
      return skippedResults;
    }

    log(`Autopopulate: searching ${total} track${total === 1 ? '' : 's'} on Beatport + Spotify\n`, 'status');

    for (let i = 0; i < total; i += AUTOPOPULATE_CONCURRENCY) {
      const batch = toProcess.slice(i, i + AUTOPOPULATE_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map((track, idx) => {
          safeSend(event.sender, 'autopopulate-progress', { current: i + idx + 1, total, filePath: track.filePath });
          return processOneAutopopulateTrack(track, config, log);
        })
      );
      for (const r of batchResults) {
        // Mark as processed only when the run completed WITHOUT a hard error, so a
        // transient failure (offline file, network error, failed tag write) is
        // retried on the next scan rather than permanently skipped. A successful
        // search that simply found no match is still marked done (no re-query).
        if (!r.error) markTrackAutopopulated(r.filePath);
      }
      results.push(...batchResults);
    }

    const updated = results.filter(r => r.updated).length;
    const errored = results.filter(r => r.error).length;
    log(`Autopopulate done: ${updated} updated, ${total - updated - errored} no-match, ${errored} errored\n`, 'status');

    return [...results, ...skippedResults];
  })
);

handleIpc('check-spotify', async (): Promise<boolean> => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    if (!config.spotifyClientId || !config.spotifyClientSecret) {
      return false;
    }
    return testSpotifyConnection({
      clientId: config.spotifyClientId,
      clientSecret: config.spotifyClientSecret
    });
  } catch (error) {
    mainLog.error('IPC check-spotify failed:', error);
    return false;
  }
});

// SoundCloud's one sign-in: the 'soundcloud' Chrome profile that the set
// reader, the downloader (Claude jobs, upgrade free downloads) and the MCP
// tools all open. The status is the note the last check by any of them left.
handleIpc('soundcloud-sign-in-status', async (): Promise<SoundCloudSignIn | null> => {
  try {
    return await readSoundCloudSignIn();
  } catch (error) {
    mainLog.error('IPC soundcloud-sign-in-status failed:', error);
    return null;
  }
});

handleIpc('soundcloud-sign-in', async (): Promise<{ success: boolean; status?: SoundCloudSignIn; error?: string }> => {
  try {
    return { success: true, status: await signInToSoundCloud() };
  } catch (error) {
    mainLog.error('IPC soundcloud-sign-in failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Sign-in failed' };
  }
});

// Source export: write source search results to CSV
handleIpc(
  'source-export-csv',
  async (_event, { content, filePath }: { content: string; filePath: string }) => {
    try {
      await fs.promises.writeFile(filePath, content, 'utf8');
      return { success: true, filePath };
    } catch (error) {
      mainLog.error('IPC source-export-csv failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Export failed' };
    }
  }
);

// Source search: parse CSV or Spotify playlist and batch search for lossless purchase sources
handleIpc(
  'source-search',
  async (event, { csvPath, spotifyPlaylistUrl }: { csvPath?: string; spotifyPlaylistUrl?: string }) => {
    try {
      let tracks: QobuzCartTrackInput[] = [];

      if (spotifyPlaylistUrl) {
        const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
        if (!config.spotifyClientId || !config.spotifyClientSecret) {
          return { success: false, error: 'Spotify credentials not configured. Go to Settings to add your Spotify Client ID and Secret.' };
        }

        safeSend(event.sender, 'qobuz-cart-search-progress', { current: 0, total: 1, currentTrack: 'Fetching Spotify playlist...' });

        const { playlist, tracks: spotifyTracks } = await getPlaylistTracks(
          spotifyPlaylistUrl,
          { clientId: config.spotifyClientId, clientSecret: config.spotifyClientSecret },
          (loaded, total) => {
            safeSend(event.sender, 'qobuz-cart-search-progress', {
              current: loaded,
              total,
              currentTrack: `Fetching playlist: ${loaded}/${total}`
            });
          }
        );

        if (spotifyTracks.length === 0) {
          return { success: false, error: `Playlist "${playlist.name}" contains no fetchable tracks.` };
        }

        tracks = spotifyTracks.map(t => {
          const artist = t.artists.join(', ');
          return {
            key: `${artist.toLowerCase()} - ${t.name.toLowerCase()}`,
            artist: artist || 'Unknown Artist',
            title: t.name || 'Unknown Title',
            album: t.album || undefined,
            duration: Math.round(t.duration_ms / 1000)
          };
        });
      } else if (csvPath) {
        // Parse full CSV to extract tracks
        const preview = await previewCsv(csvPath, Infinity);
        const lowerCols = preview.columns.map(c => c.toLowerCase().trim());

        const artistIdx = lowerCols.findIndex(c => ['artist', 'artists', 'performer'].includes(c));
        const titleIdx = lowerCols.findIndex(c => ['title', 'track', 'name', 'song'].includes(c));
        const albumIdx = lowerCols.findIndex(c => c === 'album');

        if (artistIdx === -1 || titleIdx === -1) {
          return { success: false, error: 'CSV must have artist and title columns.' };
        }

        const artistCol = preview.columns[artistIdx];
        const titleCol = preview.columns[titleIdx];
        const albumCol = albumIdx !== -1 ? preview.columns[albumIdx] : null;

        tracks = preview.rows
          .filter(row => row[artistCol]?.trim() && row[titleCol]?.trim())
          .map(row => {
            const artist = row[artistCol].trim();
            const title = row[titleCol].trim();
            return {
              key: `${artist.toLowerCase()} - ${title.toLowerCase()}`,
              artist,
              title,
              album: albumCol ? row[albumCol]?.trim() : undefined
            };
          });

        if (tracks.length === 0) {
          return { success: false, error: 'No valid tracks found in CSV.' };
        }
      } else {
        return { success: false, error: 'Either csvPath or spotifyPlaylistUrl must be provided.' };
      }

      // Ownership first, from Rekordbox + candybar.db (not a folder scan), so
      // each match can say whether it's already in the collection and the UI
      // skips auto-selecting it.
      const ownership = await checkOwnership(tracks.map(t => ({ key: t.key, artist: t.artist, title: t.title, album: t.album, duration: t.duration })));
      const statusByKey = new Map<string, { status: 'confirmed' | 'probable'; path?: string; confidence: number }>();
      for (const t of ownership.matchedTracks) {
        statusByKey.set(t.key, { status: 'confirmed', path: t.matchedLibraryTrack?.filePath, confidence: t.confidence });
      }
      for (const m of ownership.uncertainMatches) {
        if (!statusByKey.has(m.csvTrack.key)) {
          statusByKey.set(m.csvTrack.key, { status: 'probable', path: m.libraryTrack.filePath, confidence: m.confidence });
        }
      }
      const tagOwnership = (m: import('./lib/qobuzCart').QobuzCartMatch) => {
        const owned = statusByKey.get(m.trackInput.key);
        m.libraryStatus = owned?.status ?? 'missing';
        if (owned) {
          m.inLibrary = true;
          m.libraryMatchPath = owned.path;
          m.libraryMatchConfidence = owned.confidence;
        }
      };

      const results = await batchSearchQobuz(
        tracks,
        (current, total, currentTrack) => {
          safeSend(event.sender, 'qobuz-cart-search-progress', { current, total, currentTrack });
        },
        (match) => {
          tagOwnership(match);
          safeSend(event.sender, 'qobuz-cart-search-match', match);
        }
      );
      for (const m of results) tagOwnership(m);
      mainLog.info(`Sources library-tag: ${statusByKey.size}/${tracks.length} tracks already in the collection`);

      return { success: true, matches: results };
    } catch (error) {
      mainLog.error('IPC source-search failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Search failed' };
    }
  }
);

// ---------- Claude as the store matcher ----------
//
// After the plain search, small Claude Code sessions (the claude-store-finder
// job; lib/claude/storeFinder.ts) pick each track's record from what that
// search saw, searching again through the app when nothing fits. The plain
// matches stand when Claude is switched off, isn't installed or signed in to
// a subscription, or fails.
async function findMatchesWithClaude(
  matches: QobuzCartMatch[],
  candidatesByKey: Map<string, StoreCandidates>,
  config: AppConfig,
  onProgress: (p: import('./types').SourcingFinderProgress) => void,
): Promise<{ matches: QobuzCartMatch[]; finder: import('./types').SourcingFinderSummary }> {
  const plain = (note: string) => ({
    matches: matches.map(m => ({ ...m, finder: { by: 'search' as const } })),
    finder: { by: 'search' as const, note },
  });
  if (matches.length === 0) return plain('');
  if (config.claudeFindMatches === false) return plain("Claude matching is off in Settings → Claude, so these are the plain search's matches.");
  onProgress({ done: 0, total: matches.length, message: 'Checking Claude Code…' });
  const status = await getClaudeStatus(config.claudeOauthToken || undefined).catch(() => null);
  if (!status?.installed) return plain("Claude Code isn't installed, so these are the plain search's matches.");
  if (!status.subscription) return plain("Claude Code isn't signed in to a Claude subscription (Settings → Claude), so these are the plain search's matches.");

  const jm = getJobManager();
  const params: import('./types').ClaudeStoreFinderParams = { tracks: buildFinderTracks(matches, candidatesByKey) };
  const { jobId, promise } = jm.enqueue<import('./types').ClaudeStoreFinderResult>('claude-store-finder', params, 'find-and-buy');
  const onJobProgress = (p: { jobId: string; current: number; total: number; message: string }) => {
    if (p.jobId === jobId) onProgress({ done: p.current, total: p.total || matches.length, message: p.message });
  };
  jm.on('job-progress', onJobProgress);
  try {
    const result = await promise;
    const picked = await applyFinderPicks(matches, result.picks, resolveQobuzHit);
    return { matches: picked, finder: { by: 'claude', note: finderSummary(picked, result.unchecked, result.firstError) } };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    mainLog.warn('Claude store finder failed:', err);
    return plain(why === 'Job cancelled'
      ? "Claude was stopped, so these are the plain search's matches."
      : `Claude couldn't check the matches (${why.replace(/\.$/, '')}), so these are the plain search's matches.`);
  } finally {
    jm.off('job-progress', onJobProgress);
  }
}

/** A catalog search for the finder's search_store_catalog tool: the first
 *  results as the prompt lists them, each registered so a pick can name it. */
async function catalogSearch(store: 'qobuz' | 'beatport', query: string) {
  const q = query.trim().slice(0, 200);
  if (!q) throw new Error('Search for something: an artist and a title, or a title alone.');
  const results = store === 'beatport'
    ? (await searchBeatportTracks(q)).slice(0, 10).map(track => toFinderCandidate({ store: 'beatport', track }))
    : (await searchQobuzTracks(q)).slice(0, 10).map(track => toFinderCandidate({ store: 'qobuz', track }));
  return { store, query: q, results, ...(results.length === 0 ? { note: 'Nothing came back for that query.' } : {}) };
}

// ---------- Library-Sourcing: combined Check + Source flow ----------
//
// Two-phase pipeline per the merge plan:
//   Phase 1 checks each track against the Rekordbox collection (plus
//   candybar.db's reflection of it) — see checkOwnership above.
//   Phase 2 searches Qobuz + Beatport for only the tracks that aren't cleanly
//   in the collection (probable + missing).
//
// Progress is streamed on two distinct channels so the renderer can show a
// two-phase hero without the phases trampling each other:
//   `library-sourcing:phase1-progress` — library check progress updates
//   `library-sourcing:phase2-progress` — per-track store search progress
//   `library-sourcing:phase2-match`    — individual match objects as they
//                                          resolve (streaming to results)
handleIpc(
  'library-sourcing:run',
  async (
    event,
    {
      csvPath,
      spotifyPlaylistUrl,
      soundcloudSetUrl
    }: { csvPath?: string; spotifyPlaylistUrl?: string; soundcloudSetUrl?: string }
  ) => {
    try {
      const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
      // No drive check: ownership comes from the Rekordbox collection, which
      // answers correctly even while the library drive is unplugged.

      // ---------- Input parsing (CSV, Spotify playlist or SoundCloud set) ----------
      // Build both a TrackRecord list (phase 1 input) and a parallel
      // QobuzCartTrackInput list keyed the same way so we can correlate
      // phase-2 matches back to phase-1 rows.
      let phase1Tracks: import('./lib/musicLibraryCheck').TrackRecord[] = [];
      /** A SoundCloud set's own free downloads, by phase-1 track key. */
      let setFree: Map<string, import('./lib/soundcloudSets').SetFreeTrack> = new Map();

      if (spotifyPlaylistUrl) {
        if (!config.spotifyClientId || !config.spotifyClientSecret) {
          return { success: false, error: 'Spotify credentials not configured. Go to Settings to add your Spotify Client ID and Secret.' };
        }
        safeSend(event.sender, 'library-sourcing:phase1-progress', { phase: 'parsing', current: 0, total: 1, message: 'Fetching Spotify playlist…' });
        const { playlist, tracks: spotifyTracks } = await getPlaylistTracks(
          spotifyPlaylistUrl,
          { clientId: config.spotifyClientId, clientSecret: config.spotifyClientSecret },
          (loaded, total) => {
            safeSend(event.sender, 'library-sourcing:phase1-progress', {
              phase: 'parsing', current: loaded, total, message: `Fetching playlist: ${loaded}/${total}`
            });
          }
        );
        if (spotifyTracks.length === 0) {
          return { success: false, error: `Playlist "${playlist.name}" contains no fetchable tracks.` };
        }
        // Surface the playlist's cover art / name / track count now so the UI can
        // show it while the library scan (the slow phase) runs.
        safeSend(event.sender, 'library-sourcing:playlist-info', {
          name: playlist.name,
          imageUrl: playlist.imageUrl,
          trackCount: playlist.trackCount,
          fetchedCount: spotifyTracks.length,
          owner: playlist.owner,
          source: 'spotify'
        } satisfies import('./types').SourcePlaylistInfo);
        phase1Tracks = spotifyTracksToTrackRecords(spotifyTracks);
      } else if (soundcloudSetUrl) {
        safeSend(event.sender, 'library-sourcing:phase1-progress', { phase: 'parsing', current: 0, total: 1, message: 'Fetching SoundCloud set…' });
        const set = await fetchSoundCloudSet(soundcloudSetUrl, (loaded, total) => {
          safeSend(event.sender, 'library-sourcing:phase1-progress', {
            phase: 'parsing', current: loaded, total, message: `Fetching set: ${loaded}/${total}`
          });
        }, () => {
          safeSend(event.sender, 'library-sourcing:phase1-progress', {
            phase: 'parsing', current: 0, total: 1, message: 'This set is private. Sign in to SoundCloud in the Chrome window that just opened…'
          });
        });
        if (set.tracks.length === 0) {
          return { success: false, error: `Set "${set.name}" contains no playable tracks.` };
        }
        safeSend(event.sender, 'library-sourcing:playlist-info', {
          name: set.name,
          imageUrl: set.imageUrl,
          trackCount: set.trackCount,
          fetchedCount: set.tracks.length,
          owner: set.owner,
          source: 'soundcloud'
        } satisfies import('./types').SourcePlaylistInfo);
        phase1Tracks = set.tracks;
        setFree = set.freeByKey;
      } else if (csvPath) {
        safeSend(event.sender, 'library-sourcing:phase1-progress', { phase: 'parsing', current: 0, total: 1, message: 'Reading CSV…' });
        phase1Tracks = await readCsvTracks(csvPath);
      } else {
        return { success: false, error: 'Provide a CSV, a Spotify playlist or a SoundCloud set.' };
      }

      // A track listed twice in a playlist or set is one track to source.
      const seenKeys = new Set<string>();
      phase1Tracks = phase1Tracks.filter(t => {
        if (seenKeys.has(t.key)) return false;
        seenKeys.add(t.key);
        return true;
      });

      // ---------- Phase 1: what's already in the collection ----------
      const phase1Progress = (p: ProgressUpdate) => {
        safeSend(event.sender, 'library-sourcing:phase1-progress', p);
      };
      const checkResult: CheckResult = await checkOwnership(phase1Tracks, phase1Progress);

      // Pull ignore list once; applied both to phase-1 bucketing and phase-2
      // input so ignored tracks disappear from all three sections.
      const ignoredKeys = getIgnoredTrackKeys();

      // ---------- Bucket phase-1 results ----------
      const matchedRows: import('./types').LibraryMatchedRow[] = checkResult.matchedTracks
        .filter(t => !ignoredKeys.has(t.key))
        .map(t => ({
          artist: t.matchedLibraryTrack?.artist || t.artist,
          title: t.matchedLibraryTrack?.title || t.title,
          album: t.matchedLibraryTrack?.album || t.album,
          genre: t.matchedLibraryTrack?.genre || t.genre,
          filePath: t.matchedLibraryTrack?.filePath || t.filePath || '',
          duration: t.matchedLibraryTrack?.duration || t.duration
        }))
        .filter(r => !!r.filePath);

      const probableRows: import('./types').LibraryProbableRow[] = (checkResult.uncertainMatches as OwnershipUncertainMatch[])
        .filter(m => !ignoredKeys.has(m.csvTrack.key))
        .map(m => ({
          artist: m.csvTrack.artist,
          title: m.csvTrack.title,
          suspectedFilePath: m.libraryTrack.filePath || '',
          suspectedFileArtist: m.libraryTrack.artist,
          suspectedFileTitle: m.libraryTrack.title,
          confidence: m.confidence,
          reason: m.reason
        }));

      // ---------- Phase 2 input: uncertain ∪ missing, minus ignored ----------
      // phase2Meta doubles as the de-dupe: a track listed twice (common in
      // sets and CSVs) is searched, and shown, once.
      type PhaseKey = {
        key: string; status: 'probable' | 'missing'; matchPath?: string; matchConfidence?: number;
        free?: import('./lib/soundcloudSets').SetFreeTrack;
      };
      const phase2Inputs: QobuzCartTrackInput[] = [];
      const phase2Meta = new Map<string, PhaseKey>();

      for (const m of checkResult.uncertainMatches) {
        if (ignoredKeys.has(m.csvTrack.key)) continue;
        const key = `${m.csvTrack.artist.toLowerCase()} - ${m.csvTrack.title.toLowerCase()}`;
        if (phase2Meta.has(key)) continue;
        phase2Inputs.push({
          key,
          artist: m.csvTrack.artist,
          title: m.csvTrack.title,
          album: m.csvTrack.album,
          duration: m.csvTrack.duration
        });
        phase2Meta.set(key, {
          key,
          status: 'probable',
          matchPath: m.libraryTrack.filePath,
          matchConfidence: m.confidence,
          free: setFree.get(m.csvTrack.key),
        });
      }
      for (const m of checkResult.missingTracks) {
        if (ignoredKeys.has(m.key)) continue;
        const key = `${m.artist.toLowerCase()} - ${m.title.toLowerCase()}`;
        if (phase2Meta.has(key)) continue;
        phase2Inputs.push({
          key,
          artist: m.artist,
          title: m.title,
          album: m.album,
          duration: m.duration
        });
        phase2Meta.set(key, { key, status: 'missing', free: setFree.get(m.key) });
      }

      // A set's free downloads: the downloader rows stay in main, keyed like
      // the matches, for "Get free downloads". The stores are still searched
      // for these, since a free file can turn out compressed.
      const freeRows: FreeFetchRow[] = [];
      for (const meta of phase2Meta.values()) {
        if (meta.free) freeRows.push({ ...meta.free.fetchRow, upgradeKey: meta.key, scId: meta.free.fetchRow.scId });
      }
      if (freeRows.length > 0) await saveSourcingFreeRows(freeRows);

      // ---------- Phase 2: store search ----------
      safeSend(event.sender, 'library-sourcing:phase2-progress', {
        current: 0, total: phase2Inputs.length, currentTrack: 'Preparing store search…'
      });

      // Every result each track's search saw, for Claude to judge afterwards.
      const candidatesByKey = new Map<string, StoreCandidates>();
      const plainMatches = phase2Inputs.length > 0
        ? await batchSearchQobuz(
            phase2Inputs,
            (current, total, currentTrack) => {
              safeSend(event.sender, 'library-sourcing:phase2-progress', { current, total, currentTrack });
            },
            (match) => {
              // Tag with libraryStatus before streaming so the renderer can
              // place the row in the correct bucket as it arrives.
              const meta = phase2Meta.get(match.trackInput.key);
              if (meta) {
                match.libraryStatus = meta.status;
                match.libraryMatchPath = meta.matchPath;
                match.libraryMatchConfidence = meta.matchConfidence;
                if (meta.status === 'probable') match.inLibrary = true; // legacy field
                if (meta.free) match.free = meta.free.free;
              }
              safeSend(event.sender, 'library-sourcing:phase2-match', match);
            },
            (key, candidates) => candidatesByKey.set(key, candidates)
          )
        : [];

      // Post-pass: make sure every match has libraryStatus tagged (the stream
      // callback only runs during search; this catches anything that
      // short-circuited).
      for (const m of plainMatches) {
        const meta = phase2Meta.get(m.trackInput.key);
        if (meta && !m.libraryStatus) {
          m.libraryStatus = meta.status;
          m.libraryMatchPath = meta.matchPath;
          m.libraryMatchConfidence = meta.matchConfidence;
          if (meta.status === 'probable') m.inLibrary = true;
        }
        if (meta?.free) m.free = meta.free.free;
      }

      // ---------- Phase 3: Claude picks the records ----------
      const { matches: storeMatches, finder } = await findMatchesWithClaude(plainMatches, candidatesByKey, config, (p) =>
        safeSend(event.sender, 'library-sourcing:finder-progress', p));

      // Tracks that didn't match anywhere (both no library match *and* no
      // store match). The renderer still surfaces these so the user sees
      // what fully slipped through.
      const notFound = storeMatches
        .filter(m => m.status !== 'matched')
        .map(m => m.trackInput);

      const result: import('./types').LibrarySourcingResult = {
        matched: matchedRows,
        probable: probableRows,
        storeMatches,
        notFound,
        finder,
      };

      return { success: true, result };
    } catch (error) {
      mainLog.error('IPC library-sourcing:run failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Sourcing failed' };
    }
  }
);

// ---------- Saved playlists ("Your playlists" on Find and buy) ----------
//
// Each playlist, SoundCloud set or CSV that's checked is kept in candybar.db
// with its last counts, so it can be checked again in one click. The renderer
// saves after a successful library-sourcing:run (it owns the to-buy / maybe /
// owned / not-for-sale split); list marks a CSV whose file has gone.
handleIpc('saved-sources:list', async () => {
  try {
    const sources = listSavedSources().map(s =>
      s.kind === 'csv' ? { ...s, missing: !fs.existsSync(s.ref) } : s);
    return { success: true, sources };
  } catch (error) {
    mainLog.error('IPC saved-sources:list failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Could not read your saved playlists' };
  }
});

handleIpc('saved-sources:save', async (_event, input: import('./types').SavedSourceInput, opts?: { keepExisting?: boolean }) => {
  try {
    if (!input || typeof input !== 'object') throw new Error('Nothing to save.');
    const source = saveSavedSource(input, { keepExisting: opts?.keepExisting === true });
    return { success: true, source: source.kind === 'csv' ? { ...source, missing: !fs.existsSync(source.ref) } : source };
  } catch (error) {
    mainLog.error('IPC saved-sources:save failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Could not save this playlist' };
  }
});

handleIpc('saved-sources:update', async (_event, { id, name }: { id: number; name?: string | null }) => {
  try {
    if (typeof id !== 'number') throw new Error('Which saved playlist?');
    const source = renameSavedSource(id, typeof name === 'string' ? name : null);
    if (!source) return { success: false, error: 'That playlist is no longer saved.' };
    return { success: true, source: source.kind === 'csv' ? { ...source, missing: !fs.existsSync(source.ref) } : source };
  } catch (error) {
    mainLog.error('IPC saved-sources:update failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Could not rename this playlist' };
  }
});

handleIpc('saved-sources:remove', async (_event, { id }: { id: number }) => {
  try {
    if (typeof id !== 'number') throw new Error('Which saved playlist?');
    return { success: removeSavedSource(id) };
  } catch (error) {
    mainLog.error('IPC saved-sources:remove failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Could not remove this playlist' };
  }
});

// ---------- Lossless upgrades: Rekordbox playlist → lossless store copies ----------
//
// Reads a playlist from the live Rekordbox collection, finds the entries held
// as MP3/AAC or only as a streaming link, and searches Qobuz + Beatport for a
// lossless copy of each. An entry whose exact version is already in the
// collection as a lossless file is reported for relinking instead of searched.
// Progress streams on `lossless-upgrade:progress`, apart from the Sources
// channels so the two tabs never drive each other's progress UI.
handleIpc('lossless-upgrade:list-playlists', async () => {
  try {
    return { success: true, playlists: await listRekordboxPlaylists() };
  } catch (error) {
    mainLog.error('IPC lossless-upgrade:list-playlists failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Could not read Rekordbox playlists' };
  }
});

handleIpc('lossless-upgrade:run', async (event, { playlistId }: { playlistId: string }) => {
  const send = (p: import('./types').LosslessUpgradeProgress) => safeSend(event.sender, 'lossless-upgrade:progress', p);
  try {
    send({ phase: 'reading', current: 0, total: 0, message: 'Reading the playlist from Rekordbox…' });
    const { playlist, tracks, collection } = await readRekordboxPlaylist(playlistId);
    // A playlist can hold the same entry twice; one row per entry keeps
    // selection and cart-add from doubling up.
    const seen = new Set<string>();
    const rows = tracks
      .filter(t => {
        if (seen.has(t.rbId)) return false;
        seen.add(t.rbId);
        return true;
      })
      .map(toUpgradeRow);

    // Spotify streaming entries carry encrypted titles; read them back from Spotify.
    const toResolve = rows.flatMap(r => {
      const id = spotifyIdToResolve(r);
      return id ? [{ row: r, id }] : [];
    });
    if (toResolve.length > 0) {
      const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
      if (!config.spotifyClientId || !config.spotifyClientSecret) {
        for (const { row } of toResolve) row.note = 'Add Spotify credentials in Settings to read streaming titles';
      } else {
        send({ phase: 'resolving', current: 0, total: toResolve.length, message: `Reading ${toResolve.length} Spotify streaming titles…` });
        try {
          const found = await getSpotifyTracksByIds(
            [...new Set(toResolve.map(x => x.id))],
            { clientId: config.spotifyClientId, clientSecret: config.spotifyClientSecret }
          );
          for (const { row, id } of toResolve) {
            const t = found.get(id);
            if (t) applySpotifyTrack(row, t);
            else row.note = 'Spotify no longer has this track';
          }
        } catch (err) {
          // The file-backed rows are still worth searching; only these go unread.
          mainLog.warn('lossless-upgrade: Spotify lookup failed:', err);
          for (const { row } of toResolve) row.note = `Couldn't read the title from Spotify (${err instanceof Error ? err.message : String(err)})`;
        }
      }
    }

    const index = buildLosslessIndex(collection);
    for (const r of rows) {
      if (r.format === 'lossy' || r.format === 'streaming') r.losslessCopy = findLosslessCopy(r, index);
    }

    // Ben's order: a SoundCloud free download first, then Bandcamp, and only
    // then the stores. A free Bandcamp copy (no email) is full quality at the
    // source, so its row skips the store search; a SoundCloud file may turn
    // out compressed, so those rows keep a store match to fall back on.
    let toSearch = rows.filter(needsStoreSearch);
    if (toSearch.length > 0) {
      send({ phase: 'free', current: 0, total: toSearch.length, message: '' });
      try {
        const free = await searchFreeSources(
          toSearch.map(r => ({ key: `rb:${r.rbId}`, artist: r.artist, title: r.title, duration: r.duration })),
          (current, total, label) => send({ phase: 'free', current, total, message: label })
        );
        for (const r of toSearch) r.free = free.found.get(`rb:${r.rbId}`);
        toSearch = toSearch.filter(r => free.needStores.has(`rb:${r.rbId}`));
        await saveFreeFetchRows(playlistId, free.fetchRows);
      } catch (err) {
        // The stores are still worth searching; the rows say why there's no free copy.
        mainLog.warn('lossless-upgrade: free search failed:', err);
        const message = `Couldn't search SoundCloud and Bandcamp (${err instanceof Error ? err.message : String(err)})`;
        for (const r of toSearch) r.free = { soundcloud: null, bandcamp: null, errors: [message] };
      }
    }
    const byKey = new Map(toSearch.map(r => [`rb:${r.rbId}`, r]));
    if (toSearch.length > 0) {
      send({ phase: 'searching', current: 0, total: toSearch.length, message: 'Preparing store search…' });
      const storeMatches = await batchSearchQobuz(
        toSearch.map(r => ({ key: `rb:${r.rbId}`, artist: r.artist, title: r.title, album: r.album || undefined, duration: r.duration })),
        (current, total, currentTrack) => send({ phase: 'searching', current, total, message: currentTrack })
      );
      for (const m of storeMatches) {
        const row = byKey.get(m.trackInput.key);
        if (row) row.match = m;
      }
    }

    const result: import('./types').LosslessUpgradeResult = { playlist: { ...playlist, count: rows.length }, rows };
    return { success: true, result };
  } catch (error) {
    mainLog.error('IPC lossless-upgrade:run failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Lossless upgrade search failed' };
  }
});

// ---------- Free downloads for an upgrade check (SoundCloud, then Bandcamp) ----------
//
// The last check's download rows stay in main (and on disk, so a restart
// keeps them): the renderer only names the Rekordbox entries, never a link.
// bin/source-soundcloud-likes.mjs --tracks walks each entry's sources in
// order until one lands a full-quality file; compressed files are deleted on
// arrival. Each result comes back under its Rekordbox id for the swap step.
const freeFetchRowsPath = () => path.join(app.getPath('userData'), 'upgrade-free-rows.json');
let freeFetchRows: { playlistId: string; rows: FreeFetchRow[] } | null = null;
let freeFetchAbort: AbortController | null = null;

async function saveFreeFetchRows(playlistId: string, rows: FreeFetchRow[]): Promise<void> {
  freeFetchRows = { playlistId, rows };
  await fs.promises.writeFile(freeFetchRowsPath(), JSON.stringify(freeFetchRows)).catch(err =>
    mainLog.warn('lossless-upgrade: could not save the free download list:', err));
}

async function loadFreeFetchRows(): Promise<FreeFetchRow[]> {
  if (!freeFetchRows) {
    try {
      freeFetchRows = JSON.parse(await fs.promises.readFile(freeFetchRowsPath(), 'utf8'));
    } catch {
      return [];
    }
  }
  return freeFetchRows?.rows ?? [];
}

handleIpc('lossless-upgrade:fetch-free', async (event, { rbIds, accountActions }: { rbIds: string[]; accountActions?: boolean }) => trackOp('Getting free downloads', async () => {
  const send = (message: string) => safeSend(event.sender, 'lossless-upgrade:progress', { phase: 'fetching', current: 0, total: 0, message });
  try {
    if (!Array.isArray(rbIds) || rbIds.length === 0) return { success: false, error: 'Tick at least one free download first.' };
    if (freeFetchAbort) return { success: false, error: 'Free downloads are already running.' };
    const keys = new Set(rbIds.map(id => `rb:${String(id)}`));
    const rows = (await loadFreeFetchRows()).filter(r => keys.has(r.upgradeKey));
    if (rows.length === 0) return { success: false, error: 'Check the playlist again, then get the free downloads.' };

    const listPath = path.join(app.getPath('userData'), 'upgrade-free', `tracks-${Date.now()}.json`);
    writeFetchList(listPath, `Upgrade: ${rbIds.length} track${rbIds.length === 1 ? '' : 's'}`, rows);
    freeFetchAbort = new AbortController();
    send('Starting the downloads…');
    const sessionPath = await runFreeFetch({
      appRoot: app.getAppPath(),
      listPath,
      accountActions: accountActions === true,
      signal: freeFetchAbort.signal,
      onLine: send,
    });
    const byKey = await readUpgradeOutcomes(sessionPath);
    const outcomes: Record<string, import('./lib/freeSources').FreeUpgradeOutcome> = {};
    for (const [key, o] of Object.entries(byKey)) {
      if (keys.has(key)) outcomes[key.slice(3)] = o;
    }
    return { success: true, outcomes };
  } catch (error) {
    mainLog.error('IPC lossless-upgrade:fetch-free failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'The free downloads stopped' };
  } finally {
    freeFetchAbort = null;
  }
}));

handleIpc('lossless-upgrade:fetch-free-stop', () => {
  freeFetchAbort?.abort();
});

// Gate walks run in their own process group; don't leave one behind.
app.on('will-quit', () => freeFetchAbort?.abort());

// ---------- Free downloads for Find & buy (a SoundCloud set's own) ----------
//
// A set's tracks with SoundCloud's download button or a free gate keep their
// downloader rows here, by track key, as the upgrade rows above do; several
// sets can be on the page at once, so rows from each check are added to the
// last ones rather than replacing them. Same downloader, same rules (one run
// at a time across both tabs, compressed files deleted on arrival).
const sourcingFreeRowsPath = () => path.join(app.getPath('userData'), 'sourcing-free-rows.json');
/** The newest rows kept; older checks' rows go first. */
const SOURCING_FREE_ROWS_MAX = 2000;
let sourcingFreeRows: Map<string, FreeFetchRow> | null = null;

async function loadSourcingFreeRows(): Promise<Map<string, FreeFetchRow>> {
  if (!sourcingFreeRows) {
    try {
      const rows = JSON.parse(await fs.promises.readFile(sourcingFreeRowsPath(), 'utf8')) as FreeFetchRow[];
      sourcingFreeRows = new Map(rows.map(r => [r.upgradeKey, r]));
    } catch {
      sourcingFreeRows = new Map();
    }
  }
  return sourcingFreeRows;
}

async function saveSourcingFreeRows(rows: FreeFetchRow[]): Promise<void> {
  const all = await loadSourcingFreeRows();
  for (const r of rows) {
    all.delete(r.upgradeKey); // re-insert as newest
    all.set(r.upgradeKey, r);
  }
  while (all.size > SOURCING_FREE_ROWS_MAX) all.delete(all.keys().next().value as string);
  await fs.promises.writeFile(sourcingFreeRowsPath(), JSON.stringify([...all.values()])).catch(err =>
    mainLog.warn('library-sourcing: could not save the free download list:', err));
}

handleIpc('library-sourcing:fetch-free', async (event, { keys, accountActions }: { keys: string[]; accountActions?: boolean }) => trackOp('Getting free downloads', async () => {
  const send = (message: string) => safeSend(event.sender, 'library-sourcing:free-progress', { message });
  try {
    if (!Array.isArray(keys) || keys.length === 0) return { success: false, error: 'Tick at least one free download first.' };
    if (freeFetchAbort) return { success: false, error: 'Free downloads are already running.' };
    const wanted = new Set(keys.map(String));
    const all = await loadSourcingFreeRows();
    const rows = [...wanted].flatMap(k => (all.has(k) ? [all.get(k)!] : []));
    if (rows.length === 0) return { success: false, error: 'Check the set again, then get the free downloads.' };

    const listPath = path.join(app.getPath('userData'), 'sourcing-free', `tracks-${Date.now()}.json`);
    writeFetchList(listPath, `Find & buy: ${rows.length} free download${rows.length === 1 ? '' : 's'}`, rows);
    freeFetchAbort = new AbortController();
    send('Starting the downloads…');
    const sessionPath = await runFreeFetch({
      appRoot: app.getAppPath(),
      listPath,
      accountActions: accountActions === true,
      signal: freeFetchAbort.signal,
      onLine: send,
    });
    const byKey = await readUpgradeOutcomes(sessionPath);
    const outcomes = Object.fromEntries(Object.entries(byKey).filter(([key]) => wanted.has(key)));
    return { success: true, outcomes };
  } catch (error) {
    mainLog.error('IPC library-sourcing:fetch-free failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'The free downloads stopped' };
  } finally {
    freeFetchAbort = null;
  }
}));

handleIpc('library-sourcing:fetch-free-stop', () => {
  freeFetchAbort?.abort();
});

// ---------- Lossless swap: a downloaded lossless file replaces the entry's file ----------
//
// The step after "Download purchases": the same Rekordbox entry (same row, so
// cues, Date Added, play count and playlists stay) is pointed at the lossless
// file. Plan is read-only; apply runs main's cached plan for the given ids,
// never paths from the renderer. The work is in lib/rekordboxUpgradeSwap.ts.
async function upgradeSwapDeps(sender: Electron.WebContents): Promise<import('./lib/rekordboxUpgradeSwap').SwapDeps> {
  const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
  const libraryRoot = config.libraryRoot || DEFAULT_LIBRARY_ROOT;
  return {
    appRoot: app.getAppPath(),
    libraryRoot,
    archiveRoot: config.archivePath || getDefaultArchivePath(libraryRoot),
    backupDir: resolveRekordboxBackupDir(config),
    onProgress: (p) => safeSend(sender, 'upgrade-swap:progress', p),
  };
}

handleIpc('upgrade-swap:preflight', async (event): Promise<import('./types').UpgradeSwapPreflight> => {
  const deps = await upgradeSwapDeps(event.sender);
  return preflightUpgradeSwap(deps);
});

handleIpc('upgrade-swap:plan', async (event, { inputs }: { inputs: import('./types').UpgradeSwapInput[] }) => trackOp('Checking lossless swaps', async () => {
  try {
    if (!Array.isArray(inputs)) return { success: false, error: 'Nothing to plan' };
    return { success: true, items: await planUpgradeSwap(inputs, await upgradeSwapDeps(event.sender)) };
  } catch (error) {
    mainLog.error('IPC upgrade-swap:plan failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Could not plan the swap' };
  }
}));

handleIpc('upgrade-swap:apply', async (event, { rbIds }: { rbIds: string[] }) => trackOp('Swapping in lossless files', async () => {
  try {
    if (!Array.isArray(rbIds) || rbIds.length === 0) return { success: false, error: 'Nothing to swap' };
    const result = await applyUpgradeSwap(rbIds.map(String), await upgradeSwapDeps(event.sender));
    // Rekordbox's file paths changed: the "never trash what Rekordbox points
    // at" guard must re-read them.
    rekordboxPathCache = null;
    return { success: true, result };
  } catch (error) {
    mainLog.error('IPC upgrade-swap:apply failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'The swap failed' };
  }
}));

// Qobuz cart integration
handleIpc(
  'qobuz-cart-search',
  async (event, { tracks }: { tracks: QobuzCartTrackInput[] }) => {
    try {
      const results = await batchSearchQobuz(tracks, (current, total, currentTrack) => {
        safeSend(event.sender, 'qobuz-cart-search-progress', { current, total, currentTrack });
      });
      return { success: true, matches: results };
    } catch (error) {
      mainLog.error('IPC qobuz-cart-search failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Search failed' };
    }
  }
);

// (qobuz-cart-add and its qobuz-browser-close/-status are gone: they launched a
// fresh Playwright Chromium per call and made you sign in every time. Carts are
// filled through store-cart-add on the account's own session.)

// ========== Store Purchase Handlers ==========

handleIpc('store-login', async (_event, { store }: { store: 'qobuz' | 'beatport' }) => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    const accounts = store === 'qobuz' ? config.qobuzAccounts : config.beatportAccounts;
    if (accounts.length === 0) {
      return { success: false, error: `No ${store} accounts configured` };
    }
    const perAccount: Record<string, boolean> = {};
    for (const account of accounts) {
      perAccount[account.id] = store === 'qobuz'
        ? await loginQobuz(account.id)
        : await loginBeatport(account.id);
    }
    const success = Object.values(perAccount).some(Boolean);
    return { success, perAccount };
  } catch (error) {
    mainLog.error('IPC store-login failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Login failed' };
  }
});

/** Which store accounts are signed in, per account and per store. */
async function storeLoginStatuses() {
  const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
  const qobuzStatuses: Record<string, boolean> = {};
  for (const a of config.qobuzAccounts) qobuzStatuses[a.id] = await isQobuzLoggedIn(a.id);
  const beatportStatuses: Record<string, boolean> = {};
  for (const a of config.beatportAccounts) beatportStatuses[a.id] = await isBeatportLoggedIn(a.id);
  const qobuz = Object.values(qobuzStatuses).some(Boolean);
  const beatport = Object.values(beatportStatuses).some(Boolean);
  return { qobuz, beatport, qobuzAccounts: qobuzStatuses, beatportAccounts: beatportStatuses };
}

handleIpc('store-login-status', async () => {
  try {
    return await storeLoginStatuses();
  } catch (error) {
    mainLog.error('IPC store-login-status failed:', error);
    return { qobuz: false, beatport: false, qobuzAccounts: {}, beatportAccounts: {} };
  }
});

handleIpc(
  'store-login-account',
  async (_event, { store, account }: { store: 'qobuz' | 'beatport'; account: StoreAccount }) => {
    try {
      // Persist the account metadata first so the session partition has a stable id.
      await mutateConfig((config) => {
        const key = store === 'qobuz' ? 'qobuzAccounts' : 'beatportAccounts';
        const list = [...config[key]];
        const idx = list.findIndex(a => a.id === account.id);
        if (idx >= 0) list[idx] = account;
        else list.push(account);
        return { ...config, [key]: list };
      });

      // Unified browser-based connect: short-circuits silently if the session
      // is still valid, otherwise opens the store's login page so the user can
      // authenticate however they want (password, Google, Apple, 2FA, captcha).
      const ok = store === 'qobuz' ? await loginQobuz(account.id) : await loginBeatport(account.id);
      if (!ok) return { success: false, error: 'Login window closed before sign-in completed' };
      return { success: true };
    } catch (error) {
      mainLog.error('IPC store-login-account failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Login failed' };
    }
  }
);

handleIpc(
  'store-logout-account',
  async (_event, { store, accountId }: { store: 'qobuz' | 'beatport'; accountId: string }) => {
    try {
      if (store === 'qobuz') await logoutQobuz(accountId);
      else await logoutBeatport(accountId);
      return { success: true };
    } catch (error) {
      mainLog.error('IPC store-logout-account failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Logout failed' };
    }
  }
);

// (The probe-* handlers and the sniff-* / open-qobuz-login-window windows are
// gone: they replayed store APIs and captured auth headers to reverse-engineer
// them. Accounts connect through store-login-account; carts and downloads run
// on the account's own session.)

handleIpc('download-beatport-matches', async (event, { matches, destDir }: { matches: StoreMatch[]; destDir: string }) => trackOp('Downloading Beatport purchases', async () => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    // Log in every account — each match may come from a different one (via sourceAccountId).
    for (const a of config.beatportAccounts) await loginBeatport(a.id);
    const defaultId = config.beatportAccounts[0]?.id ?? LEGACY_ACCOUNT_ID;
    const result = await downloadBeatportPurchases(defaultId, matches, destDir, (p) => {
      safeSend(event.sender, 'download-beatport-progress', p);
    });
    return { success: true, ...result };
  } catch (error) {
    mainLog.error('IPC download-beatport-matches failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Download failed' };
  }
}));

handleIpc('download-qobuz-matches-concurrent', async (event, { matches, destDir, concurrency }: { matches: StoreMatch[]; destDir: string; concurrency: number }) => trackOp('Downloading Qobuz purchases', async () => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    for (const a of config.qobuzAccounts) await loginQobuz(a.id);
    const defaultId = config.qobuzAccounts[0]?.id ?? LEGACY_ACCOUNT_ID;
    const { downloadQobuzPurchases } = await import('./lib/storePurchase');
    const result = await downloadQobuzPurchases(defaultId, matches, destDir, (p) => {
      safeSend(event.sender, 'download-qobuz-progress', p);
    }, concurrency);
    return { success: true, ...result };
  } catch (error) {
    mainLog.error('IPC download-qobuz-matches-concurrent failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Download failed' };
  }
}));

handleIpc('download-beatport-matches-concurrent', async (event, { matches, destDir, concurrency }: { matches: StoreMatch[]; destDir: string; concurrency: number }) => trackOp('Downloading Beatport purchases', async () => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    for (const a of config.beatportAccounts) await loginBeatport(a.id);
    const defaultId = config.beatportAccounts[0]?.id ?? LEGACY_ACCOUNT_ID;
    const result = await downloadBeatportPurchases(defaultId, matches, destDir, (p) => {
      safeSend(event.sender, 'download-beatport-progress', p);
    }, concurrency);
    return { success: true, ...result };
  } catch (error) {
    mainLog.error('IPC download-beatport-matches-concurrent failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Download failed' };
  }
}));

/** Every purchase on every account of one store. An account that couldn't be
 *  read is named in `errors`: it isn't an account that owns nothing. */
async function readStorePurchases(source: 'qobuz' | 'beatport') {
  const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
  const accounts = source === 'beatport' ? config.beatportAccounts : config.qobuzAccounts;
  const owned = source === 'beatport'
    ? await fetchAllBeatportPurchases(accounts)
    : await fetchAllQobuzPurchases(accounts);
  const errors = owned.errors ?? [];
  for (const e of errors) mainLog.warn(`purchases (${source}): ${e}`);
  return { accounts: accounts.length, owned: [...owned], errors };
}

handleIpc('fetch-store-purchases', async (_event, { source }: { source: 'qobuz' | 'beatport' }) => {
  try {
    const { owned, errors } = await readStorePurchases(source);
    const outPath = await writeScratchFile(`owned_${source}.json`, JSON.stringify([...owned], null, 2));
    mainLog.info(`Wrote ${owned.length} ${source} purchases to ${outPath}`);
    return { success: true, owned: [...owned], errors, complete: errors.length === 0, outPath, count: owned.length };
  } catch (error) {
    mainLog.error(`IPC fetch-store-purchases (${source}) failed:`, error);
    return { success: false, error: error instanceof Error ? error.message : 'Fetch failed' };
  }
});

// (store-search / store-search-all and the store-search-results.json they saved
// — store-load-results / store-clear-results — are gone: Sources searches through
// library-sourcing:run, which checks ownership against Rekordbox first.)

handleIpc('store-cart-add', async (event, { matches, source }: { matches: StoreMatch[]; source: 'qobuz' | 'beatport' }) => {
  return addMatchesToCart(source, matches, (p) => safeSend(event.sender, 'store-cart-progress', p));
});

/** Add matches to the first account's cart. The app's UI and the store
 *  bridge both come through here, so the lossless rule holds for both. */
async function addMatchesToCart(
  source: 'qobuz' | 'beatport',
  matches: StoreMatch[],
  onProgress: (p: import('./types').StoreCartProgress) => void
): Promise<{ success: true; result: import('./types').StoreCartResult } | { success: false; error: string }> {
  try {
    // Lossless only. Anything not positively marked lossless — lossy, unknown,
    // or a caller that didn't say — is excluded here, for both stores, and
    // reported back as a failure so the UI can say why it wasn't added.
    const excluded = (matches ?? []).filter(m => m?.lossless !== true)
      .map(match => ({ match, error: 'Excluded: not a lossless match (lossless only)' }));
    if (excluded.length) mainLog.warn(`store-cart-add[${source}]: excluded ${excluded.length} match(es) not marked lossless`);
    matches = (matches ?? []).filter(m => m?.lossless === true);
    if (matches.length === 0) {
      return { success: true, result: { added: [], failed: excluded, totalCost: '$0.00' } };
    }

    // Re-authenticate before adding to cart (session may have expired since search).
    // Cart add always uses the first configured account — the user can't have
    // multiple carts open at once anyway.
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    const account = source === 'qobuz' ? config.qobuzAccounts[0] : config.beatportAccounts[0];
    if (!account) {
      return { success: false, error: `No ${source === 'qobuz' ? 'Qobuz' : 'Beatport'} account in Track Lab yet. Sign in from Settings → ${source === 'qobuz' ? 'Qobuz' : 'Beatport'}, then try again.` };
    }
    if (source === 'qobuz') {
      // Without a signed-in session every add would fail one by one; stop here.
      if (!(await loginQobuz(account.id))) {
        return { success: false, error: 'Not signed in to Qobuz — the sign-in window was closed before sign-in finished. Connect Qobuz in Settings, then try again.' };
      }
    } else {
      await loginBeatport(account.id);
      // Try to refresh the Bearer token from the persisted cookies. If the
      // refresh succeeds it overwrites the cache (so stale tokens get replaced
      // automatically). If it fails but we already have a cached token — the
      // same one that just powered the search for these matches — fall back
      // to it rather than throwing away a working session.
      const refreshed = await refreshBeatportTokenFromSession(account.id);
      if (!refreshed && !getBeatportAccessToken(account.id)) {
        return { success: false, error: 'Beatport session token not found. Open the Beatport cart once to complete login, then retry.' };
      }
    }

    const result = source === 'qobuz'
      ? await addToQobuzCart(account.id, matches, onProgress)
      : await addToBeatportCart(account.id, matches, onProgress);
    return { success: true, result: { ...result, failed: [...excluded, ...result.failed] } };
  } catch (error) {
    mainLog.error('store cart add failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Cart add failed' };
  }
}

handleIpc('store-open-cart', async (_event, { store }: { store: 'qobuz' | 'beatport' }) => {
  // Open cart in embedded panel instead of separate window
  await openStorePanel(store, cartUrl(store));
  return { success: true };
});

// Which of the tracks Track Lab added are still in the store's real cart, on
// the account cart adds use. Read-only, and never opens a sign-in window: a
// store it can't read comes back unknown, never empty.
handleIpc('store-cart-check', async (_event, { store, items }: { store: 'qobuz' | 'beatport'; items: Array<{ trackId: string; articleId?: string }> }): Promise<StoreCartCheck> => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    const account = store === 'qobuz' ? config.qobuzAccounts[0] : config.beatportAccounts[0];
    if (!account) return { known: false, reason: `No ${store === 'qobuz' ? 'Qobuz' : 'Beatport'} account in Track Lab` };
    const list = Array.isArray(items) ? items.filter(i => i && typeof i.trackId === 'string') : [];
    return store === 'qobuz'
      ? await checkQobuzCart(account.id, list)
      : await checkBeatportCart(account.id, list.map(i => i.trackId));
  } catch (error) {
    mainLog.warn(`store-cart-check[${store}] failed:`, error);
    return { known: false, reason: error instanceof Error ? error.message : 'Cart check failed' };
  }
});

handleIpc('store-download-purchases', async (event, { matches }: { matches: StoreMatch[] }) => trackOp('Downloading purchases', async () => {
  const res = await downloadPurchasedMatches(matches, (p) => safeSend(event.sender, 'store-download-progress', p));
  return res.success ? { ...res, downloaded: res.downloaded.length } : res;
}));

/** Download purchased matches into `destDir` (default: the intake folder),
 *  each from the account that bought it. Shared by the UI and the bridge. */
async function downloadPurchasedMatches(
  matches: StoreMatch[],
  onProgress: (p: import('./lib/storePurchase').DownloadProgress) => void,
  destDirOverride?: string
) {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    const destDir = destDirOverride || config.organizeSourceDir;
    if (!destDir) return { success: false as const, error: 'No organize source directory configured' };

    const qobuzTracks = matches.filter(m => m.source === 'qobuz');
    const beatportTracks = matches.filter(m => m.source === 'beatport');

    const allDownloaded: string[] = [];
    // Which file each match became, by its input key (`rb:<id>` on Lossless
    // Upgrades), so the swap step knows which file replaces which entry.
    const allFiles: Array<{ key: string; path: string }> = [];
    const allFailed: Array<{ artist: string; title: string; error: string }> = [];
    // Tracks you deleted earlier: left out on purpose, so they're reported apart from failures.
    const allSkipped: Array<{ trackId: string; artist: string; title: string; reason: string }> = [];

    if (qobuzTracks.length > 0) {
      for (const a of config.qobuzAccounts) await loginQobuz(a.id);
      const defaultQobuzId = config.qobuzAccounts[0]?.id ?? LEGACY_ACCOUNT_ID;
      const result = await downloadQobuzPurchases(defaultQobuzId, qobuzTracks, destDir, onProgress);
      allDownloaded.push(...result.downloaded);
      allFiles.push(...result.files);
      allFailed.push(...result.failed);
      allSkipped.push(...(result.skipped ?? []));
    }

    if (beatportTracks.length > 0) {
      for (const a of config.beatportAccounts) await loginBeatport(a.id);
      const defaultBeatportId = config.beatportAccounts[0]?.id ?? LEGACY_ACCOUNT_ID;
      const result = await downloadBeatportPurchases(defaultBeatportId, beatportTracks, destDir, onProgress);
      allDownloaded.push(...result.downloaded);
      allFiles.push(...result.files);
      allFailed.push(...result.failed);
      allSkipped.push(...(result.skipped ?? []));
    }

    return { success: true as const, downloaded: allDownloaded, files: allFiles, failed: allFailed, skipped: allSkipped, destDir };
  } catch (error) {
    mainLog.error('store download failed:', error);
    return { success: false as const, error: error instanceof Error ? error.message : 'Download failed' };
  }
}

// ========== Store bridge ==========
//
// Claude's MCP tools and the sourcing CLI use these accounts through the
// bridge (src/lib/storeBridge.ts), so there's one sign-in per store account:
// the one in Settings. Each method is the same code the UI runs.

function bridgeStore(value: unknown): 'qobuz' | 'beatport' {
  if (value === 'qobuz' || value === 'beatport') return value;
  throw new Error('store must be "qobuz" or "beatport"');
}

/** A match from outside the app, filled out to what the store code reads. */
function bridgeMatch(raw: unknown): StoreMatch {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Partial<StoreMatch> & Record<string, unknown>;
  const str = (v: unknown) => (v == null ? '' : String(v));
  const source = bridgeStore(m.source);
  const artist = str(m.artist);
  const title = str(m.title);
  return {
    ...m,
    input: { key: str(m.input?.key), artist: str(m.input?.artist) || artist, title: str(m.input?.title) || title },
    trackId: str(m.trackId),
    title, artist,
    album: str(m.album), label: str(m.label), price: str(m.price), quality: str(m.quality), format: str(m.format),
    lossless: m.lossless === true,
    rx3Compatible: m.rx3Compatible !== false,
    confidence: Number(m.confidence) || 0,
    url: str(m.url),
    source,
  };
}

function bridgeMatches(value: unknown): StoreMatch[] {
  if (!Array.isArray(value)) throw new Error('matches must be a list');
  return value.map(bridgeMatch);
}

/** Sign in every account of a store, making the first account the way the
 *  setup guide does when there isn't one yet. */
async function signInToStore(store: 'qobuz' | 'beatport') {
  const key = store === 'qobuz' ? 'qobuzAccounts' : 'beatportAccounts';
  let accounts = (await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH))[key];
  if (accounts.length === 0) {
    const account: StoreAccount = { id: randomUUID(), label: 'Account 1' };
    accounts = (await mutateConfig((c) => ({ ...c, [key]: [...c[key], account] })))[key];
  }
  const result: Array<{ id: string; label: string; signedIn: boolean }> = [];
  for (const a of accounts) {
    const signedIn = store === 'qobuz' ? await loginQobuz(a.id) : await loginBeatport(a.id);
    result.push({ id: a.id, label: a.label || a.email || a.id, signedIn });
  }
  return { signedIn: result.some((a) => a.signedIn), accounts: result };
}

const STORE_BRIDGE_HANDLERS: Record<string, BridgeHandler> = {
  status: async () => {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    const s = await storeLoginStatuses();
    const list = (accounts: StoreAccount[], statuses: Record<string, boolean>) =>
      accounts.map((a) => ({ id: a.id, label: a.label || a.email || a.id, signedIn: !!statuses[a.id] }));
    return { qobuz: list(config.qobuzAccounts, s.qobuzAccounts), beatport: list(config.beatportAccounts, s.beatportAccounts) };
  },
  login: (params) => {
    const store = bridgeStore(params.store);
    return trackOp(`Signing in to ${store === 'qobuz' ? 'Qobuz' : 'Beatport'} for Claude`, () => signInToStore(store));
  },
  purchases: (params) => {
    const store = bridgeStore(params.store);
    return trackOp(`Reading ${store === 'qobuz' ? 'Qobuz' : 'Beatport'} purchases for Claude`, () => readStorePurchases(store));
  },
  download: (params, progress) => trackOp('Downloading purchases for Claude', async () => {
    const destDir = typeof params.destDir === 'string' && params.destDir ? params.destDir : undefined;
    const res = await downloadPurchasedMatches(bridgeMatches(params.matches), (p) => progress(p.message), destDir);
    if (!res.success) throw new Error(res.error);
    return res;
  }),
  cartAdd: async (params, progress) => {
    const res = await addMatchesToCart(bridgeStore(params.store), bridgeMatches(params.matches), (p) => progress(p.message));
    if (!res.success) throw new Error(res.error);
    return res.result;
  },
  /** A catalog search's results with refs, for the Claude finder (search_store_catalog). */
  catalogSearch: (params) => catalogSearch(bridgeStore(params.store), typeof params.query === 'string' ? params.query : ''),
  /** Anything the window can do (ipcOps.ts), for Claude's MCP tools. */
  invoke: async (params, progress, meta) => {
    const channel = typeof params.channel === 'string' ? params.channel : '';
    const windowOnly = windowOnlyReason(channel);
    if (windowOnly) throw new Error(`"${channel}" needs the Track Lab window (${windowOnly})`);
    const args = Array.isArray(params.args) ? params.args : params.args === undefined ? [] : [params.args];
    return ipcOps.invoke(channel, args, {
      send: bridgeProgress(progress),
      source: bridgeSource(meta),
      parent: meta.parentOp,
      meta: meta.tool ? { tool: meta.tool } : undefined,
    });
  },
  /** What's running, where everything lives, and whether the window is open. */
  appStatus: async () => {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    const libraryRoot = config.libraryRoot || DEFAULT_LIBRARY_ROOT;
    return {
      version: app.getVersion(),
      pid: process.pid,
      startedAt: APP_STARTED_AT,
      uptimeSec: Math.round(process.uptime()),
      windowOpen: !!getMainWindow(),
      runningWork: describeRunningWork(),
      jobs: runningQueueJobs(),
      actions: ipcOps.channels().length,
      paths: {
        userData: app.getPath('userData'),
        config: CONFIG_PATH,
        libraryRoot,
        organizeSourceDir: config.organizeSourceDir || null,
        archive: config.archivePath || getDefaultArchivePath(libraryRoot),
        logs: LOGS_DIR,
        operations: getOpLogDir(),
        writeJournal: getWriteJournalDir(),
      },
    };
  },
};

const APP_STARTED_AT = new Date().toISOString();

function bridgeSource(meta: BridgeMeta): OpSource {
  return meta.client === 'mcp' ? 'claude' : 'cli';
}

/** What a handler sends the window, as progress lines for the bridge client:
 *  every log-panel line, other messages at most once a second per channel. */
function bridgeProgress(progress: (message: string) => void): (channel: string, payload: unknown) => void {
  const last = new Map<string, number>();
  return (channel, payload) => {
    if (channel === 'script-output') {
      const text = (payload as { text?: unknown } | null)?.text;
      if (text) progress(String(text).trimEnd());
      return;
    }
    const now = Date.now();
    if (now - (last.get(channel) ?? 0) < 1000) return;
    last.set(channel, now);
    const p = (payload ?? {}) as { message?: unknown; currentTrack?: unknown; current?: unknown; total?: unknown };
    const text = typeof payload === 'string' ? payload
      : p.message ?? p.currentTrack ?? (p.current != null && p.total != null ? `${p.current}/${p.total}` : null);
    progress(text ? `${channel}: ${String(text)}` : channel);
  };
}

/** Every bridge request is an operation; `invoke` records the action itself. */
function loggedBridgeHandlers(handlers: Record<string, BridgeHandler>): Record<string, BridgeHandler> {
  return Object.fromEntries(Object.entries(handlers).map(([method, fn]): [string, BridgeHandler] => [
    method,
    method === 'invoke' ? fn : (params, progress, meta) => withOp(
      `bridge:${method}`,
      { source: bridgeSource(meta), args: params, parent: meta.parentOp, meta: meta.tool ? { tool: meta.tool } : undefined },
      (op) => fn(params, (message) => { op.progress('bridge', message); progress(message); }, meta),
      { quiet: method === 'status' || method === 'appStatus' }
    ),
  ]));
}

let stopStoreBridge: (() => Promise<void>) | null = null;

// Track scanning and organization handlers
handleIpc('scan-tracks', async (event, { sourceDir }: { sourceDir: string }): Promise<TrackInfo[]> => trackOp('Scanning tracks to organize', async () => {
  try {
    // Scanning flattens sub-folders into the intake folder; the restore staging
    // folder (inside it by default) holds a restore's in-progress files and must
    // be left where it is.
    const libraryRoot = await getLibraryRoot();
    return await scanTracks(sourceDir, (payload) => {
      safeSend(event.sender, 'scan-progress', payload);
    }, { protectedDirs: [getDefaultRestoreStageDir(libraryRoot)] });
  } catch (error) {
    mainLog.error('IPC scan-tracks failed:', error);
    throw error;
  }
}));

handleIpc('scan-missing-album-art', async (event) => {
  try {
    const libraryRoot = await getLibraryRoot();

      const jm = getJobManager();
    const { jobId, promise } = jm.enqueue('album-art-scan', {
      libraryRoot,
      contextKey: libraryRoot
    }, libraryRoot);

    const result = await promise;
    return { id: jobId, tracks: result };
  } catch (error) {
    mainLog.error('IPC scan-missing-album-art failed:', error);
    throw error;
  }
});

handleIpc('get-track-info', async (_event, { filePath }: { filePath: string }): Promise<TrackInfo | null> => {
  try {
    const mm = await import('music-metadata');
    const meta = await mm.parseFile(filePath, { duration: false });
    const common = meta.common as unknown as Record<string, unknown>;
    const ext = path.extname(filePath).toLowerCase();
    const artist = meta.common.artist || meta.common.artists?.[0] || '';
    const pictures = meta.common.picture;
    let albumArt: string | null = null;
    if (pictures && pictures.length > 0) {
      const p = pictures[0];
      albumArt = `data:${p.format};base64,${Buffer.from(p.data).toString('base64')}`;
    }
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      filePath,
      fileName: path.basename(filePath),
      title: meta.common.title || path.basename(filePath, ext),
      artist,
      album: meta.common.album || '',
      year: meta.common.year ? String(meta.common.year) : '',
      genre: meta.common.genre?.[0] || '',
      label: meta.common.label?.[0] || '',
      ...readDjTags(meta),
      comment: (() => { const c = meta.common.comment?.[0]; return typeof c === 'string' ? c : c?.text || ''; })(),
      albumArt,
      hasArtist: !!artist,
      ignored: false,
      status: 'pending'
    };
  } catch (error) {
    mainLog.warn('IPC get-track-info failed:', filePath, error);
    return null;
  }
});

handleIpc('update-track-tags', async (event, params: UpdateTagsParams): Promise<TrackInfo> => trackOp('Writing tags', async () => {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const log = createLogger(event.sender, runId);
  try {
    // Autopopulate converts WAV/FLAC → AIFF in place (original deleted). The
    // Tag Editor / other UI can hold a stale .wav path from before the
    // conversion. If the original path is gone, look for a same-basename
    // sibling with a supported extension and retarget the write at it.
    const resolvedPath = await resolveRenamedTrackPath(params.filePath);
    const effectiveParams = resolvedPath === params.filePath
      ? params
      : { ...params, filePath: resolvedPath };
    if (resolvedPath !== params.filePath) {
      log(`Retargeting tag write: ${path.basename(params.filePath)} → ${path.basename(resolvedPath)}\n`);
    }
    log(`Updating tags: ${path.basename(effectiveParams.filePath)}\n`);
    const result = await updateTags(effectiveParams);
    log(`Tags updated: ${path.basename(effectiveParams.filePath)}\n`, 'status');
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log(`Tag update failed for ${path.basename(params.filePath)}: ${message}\n`, 'stderr');
    mainLog.error('IPC update-track-tags failed:', error);
    throw error;
  }
}));

// If `filePath` is gone, scan the parent dir for a same-basename sibling with
// a supported audio extension and return that. Used to ride through in-place
// WAV/FLAC→AIFF conversions that happen after the UI captured the old path.
async function resolveRenamedTrackPath(filePath: string): Promise<string> {
  if (fs.existsSync(filePath)) return filePath;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);
  const candidates = ['.aiff', '.aif', '.wav', '.flac', '.m4a', '.mp3'].filter(c => c !== ext.toLowerCase());
  for (const candidateExt of candidates) {
    const candidate = path.join(dir, `${baseName}${candidateExt}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return filePath;
}

handleIpc('diagnose-aiff-header', async (_event, filePath: string): Promise<AiffHeaderDiagnosis> => {
  try {
    return await diagnoseAiffHeader(filePath);
  } catch (error) {
    mainLog.error('IPC diagnose-aiff-header failed:', error);
    throw error;
  }
});

handleIpc('repair-aiff-header', async (_event, filePath: string): Promise<boolean> => {
  try {
    return await repairAiffHeader(filePath);
  } catch (error) {
    mainLog.error('IPC repair-aiff-header failed:', error);
    throw error;
  }
});

handleIpc('select-image', async (): Promise<string | null> => {
  try {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return getAlbumArtFromFile(result.filePaths[0]);
  } catch (error) {
    mainLog.error('IPC select-image failed:', error);
    throw error;
  }
});

handleIpc(
  'organize-tracks',
  async (
    event,
    { tracks }: { tracks: Array<{ filePath: string; ignored: boolean; isHealthy?: boolean }> }
  ): Promise<OrganizeResult[]> => trackOp('Organizing tracks', async () => {
    try {
      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const log = createLogger(event.sender, runId);

      safeSend(event.sender, 'script-output', { id: runId, stream: 'status', text: `--- Organize by Artist ---\n` });

      const results = await organizeTracks({
        tracks,
        rootDir: await getLibraryRoot(),
        log,
        onProgress: (payload) => {
          safeSend(event.sender, 'organize-progress', payload);
        }
      });

      log('Process exited with code 0', 'status');
      return results;
    } catch (error) {
      mainLog.error('IPC organize-tracks failed:', error);
      throw error;
    }
  })
);

// ---------- "Deleted stays deleted" ----------
//
// A file deleted out of the intake folder (organizeSourceDir, tracks_to_organize)
// is recorded as a tombstone so no download, restore or sourcing run fetches it
// again. The tags are read BEFORE the delete, while the file is still there; the
// tombstone also picks up the store/track id if the file came from a purchase.

function isInsideDir(filePath: string, dir: string): boolean {
  if (!dir) return false;
  const rel = path.relative(collectionPathKey(dir), collectionPathKey(filePath));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function intakeTombstone(filePath: string): Promise<{ filePath: string; artist?: string; title?: string } | null> {
  const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
  if (!isInsideDir(filePath, config.organizeSourceDir)) return null;
  let artist: string | undefined;
  let title: string | undefined;
  try {
    const mm = await import('music-metadata');
    const meta = await mm.parseFile(filePath, { duration: false, skipCovers: true });
    artist = meta.common.artist || meta.common.artists?.[0] || undefined;
    title = meta.common.title || undefined;
  } catch { /* unreadable tags: fall back to the file name */ }
  if (!artist || !title) {
    const fromName = extractArtistFromTitle(path.basename(filePath, path.extname(filePath)));
    artist ||= fromName?.artist;
    title ||= fromName?.title ?? path.basename(filePath, path.extname(filePath));
  }
  return { filePath, artist, title };
}

// Resolve organize conflict: keep 'incoming' (replace existing) or 'existing' (discard incoming)
handleIpc(
  'organize-resolve-conflict',
  async (
    _event,
    { incomingPath, existingPath, targetPath, keep }: { incomingPath: string; existingPath: string; targetPath: string; keep: 'incoming' | 'existing' }
  ): Promise<{ success: boolean; error?: string }> => trackOp('Resolving an organize conflict', async () => {
    try {
      if (keep === 'incoming') {
        // Stage incoming beside the target FIRST so a mid-operation failure can
        // never destroy the existing file before its replacement is in place.
        const stagingPath = `${targetPath}.incoming-${Date.now()}`;
        await safeMove(incomingPath, stagingPath, 'organize-conflict:stage');
        try {
          await safeDelete(existingPath, { context: 'organize-conflict:keep-incoming' });
        } catch (deleteError) {
          // The existing file is still there, so put the incoming one back where
          // it came from; stranded under the staging name (not an audio
          // extension) it would vanish from every scan.
          try {
            await safeMove(stagingPath, incomingPath, 'organize-conflict:unstage');
          } catch (restoreError) {
            mainLog.error(`organize-resolve-conflict: couldn't move the staged file back; it is at ${stagingPath}`, restoreError);
            throw new Error(`${deleteError instanceof Error ? deleteError.message : String(deleteError)}. The incoming file couldn't be moved back and is at ${stagingPath}.`);
          }
          throw deleteError;
        }
        await safeMove(stagingPath, targetPath, 'organize-conflict:finalize');
      } else {
        // Keep existing, discard the incoming file (recoverable via Trash). It
        // came out of the intake folder, so it's never fetched again.
        const tombstone = await intakeTombstone(incomingPath);
        await safeDelete(incomingPath, { context: 'organize-conflict:keep-existing' });
        if (tombstone) recordDeletedTrack(tombstone);
      }
      return { success: true };
    } catch (error) {
      mainLog.error('IPC organize-resolve-conflict failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to resolve conflict' };
    }
  })
);

// Extract embedded album art from an audio file
handleIpc('get-track-album-art', async (_event, { filePath }: { filePath: string }): Promise<string | null> => {
  try {
    const mm = await import('music-metadata');
    const metadata = await mm.parseFile(filePath, { duration: false });
    const picture = metadata.common.picture?.[0];
    if (!picture) return null;
    const base64 = Buffer.from(picture.data).toString('base64');
    return `data:${picture.format};base64,${base64}`;
  } catch {
    return null;
  }
});

// DevTools toggle handler
handleIpc('toggle-devtools', (event) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools();
      }
    }
  } catch (error) {
    mainLog.error('IPC toggle-devtools failed:', error);
    throw error;
  }
});

// Open external URL in default browser. Web and mail links only: a file:// or
// custom-scheme URL would launch local apps.
handleIpc('open-external', async (_event, { url }: { url: string }) => {
  if (typeof url !== 'string' || !isAllowedExternalUrl(url)) {
    mainLog.warn(`open-external refused: ${String(url)}`);
    throw new Error('Only http, https and mailto links can be opened.');
  }
  await shell.openExternal(url);
});

// Show file in Finder / file manager
handleIpc('show-in-finder', async (_event, { filePath }: { filePath: string }) => {
  shell.showItemInFolder(filePath);
});

// Track conversion handler
handleIpc(
  'convert-track',
  async (event, { filePath }: { filePath: string }): Promise<ConversionResult> => trackOp('Converting to AIFF', async () => {
    try {
      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const log = createLogger(event.sender, runId);

      log(`Converting to AIFF: ${path.basename(filePath)}`);

      const result = await convertToAiff(filePath, (progress) => {
        if (progress.percent >= 0) {
          log(`Progress: ${progress.percent}%`);
        }
      });

      if (result.success) {
        log(`Converted: ${path.basename(result.outputPath!)}`);
      } else {
        mainLog.error('Track conversion failed:', filePath, result.errorMessage);
        log(result.errorMessage || 'Conversion failed', 'stderr');
      }

      return result;
    } catch (error) {
      mainLog.error('Track conversion failed:', filePath, error);
      throw error;
    }
  })
);

// Library health scan handler with streaming progress and caching
handleIpc(
  'scan-library-health',
  async (event, { useCache = true, cacheOnly = false }: { useCache?: boolean; cacheOnly?: boolean }): Promise<{ id: string; result?: LibraryHealthResult; fromCache: boolean; cacheOnly?: boolean }> => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const libraryRoot = await getLibraryRoot();

    // Serve from SQLite snapshot if the caller accepts cached data
    if (useCache || cacheOnly) {
      const cached = getHealthSnapshot(libraryRoot);
      if (cached) {
        mainLog.debug('scan-library-health: serving SQLite snapshot');
        safeSend(event.sender, 'health-scan-progress', { id: runId, phase: 'complete', current: cached.summary.total, total: cached.summary.total });
        return { id: runId, result: cached, fromCache: true };
      }
    }

    if (cacheOnly) {
      return { id: runId, fromCache: false, cacheOnly: true };
    }

    // Run an incremental scan (mtime-based); results are written to SQLite
    const jm = getJobManager();
    const { jobId, promise } = jm.enqueue<LibraryHealthResult>('library-health', {
      libraryRoot,
      contextKey: libraryRoot
    }, libraryRoot);

    const result = await promise;
    return { id: jobId, result, fromCache: false };
  }
);

// Delete track file handler
handleIpc(
  'delete-track-file',
  async (event, { filePath }: { filePath: string }): Promise<{ success: boolean; trashPath?: string; error?: string }> => trackOp('Deleting a track', async () => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const log = createLogger(event.sender, runId);
    try {
      log(`Deleting: ${path.basename(filePath)}\n`);
      const tombstone = await intakeTombstone(filePath);
      // safeDelete throws if neither the Trash nor ~/.Trash took the file; that
      // surfaces below as a failure, never as a silent success.
      const deleted = await safeDelete(filePath, { context: 'delete-track-file' });
      if (tombstone) recordDeletedTrack(tombstone);
      log(`Moved to Trash: ${path.basename(filePath)}\n`, 'status');
      return { success: true, trashPath: deleted?.trashPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete file';
      log(`Delete failed for ${path.basename(filePath)}: ${message}\n`, 'stderr');
      mainLog.error('IPC delete-track-file failed:', filePath, error);
      return { success: false, error: message };
    }
  })
);

type ConvertIpcResult = ConversionResult & Pick<import('./types').ConversionResult, 'keptOriginalForRekordbox' | 'originalTrashFailed' | 'originalDeleteError'>;

/** Whether a conversion that would produce a NEW file must keep its original
 *  because Rekordbox points at it. Trashing it would orphan the entry and, once
 *  the new file is re-imported, wipe its Date Added, cues and play history (the
 *  Date Added clobber loop). An in-place conversion keeps the path, so the
 *  entry survives and there's nothing to guard. The answer is handed to the
 *  converter as `keepOriginal`. */
async function mustKeepOriginalForRekordbox(filePath: string, deleteOriginal: boolean, inPlace: boolean): Promise<boolean> {
  if (!deleteOriginal || inPlace) return false;
  return isReferencedByRekordbox(filePath);
}

function keptForRekordbox(result: ConversionResult, filePath: string, log: LogFn): ConvertIpcResult {
  log(`Kept original ${path.basename(filePath)}: Rekordbox still points at it. Relocate the entry to ${path.basename(result.outputPath ?? '')} in Rekordbox, then delete the original.\n`, 'status');
  return { ...result, keptOriginalForRekordbox: true };
}

/** After a conversion to a NEW file, move the original to the Trash. A trash
 *  that fails is reported (originalTrashFailed), never swallowed. Not recorded
 *  as a deletion: the track is still there, converted. */
async function trashOriginal(result: ConversionResult, filePath: string, context: string, log: LogFn): Promise<ConvertIpcResult> {
  if (!result.outputPath || path.resolve(result.outputPath) === path.resolve(filePath)) return result;
  try {
    await safeDelete(filePath, { context, detail: { convertedTo: result.outputPath } });
    log(`Moved original to Trash: ${path.basename(filePath)}\n`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    mainLog.warn(`Failed to delete original after ${context}:`, filePath, error);
    log(`Failed to remove original ${path.basename(filePath)}: ${message}\n`, 'stderr');
    // Not a silent success: the original is still there and the UI must say so.
    return { ...result, originalTrashFailed: true, originalDeleteError: message };
  }
}

// Fix track file handler (convert to compatible format)
handleIpc(
  'fix-track-file',
  async (event, { filePath, deleteOriginal }: { filePath: string; deleteOriginal: boolean }): Promise<ConvertIpcResult> => trackOp('Converting to AIFF', async () => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const log = createLogger(event.sender, runId);
    log(`Fixing to AIFF: ${path.basename(filePath)}\n`);

    // convertToAiff replaces an AIFF-family input in place; anything else becomes a new .aif.
    const keepOriginal = await mustKeepOriginalForRekordbox(filePath, deleteOriginal, /\.aiff?$/i.test(filePath));
    const result = await convertToAiff(filePath, (progress) => {
      if (progress.percent >= 0) log(`Progress: ${progress.percent}%\n`);
    }, keepOriginal ? { keepOriginal: true } : undefined);

    if (result.success) {
      log(`Fixed: ${path.basename(result.outputPath!)}\n`, 'status');
      if (keepOriginal) return keptForRekordbox(result, filePath, log);
      if (deleteOriginal) return trashOriginal(result, filePath, 'fix-track:delete-original', log);
    } else {
      log(`Fix failed for ${path.basename(filePath)}: ${result.errorMessage || 'Unknown error'}\n`, 'stderr');
    }

    return result;
  })
);

// Re-encode track file handler (fix bitrate issues by re-encoding to 320kbps MP3)
handleIpc(
  'reencode-track-file',
  async (event, { filePath, deleteOriginal }: { filePath: string; deleteOriginal: boolean }): Promise<ConvertIpcResult> => trackOp('Re-encoding to MP3', async () => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const log = createLogger(event.sender, runId);
    log(`Re-encoding to 320kbps: ${path.basename(filePath)}\n`);

    // reencodeToMp3 replaces an MP3 input in place; anything else becomes a new .mp3.
    const keepOriginal = await mustKeepOriginalForRekordbox(filePath, deleteOriginal, path.extname(filePath).toLowerCase() === '.mp3');
    const result = await reencodeToMp3(filePath, keepOriginal ? { keepOriginal: true } : undefined);

    if (result.success) {
      log(`Re-encoded: ${path.basename(result.outputPath!)}\n`, 'status');
      if (keepOriginal) return keptForRekordbox(result, filePath, log);
      if (deleteOriginal) return trashOriginal(result, filePath, 'reencode:delete-original', log);
    } else {
      log(`Re-encode failed for ${path.basename(filePath)}: ${result.errorMessage || 'Unknown error'}\n`, 'stderr');
    }

    return result;
  })
);

// Generic job queue handlers
// The queue's 'library-check' job decides ownership by walking the library
// folder; ownership comes from Rekordbox now (check-library), so it can't be
// started from the renderer.
function assertEnqueueable(type: string): void {
  if (type === 'library-check') {
    throw new Error('The folder-scan library check is retired; use check-library / library-sourcing:run (Rekordbox ownership).');
  }
}

handleIpc('job-enqueue', async (_event, { type, params, contextKey }: { type: string; params: unknown; contextKey: string }) => {
  try {
    assertEnqueueable(type);
    const { jobId, promise } = getJobManager().enqueue(type as any, params as any, contextKey);
    // The outcome reaches the renderer through job-update / job-wait; an
    // unwatched failure isn't an unhandled rejection.
    promise.catch(() => {});
    return { jobId };
  } catch (error) {
    mainLog.error('IPC job-enqueue failed:', error);
    throw error;
  }
});

handleIpc('job-enqueue-and-wait', async (_event, { type, params, contextKey }: { type: string; params: unknown; contextKey: string }) => {
  try {
    assertEnqueueable(type);
    const { jobId, promise } = getJobManager().enqueue(type as any, params as any, contextKey);
    const result = await promise;
    return { jobId, success: true, result };
  } catch (error) {
    mainLog.error('IPC job-enqueue-and-wait failed:', error);
    return {
      jobId: '',
      success: false,
      error: error instanceof Error ? error.message : 'Job failed'
    };
  }
});

handleIpc('job-cancel', async (_event, { jobId }: { jobId: string }) => {
  try {
    return getJobManager().cancel(jobId);
  } catch (error) {
    mainLog.error('IPC job-cancel failed:', error);
    return false;
  }
});

handleIpc('job-list', async () => {
  try {
    return getJobManager().getAllJobs();
  } catch (error) {
    mainLog.error('IPC job-list failed:', error);
    return [];
  }
});

// Wait for a job enqueued with job-enqueue. The renderer enqueues first so it
// holds the id (to cancel, and to match job-log lines), then waits here.
handleIpc('job-wait', async (_event, { jobId }: { jobId: string }) => {
  const promise = getJobManager().wait(jobId);
  if (!promise) return { success: false, error: 'That job is no longer known.' };
  try {
    return { success: true, result: await promise };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Job failed';
    return { success: false, error: message, cancelled: getJobManager().getJob(jobId)?.status === 'cancelled' };
  }
});

// ---------- Claude Code (jobs bill the signed-in Claude subscription) ----------

handleIpc('claude-status', async () => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    return await getClaudeStatus(config.claudeOauthToken || undefined);
  } catch (error) {
    mainLog.error('IPC claude-status failed:', error);
    throw error;
  }
});

handleIpc('claude-open-login', async () => {
  try {
    return await openClaudeLogin();
  } catch (error) {
    mainLog.error('IPC claude-open-login failed:', error);
    throw error;
  }
});

// List available volumes, filtering excluded names from config.
// The library volume is included but flagged with isLibrary = true.
handleIpc('list-volumes', async () => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    const libraryRoot = config.libraryRoot || DEFAULT_LIBRARY_ROOT;
    const volumes = await listUsbVolumes(libraryRoot, config.excludedVolumes ?? []);
    return { success: true, volumes };
  } catch (error) {
    mainLog.error('IPC list-volumes failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list volumes'
    };
  }
});

// Add a volume name to the excluded list (hides it from the Devices panel)
handleIpc('exclude-volume', async (_event, { name }: { name: string }) => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    if (!(config.excludedVolumes ?? []).includes(name)) {
      await mutateConfig((current) => {
        const existing = current.excludedVolumes ?? [];
        return existing.includes(name) ? current : { ...current, excludedVolumes: [...existing, name] };
      });
    }
    return { success: true };
  } catch (error) {
    mainLog.error('IPC exclude-volume failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed' };
  }
});

// Archive track file handler (move to .archive folder next to library)
handleIpc(
  'archive-track-file',
  async (event, { filePath }: { filePath: string }): Promise<ArchiveResult> => trackOp('Archiving a track', async () => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const log = createLogger(event.sender, runId);
    log(`Archiving: ${path.basename(filePath)}\n`);
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    const libraryRoot = await getLibraryRoot();
    // Same default as the storage stats: beside the CURRENT library root.
    const archivePath = config.archivePath || getDefaultArchivePath(libraryRoot);
    const result = await archiveTrackFile(filePath, libraryRoot, archivePath);
    if (result.success) {
      log(`Archived to: ${result.archivePath ?? archivePath}\n`, 'status');
    } else {
      log(`Archive failed for ${path.basename(filePath)}: ${result.errorMessage || 'Unknown error'}\n`, 'stderr');
    }
    return result;
  })
);

// Migrate archive contents from old path to new path
handleIpc(
  'migrate-archive',
  async (event, { oldPath, newPath }: { oldPath: string; newPath: string }): Promise<{ success: boolean; error?: string }> => trackOp('Moving the archive', async () => {
    try {
      // Check if old path exists and has content
      if (!fs.existsSync(oldPath)) {
        // Nothing to migrate
        return { success: true };
      }

      const oldStat = await fs.promises.stat(oldPath);
      if (!oldStat.isDirectory()) {
        return { success: false, error: 'Old archive path is not a directory' };
      }

      // Collect all files to migrate
      const filesToMigrate: { src: string; dest: string }[] = [];

      async function collectFiles(dir: string, relativeBase: string = '') {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const srcPath = path.join(dir, entry.name);
          const relativePath = path.join(relativeBase, entry.name);
          const destPath = path.join(newPath, relativePath);

          if (entry.isDirectory()) {
            await collectFiles(srcPath, relativePath);
          } else {
            filesToMigrate.push({ src: srcPath, dest: destPath });
          }
        }
      }

      await collectFiles(oldPath);

      if (filesToMigrate.length === 0) {
        return { success: true };
      }

      // Migrate files with progress updates
      for (let i = 0; i < filesToMigrate.length; i++) {
        const { src, dest } = filesToMigrate[i];

        // Ensure destination directory exists
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });

        // Move file (handles cross-filesystem moves)
        await safeMove(src, dest, 'migrate-archive');

        // Send progress
        safeSend(event.sender, 'migrate-progress', {
          current: i + 1,
          total: filesToMigrate.length,
          file: path.basename(src)
        });
      }

      // Clean up empty directories in old path
      async function removeEmptyDirs(dir: string) {
        try {
          const entries = await fs.promises.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              await removeEmptyDirs(path.join(dir, entry.name));
            }
          }
          await fs.promises.rmdir(dir);
        } catch (error) {
          mainLog.debug('Directory not empty during cleanup:', dir);
        }
      }

      await removeEmptyDirs(oldPath);

      return { success: true };
    } catch (error) {
      mainLog.error('IPC migrate-archive failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Migration failed'
      };
    }
  })
);

// ========== Restore Library ==========

handleIpc('restore-list-volumes', async () => {
  try {
    const volumes = await listExternalVolumes();
    return { success: true, volumes };
  } catch (error) {
    mainLog.error('IPC restore-list-volumes failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to list volumes' };
  }
});

handleIpc('restore-pick-xml', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose Rekordbox XML',
    properties: ['openFile'],
    filters: [{ name: 'Rekordbox XML', extensions: ['xml'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { success: true, path: null };
  return { success: true, path: result.filePaths[0] };
});

let restoreAbortController: AbortController | null = null;

handleIpc('restore-run', async (event, { options }: { options: Omit<RestoreOptions, 'beatportAccounts' | 'qobuzAccounts'> }) => {
  // One restore at a time: a second run would overwrite the abort controller
  // (leaving the first unabortable) and both would move files into the library.
  if (restoreAbortController) {
    return { success: false, error: 'A restore is already running. Wait for it to finish, or abort it first.' };
  }
  const controller = new AbortController();
  restoreAbortController = controller;
  try {
    return await trackOp('Restore', async () => {
      const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
      const libraryRoot = options.libraryRoot || await getLibraryRoot();
      const stageDir = options.stageDir || getDefaultRestoreStageDir(libraryRoot);
      const fullOptions: RestoreOptions = {
        ...options,
        libraryRoot,
        stageDir,
        beatportAccounts: config.beatportAccounts,
        qobuzAccounts: config.qobuzAccounts,
      };
      const report = await restoreLibrary(fullOptions, (p: RestoreProgress) => {
        safeSend(event.sender, 'restore-progress', p);
      }, controller.signal);
      // Persist a copy of the report to user data for later reference.
      const reportPath = path.join(app.getPath('userData'), `restore-report-${Date.now()}.json`);
      await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2));
      return { success: true, report, reportPath };
    });
  } catch (error) {
    if (controller.signal.aborted) {
      mainLog.info('Restore aborted by user');
      return { success: false, aborted: true, error: 'Restore aborted' };
    }
    mainLog.error('IPC restore-run failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Restore failed' };
  } finally {
    if (restoreAbortController === controller) restoreAbortController = null;
  }
});

handleIpc('restore-abort', () => {
  restoreAbortController?.abort();
  return { success: true, aborting: restoreAbortController !== null };
});

// --- Splice recovery (Ableton .als sample re-download) -------------------

handleIpc('splice-login-status', async () => {
  try {
    const { getLoginStatus } = await import('./lib/spliceRecovery');
    return { success: true, status: await getLoginStatus() };
  } catch (error) {
    mainLog.error('IPC splice-login-status failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Status check failed' };
  }
});

handleIpc('splice-start-login', async () => {
  try {
    const { startLogin } = await import('./lib/spliceRecovery');
    return await startLogin();
  } catch (error) {
    mainLog.error('IPC splice-start-login failed:', error);
    return { ok: false, error: error instanceof Error ? error.message : 'Login launch failed' };
  }
});

handleIpc('splice-pick-als', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose Ableton project (.als)',
    properties: ['openFile'],
    filters: [{ name: 'Ableton Live Set', extensions: ['als'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { success: true, path: null };
  return { success: true, path: result.filePaths[0] };
});

handleIpc('splice-scan', async (_event, { alsPath }: { alsPath: string }) => {
  try {
    const { scan } = await import('./lib/spliceRecovery');
    const result = await scan(alsPath);
    return { success: true, result };
  } catch (error) {
    mainLog.error('IPC splice-scan failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Scan failed' };
  }
});

handleIpc('splice-classify', async (event, { missing }: { missing: import('./lib/spliceRecovery').SpliceMissingSample[] }) => {
  try {
    const { classify, writeManifest } = await import('./lib/spliceRecovery');
    const buckets = await classify(missing, (p) => {
      safeSend(event.sender, 'splice-progress', p);
    });
    // Persist the classification result so it survives app restarts.
    const scanResult = { alsPath: '', totalRefs: 0, spliceRefs: 0, missing };
    let manifestPath: string | null = null;
    try {
      manifestPath = writeManifest(scanResult, buckets);
    } catch (err) {
      mainLog.warn('writeManifest failed (non-fatal):', err);
    }
    return { success: true, buckets, manifestPath };
  } catch (error) {
    mainLog.error('IPC splice-classify failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Classify failed' };
  }
});

handleIpc('splice-download-owned', async (event, { items }: { items: import('./lib/spliceRecovery').SpliceOwnedItem[] }) => trackOp('Downloading Splice samples', async () => {
  try {
    const { downloadOwned } = await import('./lib/spliceRecovery');
    const report = await downloadOwned(items, (p) => {
      safeSend(event.sender, 'splice-progress', p);
    });
    return { success: true, report };
  } catch (error) {
    mainLog.error('IPC splice-download-owned failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Download failed' };
  }
}));

handleIpc('splice-credits-balance', async () => {
  try {
    const { getCreditsBalance } = await import('./lib/spliceRecovery');
    const balance = await getCreditsBalance();
    return { success: true, balance };
  } catch (error) {
    mainLog.error('IPC splice-credits-balance failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Balance fetch failed' };
  }
});

handleIpc('splice-buy-credits', async (event, { items }: { items: import('./lib/spliceRecovery').SpliceCreditsItem[] }) => trackOp('Buying Splice samples', async () => {
  try {
    const { buyCreditsBucket } = await import('./lib/spliceRecovery');
    const report = await buyCreditsBucket(items, (p) => {
      safeSend(event.sender, 'splice-progress', p);
    });
    return { success: true, report };
  } catch (error) {
    mainLog.error('IPC splice-buy-credits failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Purchase failed' };
  }
}));
