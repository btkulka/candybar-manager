import { getErrorMessage } from '../lib/errorUtils';
export { getErrorMessage };

import type {
  ScriptOutput,
  SuggestedAction,
  HealthIssue,
  TrackHealth,
  TrackInfo,
  AlbumArtMissingTrack,
  AlbumArtScanProgress,
  ScanProgress,
  UpdateTagsParams,
  OrganizeResult,
  OrganizeConflictFile,
  OrganizeProgress,
  ConversionResult,
  HealthSummary,
  LibraryHealthTrack,
  DuplicateTrackInfo,
  DuplicatePair,
  LibraryHealthResult,
  CheckTrackRecord,
  CheckMatchCandidate,
  CheckMatchedTrack,
  CheckMissingTrack,
  CheckUncertainMatch,
  CheckResultFull,
  CheckProgress,
  CsvPreview,
  CacheStatus,
  StorageStats,
  AppConfig,
  StoreTrackInput,
  StoreMatch,
  StoreSearchProgress,
  StoreCartProgress,
  StoreSearchResult,
  StoreCartResult,
  OrganizeState,
  VolumeInfo,
  UsbVolumeIssue,
  UsbHealthResult,
  UsbHealthProgress
} from '../types';
import type { AiffHeaderDiagnosis } from '../lib/aiffRepair';

export type {
  ScriptOutput,
  SuggestedAction,
  HealthIssue,
  TrackHealth,
  TrackInfo,
  AlbumArtMissingTrack,
  AlbumArtScanProgress,
  ScanProgress,
  UpdateTagsParams,
  OrganizeResult,
  OrganizeConflictFile,
  OrganizeProgress,
  ConversionResult,
  HealthSummary,
  LibraryHealthTrack,
  DuplicateTrackInfo,
  DuplicatePair,
  LibraryHealthResult,
  CheckTrackRecord,
  CheckMatchCandidate,
  CheckMatchedTrack,
  CheckMissingTrack,
  CheckUncertainMatch,
  CheckResultFull,
  CheckProgress,
  CsvPreview,
  CacheStatus,
  StorageStats,
  AppConfig,
  OrganizeState,
  VolumeInfo,
  UsbVolumeIssue,
  UsbHealthResult,
  UsbHealthProgress
};

// Renderer-local types

type SpotifySearchTrack = {
  id: string;
  name: string;
  artists: string[];
  album: string;
  album_image_url: string | null;
  external_url: string;
  popularity: number;
  release_year: string | null;
};

type SpotifySearchResult = {
  tracks: SpotifySearchTrack[];
};

type SoundCloudSearchTrack = {
  id: number;
  title: string;
  user: string;
  artwork_url: string | null;
  permalink_url: string;
  genre: string | null;
  playback_count: number;
};

type SoundCloudSearchResult = {
  tracks: SoundCloudSearchTrack[];
};

export type MusicSearchResult = {
  spotify: SpotifySearchResult | null;
  soundcloud: SoundCloudSearchResult | null;
  errors: { source: string; message: string }[];
};

export type AlbumArtSuggestion = {
  source: 'spotify' | 'soundcloud';
  title: string;
  artist: string;
  imageUrl: string;
  confidence: number;
  externalUrl?: string;
  album?: string;
  year?: string;
  genre?: string;
};

declare global {
  interface Window {
    candybar: {
      selectPath: (type: 'file' | 'dir') => Promise<string | null>;
      checkLibrary: (
        source: { csvPath?: string; spotifyPlaylistUrl?: string },
        useCache?: boolean,
        cacheOnly?: boolean
      ) => Promise<{ id: string; success: boolean; result?: CheckResultFull; fromCache?: boolean; cacheOnly?: boolean; error?: string }>;
      getConfig: () => Promise<AppConfig>;
      getLibraryRoot: () => Promise<string>;
      setConfig: (config: AppConfig) => Promise<AppConfig>;
      migrateArchive: (oldPath: string, newPath: string) => Promise<{ success: boolean; error?: string }>;
      onMigrateProgress: (callback: (payload: { current: number; total: number; file: string }) => void) => void;
      checkSpotify: () => Promise<boolean>;
      checkSoundCloud: () => Promise<boolean>;
      searchMusic: (query: string, sources: ('spotify' | 'soundcloud' | 'beatport' | 'qobuz')[]) =>
        Promise<MusicSearchResult>;
      onOutput: (callback: (payload: ScriptOutput) => void) => void;
      onCheckProgress: (callback: (payload: CheckProgress) => void) => void;
      scanTracks: (sourceDir: string) => Promise<TrackInfo[]>;
      onScanProgress: (callback: (payload: ScanProgress) => void) => () => void;
      autopopulateTracks: (tracks: Array<{ filePath: string; title: string; artist: string; album: string; year: string; genre: string; label: string; key: string; bpm: string; remixer: string; hasAlbumArt: boolean }>, force?: boolean) =>
        Promise<Array<{ filePath: string; updated: boolean; fieldsPopulated: string[]; error?: string }>>;
      onAutopopulateProgress: (callback: (payload: { current: number; total: number; filePath: string }) => void) => void;
      scanMissingAlbumArt: () => Promise<{ id: string; tracks: AlbumArtMissingTrack[] }>;
      onPolishScanProgress: (callback: (payload: AlbumArtScanProgress) => void) => void;
      updateTrackTags: (params: UpdateTagsParams) => Promise<TrackInfo>;
      getTrackInfo: (filePath: string) => Promise<TrackInfo | null>;
      diagnoseAiffHeader: (filePath: string) => Promise<AiffHeaderDiagnosis>;
      repairAiffHeader: (filePath: string) => Promise<boolean>;
      selectImage: () => Promise<string | null>;
      organizeTracks: (
        tracks: Array<{ filePath: string; ignored: boolean; isHealthy?: boolean }>
      ) => Promise<OrganizeResult[]>;
      onOrganizeProgress: (callback: (payload: OrganizeProgress) => void) => () => void;
      organizeResolveConflict: (
        incomingPath: string, existingPath: string, targetPath: string, keep: 'incoming' | 'existing'
      ) => Promise<{ success: boolean; error?: string }>;
      getTrackAlbumArt: (filePath: string) => Promise<string | null>;
      toggleDevTools: () => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      showInFinder: (filePath: string) => Promise<void>;
      convertTrack: (filePath: string) => Promise<ConversionResult>;
      scanLibraryHealth: (useCache?: boolean, cacheOnly?: boolean) => Promise<{ id: string; result?: LibraryHealthResult; fromCache: boolean; cacheOnly?: boolean }>;
      previewCsv: (csvPath: string) => Promise<CsvPreview>;
      getCacheStatus: () => Promise<CacheStatus>;
      clearCache: () => Promise<{ success: boolean }>;
      updateCheckResult: (result: any) => Promise<{ success: boolean }>;
      updateHealthResult: (result: any) => Promise<{ success: boolean }>;
      getOrganizeState: () => Promise<OrganizeState | null>;
      updateOrganizeState: (state: OrganizeState) => Promise<{ success: boolean }>;
      getStorageStats: () => Promise<StorageStats>;
      showSaveDialog: (defaultName: string) => Promise<string | null>;
      exportTracksCsv: (
        tracks: Array<{ artist: string; title: string; album?: string; genre?: string }>,
        filePath: string
      ) => Promise<{ success: boolean; filePath?: string; error?: string }>;
      showSaveDialogM3u8: (defaultName: string) => Promise<string | null>;
      exportPlaylistM3u8: (
        tracks: Array<{ artist: string; title: string; filePath?: string }>,
        filePath: string
      ) => Promise<{ success: boolean; filePath?: string; trackCount?: number; error?: string }>;
      showSaveDialogRekordbox: (defaultName: string) => Promise<string | null>;
      exportPlaylistRekordbox: (
        tracks: Array<{ artist: string; title: string; filePath?: string; duration?: number }>,
        filePath: string,
        playlistName: string
      ) => Promise<{ success: boolean; filePath?: string; trackCount?: number; error?: string }>;
      archiveTrackFile: (filePath: string) => Promise<{ success: boolean; originalPath: string; archivePath?: string; errorMessage?: string }>;
      deleteTrackFile: (filePath: string) => Promise<{ success: boolean; error?: string }>;
      fixTrackFile: (filePath: string, deleteOriginal: boolean) => Promise<ConversionResult>;
      reencodeTrackFile: (filePath: string, deleteOriginal: boolean) => Promise<ConversionResult>;
      onHealthScanProgress: (callback: (payload: { id: string; phase: string; current: number; total: number }) => void) => void;
      ignoreTrack: (key: string, artist: string, title: string) => Promise<{ success: boolean }>;
      unignoreTrack: (key: string) => Promise<{ success: boolean }>;
      getIgnoredTracks: () => Promise<Array<{ key: string; artist: string; title: string; ignored_at: string }>>;
      dismissDuplicate: (track1Artist: string, track1Title: string, track2Artist: string, track2Title: string) => Promise<{ success: boolean }>;
      dismissHealthIssue: (libraryRoot: string, filePath: string, issueCode: string) => Promise<{ success: boolean }>;
      undismissHealthIssue: (libraryRoot: string, filePath: string, issueCode: string) => Promise<{ success: boolean }>;
      getDismissedIssues: (libraryRoot: string) => Promise<Array<{ filePath: string; issueCode: string }>>;
      showSaveDialogJson: (defaultName: string) => Promise<string | null>;
      exportCatalog: (outputPath: string) => Promise<{ id: string; success: boolean; total?: number; exported?: number; skipped?: number; error?: string }>;
      jobEnqueue: (type: string, params: unknown, contextKey: string) => Promise<{ jobId: string }>;
      jobEnqueueAndWait: (type: string, params: unknown, contextKey: string) => Promise<{ jobId: string; success: boolean; result?: unknown; error?: string }>;
      jobCancel: (jobId: string) => Promise<boolean>;
      jobList: () => Promise<import('../types').JobInfo[]>;
      onJobUpdate: (callback: (info: import('../types').JobInfo) => void) => void;
      onJobProgress: (callback: (progress: import('../types').JobProgress) => void) => void;

      // Source search (CSV or Spotify playlist → lossless purchase sources)
      sourceSearch: (source: { csvPath?: string; spotifyPlaylistUrl?: string }) =>
        Promise<{ success: boolean; matches?: import('../lib/qobuzCart').QobuzCartMatch[]; error?: string }>;
      sourceExportCsv: (content: string, filePath: string) =>
        Promise<{ success: boolean; filePath?: string; error?: string }>;

      // Combined library-check + store-search pipeline.
      librarySourcingRun: (source: { csvPath?: string; spotifyPlaylistUrl?: string }) =>
        Promise<{ success: boolean; result?: import('../types').LibrarySourcingResult; error?: string }>;
      onLibrarySourcingPhase1Progress: (callback: (payload: { phase?: string; current: number; total: number; message?: string }) => void) => void;
      onLibrarySourcingPhase2Progress: (callback: (payload: { current: number; total: number; currentTrack: string }) => void) => void;
      onLibrarySourcingPhase2Match: (callback: (match: import('../lib/qobuzCart').QobuzCartMatch) => void) => void;
      onLibrarySourcingPlaylistInfo: (callback: (info: import('../types').SourcePlaylistInfo) => void) => void;

      // Qobuz cart integration
      qobuzCartSearch: (tracks: Array<{ key: string; artist: string; title: string; album?: string; duration?: number }>) =>
        Promise<{ success: boolean; matches?: import('../lib/qobuzCart').QobuzCartMatch[]; error?: string }>;
      onQobuzCartSearchProgress: (callback: (payload: { current: number; total: number; currentTrack: string }) => void) => void;
      onQobuzCartSearchMatch: (callback: (match: import('../lib/qobuzCart').QobuzCartMatch) => void) => void;
      qobuzCartAdd: (tracks: Array<{ id: string; url: string; name: string; artists: string[] }>) =>
        Promise<{ success: boolean; added?: string[]; failed?: Array<{ id: string; error: string }>; error?: string }>;
      onQobuzCartAddProgress: (callback: (payload: { current: number; total: number; currentTrack: string; phase: string; message: string }) => void) => void;
      qobuzBrowserClose: () => Promise<{ success: boolean }>;
      qobuzBrowserStatus: () => Promise<{ open: boolean }>;

      // Store purchase integration
      storeLogin: (store: 'qobuz' | 'beatport') => Promise<{ success: boolean; error?: string; perAccount?: Record<string, boolean> }>;
      storeLoginStatus: () => Promise<{ qobuz: boolean; beatport: boolean; qobuzAccounts: Record<string, boolean>; beatportAccounts: Record<string, boolean> }>;
      storeLoginAccount: (store: 'qobuz' | 'beatport', account: { id: string; email?: string; label?: string }) => Promise<{ success: boolean; error?: string }>;
      storeLogoutAccount: (store: 'qobuz' | 'beatport', accountId: string) => Promise<{ success: boolean; error?: string }>;
      storeSearch: (tracks: StoreTrackInput[], source: 'qobuz' | 'beatport') => Promise<{ success: boolean; result?: StoreSearchResult; error?: string }>;
      storeSearchAll: (tracks: StoreTrackInput[]) => Promise<{ success: boolean; matchCount?: number; error?: string }>;
      onStoreSearchProgress: (callback: (payload: StoreSearchProgress) => void) => void;
      onStoreSearchMatch: (callback: (match: StoreMatch) => void) => void;
      storeCartAdd: (matches: StoreMatch[], source: 'qobuz' | 'beatport') => Promise<{ success: boolean; result?: StoreCartResult; error?: string }>;
      onStoreCartProgress: (callback: (payload: StoreCartProgress) => void) => void;
      offStoreCartProgress: (callback: (payload: StoreCartProgress) => void) => void;
      storeOpenCart: (store: 'qobuz' | 'beatport') => Promise<{ success: boolean }>;
      storeLoadResults: () => Promise<{ success: boolean; matches?: StoreMatch[]; savedAt?: string; trackCount?: number }>;
      storeClearResults: () => Promise<{ success: boolean }>;
      storeDownloadPurchases: (matches: StoreMatch[]) => Promise<{ success: boolean; downloaded?: number; failed?: Array<{ artist: string; title: string; error: string }>; destDir?: string; error?: string }>;
      onStoreDownloadProgress: (callback: (payload: { current: number; total: number; currentTrack: string; phase: string; message: string }) => void) => void;

      // Store panel (embedded browser)
      storePanelOpen: (store: 'qobuz' | 'beatport', url: string) => Promise<{ success: boolean }>;
      storePanelClose: () => Promise<{ success: boolean }>;
      storePanelBack: () => Promise<{ success: boolean }>;
      storePanelForward: () => Promise<{ success: boolean }>;
      storePanelResize: (width: number) => Promise<{ success: boolean }>;
      storePanelStatus: () => Promise<{ open: boolean; store: string | null; url: string | null }>;
      storePanelCheckoutAdvance: (store: 'qobuz' | 'beatport') => Promise<{
        success: boolean;
        result?: { phase: 'place-order-ready'; total: string | null; buttonText: string }
                | { phase: 'advanced'; clickedText: string }
                | { phase: 'unknown' };
        error?: string;
      }>;
      storePanelPlaceOrder: (store: 'qobuz' | 'beatport') => Promise<{ success: boolean; clickedText?: string; error?: string }>;
      onStorePanelState: (callback: (state: { open: boolean; store: string | null; panelWidth: number }) => void) => void;
      onStorePanelAuth: (callback: (auth: { store: string; loggedIn: boolean }) => void) => void;
      onStorePanelNavigated: (callback: (nav: { url: string }) => void) => void;
      // USB Health
      listVolumes: () => Promise<{ success: boolean; volumes?: VolumeInfo[]; error?: string }>;
      excludeVolume: (name: string) => Promise<{ success: boolean; error?: string }>;
      onUsbHealthProgress: (callback: (payload: UsbHealthProgress) => void) => void;
      offUsbHealthProgress: () => void;

      // Rekordbox XML repair
      rekordboxScan: () => Promise<{
        total: number;
        missing: Array<{ trackId: string; filePath: string; artist: string; title: string; album: string }>;
        libraryRoot: string;
        xmlPath: string;
      }>;
      rekordboxImport: () => Promise<{
        libraryRoot: string;
        totalInXml: number;
        inLibraryRoot: number;
        missingOnDisk: number;
        imported: number;
      }>;
      rekordboxResync: () => Promise<{
        libraryRoot: string;
        totalInXml: number;
        inLibraryRoot: number;
        missingOnDisk: number;
        imported: number;
      }>;

      // Restore Library
      restoreListVolumes: () => Promise<{ success: boolean; volumes?: Array<{ name: string; mountPath: string; scanRoot: string }>; error?: string }>;
      restorePickXml: () => Promise<{ success: boolean; path: string | null }>;
      restoreRun: (options: {
        xmlPath: string; libraryRoot: string; stageDir: string;
        sources: { usb: boolean; beatport: boolean; qobuz: boolean; soundcloud: boolean };
        concurrency: number;
        usbVolumesAllowlist?: string[];
        usbTagMatching?: boolean;
        rewriteXml?: boolean;
      }) => Promise<{ success: boolean; report?: unknown; reportPath?: string; error?: string; aborted?: boolean }>;
      abortRestore: () => Promise<{ success: boolean; aborting: boolean }>;
      onRestoreProgress: (
        callback: (p: {
          phase: string;
          phaseStatus?: 'start' | 'update' | 'end' | 'skipped';
          message: string;
          currentTrack?: string;
          totals: { totalXmlTracks: number; alreadyInLibrary: number; missing: number; recovered: number; stillMissing: number };
          elapsedSec: number;
          estRemainingSec?: number;
          rate?: number;
          perAccount?: Array<{ accountId: string; service: 'qobuz' | 'beatport'; label?: string; email?: string; ownedCount?: number; matchedCount?: number; downloadedCount?: number; failedCount?: number }>;
          log?: { level: 'info' | 'warn' | 'error'; phase: string; message: string; timestamp: number; currentTrack?: string };
        }) => void,
      ) => (() => void);
    };
  }
}

// ========== Shared DOM Elements (lazy-initialized to avoid querying before DOMContentLoaded) ==========

let _statusText: HTMLSpanElement | null = null;
let _navLinks: NodeListOf<Element> | null = null;
let _pages: NodeListOf<Element> | null = null;
let _toastContainer: HTMLDivElement | null = null;

function getStatusText() { return _statusText ??= document.querySelector('.status-text') as HTMLSpanElement; }
function getNavLinks() { return _navLinks ??= document.querySelectorAll('.nav-link'); }
function getPages() { return _pages ??= document.querySelectorAll('.page'); }
function getToastContainer() { return _toastContainer ??= document.getElementById('toast-container') as HTMLDivElement; }

// ========== Toast System ==========

export type ToastType = 'success' | 'error' | 'warning' | 'info';

const toastIcons: Record<ToastType, string> = {
  success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
    <polyline points="22 4 12 14.01 9 11.01"/>
  </svg>`,
  error: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <line x1="15" y1="9" x2="9" y2="15"/>
    <line x1="9" y1="9" x2="15" y2="15"/>
  </svg>`,
  warning: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/>
    <line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>`,
  info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <line x1="12" y1="16" x2="12" y2="12"/>
    <line x1="12" y1="8" x2="12.01" y2="8"/>
  </svg>`
};

export function showToast(type: ToastType, title: string, message?: string, duration = 5000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const copyBtn = type === 'error' && message
    ? `<button class="toast-copy" data-tooltip="Copy error details">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
      </button>`
    : '';

  toast.innerHTML = `
    <div class="toast-icon">${toastIcons[type]}</div>
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      ${message ? `<div class="toast-message">${message}</div>` : ''}
    </div>
    <div class="toast-actions">
      ${copyBtn}
      <button class="toast-close" data-tooltip="Dismiss">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  `;

  if (type === 'error' && message) {
    const copyBtnEl = toast.querySelector('.toast-copy') as HTMLButtonElement;
    copyBtnEl.addEventListener('click', async () => {
      await navigator.clipboard.writeText(`${title}: ${message}`);
      copyBtnEl.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"/>
        </svg>`;
      copyBtnEl.setAttribute('data-tooltip', 'Copied!');
    });
  }

  const closeBtn = toast.querySelector('.toast-close') as HTMLButtonElement;
  const removeToast = () => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 200);
  };

  closeBtn.addEventListener('click', removeToast);

  getToastContainer().appendChild(toast);

  if (duration > 0) {
    setTimeout(removeToast, duration);
  }
}

// ========== SVG Icons ==========

export const icons = {
  pending: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <circle cx="12" cy="12" r="10"/>
  </svg>`,
  missingArtist: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/>
    <line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>`,
  success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
    <polyline points="22 4 12 14.01 9 11.01"/>
  </svg>`,
  error: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <circle cx="12" cy="12" r="10"/>
    <line x1="15" y1="9" x2="9" y2="15"/>
    <line x1="9" y1="9" x2="15" y2="15"/>
  </svg>`,
  albumPlaceholder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <circle cx="12" cy="12" r="4"/>
    <circle cx="12" cy="12" r="1"/>
  </svg>`,
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>`,
  ignore: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <circle cx="12" cy="12" r="10"/>
    <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
  </svg>`,
  include: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <circle cx="12" cy="12" r="10"/>
    <line x1="12" y1="8" x2="12" y2="16"/>
    <line x1="8" y1="12" x2="16" y2="12"/>
  </svg>`,
  healthOk: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
    <polyline points="22 4 12 14.01 9 11.01"/>
  </svg>`,
  healthWarning: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/>
    <line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>`,
  healthError: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <circle cx="12" cy="12" r="10"/>
    <line x1="15" y1="9" x2="9" y2="15"/>
    <line x1="9" y1="9" x2="15" y2="15"/>
  </svg>`,
  convert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="17 8 12 3 7 8"/>
    <line x1="12" y1="3" x2="12" y2="15"/>
  </svg>`,
  wrench: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
  </svg>`,
  archive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polyline points="21 8 21 21 3 21 3 8"/>
    <rect x="1" y="3" width="22" height="5"/>
    <line x1="10" y1="12" x2="14" y2="12"/>
  </svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polyline points="3 6 5 6 21 6"/>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
  </svg>`,
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  </svg>`,
  play: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polygon points="5 3 19 12 5 21 5 3"/>
  </svg>`
};

// ========== Utility Functions ==========

export function setStatus(text: string) {
  getStatusText().textContent = text;
}

export function appendLog(logEl: HTMLPreElement, text: string, stream: ScriptOutput['stream'] = 'stdout') {
  const prefix = stream === 'stderr' ? '[err] ' : '';
  logEl.textContent += `${prefix}${text}`;
  logEl.scrollTop = logEl.scrollHeight;
}

export function getValue(id: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  return input?.value?.trim() ?? '';
}

export function setValue(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  if (input) input.value = value;
}

export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  // textContent->innerHTML escapes &, <, > but NOT quotes. This value is often
  // interpolated into double-quoted HTML attributes (img src, title, data-fp),
  // so quotes must be escaped too or a value like `" onerror=alert(1) x="`
  // breaks out of the attribute and injects markup/handlers.
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ========== Context Menu ==========

export type ContextMenuItem = {
  label?: string;
  icon?: string;
  disabled?: boolean;
  separator?: boolean;
  action?: () => void;
};

let activeContextMenu: HTMLElement | null = null;

function dismissContextMenu() {
  if (activeContextMenu) {
    activeContextMenu.remove();
    activeContextMenu = null;
  }
}

document.addEventListener('click', dismissContextMenu);
document.addEventListener('contextmenu', (e) => {
  // Dismiss previous menu on new right-click anywhere
  if (activeContextMenu && !activeContextMenu.contains(e.target as Node)) {
    dismissContextMenu();
  }
});
window.addEventListener('blur', dismissContextMenu);

export function showContextMenu(x: number, y: number, items: ContextMenuItem[]) {
  dismissContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      menu.appendChild(sep);
      continue;
    }

    const row = document.createElement('div');
    row.className = 'context-menu-item';
    if (item.disabled) row.classList.add('disabled');

    row.innerHTML = `${item.icon ? `<span class="context-menu-icon">${item.icon}</span>` : ''}<span class="context-menu-label">${escapeHtml(item.label ?? '')}</span>`;

    if (!item.disabled && item.action) {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        dismissContextMenu();
        item.action!();
      });
    }

    menu.appendChild(row);
  }

  document.body.appendChild(menu);
  activeContextMenu = menu;

  // Position: ensure it fits within the viewport
  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  menu.style.left = `${x + rect.width > vw ? Math.max(0, x - rect.width) : x}px`;
  menu.style.top = `${y + rect.height > vh ? Math.max(0, y - rect.height) : y}px`;
}

// ========== Page Navigation ==========

export function setActiveTab(targetPage: string) {
  getNavLinks().forEach((l) => {
    l.classList.remove('active');
    if ((l as HTMLButtonElement).dataset.page === targetPage) {
      l.classList.add('active');
    }
  });

  getPages().forEach((page) => {
    page.classList.remove('active');
    if (page.id === `page-${targetPage}`) {
      page.classList.add('active');
    }
  });
}

// ========== String Similarity (Jaccard token-based) ==========

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stringSimilarity(a: string, b: string): number {
  const normA = normalizeText(a);
  const normB = normalizeText(b);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;

  const tokensA = new Set(normA.split(' ').filter(Boolean));
  const tokensB = new Set(normB.split(' ').filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  tokensA.forEach((token) => {
    if (tokensB.has(token)) intersection += 1;
  });
  const union = tokensA.size + tokensB.size - intersection;
  const jaccard = union === 0 ? 0 : intersection / union;
  const containsBoost = normA.includes(normB) || normB.includes(normA) ? 0.15 : 0;

  return Math.min(1, jaccard + containsBoost);
}

export function scoreSuggestion(
  track: { title: string; artist: string },
  title: string,
  artist: string
): number {
  const titleScore = stringSimilarity(track.title, title);
  const artistScore = stringSimilarity(track.artist, artist);
  const blended = titleScore * 0.7 + artistScore * 0.3;
  return Math.round(blended * 100);
}

export function getSoundCloudArtwork(url: string | null): string | null {
  if (!url) return null;
  return url.replace('-large', '-t500x500');
}

export async function fetchImageAsDataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch album art: ${response.statusText}`);
  }
  const blob = await response.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read album art data'));
    reader.readAsDataURL(blob);
  });
}

// AIFC files with invalid compressionType FourCC fail ffmpeg reads with
// "could not find COMM tag or invalid block_align value". The main-side
// updateTags catches that stderr pattern and rethrows as AIFC_CORRUPT_HEADER.
// This helper wraps updateTrackTags: on that specific failure, it asks the
// user to repair the header in place (4-byte edit) and retries once.
export async function updateTrackTagsWithRepair(
  params: UpdateTagsParams,
  fileLabel?: string,
): Promise<TrackInfo> {
  try {
    return await window.candybar.updateTrackTags(params);
  } catch (err) {
    const msg = getErrorMessage(err);
    if (!msg.startsWith('AIFC_CORRUPT_HEADER:')) throw err;

    const label = fileLabel || params.filePath.split('/').pop() || 'this file';
    const accept = window.confirm(
      `"${label}" has a corrupt AIFC header that blocks tag writing.\n\n` +
      `Repair it now? This rewrites 4 bytes in the header to mark the file ` +
      `as uncompressed PCM (which it already is). No audio data is changed.`
    );
    if (!accept) throw new Error('Repair declined');

    await window.candybar.repairAiffHeader(params.filePath);
    return await window.candybar.updateTrackTags(params);
  }
}

// Mirror of updateTrackTagsWithRepair for the convert-to-AIFF flow. ffmpeg
// refuses AIFC files with a junk compressionType FourCC; trackConverter.ts
// tags those failures with an AIFC_CORRUPT_HEADER: prefix so this helper can
// prompt for the 4-byte header repair and retry.
export async function convertTrackWithRepair(
  filePath: string,
  fileLabel?: string,
): Promise<ConversionResult> {
  const first = await window.candybar.convertTrack(filePath);
  if (first.success) return first;

  const msg = first.errorMessage || '';
  if (!msg.startsWith('AIFC_CORRUPT_HEADER:')) return first;

  const label = fileLabel || filePath.split('/').pop() || 'this file';
  const accept = window.confirm(
    `"${label}" has a corrupt AIFC header that blocks conversion.\n\n` +
    `Repair it now? This rewrites 4 bytes in the header to mark the file ` +
    `as uncompressed PCM (which it already is). No audio data is changed.`
  );
  if (!accept) return first;

  try {
    await window.candybar.repairAiffHeader(filePath);
  } catch (err) {
    return {
      success: false,
      originalPath: filePath,
      errorMessage: `Header repair failed: ${getErrorMessage(err)}`,
    };
  }
  return await window.candybar.convertTrack(filePath);
}

// ========== Service Status Checks ==========

let spotifyCollapseTimer: ReturnType<typeof setTimeout> | null = null;
let soundcloudCollapseTimer: ReturnType<typeof setTimeout> | null = null;
let qobuzCollapseTimer: ReturnType<typeof setTimeout> | null = null;
let beatportCollapseTimer: ReturnType<typeof setTimeout> | null = null;
let isCheckingSpotify = false;
let isCheckingSoundCloud = false;
let isCheckingStores = false;

function scheduleCollapse(element: HTMLElement, timer: ReturnType<typeof setTimeout> | null): ReturnType<typeof setTimeout> {
  if (timer) clearTimeout(timer);
  return setTimeout(() => {
    element.classList.add('collapsed');
  }, 2000);
}

export async function checkSpotifyConnection(showToasts = false) {
  if (isCheckingSpotify) return;
  isCheckingSpotify = true;

  const spotifyStatus = document.getElementById('spotify-status') as HTMLDivElement;
  const spotifyStatusText = spotifyStatus.querySelector('.spotify-status-text') as HTMLSpanElement;

  spotifyStatus.classList.remove('collapsed');
  if (spotifyCollapseTimer) clearTimeout(spotifyCollapseTimer);

  spotifyStatusText.textContent = 'Connecting';
  spotifyStatus.classList.remove('connected', 'disconnected');
  spotifyStatus.classList.add('checking');

  try {
    const connected = await window.candybar.checkSpotify();
    spotifyStatus.classList.remove('checking');

    if (connected) {
      spotifyStatus.classList.add('connected');
      spotifyStatusText.textContent = 'Connected';
      if (showToasts) {
        showToast('success', 'Spotify Connected', 'Successfully authenticated with Spotify API');
      }
    } else {
      spotifyStatus.classList.add('disconnected');
      spotifyStatusText.textContent = 'Not configured';
      if (showToasts) {
        showToast(
          'warning',
          'Spotify Not Configured',
          'Add your Client ID and Secret to the config file at ~/Library/Application Support/candybar-manager/config.json'
        );
      }
    }
    spotifyCollapseTimer = scheduleCollapse(spotifyStatus, spotifyCollapseTimer);
  } catch (err) {
    spotifyStatus.classList.remove('checking');
    spotifyStatus.classList.add('disconnected');
    spotifyStatusText.textContent = 'Error';
    if (showToasts) {
      const message = err instanceof Error ? err.message : 'Unknown error occurred';
      showToast('error', 'Spotify Connection Failed', message);
    }
    spotifyCollapseTimer = scheduleCollapse(spotifyStatus, spotifyCollapseTimer);
  } finally {
    isCheckingSpotify = false;
  }
}

export async function checkStoreConnections(showToasts = false) {
  if (isCheckingStores) return;
  isCheckingStores = true;

  const qobuzStatus = document.getElementById('qobuz-status') as HTMLDivElement;
  const qobuzStatusText = qobuzStatus.querySelector('.qobuz-status-text') as HTMLSpanElement;
  const beatportStatus = document.getElementById('beatport-status') as HTMLDivElement;
  const beatportStatusText = beatportStatus.querySelector('.beatport-status-text') as HTMLSpanElement;

  for (const el of [qobuzStatus, beatportStatus]) {
    el.classList.remove('collapsed', 'connected', 'disconnected');
    el.classList.add('checking');
  }
  if (qobuzCollapseTimer) clearTimeout(qobuzCollapseTimer);
  if (beatportCollapseTimer) clearTimeout(beatportCollapseTimer);
  qobuzStatusText.textContent = 'Checking';
  beatportStatusText.textContent = 'Checking';

  const applyState = (
    el: HTMLDivElement,
    text: HTMLSpanElement,
    connected: boolean,
    accountCount: number
  ) => {
    el.classList.remove('checking');
    if (connected) {
      el.classList.add('connected');
      text.textContent = accountCount > 1 ? `${accountCount} connected` : 'Connected';
    } else {
      el.classList.add('disconnected');
      text.textContent = accountCount > 0 ? 'Signed out' : 'Not configured';
    }
  };

  try {
    const statuses = await window.candybar.storeLoginStatus();
    const qobuzAccountCount = Object.keys(statuses.qobuzAccounts ?? {}).length;
    const qobuzConnectedCount = Object.values(statuses.qobuzAccounts ?? {}).filter(Boolean).length;
    const beatportAccountCount = Object.keys(statuses.beatportAccounts ?? {}).length;
    const beatportConnectedCount = Object.values(statuses.beatportAccounts ?? {}).filter(Boolean).length;

    applyState(qobuzStatus, qobuzStatusText, statuses.qobuz, qobuzConnectedCount || qobuzAccountCount);
    applyState(beatportStatus, beatportStatusText, statuses.beatport, beatportConnectedCount || beatportAccountCount);

    if (showToasts) {
      if (statuses.qobuz) {
        showToast('success', 'Qobuz Connected', qobuzConnectedCount > 1 ? `${qobuzConnectedCount} accounts signed in` : 'Signed in');
      } else {
        showToast('warning', 'Qobuz Not Connected', qobuzAccountCount > 0 ? 'Sign in from Settings → Qobuz' : 'Add a Qobuz account in Settings');
      }
      if (statuses.beatport) {
        showToast('success', 'Beatport Connected', beatportConnectedCount > 1 ? `${beatportConnectedCount} accounts signed in` : 'Signed in');
      } else {
        showToast('warning', 'Beatport Not Connected', beatportAccountCount > 0 ? 'Sign in from Settings → Beatport' : 'Add a Beatport account in Settings');
      }
    }

    qobuzCollapseTimer = scheduleCollapse(qobuzStatus, qobuzCollapseTimer);
    beatportCollapseTimer = scheduleCollapse(beatportStatus, beatportCollapseTimer);
  } catch (err) {
    for (const [el, text] of [[qobuzStatus, qobuzStatusText], [beatportStatus, beatportStatusText]] as const) {
      el.classList.remove('checking');
      el.classList.add('disconnected');
      text.textContent = 'Error';
    }
    if (showToasts) {
      const message = err instanceof Error ? err.message : 'Unknown error occurred';
      showToast('error', 'Store Status Check Failed', message);
    }
    qobuzCollapseTimer = scheduleCollapse(qobuzStatus, qobuzCollapseTimer);
    beatportCollapseTimer = scheduleCollapse(beatportStatus, beatportCollapseTimer);
  } finally {
    isCheckingStores = false;
  }
}

export async function checkSoundCloudConnection(showToasts = false) {
  if (isCheckingSoundCloud) return;
  isCheckingSoundCloud = true;

  const soundcloudStatus = document.getElementById('soundcloud-status') as HTMLDivElement;
  const soundcloudStatusText = soundcloudStatus.querySelector('.soundcloud-status-text') as HTMLSpanElement;

  soundcloudStatus.classList.remove('collapsed');
  if (soundcloudCollapseTimer) clearTimeout(soundcloudCollapseTimer);

  soundcloudStatusText.textContent = 'Connecting';
  soundcloudStatus.classList.remove('connected', 'disconnected');
  soundcloudStatus.classList.add('checking');

  try {
    const connected = await window.candybar.checkSoundCloud();
    soundcloudStatus.classList.remove('checking');

    if (connected) {
      soundcloudStatus.classList.add('connected');
      soundcloudStatusText.textContent = 'Connected';
      if (showToasts) {
        showToast('success', 'SoundCloud Connected', 'Successfully connected to SoundCloud');
      }
    } else {
      soundcloudStatus.classList.add('disconnected');
      soundcloudStatusText.textContent = 'Unavailable';
      if (showToasts) {
        showToast('warning', 'SoundCloud Unavailable', 'Could not connect to SoundCloud');
      }
    }
    soundcloudCollapseTimer = scheduleCollapse(soundcloudStatus, soundcloudCollapseTimer);
  } catch (err) {
    soundcloudStatus.classList.remove('checking');
    soundcloudStatus.classList.add('disconnected');
    soundcloudStatusText.textContent = 'Error';
    if (showToasts) {
      const message = err instanceof Error ? err.message : 'Unknown error occurred';
      showToast('error', 'SoundCloud Connection Failed', message);
    }
    soundcloudCollapseTimer = scheduleCollapse(soundcloudStatus, soundcloudCollapseTimer);
  } finally {
    isCheckingSoundCloud = false;
  }
}

// ========== Album Art Viewer ==========

export function initArtViewer() {
  const overlay = document.getElementById('art-viewer') as HTMLDivElement | null;
  const image = document.getElementById('art-viewer-image') as HTMLImageElement | null;
  if (!overlay || !image) return;

  const close = () => {
    overlay.style.display = 'none';
    image.src = '';
  };

  // Delegated: any <img> inside .track-art or .album-art-preview opens the viewer.
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (!(target instanceof HTMLImageElement)) return;
    if (!target.closest('.track-art, .album-art-preview')) return;
    if (!target.src) return;
    image.src = target.src;
    overlay.style.display = 'flex';
  });

  overlay.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.style.display === 'flex') close();
  });
}

// ========== Tag Editor Modal ==========

export type TagEditorTrack = {
  filePath: string;
  title: string;
  artist: string;
  album: string;
  year: number | string | null;
  genre: string;
  label?: string;
  key?: string;
  bpm?: string;
  remixer?: string;
  comment?: string;
  albumArt?: string | null;
  hasAlbumArt?: boolean;
};

let tagEditorOnSave: ((updatedTrack: TrackInfo) => void) | null = null;
let tagEditorPendingAlbumArt: string | null = null;
let tagEditorArtSuggestions: AlbumArtSuggestion[] = [];
let tagEditorArtSearchToken = 0;

const TAG_EDITOR_FIELDS = [
  'edit-title', 'edit-artist', 'edit-album', 'edit-year',
  'edit-genre', 'edit-label', 'edit-key', 'edit-bpm',
  'edit-remixer', 'edit-comment'
] as const;

type TagEditorSnapshot = {
  fields: Record<string, string>;
  albumArt: string | null;
  albumArtHtml: string;
};

let tagEditorUndoStack: TagEditorSnapshot[] = [];
let tagEditorRedoStack: TagEditorSnapshot[] = [];

function captureTagEditorSnapshot(): TagEditorSnapshot {
  const fields: Record<string, string> = {};
  for (const id of TAG_EDITOR_FIELDS) {
    fields[id] = getValue(id);
  }
  return {
    fields,
    albumArt: tagEditorPendingAlbumArt,
    albumArtHtml: _tagEditorAlbumArtPreview.innerHTML
  };
}

function restoreTagEditorSnapshot(snapshot: TagEditorSnapshot) {
  for (const id of TAG_EDITOR_FIELDS) {
    setValue(id, snapshot.fields[id]);
  }
  tagEditorPendingAlbumArt = snapshot.albumArt;
  _tagEditorAlbumArtPreview.innerHTML = snapshot.albumArtHtml;
}

function pushTagEditorUndo() {
  tagEditorUndoStack.push(captureTagEditorSnapshot());
  tagEditorRedoStack = [];
}

let _tagEditorModal: HTMLDivElement;
let _tagEditorAlbumArtPreview: HTMLDivElement;
let _tagEditorSearchAlbumArtBtn: HTMLButtonElement;
let _tagEditorAlbumArtSuggestions: HTMLDivElement;
let _tagEditorAlbumArtSuggestionsStatus: HTMLDivElement;
let _tagEditorAlbumArtSuggestionsGrid: HTMLDivElement;
let _tagEditorSaveBtn: HTMLButtonElement;
let _tagEditorScanTagsBtn: HTMLButtonElement;

export function initTagEditor() {
  _tagEditorModal = document.getElementById('tag-editor-modal') as HTMLDivElement;
  _tagEditorAlbumArtPreview = document.getElementById('album-art-preview') as HTMLDivElement;
  _tagEditorSearchAlbumArtBtn = document.getElementById('search-album-art') as HTMLButtonElement;
  _tagEditorAlbumArtSuggestions = document.getElementById('album-art-suggestions') as HTMLDivElement;
  _tagEditorAlbumArtSuggestionsStatus = document.getElementById('album-art-suggestions-status') as HTMLDivElement;
  _tagEditorAlbumArtSuggestionsGrid = document.getElementById('album-art-suggestions-grid') as HTMLDivElement;
  _tagEditorSaveBtn = document.getElementById('save-tag-editor') as HTMLButtonElement;
  _tagEditorScanTagsBtn = document.getElementById('scan-tags') as HTMLButtonElement;

  const closeBtn = document.getElementById('close-tag-editor') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cancel-tag-editor') as HTMLButtonElement;
  const changeAlbumArtBtn = document.getElementById('change-album-art') as HTMLButtonElement;

  closeBtn.addEventListener('click', closeTagEditor);
  cancelBtn.addEventListener('click', closeTagEditor);

  _tagEditorModal.addEventListener('click', (e) => {
    if (e.target === _tagEditorModal) closeTagEditor();
  });

  // Undo/redo keyboard handler
  _tagEditorModal.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      if (tagEditorUndoStack.length > 0) {
        tagEditorRedoStack.push(captureTagEditorSnapshot());
        restoreTagEditorSnapshot(tagEditorUndoStack.pop()!);
      }
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      if (tagEditorRedoStack.length > 0) {
        tagEditorUndoStack.push(captureTagEditorSnapshot());
        restoreTagEditorSnapshot(tagEditorRedoStack.pop()!);
      }
    }
  });

  // Track field changes for undo
  for (const id of TAG_EDITOR_FIELDS) {
    const el = document.getElementById(id) as HTMLInputElement;
    el.addEventListener('focus', () => pushTagEditorUndo());
  }

  changeAlbumArtBtn.addEventListener('click', async () => {
    pushTagEditorUndo();
    const imageData = await window.candybar.selectImage();
    if (imageData) {
      tagEditorPendingAlbumArt = imageData;
      _tagEditorAlbumArtPreview.innerHTML = `<img src="${imageData}" alt="Album art" />`;
    }
  });

  _tagEditorSearchAlbumArtBtn.addEventListener('click', () => tagEditorSearchAlbumArt());

  _tagEditorScanTagsBtn.addEventListener('click', () => tagEditorScanTags());

  _tagEditorSaveBtn.addEventListener('click', async () => {
    const filePath = getValue('edit-file-path');
    const title = getValue('edit-title');
    const artist = getValue('edit-artist');

    if (!artist) {
      showToast('error', 'Artist Required', 'Please enter an artist name.');
      return;
    }

    if (filePath.toLowerCase().endsWith('.wav')) {
      const ok = confirm('WAV files don\'t support tags reliably.\n\nThis file will be converted to AIFF and the original WAV will be deleted. Continue?');
      if (!ok) return;
    }

    _tagEditorSaveBtn.disabled = true;
    _tagEditorSaveBtn.textContent = 'Saving...';

    try {
      const params: UpdateTagsParams = {
        filePath,
        title,
        artist,
        album: getValue('edit-album'),
        year: getValue('edit-year'),
        genre: getValue('edit-genre'),
        label: getValue('edit-label'),
        key: getValue('edit-key'),
        bpm: getValue('edit-bpm'),
        remixer: getValue('edit-remixer'),
        comment: getValue('edit-comment')
      };

      if (tagEditorPendingAlbumArt) {
        params.albumArt = tagEditorPendingAlbumArt;
      }

      const updatedTrack = await updateTrackTagsWithRepair(params, title);
      if (tagEditorOnSave) tagEditorOnSave(updatedTrack);
      closeTagEditor();
      showToast('success', 'Tags Updated', `Updated tags for "${title || updatedTrack.fileName}"`);
    } catch (err) {
      showToast('error', 'Update Failed', getErrorMessage(err));
    } finally {
      _tagEditorSaveBtn.disabled = false;
      _tagEditorSaveBtn.textContent = 'Save Changes';
    }
  });
}

export function openTagEditor(track: TagEditorTrack, onSave?: (updatedTrack: TrackInfo) => void) {
  tagEditorOnSave = onSave ?? null;

  setValue('edit-file-path', track.filePath);
  setValue('edit-title', track.title);
  setValue('edit-artist', track.artist);
  setValue('edit-album', track.album);
  setValue('edit-year', track.year != null ? String(track.year) : '');
  setValue('edit-genre', track.genre);
  setValue('edit-label', track.label || '');
  setValue('edit-key', track.key || '');
  setValue('edit-bpm', track.bpm || '');
  setValue('edit-remixer', track.remixer || '');
  setValue('edit-comment', track.comment || '');

  tagEditorPendingAlbumArt = null;
  const hasArt = track.albumArt || track.hasAlbumArt;
  if (track.albumArt) {
    _tagEditorAlbumArtPreview.innerHTML = `<img src="${track.albumArt}" alt="Album art" />`;
  } else if (track.hasAlbumArt) {
    _tagEditorAlbumArtPreview.innerHTML = `<div class="inspector-art-loading">Loading...</div>`;
    window.candybar.getTrackAlbumArt(track.filePath).then((dataUrl) => {
      if (dataUrl) {
        _tagEditorAlbumArtPreview.innerHTML = `<img src="${dataUrl}" alt="Album art" />`;
      } else {
        _tagEditorAlbumArtPreview.innerHTML = `<svg class="album-art-placeholder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="12" cy="12" r="4"/>
          <circle cx="12" cy="12" r="1"/>
        </svg>`;
      }
    }).catch(() => {});
  } else {
    _tagEditorAlbumArtPreview.innerHTML = `<svg class="album-art-placeholder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <circle cx="12" cy="12" r="4"/>
      <circle cx="12" cy="12" r="1"/>
    </svg>`;
  }

  tagEditorArtSuggestions = [];
  _tagEditorAlbumArtSuggestions.style.display = 'none';
  _tagEditorAlbumArtSuggestionsGrid.innerHTML = '';

  tagEditorUndoStack = [];
  tagEditorRedoStack = [];

  _tagEditorModal.style.display = 'flex';

  if (!hasArt) {
    tagEditorSearchAlbumArt();
  }
}

export function closeTagEditor() {
  _tagEditorModal.style.display = 'none';
  tagEditorPendingAlbumArt = null;
  tagEditorOnSave = null;
  tagEditorArtSuggestions = [];
  _tagEditorAlbumArtSuggestions.style.display = 'none';
  _tagEditorAlbumArtSuggestionsGrid.innerHTML = '';
}

type ScannedTagMatch = {
  source: 'spotify' | 'soundcloud';
  title: string;
  artist: string;
  album?: string;
  year?: string;
  genre?: string;
  confidence: number;
};

async function tagEditorScanTags() {
  const artist = getValue('edit-artist');
  const title = getValue('edit-title');
  const query = `${artist} ${title}`.trim();
  if (!query) {
    showToast('warning', 'No Search Query', 'Enter an artist or title first.');
    return;
  }

  _tagEditorScanTagsBtn.disabled = true;
  const originalLabel = _tagEditorScanTagsBtn.textContent;
  _tagEditorScanTagsBtn.textContent = 'Scanning...';

  try {
    const result = await window.candybar.searchMusic(query, ['spotify', 'soundcloud']);
    const trackRef = { title, artist };

    const matches: ScannedTagMatch[] = [
      ...(result.spotify?.tracks ?? []).map((t) => ({
        source: 'spotify' as const,
        title: t.name,
        artist: t.artists.join(', '),
        album: t.album || undefined,
        year: t.release_year || undefined,
        confidence: scoreSuggestion(trackRef, t.name, t.artists.join(' '))
      })),
      ...(result.soundcloud?.tracks ?? []).map((t) => ({
        source: 'soundcloud' as const,
        title: t.title,
        artist: t.user,
        genre: t.genre || undefined,
        confidence: scoreSuggestion(trackRef, t.title, t.user)
      }))
    ].sort((a, b) => b.confidence - a.confidence);

    const top = matches[0];
    if (!top || top.confidence < 40) {
      showToast('warning', 'No Confident Match', 'Could not find a confident match. Try refining artist/title first.');
      return;
    }

    const populated: string[] = [];
    const apply = (fieldId: string, value: string | undefined, label: string) => {
      if (!value) return;
      if (getValue(fieldId).trim()) return;
      setValue(fieldId, value);
      populated.push(label);
    };

    pushTagEditorUndo();
    apply('edit-title', top.title, 'title');
    apply('edit-artist', top.artist, 'artist');
    apply('edit-album', top.album, 'album');
    apply('edit-year', top.year, 'year');
    apply('edit-genre', top.genre, 'genre');

    if (populated.length === 0) {
      showToast('info', 'Nothing to Fill', `Top match (${top.confidence}%) had no new data for empty fields.`);
    } else {
      showToast('success', 'Tags Scanned', `+${populated.join(', ')} (${top.confidence}% match, ${top.source})`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    showToast('error', 'Scan Failed', message);
  } finally {
    _tagEditorScanTagsBtn.disabled = false;
    _tagEditorScanTagsBtn.textContent = originalLabel;
  }
}

async function tagEditorSearchAlbumArt() {
  const artist = getValue('edit-artist');
  const title = getValue('edit-title');
  const query = `${artist} ${title}`.trim();
  if (!query) {
    showToast('warning', 'No Search Query', 'Enter an artist or title first.');
    return;
  }

  const token = ++tagEditorArtSearchToken;
  _tagEditorSearchAlbumArtBtn.disabled = true;
  _tagEditorSearchAlbumArtBtn.textContent = 'Searching...';
  _tagEditorAlbumArtSuggestions.style.display = 'block';
  _tagEditorAlbumArtSuggestionsStatus.textContent = 'Searching...';
  _tagEditorAlbumArtSuggestionsGrid.innerHTML = '';

  try {
    const result = await window.candybar.searchMusic(query, ['spotify', 'soundcloud']);
    if (token !== tagEditorArtSearchToken) return;

    const trackRef = { title, artist };

    const spotifySuggestions: AlbumArtSuggestion[] = (result.spotify?.tracks ?? [])
      .slice(0, 10)
      .map((t) => ({
        source: 'spotify' as const,
        title: t.name,
        artist: t.artists.join(', '),
        imageUrl: t.album_image_url || '',
        externalUrl: t.external_url,
        confidence: scoreSuggestion(trackRef, t.name, t.artists.join(' ')),
        album: t.album || undefined,
        year: t.release_year || undefined
      }))
      .filter((s) => s.imageUrl);

    const soundCloudSuggestions: AlbumArtSuggestion[] = (result.soundcloud?.tracks ?? [])
      .slice(0, 10)
      .map((t) => ({
        source: 'soundcloud' as const,
        title: t.title,
        artist: t.user,
        imageUrl: getSoundCloudArtwork(t.artwork_url) || '',
        externalUrl: t.permalink_url,
        confidence: scoreSuggestion(trackRef, t.title, t.user),
        genre: t.genre || undefined
      }))
      .filter((s) => s.imageUrl);

    tagEditorArtSuggestions = [...spotifySuggestions, ...soundCloudSuggestions]
      .sort((a, b) => b.confidence - a.confidence);

    if (tagEditorArtSuggestions.length === 0) {
      _tagEditorAlbumArtSuggestionsStatus.textContent = 'No results found';
    } else {
      _tagEditorAlbumArtSuggestionsStatus.textContent = `${tagEditorArtSuggestions.length} results`;
      tagEditorRenderArtSuggestions();
    }
  } catch {
    if (token !== tagEditorArtSearchToken) return;
    _tagEditorAlbumArtSuggestionsStatus.textContent = 'Search failed';
  } finally {
    _tagEditorSearchAlbumArtBtn.disabled = false;
    _tagEditorSearchAlbumArtBtn.textContent = 'Search Art';
  }
}

function tagEditorRenderArtSuggestions() {
  _tagEditorAlbumArtSuggestionsGrid.innerHTML = '';
  for (const suggestion of tagEditorArtSuggestions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'album-art-suggestion-thumb';
    btn.setAttribute('data-tooltip', `${suggestion.artist} — ${suggestion.title} (${suggestion.source}, ${suggestion.confidence}%)`);

    const img = document.createElement('img');
    img.src = suggestion.imageUrl;
    img.alt = `${suggestion.title} album art`;
    btn.appendChild(img);

    const badge = document.createElement('span');
    badge.className = 'suggestion-source';
    badge.textContent = suggestion.source === 'spotify' ? 'S' : 'SC';
    btn.appendChild(badge);

    btn.addEventListener('click', async () => {
      try {
        pushTagEditorUndo();
        const dataUrl = await fetchImageAsDataUrl(suggestion.imageUrl);
        tagEditorPendingAlbumArt = dataUrl;
        _tagEditorAlbumArtPreview.innerHTML = `<img src="${dataUrl}" alt="Album art" />`;

        _tagEditorAlbumArtSuggestionsGrid.querySelectorAll('.album-art-suggestion-thumb').forEach(
          (el) => el.classList.remove('selected')
        );
        btn.classList.add('selected');
      } catch {
        showToast('error', 'Fetch Failed', 'Could not download album art image.');
      }
    });

    _tagEditorAlbumArtSuggestionsGrid.appendChild(btn);
  }
}

// ========== Page Navigation ==========

export function initNavigation() {
  getNavLinks().forEach((link) => {
    link.addEventListener('click', async () => {
      const targetPage = (link as HTMLButtonElement).dataset.page;
      if (!targetPage) return;

      setActiveTab(targetPage);

      const currentConfig = await window.candybar.getConfig();
      await window.candybar.setConfig({
        ...currentConfig,
        activeTab: targetPage
      });
    });
  });
}
