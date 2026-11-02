import log, { createScopedLogger } from './lib/logger';
import { app, BrowserWindow, webContents, ipcMain, dialog, nativeImage, Tray, Menu, protocol, net, shell, session, type OpenDialogOptions } from 'electron';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';

const mainLog = createScopedLogger('Main');

// Process-level error handlers
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason);
});
import { organizeTracks, OrganizeResult } from './lib/organizeByArtist';
import { cartUrl } from './lib/storeUrls';
import { checkLibrary, checkLibraryFromTracks, spotifyTracksToTrackRecords, CheckResult, ProgressUpdate, previewCsv, CsvPreview } from './lib/musicLibraryCheck';
import { readConfig, writeConfig, AppConfig, DEFAULT_LIBRARY_ROOT, getDefaultArchivePath, getDefaultRestoreStageDir, setSecretsPath } from './lib/config';
import { searchSpotify, testSpotifyConnection, SpotifySearchResult, getPlaylistTracks } from './lib/spotify';
import {
  searchSoundCloud,
  searchSoundCloudPublicTracks,
  testSoundCloudConnection,
  pingSoundCloudPublic,
  SoundCloudSearchResult
} from './lib/soundcloud';
import { searchBeatport, BeatportSearchResult } from './lib/beatport';
import { searchQobuz, QobuzSearchResult } from './lib/qobuz';
import { batchSearchQobuz, addTracksToQobuzCart, closeQobuzBrowser, isQobuzBrowserOpen, QobuzCartTrackInput, CartTrack } from './lib/qobuzCart';
import {
  loginQobuz, loginBeatport, logoutQobuz, logoutBeatport, isQobuzLoggedIn, isBeatportLoggedIn,
  fetchAllQobuzPurchases, fetchAllBeatportPurchases, matchesOwnedTrack,
  probeBeatportPurchases, probeQobuzPurchases, probeBeatportDownloadLink,
  downloadBeatportPurchases, downloadQobuzPurchases,
  setBeatportToken, getBeatportAccessToken,
  searchQobuzStore, searchBeatportStore, addToQobuzCart, addToBeatportCart,
  probeQobuzLoginForPartition, invalidateQobuzAuthCache,
  qobuzPartition, beatportPartition,
  LEGACY_ACCOUNT_ID,
} from './lib/storePurchase';
import { restoreLibrary, type RestoreOptions, type RestoreReport, type RestoreProgress } from './lib/restoreLibrary';
import { listExternalVolumes } from './lib/usbScan';
import type { StoreTrackInput, StoreMatch, StoreAccount } from './types';
import { scanTracks, updateTags, getAlbumArtFromFile, TrackInfo, UpdateTagsParams } from './lib/trackScanner';
import { readDjTags } from './lib/djTags';
import { diagnoseAiffHeader, repairAiffHeader, type AiffHeaderDiagnosis } from './lib/aiffRepair';
import { scanMissingAlbumArt, type AlbumArtScanProgress } from './lib/albumArtScan';
import { convertToAiff, reencodeToMp3, createMp3PreviewResponse, ConversionResult } from './lib/trackConverter';
import { scanLibraryHealth, LibraryHealthResult, archiveTrackFile, ArchiveResult } from './lib/libraryHealthScan';
import {
  initCachePath,
  loadCache,
  getCachedLibraryCheck,
  getLatestCachedLibraryTracks,
  cacheLibraryCheck,
  getCacheStatus,
  clearCache,
  updateCachedCheckResult,
  startBackgroundRefresh,
  stopBackgroundRefresh
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
import { initWriteJournal, recordWrite, statBytes, flushWriteJournal } from './lib/writeJournal';
import { safeDelete, setTrashHandler } from './lib/safeDelete';
import { listUsbVolumes } from './lib/usbHealthScan';
import { normalizeForComparison, stringSimilarity, looseTrackKey, normalizeLoose } from './lib/stringUtils';
import { initJobQueue, getJobManager } from './lib/jobQueue';
import { AUTOPOPULATE_CONCURRENCY, AUDIO_EXTENSIONS } from './lib/constants';
import { initDatabase, closeDatabase, ignoreTrack, unignoreTrack, getIgnoredTracks, getIgnoredTrackKeys, dismissDuplicate, getDismissedDuplicateKeys, makeDuplicatePairKey, dismissHealthIssue, undismissHealthIssue, getDismissedIssues, markTrackAutopopulated, getAutopopulatedPaths } from './lib/db';
import { parseRekordboxXml, findMissingFiles, importRekordboxToLibrary, type MissingFile, type RekordboxImportSummary } from './lib/rekordbox';
import { checkForUpdate, oneClickBlocker, UPDATE_BRANCH } from './lib/updateCheck';

type ScriptStream = 'stdout' | 'stderr' | 'status';

type LogFn = (text: string, stream?: ScriptStream) => void;

// Register media:// scheme for audio preview (must be before app.whenReady)
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, stream: true, supportFetchAPI: true } }
]);

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
// `app.getAppPath()` returns the repo root in dev and the unpacked app dir
// in production — robust to Vite's code-splitting moving main.js around.
const CONFIG_DEFAULTS_PATH = path.join(app.getAppPath(), 'config.json');
// Untracked secrets file — kept out of the repo; supplies API keys and account
// identifiers when the user's own config.json hasn't been written yet.
const SECRETS_PATH = path.join(app.getAppPath(), 'secrets.json');
setSecretsPath(SECRETS_PATH);

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

function createLogger(sender: Electron.WebContents, id: string): LogFn {
  return (text, stream = 'stdout') => {
    sender.send('script-output', { id, stream, text });
  };
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

  // Harden every <webview> guest before it attaches: strip any preload, force
  // an isolated no-node context, and only let it start on a known store origin
  // (the renderer sets src to the qobuz/beatport cart). Popups from the guest
  // (3DS/SCA, login) are handled in the app-level `web-contents-created` hook.
  win.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    const src = params.src ?? '';
    const allowed = src === '' || src === 'about:blank'
      || /^https:\/\/(www\.)?(qobuz|beatport)\.com\//.test(src);
    if (!allowed) {
      mainLog.warn(`Blocked disallowed <webview> src, redirecting to about:blank: ${src}`);
      params.src = 'about:blank';
    }
  });

  // Maximize and show window when ready
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });

  // In development, use Vite dev server; in production, load the built file
  if (process.env.NODE_ENV === 'development') {
    void win.loadURL('http://localhost:5173');
  } else {
    void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
}

// Popups opened by the store-cart <webview> guest (3DS/SCA bank prompts, an
// interactive login) must open as real windows so the user can complete them —
// but hardened, and inheriting the guest's session partition (so they stay
// authenticated). Anything the app's own web-contents opens is not affected.
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {
    if (!/^https:\/\//.test(url)) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      },
    };
  });
});

app.whenReady().then(async () => {
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
            const win = BrowserWindow.getAllWindows()[0];
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

      // Click on tray icon shows the window
      tray.on('click', () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          win.show();
          win.focus();
        }
      });
    }
  }

  mainLog.info('App ready, initializing...');

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
      if (/\.aiff?$/i.test(filePath)) {
        mainLog.info(`Media protocol: transcoding "${filePath}" to MP3`);
        return await createMp3PreviewResponse(filePath, request.headers.get('range'));
      }
      mainLog.info(`Media protocol: serving "${filePath}"`);
      const fileUrl = pathToFileURL(filePath).href;
      return await net.fetch(fileUrl);
    } catch (err) {
      mainLog.error(`Media protocol error for ${request.url}:`, err);
      return new Response('File not found', { status: 404 });
    }
  });

  // Initialize database
  initDatabase();
  mainLog.info('Database initialized');

  // Append-only journal of destructive file operations (for recovery tracing)
  initWriteJournal(app.getPath('userData'));
  // Route user-audio deletes through the OS Trash (recoverable) instead of a
  // permanent unlink. The lib layer stays Electron-free; we inject the handler.
  setTrashHandler((filePath) => shell.trashItem(filePath));

  // One-shot migration of legacy scan-cache.json data into SQLite
  migrateFromJsonCacheIfNeeded(app.getPath('userData'));

  // Load cache on startup (with file persistence for dev HMR survival)
  initCachePath(app.getPath('userData'));
  await loadCache();
  mainLog.info('Cache loaded');

  // Initialize job queue
  initJobQueue();
  mainLog.info('Job queue initialized');

  // Start background refresh timer for library-check (library health now lives in SQLite
  // and rescans are incremental via mtime, so no periodic re-scan is needed)
  startBackgroundRefresh({
    onRefreshLibraryCheck: async (libraryRoot, csvPath) => {
      mainLog.info('Background refreshing library check cache...');
      const result = await checkLibrary({ libraryRoot, csvPath });
      await cacheLibraryCheck(libraryRoot, csvPath, result);
      mainLog.info('Library check cache refreshed');
    }
  });

  createWindow();
  mainLog.info('App startup complete');

  // Advisory: never awaited, never blocks startup.
  void promptForUpdateIfBehind();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  mainLog.info('All windows closed');
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', (event) => {
  mainLog.info('App will quit, cleaning up...');
  closeStorePanel();
  stopBackgroundRefresh();
  closeDatabase();
  // Ensure in-flight write-journal appends (the recovery trail) land before exit.
  event.preventDefault();
  flushWriteJournal().finally(() => app.exit(0));
});

// ========== Startup update check ==========
//
// The app runs from a git checkout (`npm start`), so the repo dir is the app
// path. If origin/main has commits we don't, offer to pull + rebuild +
// relaunch via scripts/update.sh, which runs detached after we quit (the
// rebuild replaces dist/ and native modules this process has loaded).

async function promptForUpdateIfBehind(): Promise<void> {
  if (process.env.NODE_ENV === 'development' || process.env.CANDYBAR_SKIP_UPDATE_CHECK) return;
  const repoDir = app.getAppPath();
  const status = await checkForUpdate(repoDir);
  if (!status || status.behind === 0) return;

  const win = BrowserWindow.getAllWindows()[0];
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
    message: `Candy Bar Manager is ${n} update${n === 1 ? '' : 's'} behind GitHub.`,
    detail: blocker
      ? `${changes}\n\n${blocker} Update by hand:\n  cd "${repoDir}"\n  git pull origin ${UPDATE_BRANCH} && npm install && npm start`
      : `${changes}\n\nUpdating pulls the latest code, rebuilds, and restarts the app (about a minute).`,
    buttons: blocker ? ['OK'] : ['Update & Restart', 'Later'],
    defaultId: 0,
    cancelId: blocker ? 0 : 1,
  };
  const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  if (blocker || response !== 0) return;

  const script = path.join(repoDir, 'scripts', 'update.sh');
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
// The window that owns the panel, captured when it opens. State sends must target
// THIS window's web-contents: getMainWindow() (= getAllWindows()[0]) can
// transiently return a login/helper window, and the store-panel-state event would
// then be delivered to the wrong renderer (so the app never shows the panel).
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

function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null;
}

async function openStorePanel(store: 'qobuz' | 'beatport', url: string): Promise<void> {
  const win = getMainWindow();
  if (!win) return;
  storePanelWin = win; // canonical owner window for all subsequent state sends

  // Pre-warm the account's session partition so the panel lands authed.
  // loginQobuz/Beatport are no-ops when the partition already has valid
  // cookies; otherwise they pop an interactive login window and wait.
  const accountId = await resolveStorePanelAccountId(store);
  try {
    if (store === 'qobuz') await loginQobuz(accountId);
    else await loginBeatport(accountId);
  } catch (err) {
    mainLog.warn(`Failed to pre-warm ${store}[${accountId}] session before opening panel:`, err);
  }

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
  win.webContents.send('store-panel-state', { open: true, store, url, partition });

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
  if (win && !win.isDestroyed()) {
    win.webContents.send('store-panel-state', { open: false });
  }
  storePanelWin = null;
}

// ========== Auth Detection ==========

/** Read the persisted Beatport session and refresh the in-memory access token.
 *  Independent of whether the store panel is open — used on demand before
 *  cart-add so stale in-memory state doesn't block a user who logged in
 *  earlier.
 *
 *  Partition priority: since the store panel + login window were unified on
 *  the account-scoped partition (`persist:beatport-{accountId}`), that's where
 *  fresh authenticated sessions land. The legacy `persist:beatport` partition
 *  often holds a STALE cookie from before that change, which may still yield
 *  an identity-bearing-but-expired JWT — enough to pass the identity check,
 *  not enough to actually authenticate cart-add. Account partition first. */
/** Probe a Beatport Bearer token against a user-scoped endpoint. This is the
 *  only reliable way to know a token actually authenticates the user — JWT
 *  claim inspection can pass for anonymous-but-structured tokens, and Beatport
 *  happily returns 401 "Authentication credentials were not provided." on
 *  `/v4/my/*` for those. Returns true only on 2xx. */
async function verifyBeatportToken(token: string): Promise<boolean> {
  try {
    const res = await fetch('https://api.beatport.com/v4/my/account/?per_page=1', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

async function refreshBeatportTokenFromSession(accountId: string): Promise<boolean> {
  const { beatportPartition } = await import('./lib/storePurchase');
  // Try BOTH partitions and verify each token against a user-scoped endpoint.
  // Whichever yields a working token wins — order doesn't matter once we
  // verify rather than guess.
  const candidates = [beatportPartition(accountId), 'persist:beatport'];
  for (const partition of candidates) {
    try {
      const ses = session.fromPartition(partition);
      const cookies = await ses.cookies.get({ url: 'https://www.beatport.com' });
      const hasSession = cookies.some(c => c.name.includes('next-auth.session-token'));
      if (!hasSession) {
        mainLog.info(`Beatport[${accountId}]: partition ${partition} has no session-token cookie — skipping`);
        continue;
      }

      const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      const res = await fetch('https://www.beatport.com/api/auth/session', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Cookie': cookieHeader,
        },
      });
      if (!res.ok) {
        mainLog.info(`Beatport[${accountId}]: ${partition} /api/auth/session returned ${res.status}`);
        continue;
      }
      const data = await res.json() as {
        user?: { id?: unknown; email?: string; person_id?: number };
        token?: { accessToken?: string; expiresIn?: number };
      };
      const token = data?.token?.accessToken;
      if (!token) {
        mainLog.info(`Beatport[${accountId}]: ${partition} session response has no accessToken`);
        continue;
      }

      // Don't trust JWT claims — actually probe a user-scoped endpoint. An
      // anonymous next-auth session can return a well-formed JWT that /my/*
      // still 401s on.
      const worksForUser = await verifyBeatportToken(token);
      if (!worksForUser) {
        mainLog.info(`Beatport[${accountId}]: token from ${partition} failed user-scope probe — skipping`);
        continue;
      }

      setBeatportToken(accountId, token, data.token?.expiresIn ?? 3600);
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
    const ses = session.fromPartition(beatportPartition(accountId));
    const cookies = await ses.cookies.get({ url: 'https://www.beatport.com' });
    const hasSession = cookies.some(c => c.name.includes('next-auth.session-token'));
    if (!hasSession) return false;

    // Have session cookie — fetch session endpoint to get Bearer token
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const res = await fetch('https://www.beatport.com/api/auth/session', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Cookie': cookieHeader,
      },
    });

    if (!res.ok) return false;
    const data = await res.json() as { token?: { accessToken?: string; expiresIn?: number } };
    const token = data?.token?.accessToken;
    if (!token) return false;

    // Don't cache an anonymous token — Beatport's /api/auth/session returns a
    // JWT even for pre-login browsing, and that token 401s on /v4/my/*. Verify
    // against a user-scoped endpoint before caching.
    const worksForUser = await verifyBeatportToken(token);
    if (!worksForUser) return false;

    const expiresIn = data.token?.expiresIn ?? 3600;
    setBeatportToken(accountId, token, expiresIn);
    mainLog.info(`Beatport[${accountId}]: verified authenticated token from panel session`);

    const win = getMainWindow();
    if (win) {
      win.webContents.send('store-panel-auth', { store: 'beatport', loggedIn: true });
    }
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
    const win = getMainWindow();
    if (win) {
      win.webContents.send('store-panel-auth', { store: 'qobuz', loggedIn: true });
    }
    return true;
  } catch (err) {
    mainLog.warn('Failed to detect Qobuz login from panel:', err);
    return false;
  }
}

function startBeatportTokenPoll(): void {
  stopStorePanelAuthPoll();
  if (storePanelAccountId && getBeatportAccessToken(storePanelAccountId)) {
    const win = getMainWindow();
    if (win) win.webContents.send('store-panel-auth', { store: 'beatport', loggedIn: true });
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
ipcMain.handle('store-panel-open', async (_event, { store, url }: { store: 'qobuz' | 'beatport'; url: string }) => {
  await openStorePanel(store, url);
  return { success: true };
});

ipcMain.handle('store-panel-close', () => {
  closeStorePanel();
  return { success: true };
});

// The renderer registers the <webview> guest's webContents id once it attaches,
// so the scripted-checkout injection below can reach the live cart page.
ipcMain.handle('store-panel-attach', (_event, { contentsId }: { contentsId: number | null }) => {
  storePanelContentsId = typeof contentsId === 'number' ? contentsId : null;
  return { success: true };
});

// The renderer reports each guest navigation. We remember the URL for status and
// re-broadcast it as `store-panel-navigated` so the app's purchase-success watcher
// (auto-download) keeps working now that nav events originate in the renderer.
ipcMain.handle('store-panel-nav', (_event, { url }: { url: string }) => {
  if (typeof url === 'string' && url) storePanelUrl = url;
  const win = storePanelWin ?? getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send('store-panel-navigated', { url });
  return { success: true };
});

ipcMain.handle('store-panel-status', () => {
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

const CHECKOUT_ADVANCE_SCRIPT = `
(async () => {
  const visible = (el) => !!el && el.offsetParent !== null && !el.disabled && window.getComputedStyle(el).visibility !== 'hidden';
  const ctas = () => Array.from(document.querySelectorAll('button, a, input[type="submit"], [role="button"]')).filter(visible);
  const text = (el) => ((el.innerText || el.value || el.getAttribute('aria-label') || '').trim());
  const match = (re) => ctas().filter(el => re.test(text(el)));

  // "Place order" / final-commit patterns — if we see one, this is the commit page.
  // We do NOT click it from this advance step; we report readiness instead.
  const placeRe = /^(?:place order|place your order|confirm (?:order|purchase|and pay)|pay now|buy now|commander|valider la commande)$/i;
  // Intermediate "advance to next step" patterns.
  const advanceRe = /(?:proceed to checkout|go to checkout|checkout|continue to (?:payment|checkout|review)|complete order|next step|payer)/i;

  const placeBtns = match(placeRe);
  if (placeBtns.length > 0) {
    // Pull a plausible order total from nearby text.
    const body = document.body.innerText || '';
    const totalMatch = body.match(/(?:grand\\s+total|order\\s+total|total(?:\\s+to\\s+pay)?)[^\\d$€£¥]{0,40}([\\$€£¥]\\s*\\d+[.,]\\d{2})/i);
    return { phase: 'place-order-ready', total: totalMatch ? totalMatch[1].replace(/\\s+/g, '') : null, buttonText: text(placeBtns[0]) };
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
  const placeRe = /^(?:place order|place your order|confirm (?:order|purchase|and pay)|pay now|buy now|commander|valider la commande)$/i;

  const btns = ctas().filter(el => placeRe.test(text(el)));
  if (btns.length === 0) return { success: false, error: 'Place Order button not visible on this page.' };
  btns[0].click();
  return { success: true, clickedText: text(btns[0]) };
})();
`;

type CheckoutAdvanceResult =
  | { phase: 'place-order-ready'; total: string | null; buttonText: string }
  | { phase: 'advanced'; clickedText: string }
  | { phase: 'unknown' };

ipcMain.handle('store-panel-checkout-advance', async (_event, { store }: { store: 'qobuz' | 'beatport' }) => {
  if (!storePanelOpen || storePanelStore !== store) {
    return { success: false, error: `${store} cart panel is not open.` };
  }
  // Tolerate the brief post-open window before the guest reports its id.
  const wc = await awaitStorePanelContents();
  if (!wc) {
    return { success: false, error: `${store} cart panel is still loading — try again in a moment.` };
  }
  try {
    const result = await wc.executeJavaScript(CHECKOUT_ADVANCE_SCRIPT) as CheckoutAdvanceResult;
    return { success: true, result };
  } catch (err) {
    mainLog.error(`checkout-advance[${store}] failed:`, err);
    return { success: false, error: err instanceof Error ? err.message : 'Script injection failed' };
  }
});

ipcMain.handle('store-panel-place-order', async (_event, { store }: { store: 'qobuz' | 'beatport' }) => {
  if (!storePanelOpen || storePanelStore !== store) {
    return { success: false, error: `${store} cart panel is not open.` };
  }
  const wc = await awaitStorePanelContents();
  if (!wc) {
    return { success: false, error: `${store} cart panel is still loading — try again in a moment.` };
  }
  try {
    const result = await wc.executeJavaScript(CHECKOUT_PLACE_ORDER_SCRIPT) as { success: boolean; clickedText?: string; error?: string };
    return result;
  } catch (err) {
    mainLog.error(`place-order[${store}] failed:`, err);
    return { success: false, error: err instanceof Error ? err.message : 'Script injection failed' };
  }
});

ipcMain.handle('select-path', async (_event, { type }: { type: 'file' | 'dir' }) => {
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

ipcMain.handle('get-config', async () => {
  try {
    return await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
  } catch (error) {
    mainLog.error('IPC get-config failed:', error);
    throw error;
  }
});

ipcMain.handle('get-config-path', () => CONFIG_PATH);

ipcMain.handle('get-library-root', async () => {
  try {
    return getLibraryRoot();
  } catch (error) {
    mainLog.error('IPC get-library-root failed:', error);
    throw error;
  }
});

ipcMain.handle('set-config', async (_event, config: AppConfig) => {
  try {
    return await writeConfig(CONFIG_PATH, config);
  } catch (error) {
    mainLog.error('IPC set-config failed:', error);
    throw error;
  }
});

ipcMain.handle(
  'check-library',
  async (event, { csvPath, spotifyPlaylistUrl, useCache = true, cacheOnly = false }: { csvPath?: string; spotifyPlaylistUrl?: string; useCache?: boolean; cacheOnly?: boolean }) => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const libraryRoot = await getLibraryRoot();
    const sourceKey = csvPath || spotifyPlaylistUrl || '';

    try {
      // Check cache first if enabled
      if (useCache || cacheOnly) {
        const cached = getCachedLibraryCheck(libraryRoot, sourceKey);
        if (cached) {
          mainLog.debug('check-library: Using cached result');
          // Annotate cached results with current ignored state
          const ignoredKeys = getIgnoredTrackKeys();
          for (const track of cached.missingTracks) {
            track.ignored = ignoredKeys.has(track.key);
          }
          for (const match of (cached.uncertainMatches || [])) {
            match.csvTrack.ignored = ignoredKeys.has(match.csvTrack.key);
          }
          event.sender.send('check-progress', { id: runId, phase: 'complete', current: cached.csvTotal, total: cached.csvTotal, message: 'Loaded from cache' });
          return { id: runId, success: true, result: cached, fromCache: true };
        }
      }

      // If cacheOnly, don't run a full scan
      if (cacheOnly) {
        return { id: runId, success: false, cacheOnly: true };
      }

      // Build job params
      const jobParams: Record<string, unknown> = {
        libraryRoot,
        contextKey: libraryRoot
      };

      if (spotifyPlaylistUrl) {
        const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
        if (!config.spotifyClientId || !config.spotifyClientSecret) {
          return { id: runId, success: false, error: 'Spotify credentials not configured. Go to Settings to add your Spotify Client ID and Secret.' };
        }
        jobParams.spotifyPlaylistUrl = spotifyPlaylistUrl;
        jobParams.spotifyCredentials = {
          clientId: config.spotifyClientId,
          clientSecret: config.spotifyClientSecret
        };
      } else {
        jobParams.csvPath = csvPath;
      }

      // Use job queue for concurrent execution and shared library scan
      const jm = getJobManager();
      const { jobId, promise } = jm.enqueue('library-check', jobParams, libraryRoot);

      const result = await promise as CheckResult;

      // Cache the result
      await cacheLibraryCheck(libraryRoot, sourceKey, result);

      // Clear stale store search results since the missing track list has changed
      const storeResultsPath = path.join(app.getPath('userData'), 'store-search-results.json');
      await fs.promises.unlink(storeResultsPath).catch(() => {});

      // Annotate with ignored state
      const ignoredKeys = getIgnoredTrackKeys();
      for (const track of result.missingTracks) {
        track.ignored = ignoredKeys.has(track.key);
      }
      for (const match of (result.uncertainMatches || [])) {
        match.csvTrack.ignored = ignoredKeys.has(match.csvTrack.key);
      }

      return { id: jobId, success: true, result, fromCache: false };
    } catch (error) {
      mainLog.error('IPC check-library failed:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { id: runId, success: false, error: message };
    }
  }
);

// Ignored tracks handlers
ipcMain.handle('ignore-track', async (_event, { key, artist, title }: { key: string; artist: string; title: string }) => {
  try {
    ignoreTrack(key, artist, title);
    return { success: true };
  } catch (error) {
    mainLog.error('IPC ignore-track failed:', error);
    throw error;
  }
});

ipcMain.handle('unignore-track', async (_event, { key }: { key: string }) => {
  try {
    unignoreTrack(key);
    return { success: true };
  } catch (error) {
    mainLog.error('IPC unignore-track failed:', error);
    throw error;
  }
});

ipcMain.handle('get-ignored-tracks', async () => {
  try {
    return getIgnoredTracks();
  } catch (error) {
    mainLog.error('IPC get-ignored-tracks failed:', error);
    throw error;
  }
});

// Dismissed duplicates handler
ipcMain.handle('dismiss-duplicate', async (_event, {
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
ipcMain.handle('dismiss-health-issue', async (_event, {
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

ipcMain.handle('undismiss-health-issue', async (_event, {
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

ipcMain.handle('get-dismissed-issues', async (_event, { libraryRoot }: { libraryRoot: string }) => {
  try {
    return getDismissedIssues(libraryRoot);
  } catch (error) {
    mainLog.error('IPC get-dismissed-issues failed:', error);
    throw error;
  }
});

// Rekordbox XML repair handlers
ipcMain.handle('rekordbox-scan', async (): Promise<{ total: number; missing: MissingFile[]; libraryRoot: string; xmlPath: string }> => {
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

ipcMain.handle('rekordbox-import', async (): Promise<RekordboxImportSummary> => {
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

ipcMain.handle('rekordbox-resync', async (): Promise<RekordboxImportSummary> => {
  const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
  const xmlPath = config.rekordboxXmlPath;
  const libraryRoot = config.libraryRoot || DEFAULT_LIBRARY_ROOT;
  if (!xmlPath) throw new Error('Rekordbox XML path is not set. Configure it in Settings.');
  try {
    // Parse & validate the XML BEFORE wiping the DB — a failed/empty parse must
    // never leave the library index emptied with nothing to import.
    const tracks = await parseRekordboxXml(xmlPath);
    if (!tracks.length) {
      throw new Error('Rekordbox XML parsed to zero tracks; refusing to wipe the library index.');
    }
    mainLog.info(`Resync: parsed ${tracks.length} tracks; wiping library_tracks/issues/duplicates/scan_runs for root=${libraryRoot}`);
    clearLibraryRoot(libraryRoot);
    return await importRekordboxToLibrary(tracks, libraryRoot);
  } catch (error) {
    mainLog.error('IPC rekordbox-resync failed:', error);
    throw error;
  }
});

// CSV Preview handler
ipcMain.handle('preview-csv', async (_event, { csvPath }: { csvPath: string }): Promise<CsvPreview> => {
  try {
    return previewCsv(csvPath);
  } catch (error) {
    mainLog.error('IPC preview-csv failed:', error);
    throw error;
  }
});

// Cache status handler
ipcMain.handle('get-cache-status', async () => {
  try {
    return getCacheStatus();
  } catch (error) {
    mainLog.error('IPC get-cache-status failed:', error);
    throw error;
  }
});

// Clear cache handler
ipcMain.handle('clear-cache', async () => {
  try {
    await clearCache();
    return { success: true };
  } catch (error) {
    mainLog.error('IPC clear-cache failed:', error);
    throw error;
  }
});

// Sync mutated state from renderer back to main process store
ipcMain.handle('update-check-result', async (_event, { result }: { result: any }) => {
  try {
    updateCachedCheckResult(result);
    return { success: true };
  } catch (error) {
    mainLog.error('IPC update-check-result failed:', error);
    throw error;
  }
});

ipcMain.handle('update-health-result', async (_event, { result }: { result: LibraryHealthResult }) => {
  try {
    replaceLibraryFromResult(result);
    return { success: true };
  } catch (error) {
    mainLog.error('IPC update-health-result failed:', error);
    throw error;
  }
});

// Organize state persistence (survives renderer HMR)
ipcMain.handle('get-organize-state', async () => {
  return getOrganizeState();
});

ipcMain.handle('update-organize-state', async (_event, { state }: { state: any }) => {
  try {
    saveOrganizeState(state);
    return { success: true };
  } catch (error) {
    mainLog.error('IPC update-organize-state failed:', error);
    throw error;
  }
});

// Storage stats handler
ipcMain.handle('get-storage-stats', async () => {
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
ipcMain.handle(
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
ipcMain.handle(
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
ipcMain.handle(
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
ipcMain.handle('show-save-dialog-m3u8', async (_event, { defaultName }: { defaultName: string }) => {
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
ipcMain.handle('show-save-dialog-rekordbox', async (_event, { defaultName }: { defaultName: string }) => {
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
ipcMain.handle('show-save-dialog', async (_event, { defaultName }: { defaultName: string }) => {
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
ipcMain.handle('show-save-dialog-json', async (_event, { defaultName }: { defaultName: string }) => {
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
ipcMain.handle('export-catalog', async (event, { outputPath }: { outputPath: string }) => {
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

ipcMain.handle(
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

ipcMain.handle(
  'autopopulate-tracks',
  async (
    event,
    { tracks: inputTracks, force = false }: { tracks: AutopopulateTrackInput[]; force?: boolean }
  ): Promise<AutopopulateResult[]> => {
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
          event.sender.send('autopopulate-progress', { current: i + idx + 1, total, filePath: track.filePath });
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
  }
);

ipcMain.handle('check-spotify', async (): Promise<boolean> => {
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

ipcMain.handle('check-soundcloud', async (): Promise<boolean> => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    if (config.soundcloudClientId && config.soundcloudClientSecret) {
      const ok = await testSoundCloudConnection({
        clientId: config.soundcloudClientId,
        clientSecret: config.soundcloudClientSecret
      });
      if (ok) return true;
      mainLog.warn('SoundCloud OAuth check failed; falling back to public reachability ping');
    }
    return await pingSoundCloudPublic();
  } catch (error) {
    mainLog.error('IPC check-soundcloud failed:', error);
    return false;
  }
});

// Source export: write source search results to CSV
ipcMain.handle(
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
ipcMain.handle(
  'source-search',
  async (event, { csvPath, spotifyPlaylistUrl }: { csvPath?: string; spotifyPlaylistUrl?: string }) => {
    try {
      let tracks: QobuzCartTrackInput[] = [];

      if (spotifyPlaylistUrl) {
        const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
        if (!config.spotifyClientId || !config.spotifyClientSecret) {
          return { success: false, error: 'Spotify credentials not configured. Go to Settings to add your Spotify Client ID and Secret.' };
        }

        event.sender.send('qobuz-cart-search-progress', { current: 0, total: 1, currentTrack: 'Fetching Spotify playlist...' });

        const { playlist, tracks: spotifyTracks } = await getPlaylistTracks(
          spotifyPlaylistUrl,
          { clientId: config.spotifyClientId, clientSecret: config.spotifyClientSecret },
          (loaded, total) => {
            event.sender.send('qobuz-cart-search-progress', {
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

      const results = await batchSearchQobuz(
        tracks,
        (current, total, currentTrack) => {
          event.sender.send('qobuz-cart-search-progress', { current, total, currentTrack });
        },
        (match) => {
          event.sender.send('qobuz-cart-search-match', match);
        }
      );

      // Tag matches whose artist+title already exists in the user's library
      // (per the latest cached Check scan) so the UI can skip auto-select and
      // flag the row. Uses a LOOSE key (accent/version-insensitive) plus a
      // title-only fallback indexed by primary artist, because Spotify often
      // credits every collaborator ("Four Tet, Burial, Thom Yorke") while the
      // library file only has the primary artist. Exact or normalized-key
      // matching was too strict — it missed ~everything with accents, remix
      // tags, or extra collab credits.
      const sourceConfig = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
      const libraryRoot = sourceConfig.libraryRoot || DEFAULT_LIBRARY_ROOT;
      const cachedLibraryTracks = getLatestCachedLibraryTracks(libraryRoot);
      if (cachedLibraryTracks && cachedLibraryTracks.length > 0) {
        // Primary index: full "artist - title" loose keys.
        const fullKeys = new Set<string>();
        // Secondary index: `${looseTitle} :: ${primaryArtistFirstToken}`, so we
        // match collab credits back to single-artist library files when the
        // first word of the library artist shows up anywhere in the source
        // artist credits. Cheap and usually correct.
        const titleIndex = new Map<string, string[]>(); // title → primary-artist tokens
        for (const lt of cachedLibraryTracks) {
          fullKeys.add(looseTrackKey(lt.artist, lt.title));
          const titleKey = normalizeLoose(lt.title);
          if (!titleKey) continue;
          const primaryArtistTok = normalizeLoose(lt.artist).split(/\s+/)[0];
          if (!primaryArtistTok) continue;
          const arr = titleIndex.get(titleKey) ?? [];
          arr.push(primaryArtistTok);
          titleIndex.set(titleKey, arr);
        }
        let flagged = 0;
        for (const m of results) {
          const srcKey = looseTrackKey(m.trackInput.artist, m.trackInput.title);
          if (fullKeys.has(srcKey)) {
            m.inLibrary = true;
            flagged++;
            continue;
          }
          // Fallback: match on title + any library artist's first token found
          // in the source artist credits.
          const srcTitle = normalizeLoose(m.trackInput.title);
          const libArtistTokens = srcTitle ? titleIndex.get(srcTitle) : undefined;
          if (libArtistTokens) {
            const srcArtistWords = new Set(normalizeLoose(m.trackInput.artist).split(/\s+/).filter(Boolean));
            if (libArtistTokens.some(t => srcArtistWords.has(t))) {
              m.inLibrary = true;
              flagged++;
            }
          }
        }
        mainLog.info(`Sources library-tag: ${flagged}/${results.length} matches flagged as in-library (cache: ${cachedLibraryTracks.length} tracks)`);
      } else {
        mainLog.info('Sources library-tag: no cached library scan — skipping auto-deselect');
      }

      return { success: true, matches: results };
    } catch (error) {
      mainLog.error('IPC source-search failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Search failed' };
    }
  }
);

// ---------- Library-Sourcing: combined Check + Source flow ----------
//
// Two-phase pipeline per the merge plan:
//   Phase 1 runs the library fuzzy-match against the user's local files.
//   Phase 2 searches Qobuz + Beatport for only the tracks that aren't cleanly
//   in the library (uncertain + missing).
//
// Progress is streamed on two distinct channels so the renderer can show a
// two-phase hero without the phases trampling each other:
//   `library-sourcing:phase1-progress` — library check progress updates
//   `library-sourcing:phase2-progress` — per-track store search progress
//   `library-sourcing:phase2-match`    — individual match objects as they
//                                          resolve (streaming to results)
ipcMain.handle(
  'library-sourcing:run',
  async (
    event,
    {
      csvPath,
      spotifyPlaylistUrl
    }: { csvPath?: string; spotifyPlaylistUrl?: string }
  ) => {
    try {
      const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
      const libraryRoot = config.libraryRoot || DEFAULT_LIBRARY_ROOT;

      // ---------- Input parsing (CSV or Spotify playlist) ----------
      // Build both a TrackRecord list (phase 1 input) and a parallel
      // QobuzCartTrackInput list keyed the same way so we can correlate
      // phase-2 matches back to phase-1 rows.
      let phase1Tracks: import('./lib/musicLibraryCheck').TrackRecord[] = [];

      if (spotifyPlaylistUrl) {
        if (!config.spotifyClientId || !config.spotifyClientSecret) {
          return { success: false, error: 'Spotify credentials not configured. Go to Settings to add your Spotify Client ID and Secret.' };
        }
        event.sender.send('library-sourcing:phase1-progress', { phase: 'parsing', current: 0, total: 1, message: 'Fetching Spotify playlist…' });
        const { playlist, tracks: spotifyTracks } = await getPlaylistTracks(
          spotifyPlaylistUrl,
          { clientId: config.spotifyClientId, clientSecret: config.spotifyClientSecret },
          (loaded, total) => {
            event.sender.send('library-sourcing:phase1-progress', {
              phase: 'parsing', current: loaded, total, message: `Fetching playlist: ${loaded}/${total}`
            });
          }
        );
        if (spotifyTracks.length === 0) {
          return { success: false, error: `Playlist "${playlist.name}" contains no fetchable tracks.` };
        }
        // Surface the playlist's cover art / name / track count now so the UI can
        // show it while the library scan (the slow phase) runs.
        event.sender.send('library-sourcing:playlist-info', {
          name: playlist.name,
          imageUrl: playlist.imageUrl,
          trackCount: playlist.trackCount,
          fetchedCount: spotifyTracks.length,
          owner: playlist.owner
        } satisfies import('./types').SourcePlaylistInfo);
        phase1Tracks = spotifyTracksToTrackRecords(spotifyTracks);
      } else if (csvPath) {
        // We let checkLibrary() parse the CSV directly below, but we also need
        // a TrackRecord list here so we can convert to QobuzCartTrackInput for
        // phase 2. Easier path: run checkLibrary first (which reads CSV once),
        // then derive store inputs from its output.
      } else {
        return { success: false, error: 'Either csvPath or spotifyPlaylistUrl must be provided.' };
      }

      // ---------- Phase 1: library match ----------
      event.sender.send('library-sourcing:phase1-progress', { phase: 'scanning', current: 0, total: 0, message: 'Scanning library…' });
      const phase1Progress = (p: ProgressUpdate) => {
        event.sender.send('library-sourcing:phase1-progress', p);
      };
      const checkResult: CheckResult = csvPath
        ? await checkLibrary({ libraryRoot, csvPath, onProgress: phase1Progress })
        : await checkLibraryFromTracks({ libraryRoot, tracks: phase1Tracks, onProgress: phase1Progress });

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

      const probableRows: import('./types').LibraryProbableRow[] = checkResult.uncertainMatches
        .filter(m => !ignoredKeys.has(m.csvTrack.key))
        .map(m => ({
          artist: m.csvTrack.artist,
          title: m.csvTrack.title,
          suspectedFilePath: m.libraryTrack.filePath || '',
          suspectedFileArtist: m.libraryTrack.artist,
          suspectedFileTitle: m.libraryTrack.title,
          confidence: m.confidence
        }));

      // ---------- Phase 2 input: uncertain ∪ missing, minus ignored ----------
      type PhaseKey = { key: string; status: 'probable' | 'missing'; matchPath?: string; matchConfidence?: number };
      const phase2Inputs: QobuzCartTrackInput[] = [];
      const phase2Meta = new Map<string, PhaseKey>();

      for (const m of checkResult.uncertainMatches) {
        if (ignoredKeys.has(m.csvTrack.key)) continue;
        const key = `${m.csvTrack.artist.toLowerCase()} - ${m.csvTrack.title.toLowerCase()}`;
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
          matchConfidence: m.confidence
        });
      }
      for (const m of checkResult.missingTracks) {
        if (ignoredKeys.has(m.key)) continue;
        const key = `${m.artist.toLowerCase()} - ${m.title.toLowerCase()}`;
        phase2Inputs.push({
          key,
          artist: m.artist,
          title: m.title,
          album: m.album,
          duration: m.duration
        });
        phase2Meta.set(key, { key, status: 'missing' });
      }

      // ---------- Phase 2: store search ----------
      event.sender.send('library-sourcing:phase2-progress', {
        current: 0, total: phase2Inputs.length, currentTrack: 'Preparing store search…'
      });

      const storeMatches = phase2Inputs.length > 0
        ? await batchSearchQobuz(
            phase2Inputs,
            (current, total, currentTrack) => {
              event.sender.send('library-sourcing:phase2-progress', { current, total, currentTrack });
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
              }
              event.sender.send('library-sourcing:phase2-match', match);
            }
          )
        : [];

      // Post-pass: make sure every match has libraryStatus tagged (the stream
      // callback only runs during search; this catches anything that
      // short-circuited).
      for (const m of storeMatches) {
        const meta = phase2Meta.get(m.trackInput.key);
        if (meta && !m.libraryStatus) {
          m.libraryStatus = meta.status;
          m.libraryMatchPath = meta.matchPath;
          m.libraryMatchConfidence = meta.matchConfidence;
          if (meta.status === 'probable') m.inLibrary = true;
        }
      }

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
        notFound
      };

      return { success: true, result };
    } catch (error) {
      mainLog.error('IPC library-sourcing:run failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Sourcing failed' };
    }
  }
);

// Qobuz cart integration
ipcMain.handle(
  'qobuz-cart-search',
  async (event, { tracks }: { tracks: QobuzCartTrackInput[] }) => {
    try {
      const results = await batchSearchQobuz(tracks, (current, total, currentTrack) => {
        event.sender.send('qobuz-cart-search-progress', { current, total, currentTrack });
      });
      return { success: true, matches: results };
    } catch (error) {
      mainLog.error('IPC qobuz-cart-search failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Search failed' };
    }
  }
);

ipcMain.handle(
  'qobuz-cart-add',
  async (event, { tracks }: { tracks: CartTrack[] }) => {
    try {
      const result = await addTracksToQobuzCart(tracks, (progress) => {
        event.sender.send('qobuz-cart-add-progress', progress);
      });
      return { success: true, ...result };
    } catch (error) {
      mainLog.error('IPC qobuz-cart-add failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Cart automation failed' };
    }
  }
);

ipcMain.handle('qobuz-browser-close', async () => {
  try {
    await closeQobuzBrowser();
    return { success: true };
  } catch (error) {
    mainLog.error('IPC qobuz-browser-close failed:', error);
    throw error;
  }
});

ipcMain.handle('qobuz-browser-status', () => {
  try {
    return { open: isQobuzBrowserOpen() };
  } catch (error) {
    mainLog.error('IPC qobuz-browser-status failed:', error);
    throw error;
  }
});

// ========== Store Purchase Handlers ==========

ipcMain.handle('store-login', async (_event, { store }: { store: 'qobuz' | 'beatport' }) => {
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

ipcMain.handle('store-login-status', async () => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    const qobuzStatuses: Record<string, boolean> = {};
    for (const a of config.qobuzAccounts) qobuzStatuses[a.id] = await isQobuzLoggedIn(a.id);
    const beatportStatuses: Record<string, boolean> = {};
    for (const a of config.beatportAccounts) beatportStatuses[a.id] = await isBeatportLoggedIn(a.id);
    const qobuz = Object.values(qobuzStatuses).some(Boolean);
    const beatport = Object.values(beatportStatuses).some(Boolean);
    return { qobuz, beatport, qobuzAccounts: qobuzStatuses, beatportAccounts: beatportStatuses };
  } catch (error) {
    mainLog.error('IPC store-login-status failed:', error);
    return { qobuz: false, beatport: false, qobuzAccounts: {}, beatportAccounts: {} };
  }
});

ipcMain.handle(
  'store-login-account',
  async (_event, { store, account }: { store: 'qobuz' | 'beatport'; account: StoreAccount }) => {
    try {
      // Persist the account metadata first so the session partition has a stable id.
      const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
      const list = store === 'qobuz' ? config.qobuzAccounts : config.beatportAccounts;
      const idx = list.findIndex(a => a.id === account.id);
      if (idx >= 0) list[idx] = account;
      else list.push(account);
      await writeConfig(CONFIG_PATH, config);

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

ipcMain.handle(
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

ipcMain.handle('probe-beatport-download-link', async (_event, { trackId, orderItemDownloadId }: { trackId: string; orderItemDownloadId?: string }) => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    const account = config.beatportAccounts[0];
    if (!account) return { success: false, error: 'No Beatport account configured' };
    await loginBeatport(account.id);
    const results = await probeBeatportDownloadLink(account.id, trackId, orderItemDownloadId);
    return { success: true, results };
  } catch (error) {
    mainLog.error('IPC probe-beatport-download-link failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Probe failed' };
  }
});

ipcMain.handle('sniff-beatport-headers', async () => {
  const { BrowserWindow } = await import('electron');
  const REAL_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const win = new BrowserWindow({
    width: 1200, height: 900, show: true,
    webPreferences: { partition: 'persist:beatport', nodeIntegration: false, contextIsolation: true },
  });
  win.webContents.setUserAgent(REAL_UA);

  const captured: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const allUrls: string[] = [];
  const onBeforeSend = (details: Electron.OnBeforeSendHeadersListenerDetails, cb: (r: Electron.BeforeSendResponse) => void) => {
    try {
      allUrls.push(`${details.method} ${details.url}`);
      if (details.url.includes('api.beatport.com') || details.url.includes('/api/v4/')) {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(details.requestHeaders || {})) h[k] = String(v);
        captured.push({ url: details.url, method: details.method, headers: h });
      }
    } catch {}
    cb({ requestHeaders: details.requestHeaders });
  };
  const beatportSession = win.webContents.session;
  beatportSession.webRequest.onBeforeSendHeaders(onBeforeSend);
  // The 'persist:beatport' session outlives the window, so the listener must be
  // explicitly removed or it accumulates and keeps intercepting every request.
  const detach = () => { try { beatportSession.webRequest.onBeforeSendHeaders(null); } catch { /* ignore */ } };

  try {
    await win.loadURL('https://www.beatport.com/');
    await new Promise(r => setTimeout(r, 90000)); // 90s — user navigates to library + clicks Download
    const outPath = await writeScratchFile('beatport_captured_requests.json', JSON.stringify(captured, null, 2));
    await writeScratchFile('beatport_all_urls.txt', allUrls.join('\n'));
    detach();
    win.close();
    return { success: true, capturedCount: captured.length, totalUrls: allUrls.length, outPath };
  } catch (error) {
    detach();
    try { win.close(); } catch {}
    mainLog.error('IPC sniff-beatport-headers failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Sniff failed' };
  }
});

ipcMain.handle('sniff-qobuz-headers', async () => {
  const { BrowserWindow } = await import('electron');
  const REAL_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const win = new BrowserWindow({
    width: 1200, height: 900, show: true,
    webPreferences: { partition: 'persist:qobuz', nodeIntegration: false, contextIsolation: true },
  });
  win.webContents.setUserAgent(REAL_UA);

  const captured: Array<{ url: string; headers: Record<string, string> }> = [];
  const allUrls: string[] = [];
  const onBeforeSend = (details: Electron.OnBeforeSendHeadersListenerDetails, cb: (r: Electron.BeforeSendResponse) => void) => {
    try {
      allUrls.push(details.url);
      // Capture all XHR-like requests with potentially-authenticated headers
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(details.requestHeaders || {})) h[k] = String(v);
      const hasAuth = Object.keys(h).some(k => /auth|token|app[-_]?id/i.test(k));
      if (hasAuth || details.url.includes('qobuz.com')) {
        captured.push({ url: details.url, headers: h });
      }
    } catch {}
    cb({ requestHeaders: details.requestHeaders });
  };
  const qobuzSession = win.webContents.session;
  qobuzSession.webRequest.onBeforeSendHeaders(onBeforeSend);
  // 'persist:qobuz' outlives the window — remove the listener explicitly.
  const detach = () => { try { qobuzSession.webRequest.onBeforeSendHeaders(null); } catch { /* ignore */ } };

  try {
    await win.loadURL('https://play.qobuz.com/');
    await new Promise(r => setTimeout(r, 120000)); // 2 min — user logs into play.qobuz.com, navigates to purchases, clicks Download
    const outPath = await writeScratchFile('qobuz_captured_requests.json', JSON.stringify(captured, null, 2));
    await writeScratchFile('qobuz_all_urls.txt', allUrls.join('\n'));
    await new Promise(r => setTimeout(r, 1500));
    detach();
    win.close();
    return { success: true, capturedCount: captured.length, totalUrls: allUrls.length, outPath, sample: captured.slice(0, 5), urlSample: allUrls.slice(0, 20) };
  } catch (error) {
    detach();
    try { win.close(); } catch {}
    mainLog.error('IPC sniff-qobuz-headers failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Sniff failed' };
  }
});

ipcMain.handle('probe-beatport-purchases', async () => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    const account = config.beatportAccounts[0];
    if (!account) return { success: false, error: 'No Beatport account configured' };
    await loginBeatport(account.id);
    const results = await probeBeatportPurchases(account.id);
    const outPath = await writeScratchFile('beatport_probe.json', JSON.stringify(results, null, 2));
    mainLog.info(`Wrote Beatport probe to ${outPath}`);
    return { success: true, results, outPath };
  } catch (error) {
    mainLog.error('IPC probe-beatport-purchases failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Probe failed' };
  }
});

ipcMain.handle('open-qobuz-login-window', async () => {
  try {
    const { BrowserWindow } = await import('electron');
    const REAL_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    const win = new BrowserWindow({
      width: 1000,
      height: 900,
      show: true,
      webPreferences: {
        partition: 'persist:qobuz',
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    win.webContents.setUserAgent(REAL_UA);
    // Land on the homepage first so Cloudflare can set its cookies, then user navigates to signin
    await win.loadURL('https://www.qobuz.com/us-en/');
    return { success: true };
  } catch (error) {
    mainLog.error('IPC open-qobuz-login-window failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to open window' };
  }
});

ipcMain.handle('probe-qobuz-download', async (_event, { trackId }: { trackId: string }) => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    const account = config.qobuzAccounts[0];
    if (!account) return { success: false, error: 'No Qobuz account configured' };
    await loginQobuz(account.id);
    const { probeQobuzDownload } = await import('./lib/storePurchase');
    const results = await probeQobuzDownload(account.id, trackId);
    return { success: true, results };
  } catch (error) {
    mainLog.error('IPC probe-qobuz-download failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Probe failed' };
  }
});

ipcMain.handle('probe-qobuz-purchases', async () => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    const account = config.qobuzAccounts[0];
    if (!account) return { success: false, error: 'No Qobuz account configured' };
    await loginQobuz(account.id);
    const results = await probeQobuzPurchases(account.id);
    const outPath = await writeScratchFile('qobuz_probe.json', JSON.stringify(results, null, 2));
    mainLog.info(`Wrote Qobuz probe to ${outPath}`);
    return { success: true, results, outPath };
  } catch (error) {
    mainLog.error('IPC probe-qobuz-purchases failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Probe failed' };
  }
});

ipcMain.handle('download-beatport-matches', async (event, { matches, destDir }: { matches: StoreMatch[]; destDir: string }) => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    // Log in every account — each match may come from a different one (via sourceAccountId).
    for (const a of config.beatportAccounts) await loginBeatport(a.id);
    const defaultId = config.beatportAccounts[0]?.id ?? LEGACY_ACCOUNT_ID;
    const result = await downloadBeatportPurchases(defaultId, matches, destDir, (p) => {
      event.sender.send('download-beatport-progress', p);
    });
    return { success: true, ...result };
  } catch (error) {
    mainLog.error('IPC download-beatport-matches failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Download failed' };
  }
});

ipcMain.handle('download-qobuz-matches-concurrent', async (event, { matches, destDir, concurrency }: { matches: StoreMatch[]; destDir: string; concurrency: number }) => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    for (const a of config.qobuzAccounts) await loginQobuz(a.id);
    const defaultId = config.qobuzAccounts[0]?.id ?? LEGACY_ACCOUNT_ID;
    const { downloadQobuzPurchases } = await import('./lib/storePurchase');
    const result = await downloadQobuzPurchases(defaultId, matches, destDir, (p) => {
      event.sender.send('download-qobuz-progress', p);
    }, concurrency);
    return { success: true, ...result };
  } catch (error) {
    mainLog.error('IPC download-qobuz-matches-concurrent failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Download failed' };
  }
});

ipcMain.handle('download-beatport-matches-concurrent', async (event, { matches, destDir, concurrency }: { matches: StoreMatch[]; destDir: string; concurrency: number }) => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    for (const a of config.beatportAccounts) await loginBeatport(a.id);
    const defaultId = config.beatportAccounts[0]?.id ?? LEGACY_ACCOUNT_ID;
    const result = await downloadBeatportPurchases(defaultId, matches, destDir, (p) => {
      event.sender.send('download-beatport-progress', p);
    }, concurrency);
    return { success: true, ...result };
  } catch (error) {
    mainLog.error('IPC download-beatport-matches-concurrent failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Download failed' };
  }
});

ipcMain.handle('fetch-store-purchases', async (_event, { source }: { source: 'qobuz' | 'beatport' }) => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    let owned;
    if (source === 'beatport') {
      owned = await fetchAllBeatportPurchases(config.beatportAccounts);
    } else {
      owned = await fetchAllQobuzPurchases(config.qobuzAccounts);
    }
    const outPath = await writeScratchFile(`owned_${source}.json`, JSON.stringify(owned, null, 2));
    mainLog.info(`Wrote ${owned.length} ${source} purchases to ${outPath}`);
    return { success: true, owned, outPath, count: owned.length };
  } catch (error) {
    mainLog.error(`IPC fetch-store-purchases (${source}) failed:`, error);
    return { success: false, error: error instanceof Error ? error.message : 'Fetch failed' };
  }
});

ipcMain.handle('store-search', async (event, { tracks, source }: { tracks: StoreTrackInput[]; source: 'qobuz' | 'beatport' }) => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    const onProgress = (p: import('./types').StoreSearchProgress) => {
      event.sender.send('store-search-progress', p);
    };
    const accountId = source === 'qobuz'
      ? (config.qobuzAccounts[0]?.id ?? LEGACY_ACCOUNT_ID)
      : (config.beatportAccounts[0]?.id ?? LEGACY_ACCOUNT_ID);
    const result = source === 'qobuz'
      ? await searchQobuzStore(accountId, tracks, onProgress)
      : await searchBeatportStore(accountId, tracks, onProgress);
    return { success: true, result };
  } catch (error) {
    mainLog.error('IPC store-search failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Search failed' };
  }
});

ipcMain.handle('store-search-all', async (event, { tracks }: { tracks: StoreTrackInput[] }) => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    const onProgress = (p: import('./types').StoreSearchProgress) => {
      event.sender.send('store-search-progress', p);
    };
    const onMatch = (match: StoreMatch) => {
      event.sender.send('store-search-match', match);
    };

    // Log in + fetch purchases for every configured account
    event.sender.send('store-search-progress', { current: 0, total: tracks.length, currentTrack: 'Checking past purchases...', source: 'qobuz' as const });
    const purchaseCheckWarnings: string[] = [];
    const [qobuzOwned, beatportOwned] = await Promise.all([
      fetchAllQobuzPurchases(config.qobuzAccounts).catch((e) => {
        purchaseCheckWarnings.push(`Qobuz past-purchase check failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }),
      fetchAllBeatportPurchases(config.beatportAccounts).catch((e) => {
        purchaseCheckWarnings.push(`Beatport past-purchase check failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }),
    ]);
    // A failed fetch (null) is NOT the same as "owns nothing" ([]). When it fails
    // we can't confirm ownership, so the owned short-circuit is skipped for that
    // source and the caller is warned rather than silently re-routing owned tracks.
    const allOwned = [...(qobuzOwned ?? []), ...(beatportOwned ?? [])];
    mainLog.info(`Found ${qobuzOwned?.length ?? 0} Qobuz + ${beatportOwned?.length ?? 0} Beatport past purchases${purchaseCheckWarnings.length ? ` (${purchaseCheckWarnings.length} check(s) failed)` : ''}`);

    // Separate tracks into already-owned vs needs-purchase
    const tracksToSearch: StoreTrackInput[] = [];
    const allMatches: StoreMatch[] = [];

    for (const track of tracks) {
      const owned = matchesOwnedTrack(track, allOwned);
      if (owned) {
        // Emit as an owned match — no need to search stores
        const match: StoreMatch = {
          input: track,
          trackId: '',
          title: track.title,
          artist: track.artist,
          album: track.album || '',
          label: '',
          price: '',
          quality: '',
          format: owned.source === 'qobuz' ? 'FLAC' : 'WAV/AIFF',
          lossless: true,
          rx3Compatible: owned.source === 'beatport',
          confidence: 1.0,
          url: '',
          source: owned.source,
          ownedOn: owned.source
        };
        allMatches.push(match);
        onMatch(match);
      } else {
        tracksToSearch.push(track);
      }
    }

    // Search Beatport first — WAV/AIFF is RX3-compatible out of the box
    const beatportSearchAccountId = config.beatportAccounts[0]?.id ?? LEGACY_ACCOUNT_ID;
    const qobuzSearchAccountId = config.qobuzAccounts[0]?.id ?? LEGACY_ACCOUNT_ID;
    if (tracksToSearch.length > 0) {
      const beatportResult = await searchBeatportStore(beatportSearchAccountId, tracksToSearch, onProgress, onMatch);
      allMatches.push(...beatportResult.matches);

      // Search Qobuz for tracks Beatport didn't have (FLAC — needs conversion but still lossless)
      const qobuzInputs = beatportResult.notFound;
      if (qobuzInputs.length > 0) {
        const qobuzResult = await searchQobuzStore(qobuzSearchAccountId, qobuzInputs, onProgress, onMatch);
        allMatches.push(...qobuzResult.matches);
      }
    }

    // Auto-save results
    const resultsPath = path.join(app.getPath('userData'), 'store-search-results.json');
    await fs.promises.writeFile(resultsPath, JSON.stringify({
      matches: allMatches,
      savedAt: new Date().toISOString(),
      trackCount: tracks.length
    }), 'utf-8');

    return {
      success: true,
      matchCount: allMatches.length,
      purchaseCheckWarning: purchaseCheckWarnings.length ? purchaseCheckWarnings.join('; ') : undefined,
    };
  } catch (error) {
    mainLog.error('IPC store-search-all failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Search failed' };
  }
});

ipcMain.handle('store-load-results', async () => {
  try {
    const resultsPath = path.join(app.getPath('userData'), 'store-search-results.json');
    const data = await fs.promises.readFile(resultsPath, 'utf-8');
    const parsed = JSON.parse(data) as { matches: StoreMatch[]; savedAt: string; trackCount: number };
    return { success: true, ...parsed };
  } catch {
    return { success: false };
  }
});

ipcMain.handle('store-clear-results', async () => {
  try {
    const resultsPath = path.join(app.getPath('userData'), 'store-search-results.json');
    await fs.promises.unlink(resultsPath).catch(() => {});
    return { success: true };
  } catch {
    return { success: true };
  }
});

ipcMain.handle('store-cart-add', async (event, { matches, source }: { matches: StoreMatch[]; source: 'qobuz' | 'beatport' }) => {
  try {
    const onProgress = (p: import('./types').StoreCartProgress) => {
      event.sender.send('store-cart-progress', p);
    };

    // Re-authenticate before adding to cart (session may have expired since search).
    // Cart add always uses the first configured account — the user can't have
    // multiple carts open at once anyway.
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    const account = source === 'qobuz' ? config.qobuzAccounts[0] : config.beatportAccounts[0];
    if (!account) return { success: false, error: `No ${source} account configured` };
    if (source === 'qobuz') {
      await loginQobuz(account.id);
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
    return { success: true, result };
  } catch (error) {
    mainLog.error('IPC store-cart-add failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Cart add failed' };
  }
});

ipcMain.handle('store-open-cart', async (_event, { store }: { store: 'qobuz' | 'beatport' }) => {
  // Open cart in embedded panel instead of separate window
  await openStorePanel(store, cartUrl(store));
  return { success: true };
});

ipcMain.handle('store-download-purchases', async (event, { matches }: { matches: StoreMatch[] }) => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    const destDir = config.organizeSourceDir;
    if (!destDir) return { success: false, error: 'No organize source directory configured' };

    const onProgress = (p: import('./lib/storePurchase').DownloadProgress) => {
      event.sender.send('store-download-progress', p);
    };

    const qobuzTracks = matches.filter(m => m.source === 'qobuz');
    const beatportTracks = matches.filter(m => m.source === 'beatport');

    const allDownloaded: string[] = [];
    const allFailed: Array<{ artist: string; title: string; error: string }> = [];

    if (qobuzTracks.length > 0) {
      for (const a of config.qobuzAccounts) await loginQobuz(a.id);
      const defaultQobuzId = config.qobuzAccounts[0]?.id ?? LEGACY_ACCOUNT_ID;
      const result = await downloadQobuzPurchases(defaultQobuzId, qobuzTracks, destDir, onProgress);
      allDownloaded.push(...result.downloaded);
      allFailed.push(...result.failed);
    }

    if (beatportTracks.length > 0) {
      for (const a of config.beatportAccounts) await loginBeatport(a.id);
      const defaultBeatportId = config.beatportAccounts[0]?.id ?? LEGACY_ACCOUNT_ID;
      const result = await downloadBeatportPurchases(defaultBeatportId, beatportTracks, destDir, onProgress);
      allDownloaded.push(...result.downloaded);
      allFailed.push(...result.failed);
    }

    return { success: true, downloaded: allDownloaded.length, failed: allFailed, destDir };
  } catch (error) {
    mainLog.error('IPC store-download-purchases failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Download failed' };
  }
});

// Track scanning and organization handlers
ipcMain.handle('scan-tracks', async (event, { sourceDir }: { sourceDir: string }): Promise<TrackInfo[]> => {
  try {
    return scanTracks(sourceDir, (payload) => {
      event.sender.send('scan-progress', payload);
    });
  } catch (error) {
    mainLog.error('IPC scan-tracks failed:', error);
    throw error;
  }
});

ipcMain.handle('scan-missing-album-art', async (event) => {
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

ipcMain.handle('get-track-info', async (_event, { filePath }: { filePath: string }): Promise<TrackInfo | null> => {
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

ipcMain.handle('update-track-tags', async (event, params: UpdateTagsParams): Promise<TrackInfo> => {
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
});

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

ipcMain.handle('diagnose-aiff-header', async (_event, filePath: string): Promise<AiffHeaderDiagnosis> => {
  try {
    return await diagnoseAiffHeader(filePath);
  } catch (error) {
    mainLog.error('IPC diagnose-aiff-header failed:', error);
    throw error;
  }
});

ipcMain.handle('repair-aiff-header', async (_event, filePath: string): Promise<boolean> => {
  try {
    return await repairAiffHeader(filePath);
  } catch (error) {
    mainLog.error('IPC repair-aiff-header failed:', error);
    throw error;
  }
});

ipcMain.handle('select-image', async (): Promise<string | null> => {
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

ipcMain.handle(
  'organize-tracks',
  async (
    event,
    { tracks }: { tracks: Array<{ filePath: string; ignored: boolean; isHealthy?: boolean }> }
  ): Promise<OrganizeResult[]> => {
    try {
      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const log = createLogger(event.sender, runId);

      event.sender.send('script-output', { id: runId, stream: 'status', text: `--- Organize by Artist ---\n` });

      const results = await organizeTracks({
        tracks,
        rootDir: await getLibraryRoot(),
        log,
        onProgress: (payload) => {
          event.sender.send('organize-progress', payload);
        }
      });

      log('Process exited with code 0', 'status');
      return results;
    } catch (error) {
      mainLog.error('IPC organize-tracks failed:', error);
      throw error;
    }
  }
);

// Resolve organize conflict: keep 'incoming' (replace existing) or 'existing' (discard incoming)
ipcMain.handle(
  'organize-resolve-conflict',
  async (
    _event,
    { incomingPath, existingPath, targetPath, keep }: { incomingPath: string; existingPath: string; targetPath: string; keep: 'incoming' | 'existing' }
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      if (keep === 'incoming') {
        // Stage incoming beside the target FIRST so a mid-operation failure can
        // never destroy the existing file before its replacement is in place.
        const stagingPath = `${targetPath}.incoming-${Date.now()}`;
        await safeMove(incomingPath, stagingPath, 'organize-conflict:stage');
        await safeDelete(existingPath, { context: 'organize-conflict:keep-incoming' });
        await safeMove(stagingPath, targetPath, 'organize-conflict:finalize');
      } else {
        // Keep existing, discard the incoming file (recoverable via Trash).
        await safeDelete(incomingPath, { context: 'organize-conflict:keep-existing' });
      }
      return { success: true };
    } catch (error) {
      mainLog.error('IPC organize-resolve-conflict failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to resolve conflict' };
    }
  }
);

// Extract embedded album art from an audio file
ipcMain.handle('get-track-album-art', async (_event, { filePath }: { filePath: string }): Promise<string | null> => {
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
ipcMain.handle('toggle-devtools', (event) => {
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

// Open external URL in default browser
ipcMain.handle('open-external', async (_event, { url }: { url: string }) => {
  await shell.openExternal(url);
});

// Show file in Finder / file manager
ipcMain.handle('show-in-finder', async (_event, { filePath }: { filePath: string }) => {
  shell.showItemInFolder(filePath);
});

// Track conversion handler
ipcMain.handle(
  'convert-track',
  async (event, { filePath }: { filePath: string }): Promise<ConversionResult> => {
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
  }
);

// Library health scan handler with streaming progress and caching
ipcMain.handle(
  'scan-library-health',
  async (event, { useCache = true, cacheOnly = false }: { useCache?: boolean; cacheOnly?: boolean }): Promise<{ id: string; result?: LibraryHealthResult; fromCache: boolean; cacheOnly?: boolean }> => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const libraryRoot = await getLibraryRoot();

    // Serve from SQLite snapshot if the caller accepts cached data
    if (useCache || cacheOnly) {
      const cached = getHealthSnapshot(libraryRoot);
      if (cached) {
        mainLog.debug('scan-library-health: serving SQLite snapshot');
        event.sender.send('health-scan-progress', { id: runId, phase: 'complete', current: cached.summary.total, total: cached.summary.total });
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
ipcMain.handle(
  'delete-track-file',
  async (event, { filePath }: { filePath: string }): Promise<{ success: boolean; error?: string }> => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const log = createLogger(event.sender, runId);
    try {
      log(`Deleting: ${path.basename(filePath)}\n`);
      await safeDelete(filePath, { context: 'delete-track-file' });
      log(`Moved to Trash: ${path.basename(filePath)}\n`, 'status');
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete file';
      log(`Delete failed for ${path.basename(filePath)}: ${message}\n`, 'stderr');
      mainLog.error('IPC delete-track-file failed:', filePath, error);
      return { success: false, error: message };
    }
  }
);

// Fix track file handler (convert to compatible format)
ipcMain.handle(
  'fix-track-file',
  async (event, { filePath, deleteOriginal }: { filePath: string; deleteOriginal: boolean }): Promise<ConversionResult> => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const log = createLogger(event.sender, runId);
    log(`Fixing to AIFF: ${path.basename(filePath)}\n`);

    const result = await convertToAiff(filePath, (progress) => {
      if (progress.percent >= 0) log(`Progress: ${progress.percent}%\n`);
    });

    if (result.success) {
      log(`Fixed: ${path.basename(result.outputPath!)}\n`, 'status');
      if (deleteOriginal && result.outputPath && path.resolve(result.outputPath) !== path.resolve(filePath)) {
        try {
          await safeDelete(filePath, { context: 'fix-track:delete-original', detail: { convertedTo: result.outputPath } });
          log(`Moved original to Trash: ${path.basename(filePath)}\n`);
        } catch (error) {
          mainLog.debug('Failed to delete original after fix-track:', filePath, error);
          log(`Failed to remove original ${path.basename(filePath)}\n`, 'stderr');
        }
      }
    } else {
      log(`Fix failed for ${path.basename(filePath)}: ${result.errorMessage || 'Unknown error'}\n`, 'stderr');
    }

    return result;
  }
);

// Re-encode track file handler (fix bitrate issues by re-encoding to 320kbps MP3)
ipcMain.handle(
  'reencode-track-file',
  async (event, { filePath, deleteOriginal }: { filePath: string; deleteOriginal: boolean }): Promise<ConversionResult> => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const log = createLogger(event.sender, runId);
    log(`Re-encoding to 320kbps: ${path.basename(filePath)}\n`);

    const result = await reencodeToMp3(filePath);

    if (result.success) {
      log(`Re-encoded: ${path.basename(result.outputPath!)}\n`, 'status');
      if (deleteOriginal && result.outputPath && path.resolve(result.outputPath) !== path.resolve(filePath)) {
        try {
          await safeDelete(filePath, { context: 'reencode:delete-original', detail: { convertedTo: result.outputPath } });
          log(`Moved original to Trash: ${path.basename(filePath)}\n`);
        } catch (error) {
          mainLog.debug('Failed to delete original after reencode:', filePath, error);
          log(`Failed to remove original ${path.basename(filePath)}\n`, 'stderr');
        }
      }
    } else {
      log(`Re-encode failed for ${path.basename(filePath)}: ${result.errorMessage || 'Unknown error'}\n`, 'stderr');
    }

    return result;
  }
);

// Generic job queue handlers
ipcMain.handle('job-enqueue', async (_event, { type, params, contextKey }: { type: string; params: unknown; contextKey: string }) => {
  try {
    const { jobId } = getJobManager().enqueue(type as any, params as any, contextKey);
    return { jobId };
  } catch (error) {
    mainLog.error('IPC job-enqueue failed:', error);
    throw error;
  }
});

ipcMain.handle('job-enqueue-and-wait', async (_event, { type, params, contextKey }: { type: string; params: unknown; contextKey: string }) => {
  try {
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

ipcMain.handle('job-cancel', async (_event, { jobId }: { jobId: string }) => {
  try {
    return getJobManager().cancel(jobId);
  } catch (error) {
    mainLog.error('IPC job-cancel failed:', error);
    return false;
  }
});

ipcMain.handle('job-list', async () => {
  try {
    return getJobManager().getAllJobs();
  } catch (error) {
    mainLog.error('IPC job-list failed:', error);
    return [];
  }
});

// List available volumes, filtering excluded names from config.
// The library volume is included but flagged with isLibrary = true.
ipcMain.handle('list-volumes', async () => {
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
ipcMain.handle('exclude-volume', async (_event, { name }: { name: string }) => {
  try {
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    const existing = config.excludedVolumes ?? [];
    if (!existing.includes(name)) {
      const updated = { ...config, excludedVolumes: [...existing, name] };
      await writeConfig(CONFIG_PATH, updated);
    }
    return { success: true };
  } catch (error) {
    mainLog.error('IPC exclude-volume failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed' };
  }
});

// Archive track file handler (move to .archive folder next to library)
ipcMain.handle(
  'archive-track-file',
  async (event, { filePath }: { filePath: string }): Promise<ArchiveResult> => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const log = createLogger(event.sender, runId);
    log(`Archiving: ${path.basename(filePath)}\n`);
    const config = await readConfig(CONFIG_PATH, CONFIG_DEFAULTS_PATH);
    const archivePath = config.archivePath || getDefaultArchivePath();
    const result = await archiveTrackFile(filePath, await getLibraryRoot(), archivePath);
    if (result.success) {
      log(`Archived to: ${result.archivePath ?? archivePath}\n`, 'status');
    } else {
      log(`Archive failed for ${path.basename(filePath)}: ${result.errorMessage || 'Unknown error'}\n`, 'stderr');
    }
    return result;
  }
);

// Migrate archive contents from old path to new path
ipcMain.handle(
  'migrate-archive',
  async (event, { oldPath, newPath }: { oldPath: string; newPath: string }): Promise<{ success: boolean; error?: string }> => {
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
        event.sender.send('migrate-progress', {
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
  }
);

// ========== Restore Library ==========

ipcMain.handle('restore-list-volumes', async () => {
  try {
    const volumes = await listExternalVolumes();
    return { success: true, volumes };
  } catch (error) {
    mainLog.error('IPC restore-list-volumes failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to list volumes' };
  }
});

ipcMain.handle('restore-pick-xml', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose Rekordbox XML',
    properties: ['openFile'],
    filters: [{ name: 'Rekordbox XML', extensions: ['xml'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { success: true, path: null };
  return { success: true, path: result.filePaths[0] };
});

let restoreAbortController: AbortController | null = null;

ipcMain.handle('restore-run', async (event, { options }: { options: Omit<RestoreOptions, 'beatportAccounts' | 'qobuzAccounts'> }) => {
  restoreAbortController = new AbortController();
  try {
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
      event.sender.send('restore-progress', p);
    }, restoreAbortController.signal);
    // Persist a copy of the report to user data for later reference.
    const reportPath = path.join(app.getPath('userData'), `restore-report-${Date.now()}.json`);
    await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2));
    return { success: true, report, reportPath };
  } catch (error) {
    const aborted = restoreAbortController?.signal.aborted;
    if (aborted) {
      mainLog.info('Restore aborted by user');
      return { success: false, aborted: true, error: 'Restore aborted' };
    }
    mainLog.error('IPC restore-run failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Restore failed' };
  } finally {
    restoreAbortController = null;
  }
});

ipcMain.handle('restore-abort', () => {
  restoreAbortController?.abort();
  return { success: true, aborting: restoreAbortController !== null };
});

// --- Splice recovery (Ableton .als sample re-download) -------------------

ipcMain.handle('splice-login-status', async () => {
  try {
    const { getLoginStatus } = await import('./lib/spliceRecovery');
    return { success: true, status: await getLoginStatus() };
  } catch (error) {
    mainLog.error('IPC splice-login-status failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Status check failed' };
  }
});

ipcMain.handle('splice-start-login', async () => {
  try {
    const { startLogin } = await import('./lib/spliceRecovery');
    return await startLogin();
  } catch (error) {
    mainLog.error('IPC splice-start-login failed:', error);
    return { ok: false, error: error instanceof Error ? error.message : 'Login launch failed' };
  }
});

ipcMain.handle('splice-pick-als', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose Ableton project (.als)',
    properties: ['openFile'],
    filters: [{ name: 'Ableton Live Set', extensions: ['als'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { success: true, path: null };
  return { success: true, path: result.filePaths[0] };
});

ipcMain.handle('splice-scan', async (_event, { alsPath }: { alsPath: string }) => {
  try {
    const { scan } = await import('./lib/spliceRecovery');
    const result = await scan(alsPath);
    return { success: true, result };
  } catch (error) {
    mainLog.error('IPC splice-scan failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Scan failed' };
  }
});

ipcMain.handle('splice-classify', async (event, { missing }: { missing: import('./lib/spliceRecovery').SpliceMissingSample[] }) => {
  try {
    const { classify, writeManifest } = await import('./lib/spliceRecovery');
    const buckets = await classify(missing, (p) => {
      event.sender.send('splice-progress', p);
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

ipcMain.handle('splice-download-owned', async (event, { items }: { items: import('./lib/spliceRecovery').SpliceOwnedItem[] }) => {
  try {
    const { downloadOwned } = await import('./lib/spliceRecovery');
    const report = await downloadOwned(items, (p) => {
      event.sender.send('splice-progress', p);
    });
    return { success: true, report };
  } catch (error) {
    mainLog.error('IPC splice-download-owned failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Download failed' };
  }
});

ipcMain.handle('splice-credits-balance', async () => {
  try {
    const { getCreditsBalance } = await import('./lib/spliceRecovery');
    const balance = await getCreditsBalance();
    return { success: true, balance };
  } catch (error) {
    mainLog.error('IPC splice-credits-balance failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Balance fetch failed' };
  }
});

ipcMain.handle('splice-buy-credits', async (event, { items }: { items: import('./lib/spliceRecovery').SpliceCreditsItem[] }) => {
  try {
    const { buyCreditsBucket } = await import('./lib/spliceRecovery');
    const report = await buyCreditsBucket(items, (p) => {
      event.sender.send('splice-progress', p);
    });
    return { success: true, report };
  } catch (error) {
    mainLog.error('IPC splice-buy-credits failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Purchase failed' };
  }
});
