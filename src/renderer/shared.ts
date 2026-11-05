import { getErrorMessage as baseErrorMessage } from '../lib/errorUtils';
import { confirmAction } from './confirmDialog';

/** Electron wraps a rejected ipcRenderer.invoke as
 *  "Error invoking remote method 'scan-library-health': Error: <message>".
 *  The channel name means nothing to the user, so keep only <message>. */
export function stripIpcErrorPrefix(message: string): string {
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/, '');
}

/** A caught value's message, minus Electron's IPC wrapper. */
export function getErrorMessage(err: unknown, fallback = 'Unknown error'): string {
  return stripIpcErrorPrefix(baseErrorMessage(err, fallback));
}

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
  StoreCartCheck,
  OrganizeState,
  VolumeInfo,
  UsbVolumeIssue,
  UsbHealthResult,
  UsbHealthProgress,
  SoundCloudSignIn,
  SpotifySignIn,
  ProfilesState,
  TrackLabProfile,
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

// Splice recovery shared types (mirror src/lib/spliceRecovery.ts)
export type SpliceLoginStatus = { connected: boolean; tokenExpiresAt: number | null; hasProfile: boolean };
export type SpliceMissingSample = { originalPath: string; basename: string; searchKey: string };
export type SpliceScanResult = { alsPath: string; totalRefs: number; spliceRefs: number; missing: SpliceMissingSample[] };
export type SpliceAsset = {
  uuid: string;
  filename: string;
  name: string;
  coverUrl: string | null;
  packName: string | null;
  packSlug: string | null;
};
export type SpliceCreditsBalance = { credits: number; state: string; planName: string | null; planTier: string | null };
export type SpliceOwnedItem = SpliceMissingSample & { asset: SpliceAsset };
export type SpliceCreditsItem = SpliceMissingSample & { asset: SpliceAsset; spliceUrl: string };
export type SpliceNotFoundItem = SpliceMissingSample & { error?: string };
export type SpliceBuckets = { owned: SpliceOwnedItem[]; credits: SpliceCreditsItem[]; notFound: SpliceNotFoundItem[] };
export type SpliceDownloadReport = {
  attempted: number;
  succeeded: number;
  failed: Array<{ sample: SpliceOwnedItem; error: string }>;
};
export type SpliceProgressEvent =
  | { phase: 'parsing'; alsPath: string }
  | { phase: 'searching'; index: number; total: number; sample: SpliceMissingSample; result?: 'owned' | 'credits' | 'notFound' }
  | { phase: 'downloading'; index: number; total: number; sample: SpliceOwnedItem; status?: 'ok' | 'fail'; error?: string }
  | { phase: 'complete' };

declare global {
  interface Window {
    candybar: {
      selectPath: (type: 'file' | 'dir') => Promise<string | null>;
      rendererReady: () => void;
      checkLibrary: (
        source: { csvPath?: string; spotifyPlaylistUrl?: string },
        useCache?: boolean,
        cacheOnly?: boolean
      ) => Promise<{ id: string; success: boolean; result?: CheckResultFull; fromCache?: boolean; cacheOnly?: boolean; error?: string }>;
      getConfig: () => Promise<AppConfig>;
      getConfigPath: () => Promise<string>;
      profilesList: () => Promise<ProfilesState>;
      profilesCreate: (name: string, switchTo?: boolean) => Promise<ProfilesState & { created: TrackLabProfile; switched: boolean }>;
      profilesRename: (id: string, name: string) => Promise<ProfilesState>;
      profilesSetDefault: (id: string) => Promise<ProfilesState>;
      profilesDelete: (id: string) => Promise<ProfilesState & { trashed: boolean; folder: string }>;
      profilesSwitch: (id: string) => Promise<{ switched: boolean; profile: TrackLabProfile; reason?: string }>;
      getLibraryRoot: () => Promise<string>;
      setConfig: (config: AppConfig) => Promise<AppConfig>;
      /** Merge-write: only the given keys change, so concurrent saves can't clobber each other. */
      updateConfig: (partial: Partial<AppConfig>) => Promise<AppConfig>;
      migrateArchive: (oldPath: string, newPath: string) => Promise<{ success: boolean; error?: string }>;
      onMigrateProgress: (callback: (payload: { current: number; total: number; file: string }) => void) => void;
      checkSpotify: () => Promise<boolean>;
      soundcloudSignInStatus: () => Promise<SoundCloudSignIn | null>;
      spotifySignInStatus: () => Promise<SpotifySignIn | null>;
      spotifySignIn: () => Promise<{ success: boolean; status?: SpotifySignIn; error?: string }>;
      soundcloudSignIn: () => Promise<{ success: boolean; status?: SoundCloudSignIn; error?: string }>;
      searchMusic: (query: string, sources: ('spotify' | 'soundcloud' | 'beatport' | 'qobuz')[]) =>
        Promise<MusicSearchResult>;
      onOutput: (callback: (payload: ScriptOutput) => void) => void;
      onCheckProgress: (callback: (payload: CheckProgress) => void) => void;
      scanTracks: (sourceDir: string) => Promise<TrackInfo[]>;
      onScanProgress: (callback: (payload: ScanProgress) => void) => () => void;
      autopopulateTracks: (tracks: Array<{ filePath: string; title: string; artist: string; album: string; year: string; genre: string; label: string; key: string; bpm: string; remixer: string; hasAlbumArt: boolean }>, force?: boolean) =>
        Promise<Array<{ filePath: string; updated: boolean; fieldsPopulated: string[]; error?: string }>>;
      onAutopopulateProgress: (callback: (payload: { current: number; total: number; filePath: string }) => void) => (() => void);
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
      getUpdateState: () => Promise<import('../types').UpdateState>;
      /** Checks GitHub now and shows the result; resolves once the dialog closes. */
      checkForUpdates: () => Promise<void>;
      onUpdateState: (callback: (state: import('../types').UpdateState) => void) => () => void;
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
      librarySourcingRun: (source: { csvPath?: string; spotifyPlaylistUrl?: string; soundcloudSetUrl?: string }) =>
        Promise<{ success: boolean; result?: import('../types').LibrarySourcingResult; error?: string }>;
      onLibrarySourcingPhase1Progress: (callback: (payload: { phase?: string; current: number; total: number; message?: string }) => void) => void;
      onLibrarySourcingPhase2Progress: (callback: (payload: { current: number; total: number; currentTrack: string }) => void) => void;
      onLibrarySourcingPhase2Match: (callback: (match: import('../lib/qobuzCart').QobuzCartMatch) => void) => void;
      onLibrarySourcingPlaylistInfo: (callback: (info: import('../types').SourcePlaylistInfo) => void) => void;
      onLibrarySourcingFinderProgress: (callback: (p: import('../types').SourcingFinderProgress) => void) => (() => void);
      librarySourcingFetchFree: (keys: string[], opts: { accountActions: boolean }) => Promise<{ success: boolean; outcomes?: Record<string, import('../lib/freeSources').FreeUpgradeOutcome>; error?: string }>;
      librarySourcingFetchFreeStop: () => Promise<void>;
      onLibrarySourcingFreeProgress: (callback: (p: { message: string }) => void) => (() => void);

      // Lossless upgrades (Rekordbox playlist → lossless copies of its lossy tracks)
      upgradeListPlaylists: () => Promise<{ success: boolean; playlists?: import('../types').RekordboxPlaylistSummary[]; error?: string }>;
      upgradeRun: (playlistId: string) => Promise<{ success: boolean; result?: import('../types').LosslessUpgradeResult; error?: string }>;
      onUpgradeProgress: (callback: (p: import('../types').LosslessUpgradeProgress) => void) => (() => void);
      upgradeFetchFree: (rbIds: string[], opts: { accountActions: boolean }) => Promise<{ success: boolean; outcomes?: Record<string, import('../lib/freeSources').FreeUpgradeOutcome>; error?: string }>;
      upgradeFetchFreeStop: () => Promise<void>;
      upgradeUseLink: (rbId: string, url: string) => Promise<{ success: boolean; hit?: import('../lib/freeSources').FreeSourceHit; pasted?: { url: string; warning: string | null }; error?: string }>;
      upgradeForgetLink: (rbId: string) => Promise<{ success: boolean; forgotten?: boolean; error?: string }>;
      supportSaveReport: (pages: Record<string, string | null>) => Promise<{ success: boolean; path?: string; error?: string }>;
      upgradeApplyClaude: (items: Array<{ rbId: string; verdict: import('../types').UpgradeVerdictKind; note: string; freeUrl?: string; ref?: string; match?: import('../lib/qobuzCart').QobuzCartMatch | null; artist?: string; title?: string; duration?: number }>) => Promise<{ success: boolean; results: Array<{ rbId: string; hit?: import('../lib/freeSources').FreeSourceHit; pasted?: { url: string; warning: string | null }; match?: import('../lib/qobuzCart').QobuzCartMatch; error?: string }> }>;
      librarySourcingResolvePick: (match: import('../lib/qobuzCart').QobuzCartMatch, ref: string, note?: string) => Promise<{ success: boolean; match?: import('../lib/qobuzCart').QobuzCartMatch; changed?: boolean; error?: string }>;

      // Find & buy: saved playlists (check again in one click)
      savedSourcesList: () => Promise<{ success: boolean; sources?: import('../types').SavedSource[]; error?: string }>;
      savedSourcesSave: (input: import('../types').SavedSourceInput, opts?: { keepExisting?: boolean }) => Promise<{ success: boolean; source?: import('../types').SavedSource; error?: string }>;
      savedSourcesUpdate: (id: number, patch: { name?: string | null }) => Promise<{ success: boolean; source?: import('../types').SavedSource; error?: string }>;
      savedSourcesRemove: (id: number) => Promise<{ success: boolean; error?: string }>;

      // Replace in Rekordbox: swap a lossless file in under the same row (cues, plays, date added kept)
      upgradeSwapPreflight: () => Promise<import('../types').UpgradeSwapPreflight>;
      upgradeSwapPlan: (inputs: import('../types').UpgradeSwapInput[]) => Promise<{ success: boolean; items?: import('../types').UpgradeSwapPlanItem[]; error?: string }>;
      upgradeSwapApply: (rbIds: string[]) => Promise<{ success: boolean; result?: import('../types').UpgradeSwapResult; error?: string }>;
      onUpgradeSwapProgress: (callback: (p: import('../types').UpgradeSwapProgress) => void) => (() => void);

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
      onStoreCartProgress: (callback: (payload: StoreCartProgress) => void) => (() => void);
      storeOpenCart: (store: 'qobuz' | 'beatport') => Promise<{ success: boolean }>;
      storeCartCheck: (store: 'qobuz' | 'beatport', items: Array<{ trackId: string; articleId?: string }>) => Promise<StoreCartCheck>;
      storeLoadResults: () => Promise<{ success: boolean; matches?: StoreMatch[]; savedAt?: string; trackCount?: number }>;
      storeClearResults: () => Promise<{ success: boolean }>;
      storeDownloadPurchases: (matches: StoreMatch[]) => Promise<{ success: boolean; downloaded?: number; files?: Array<{ key: string; path: string }>; failed?: Array<{ artist: string; title: string; error: string }>; destDir?: string; error?: string }>;
      onStoreDownloadProgress: (callback: (payload: { current: number; total: number; currentTrack: string; phase: string; message: string }) => void) => void;

      // Store panel (embedded browser)
      storePanelOpen: (store: 'qobuz' | 'beatport', url: string) => Promise<{ success: boolean }>;
      storePanelClose: () => Promise<{ success: boolean }>;
      storePanelAttach: (contentsId: number | null) => Promise<{ success: boolean }>;
      storePanelNav: (url: string) => Promise<{ success: boolean }>;
      storePanelStatus: () => Promise<{ open: boolean; store: string | null; url: string | null }>;
      storePanelCheckoutAdvance: (store: 'qobuz' | 'beatport') => Promise<{
        success: boolean;
        /** itemCount: items the store's own checkout page lists, or null when it can't be read. */
        result?: { phase: 'place-order-ready'; total: string | null; buttonText: string; itemCount?: number | null }
                | { phase: 'advanced'; clickedText: string }
                | { phase: 'unknown' };
        error?: string;
      }>;
      storePanelPlaceOrder: (store: 'qobuz' | 'beatport') => Promise<{ success: boolean; clickedText?: string; error?: string }>;
      onStorePanelState: (callback: (state: { open: boolean; store?: string | null; url?: string; partition?: string }) => void) => void;
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

      // Splice recovery (Ableton .als sample re-download)
      spliceLoginStatus: () => Promise<{ success: boolean; status?: SpliceLoginStatus; error?: string }>;
      spliceStartLogin: () => Promise<{ ok: boolean; error?: string }>;
      splicePickAls: () => Promise<{ success: boolean; path: string | null }>;
      spliceScan: (alsPath: string) => Promise<{ success: boolean; result?: SpliceScanResult; error?: string }>;
      spliceClassify: (missing: SpliceMissingSample[]) => Promise<{ success: boolean; buckets?: SpliceBuckets; manifestPath?: string | null; error?: string }>;
      spliceDownloadOwned: (items: SpliceOwnedItem[]) => Promise<{ success: boolean; report?: SpliceDownloadReport; error?: string }>;
      spliceCreditsBalance: () => Promise<{ success: boolean; balance?: SpliceCreditsBalance; error?: string }>;
      spliceBuyCredits: (items: SpliceCreditsItem[]) => Promise<{ success: boolean; report?: SpliceDownloadReport; error?: string }>;
      onSpliceProgress: (callback: (p: SpliceProgressEvent) => void) => (() => void);
    };
  }
}

// ========== Shared DOM Elements (lazy-initialized to avoid querying before DOMContentLoaded) ==========

let _statusText: HTMLSpanElement | null = null;
let _navLinks: NodeListOf<Element> | null = null;
let _pages: NodeListOf<Element> | null = null;
let _toastContainer: HTMLDivElement | null = null;

function getStatusText() { return _statusText ??= document.querySelector<HTMLSpanElement>('.status-text'); }
// Only page links: the side nav footer reuses .nav-link for Setup/Tour/Settings.
function getNavLinks() { return _navLinks ??= document.querySelectorAll('.nav-link[data-page]'); }
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

export interface ToastAction {
  label: string;
  onClick: () => void;
}

/**
 * Ask the settings module to open at a given section. Decoupled via
 * CustomEvent so `shared.ts` doesn't depend on `settings.ts` (which already
 * imports from here).
 */
export function requestOpenSettings(sectionKey: string): void {
  document.dispatchEvent(new CustomEvent('candybar:open-settings', { detail: { sectionKey } }));
}

/** Ask the setup wizard to open, optionally at one step ('library', 'folders',
 *  'rekordbox', 'spotify', 'stores'). Same CustomEvent decoupling as above. */
export function requestOpenSetup(step?: string): void {
  document.dispatchEvent(new CustomEvent('candybar:open-setup', { detail: { step } }));
}

// ========== "How it works" strips ==========
// Any <ol class="how-steps" data-how="<page>"> gets a close button that hides
// it for good (per page, in localStorage) and a small "How does this work?"
// link that brings it back.

const HOW_DISMISSED_KEY = 'candybar.howSteps.dismissed';
const HELP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

function readHowDismissed(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HOW_DISMISSED_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

function writeHowDismissed(keys: string[]): void {
  try { localStorage.setItem(HOW_DISMISSED_KEY, JSON.stringify(keys)); } catch { /* per-viewer nicety only */ }
}

/** Wire every how-steps strip in `root` that isn't wired yet. Call again after
 *  rendering one from code. */
export function applyHowSteps(root: ParentNode = document): void {
  const dismissed = readHowDismissed();
  root.querySelectorAll<HTMLElement>('.how-steps[data-how]').forEach((strip) => {
    if (strip.dataset.howWired) return;
    strip.dataset.howWired = '1';
    const key = strip.dataset.how!;
    const reopen = document.createElement('button');
    reopen.type = 'button';
    reopen.className = 'how-steps-reopen';
    reopen.innerHTML = `${HELP_ICON}<span>How does this work?</span>`;
    strip.insertAdjacentElement('afterend', reopen);
    const show = (visible: boolean) => {
      strip.classList.toggle('is-dismissed', !visible);
      reopen.hidden = visible;
    };
    show(!dismissed.includes(key));
    strip.querySelector('.how-steps-close')?.addEventListener('click', () => {
      writeHowDismissed([...new Set([...readHowDismissed(), key])]);
      show(false);
      reopen.focus();
    });
    reopen.addEventListener('click', () => {
      writeHowDismissed(readHowDismissed().filter((k) => k !== key));
      show(true);
    });
  });
}

export function showToast(
  type: ToastType,
  title: string,
  message?: string,
  duration = 5000,
  action?: ToastAction
) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  // Titles and messages carry file names, store titles and error text, so they
  // go in as text, never markup.
  if (message) message = stripIpcErrorPrefix(message);

  const copyBtn = type === 'error' && message
    ? `<button class="toast-copy" data-tooltip="Copy error details" aria-label="Copy error details">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
      </button>`
    : '';

  const actionBtn = action
    ? `<button class="toast-action">${escapeHtml(action.label)}</button>`
    : '';

  toast.innerHTML = `
    <div class="toast-icon">${toastIcons[type]}</div>
    <div class="toast-content">
      <div class="toast-title"></div>
      ${message ? `<div class="toast-message"></div>` : ''}
    </div>
    <div class="toast-actions">
      ${actionBtn}
      ${copyBtn}
      <button class="toast-close" data-tooltip="Dismiss" aria-label="Dismiss">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  `;
  (toast.querySelector('.toast-title') as HTMLElement).textContent = title;
  const messageEl = toast.querySelector<HTMLElement>('.toast-message');
  if (messageEl && message) messageEl.textContent = message;

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

  if (action) {
    const actionEl = toast.querySelector('.toast-action') as HTMLButtonElement;
    actionEl.addEventListener('click', () => {
      action.onClick();
      removeToast();
    });
  }

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

// ========== Action Hints ==========
// One plain-language explanation per track action, shared by row buttons,
// right-click menus and the inspector so the same action never reads two ways.

export const actionHints = {
  play: 'Listen to it in the player at the top of the window.',
  convertAiff: 'Make a lossless AIFF version that Pioneer CDJs and XDJs play reliably. It sounds the same.',
  reencodeMp3: 'Rebuild this MP3 in the standard 320 kbps format Pioneer players accept. It fixes playback problems, not sound quality.',
  editTags: 'Change the artist, title, key, BPM and artwork saved inside the file.',
  populateTags: 'Look the track up online and fill in any empty tags. Tags you already have are kept.',
  archive: 'Move it out of your library into your archive folder. Nothing is deleted.',
  trash: 'Move it to the Trash. You\'ll be asked first, and you can put it back from Finder.',
  dismissIssue: 'Stop flagging this problem on this track. You can bring it back later.',
  restoreIssue: 'Start flagging this problem on this track again.',
  ignore: 'Leave this track where it is when you organize.',
  include: 'Organize this track along with the others.',
} as const;

// ========== Utility Functions ==========

/** Legacy one-line status. The redesigned shell has no status line (pages and
 *  the activity chip say what's happening), so with nothing to write to this
 *  is a no-op rather than a crash for the screens that still call it. */
export function setStatus(text: string) {
  const el = getStatusText();
  if (el) el.textContent = text;
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
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ========== Dialog Focus ==========
// Same contract as Settings and the album-art overlay: focus moves in on
// open, Tab stays inside while open, and focus goes back on close.

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keep Tab / Shift+Tab inside `container`. Call from a keydown handler. */
export function trapDialogFocus(container: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== 'Tab' || e.defaultPrevented) return;
  const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((el) => el.offsetParent !== null && el.tabIndex >= 0);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const inside = container.contains(document.activeElement);
  if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
}

/** Remember what had focus before a dialog opened, and hand it back later. */
export function captureFocusReturn(): () => void {
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  return () => { if (before?.isConnected) before.focus({ preventScroll: true }); };
}

// ========== Store Match Flags ==========
// Shared by the Sources and Upgrades rows, so a match reads the same on both.

/** A Qobuz hit that is still a whole release (its title and price are the
 *  release's, not the track's). Never pre-selected; flagged on the row. */
export function isReleaseMatch(m: import('../lib/qobuzCart').QobuzCartMatch): boolean {
  return m.source === 'qobuz' && (m.albumLevel === true || m.qobuzTrack?.trackResolved === false);
}

export const RELEASE_MATCH_TAG = '<span class="src-tag-version src-tag-release" title="Qobuz matched the whole release, not this one track, so the name and price shown may be the release\'s. Open it on Qobuz before buying.">release match — check before buying</span>';

/** The match's note ("Couldn't find X on the release…"), as a row sub-line. */
export function matchNoteHtml(m: import('../lib/qobuzCart').QobuzCartMatch): string {
  return m.note ? `<span class="sub src-match-note">${escapeHtml(m.note)}</span>` : '';
}

/** "1 track", "3 tracks". Pass `pluralWord` for irregular plurals. */
export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? word : pluralWord}`;
}

/** Format a summed price in the currency the store's own price strings use
 *  ("$2.99", "€1.29", "1.79 USD"), rather than assuming dollars. With no
 *  currency in sight it's just the number. */
export function formatPriceTotal(total: number, samplePrices: Array<string | null | undefined>): string {
  for (const raw of samplePrices) {
    if (!raw) continue;
    const code = raw.match(/\b([A-Z]{3})\b/)?.[1];
    if (code) {
      try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(total);
      } catch { /* not an ISO code; keep looking */ }
    }
    const symbol = raw.match(/[$€£¥]/)?.[0];
    if (symbol) return `${symbol}${total.toFixed(2)}`;
  }
  // Nothing to read a currency from (e.g. an empty store): the stores bill in USD.
  return `$${total.toFixed(2)}`;
}

// ========== Context Menu ==========

export type ContextMenuItem = {
  label?: string;
  icon?: string;
  disabled?: boolean;
  separator?: boolean;
  /** Red styling for items that remove or move files. */
  danger?: boolean;
  /** Plain-language explanation shown as a tooltip. */
  hint?: string;
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
  const returnFocus = document.activeElement as HTMLElement | null;

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      sep.setAttribute('role', 'separator');
      menu.appendChild(sep);
      continue;
    }

    const row = document.createElement('div');
    row.className = 'context-menu-item';
    row.setAttribute('role', 'menuitem');
    row.tabIndex = -1;
    if (item.disabled) {
      row.classList.add('disabled');
      row.setAttribute('aria-disabled', 'true');
    }
    if (item.danger) row.classList.add('is-danger');
    if (item.hint) {
      row.dataset.tooltip = item.hint;
      row.dataset.tooltipPos = 'right';
    }

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

  // Keyboard: arrows move between items, Enter/Space runs one, Escape closes
  // the menu (and only the menu) and gives focus back.
  const enabledRows = () => [...menu.querySelectorAll<HTMLElement>('.context-menu-item:not(.disabled)')];
  menu.addEventListener('keydown', (e) => {
    const rows = enabledRows();
    const i = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      rows[(i + step + rows.length) % rows.length]?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.click();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      dismissContextMenu();
      returnFocus?.focus?.();
    }
  });

  document.body.appendChild(menu);
  activeContextMenu = menu;
  enabledRows()[0]?.focus({ preventScroll: true });

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

  const wasActive = document.querySelector('.page.active')?.id;
  getPages().forEach((page) => {
    page.classList.remove('active');
    if (page.id === `page-${targetPage}`) {
      page.classList.add('active');
    }
  });
  // Each page opens at its top; one scroll position shared by every page
  // would land you halfway down the next one.
  if (wasActive !== `page-${targetPage}`) {
    const content = document.querySelector<HTMLElement>('.content');
    if (content) content.scrollTop = 0;
  }
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
    const accept = await confirmAiffHeaderRepair(label, 'save its tags');
    if (!accept) throw new Error('Repair declined');

    await window.candybar.repairAiffHeader(params.filePath);
    return await window.candybar.updateTrackTags(params);
  }
}

function confirmAiffHeaderRepair(label: string, blockedAction: string): Promise<boolean> {
  return confirmAction({
    title: 'Repair this file first?',
    message: `"${label}" has a damaged header (the label at the start of the file), so we can't ${blockedAction}. ` +
      'A quick repair corrects 4 bytes of that label.',
    safetyNote: 'The music itself is not touched.',
    confirmLabel: 'Repair and continue',
    tone: 'info',
  });
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
  const accept = await confirmAiffHeaderRepair(label, 'convert it');
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
// The top-bar pills always show the service's name; the state is a dot plus
// a sentence in the tooltip and the screen-reader text, so nobody has to
// decode colours. States: checking · ok · off (not set up) · problem.

type ServiceState = 'checking' | 'ok' | 'off' | 'problem';

let isCheckingSpotify = false;
let isCheckingSoundCloud = false;
let isCheckingStores = false;

function setServiceState(el: HTMLElement, textEl: HTMLElement | null, state: ServiceState, word: string, tip: string): void {
  el.classList.remove('checking', 'connected', 'disconnected', 'collapsed', 'is-off');
  if (state === 'checking') el.classList.add('checking');
  else if (state === 'ok') el.classList.add('connected');
  else el.classList.add('disconnected');
  if (state === 'off') el.classList.add('is-off');
  el.dataset.state = state;
  if (textEl) textEl.textContent = word;
  el.title = tip;
  el.removeAttribute('data-tip-title');
  updateConnectionsSummary();
}

const SERVICE_PILL_IDS = ['spotify-status', 'soundcloud-status', 'qobuz-status', 'beatport-status'];

/** The top bar's one "Connections" button: the four services' states in a phrase. */
function updateConnectionsSummary(): void {
  const toggle = document.getElementById('connections-toggle');
  const label = document.getElementById('connections-label');
  if (!toggle || !label) return;
  const pills = SERVICE_PILL_IDS.map((id) => document.getElementById(id)).filter((p): p is HTMLElement => !!p);
  const nameOf = (p: HTMLElement) => p.querySelector('.service-name')?.textContent ?? 'A service';
  const by = (s: ServiceState) => pills.filter((p) => p.dataset.state === s);
  const [checking, ok, off, problem] = [by('checking'), by('ok'), by('off'), by('problem')];
  let text: string;
  let tone: 'ok' | 'warn' | 'off' | 'checking';
  if (checking.length === pills.length) { text = 'Checking connections…'; tone = 'checking'; }
  else if (problem.length === 1) { text = `${nameOf(problem[0])} needs attention`; tone = 'warn'; }
  else if (problem.length > 1) { text = `${problem.length} need attention`; tone = 'warn'; }
  else if (ok.length === pills.length) { text = 'All connected'; tone = 'ok'; }
  else if (off.length === 1 && checking.length === 0) { text = `${nameOf(off[0])} not set up`; tone = 'off'; }
  else { text = `${ok.length} of ${pills.length} connected`; tone = checking.length ? 'checking' : 'off'; }
  label.textContent = text;
  toggle.dataset.tone = tone;
}

/** Open and close the Connections panel; a click on a service runs its own
 *  action (re-check, or Settings for the stores) and closes the panel. */
export function initConnections(): void {
  const wrap = document.getElementById('connections');
  const toggle = document.getElementById('connections-toggle');
  const panel = document.getElementById('connections-panel');
  if (!wrap || !toggle || !panel) return;
  const setOpen = (open: boolean) => {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setOpen(panel.hidden));
  panel.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.service-status')) setOpen(false);
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !wrap.contains(e.target as Node)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) { setOpen(false); toggle.focus(); }
  });
  updateConnectionsSummary();
}

export async function checkSpotifyConnection(showToasts = false) {
  if (isCheckingSpotify) return;
  isCheckingSpotify = true;

  const spotifyStatus = document.getElementById('spotify-status') as HTMLDivElement;
  const spotifyStatusText = spotifyStatus.querySelector('.spotify-status-text') as HTMLSpanElement;
  setServiceState(spotifyStatus, spotifyStatusText, 'checking', 'checking', 'Spotify: checking the connection…');

  try {
    // The account first: a sign-in reads private playlists and passes the
    // Spotify-connect download gates. The API key alone reads public ones.
    const signIn = await window.candybar.spotifySignInStatus().catch(() => null);
    if (signIn?.signedIn) {
      const who = signIn.name || signIn.username || 'your account';
      setServiceState(spotifyStatus, spotifyStatusText, 'ok', 'signed in',
        `Spotify: signed in as ${who}. Playlists (private ones too) and Spotify-connect download gates use this sign-in. Click to check again.`);
      if (showToasts) showToast('success', `Spotify: signed in as ${who}`, 'Playlists, private ones too, are read through this sign-in.');
      return;
    }
    const connected = await window.candybar.checkSpotify();
    if (connected) {
      setServiceState(spotifyStatus, spotifyStatusText, 'ok', 'API key',
        'Spotify: reading public playlists with the API key. Sign in to read private playlists and pass Spotify-connect download gates. Click to sign in.');
      if (showToasts) showToast('info', 'Spotify works for public playlists', 'Sign in with the Spotify account to read private playlists and pass Spotify-connect gates.', 7000, { label: 'Sign in', onClick: () => void signInToSpotifyFlow() });
    } else {
      setServiceState(spotifyStatus, spotifyStatusText, 'off', 'not signed in',
        'Spotify: not signed in. Track Lab needs it to read Spotify playlists. Click to sign in.');
      if (showToasts) {
        showToast(
          'warning',
          'Spotify isn\'t signed in',
          'Sign in with the Spotify account to read playlists, private ones too.',
          7000,
          { label: 'Sign in', onClick: () => void signInToSpotifyFlow() }
        );
      }
    }
  } catch (err) {
    setServiceState(spotifyStatus, spotifyStatusText, 'problem', 'not working',
      'Spotify isn\'t answering right now. Click to try again.');
    if (showToasts) {
      const message = err instanceof Error ? err.message : 'Unknown error occurred';
      showToast('error', 'Couldn\'t reach Spotify', message);
    }
  } finally {
    isCheckingSpotify = false;
  }
}

/**
 * Sign in to Spotify: Track Lab opens Chrome on this profile's gate browser at
 * Spotify's login; the person signs in and closes that window.
 */
export async function signInToSpotifyFlow(): Promise<SpotifySignIn | null> {
  showToast('info', 'Sign in to Spotify in the Chrome window', 'Log in with the Spotify account, then close that window. Track Lab checks the sign-in when it closes.', 12000);
  try {
    const res = await window.candybar.spotifySignIn();
    if (!res.success) throw new Error(res.error ?? 'Sign-in failed');
    const who = res.status?.name || res.status?.username;
    if (res.status?.signedIn) showToast('success', `Signed in to Spotify as ${who ?? 'your account'}`, 'Playlists, private ones too, now come through this sign-in.');
    else showToast('warning', 'Not signed in to Spotify', 'The window closed before the sign-in finished.');
    document.dispatchEvent(new CustomEvent('spotify-sign-in-changed', { detail: res.status ?? null }));
    void checkSpotifyConnection(false);
    return res.status ?? null;
  } catch (err) {
    showToast('error', 'Couldn\'t sign in to Spotify', getErrorMessage(err));
    return null;
  }
}

export async function checkStoreConnections(showToasts = false) {
  if (isCheckingStores) return;
  isCheckingStores = true;

  const qobuzStatus = document.getElementById('qobuz-status') as HTMLDivElement;
  const qobuzStatusText = qobuzStatus.querySelector('.qobuz-status-text') as HTMLSpanElement;
  const beatportStatus = document.getElementById('beatport-status') as HTMLDivElement;
  const beatportStatusText = beatportStatus.querySelector('.beatport-status-text') as HTMLSpanElement;

  setServiceState(qobuzStatus, qobuzStatusText, 'checking', 'checking', 'Qobuz: checking your sign-in…');
  setServiceState(beatportStatus, beatportStatusText, 'checking', 'checking', 'Beatport: checking your sign-in…');

  const applyState = (el: HTMLDivElement, text: HTMLSpanElement, store: string, connected: boolean, accountCount: number) => {
    if (connected) {
      setServiceState(el, text, 'ok', accountCount > 1 ? `${accountCount} accounts signed in` : 'signed in',
        `${store}: ${accountCount > 1 ? `${accountCount} accounts are` : 'you\'re'} signed in, so searches, carts and downloads work. Click to manage accounts.`);
    } else if (accountCount > 0) {
      setServiceState(el, text, 'problem', 'signed out',
        `${store}: you've been signed out. Click to sign in again.`);
    } else {
      setServiceState(el, text, 'off', 'not set up',
        `${store} isn't set up yet. Sign in to search, fill carts and re-download what you've bought. Click to sign in.`);
    }
  };

  try {
    const statuses = await window.candybar.storeLoginStatus();
    const qobuzAccountCount = Object.keys(statuses.qobuzAccounts ?? {}).length;
    const qobuzConnectedCount = Object.values(statuses.qobuzAccounts ?? {}).filter(Boolean).length;
    const beatportAccountCount = Object.keys(statuses.beatportAccounts ?? {}).length;
    const beatportConnectedCount = Object.values(statuses.beatportAccounts ?? {}).filter(Boolean).length;

    applyState(qobuzStatus, qobuzStatusText, 'Qobuz', statuses.qobuz, qobuzConnectedCount || qobuzAccountCount);
    applyState(beatportStatus, beatportStatusText, 'Beatport', statuses.beatport, beatportConnectedCount || beatportAccountCount);

    if (showToasts) {
      if (statuses.qobuz) {
        showToast('success', 'Qobuz is connected', qobuzConnectedCount > 1 ? `${qobuzConnectedCount} accounts are signed in.` : 'You\'re signed in.');
      } else {
        showToast('warning', 'Qobuz isn\'t connected', qobuzAccountCount > 0 ? 'Sign in again from Settings → Qobuz.' : 'Add your Qobuz account in Settings.');
      }
      if (statuses.beatport) {
        showToast('success', 'Beatport is connected', beatportConnectedCount > 1 ? `${beatportConnectedCount} accounts are signed in.` : 'You\'re signed in.');
      } else {
        showToast('warning', 'Beatport isn\'t connected', beatportAccountCount > 0 ? 'Sign in again from Settings → Beatport.' : 'Add your Beatport account in Settings.');
      }
    }
  } catch (err) {
    for (const [el, text, store] of [[qobuzStatus, qobuzStatusText, 'Qobuz'], [beatportStatus, beatportStatusText, 'Beatport']] as const) {
      setServiceState(el, text, 'problem', 'couldn\'t check', `${store}: couldn't check your sign-in. Click to try again.`);
    }
    if (showToasts) {
      const message = err instanceof Error ? err.message : 'Unknown error occurred';
      showToast('error', 'Couldn\'t check your store sign-ins', message);
    }
  } finally {
    isCheckingStores = false;
  }
}

/** SoundCloud's pill is the one saved sign-in that private sets, the
 *  downloader and Claude's SoundCloud jobs all use. Without `signIn` it reads
 *  the note the last check left (no Chrome); with it, it checks for real and
 *  opens a sign-in window only when the profile is signed out. */
export async function checkSoundCloudConnection(signIn = false) {
  if (isCheckingSoundCloud) return;
  isCheckingSoundCloud = true;

  const soundcloudStatus = document.getElementById('soundcloud-status') as HTMLDivElement;
  const soundcloudStatusText = soundcloudStatus.querySelector('.soundcloud-status-text') as HTMLSpanElement;
  setServiceState(soundcloudStatus, soundcloudStatusText, 'checking', 'checking', 'SoundCloud: checking your sign-in…');

  try {
    let status: SoundCloudSignIn | null;
    if (signIn) {
      const res = await window.candybar.soundcloudSignIn();
      if (!res.success) throw new Error(res.error ?? 'Sign-in failed');
      status = res.status ?? null;
    } else {
      status = await window.candybar.soundcloudSignInStatus();
    }
    if (status?.signedIn) {
      const who = status.username || status.permalink || 'your account';
      setServiceState(soundcloudStatus, soundcloudStatusText, 'ok', 'signed in',
        `SoundCloud: signed in as ${who}. Private sets, your likes and free downloads all use this sign-in. Click to check again.`);
      if (signIn) showToast('success', `Signed in to SoundCloud as ${who}`, 'Private sets, likes and free downloads use this sign-in.');
    } else {
      setServiceState(soundcloudStatus, soundcloudStatusText, 'off', 'not signed in',
        'SoundCloud: not signed in. Track Lab needs it for private sets, your likes and SoundCloud\'s own download buttons. Click to sign in.');
      if (signIn) showToast('warning', 'Not signed in to SoundCloud', 'The sign-in window closed before you finished.');
    }
  } catch (err) {
    const message = getErrorMessage(err);
    setServiceState(soundcloudStatus, soundcloudStatusText, 'problem', 'not working',
      `SoundCloud: couldn't check your sign-in (${message}). Click to try again.`);
    if (signIn) showToast('error', 'Couldn\'t check SoundCloud', message);
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
  // Capture phase so Escape closes only the viewer, not the tag editor or
  // drawer it was opened over.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.style.display === 'flex') {
      e.stopImmediatePropagation();
      close();
    }
  }, true);
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
/** Gives focus back to whatever opened the editor. */
let tagEditorFocusReturn: (() => void) | null = null;
let tagEditorPendingAlbumArt: string | null = null;
let tagEditorArtSuggestions: AlbumArtSuggestion[] = [];
let tagEditorArtSearchToken = 0;
let tagEditorArtLoadToken = 0;

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
  setTagEditorPendingArt(snapshot.albumArt);
  _tagEditorAlbumArtPreview.innerHTML = snapshot.albumArtHtml;
  updateTagEditorMoreHint();
}

export function pushTagEditorUndo() {
  tagEditorUndoStack.push(captureTagEditorSnapshot());
  tagEditorRedoStack = [];
}

const TAG_EDITOR_ART_PLACEHOLDER = `<svg class="album-art-placeholder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
  <rect x="3" y="3" width="18" height="18" rx="2"/>
  <circle cx="12" cy="12" r="4"/>
  <circle cx="12" cy="12" r="1"/>
</svg>`;

const TAG_EDITOR_ARTIST_HELP = 'Track Lab names the track\'s folder in your library after the artist.';

/** The cover waiting to be saved, and the note that says it isn't saved yet. */
function setTagEditorPendingArt(dataUrl: string | null) {
  tagEditorPendingAlbumArt = dataUrl;
  if (_tagEditorPendingArtNote) _tagEditorPendingArtNote.hidden = !dataUrl;
}

/** Artist is the one field the editor insists on; say so beside it, not in a toast. */
function setTagEditorArtistError(missing: boolean) {
  const input = document.getElementById('edit-artist') as HTMLInputElement | null;
  const help = document.getElementById('edit-artist-help');
  input?.toggleAttribute('aria-invalid', missing);
  if (help) {
    help.classList.toggle('is-error', missing);
    help.textContent = missing
      ? 'Add an artist name to save. Track Lab names the track\'s folder after it.'
      : TAG_EDITOR_ARTIST_HELP;
  }
}

/** "More details" is folded; its hint shows what's already in there
 *  ("124 BPM · 8A · Tech house") so nothing filled in feels hidden. */
function updateTagEditorMoreHint() {
  const hint = document.getElementById('tag-editor-more-hint');
  if (!hint) return;
  const bpm = getValue('edit-bpm');
  const filled = [
    bpm ? `${bpm} BPM` : '',
    getValue('edit-key'),
    getValue('edit-genre'),
    getValue('edit-year'),
    getValue('edit-label'),
  ].filter(Boolean);
  hint.textContent = filled.length ? filled.join(' · ') : 'BPM, key, genre, label and more';
}

/** WAV and FLAC files can't hold track info reliably, so saving it turns them
 *  into an AIFF copy (original to the Trash). Ask first. Resolves true for
 *  every other file type without asking. Used by the editor and by the
 *  inline "add artist" fix on Sort new music. */
export async function confirmTagWriteConversion(filePath: string): Promise<boolean> {
  const lower = filePath.toLowerCase();
  const type = lower.endsWith('.wav') ? 'WAV' : lower.endsWith('.flac') ? 'FLAC' : null;
  if (!type) return true;
  return confirmAction({
    title: 'Save this track as an AIFF?',
    message: `${type} files can't reliably hold track info like the artist and title, so Track Lab saves your changes into an AIFF copy instead.`,
    details: [{ label: 'File', value: filePath.split('/').pop() || filePath }],
    safetyNote: `AIFF is full quality and sounds identical to ${type}. The original ${type} goes to the Trash, so you can put it back.`,
    confirmLabel: 'Save as AIFF',
    tone: 'caution',
  });
}

/** Busy text on a button that also carries an icon: only its label changes. */
function setTagEditorButtonLabel(btn: HTMLButtonElement, labelSelector: string, text: string) {
  const label = btn.querySelector<HTMLElement>(labelSelector);
  if (label) label.textContent = text;
  else btn.textContent = text;
}

let _tagEditorModal: HTMLDivElement;
let _tagEditorAlbumArtPreview: HTMLDivElement;
let _tagEditorSearchAlbumArtBtn: HTMLButtonElement;
let _tagEditorAlbumArtSuggestions: HTMLDivElement;
let _tagEditorAlbumArtSuggestionsStatus: HTMLDivElement;
let _tagEditorAlbumArtSuggestionsGrid: HTMLDivElement;
let _tagEditorSaveBtn: HTMLButtonElement;
let _tagEditorScanTagsBtn: HTMLButtonElement;
let _tagEditorPendingArtNote: HTMLElement | null = null;

export function initTagEditor() {
  _tagEditorModal = document.getElementById('tag-editor-modal') as HTMLDivElement;
  _tagEditorAlbumArtPreview = document.getElementById('album-art-preview') as HTMLDivElement;
  _tagEditorSearchAlbumArtBtn = document.getElementById('search-album-art') as HTMLButtonElement;
  _tagEditorAlbumArtSuggestions = document.getElementById('album-art-suggestions') as HTMLDivElement;
  _tagEditorAlbumArtSuggestionsStatus = document.getElementById('album-art-suggestions-status') as HTMLDivElement;
  _tagEditorAlbumArtSuggestionsGrid = document.getElementById('album-art-suggestions-grid') as HTMLDivElement;
  _tagEditorSaveBtn = document.getElementById('save-tag-editor') as HTMLButtonElement;
  _tagEditorScanTagsBtn = document.getElementById('scan-tags') as HTMLButtonElement;
  _tagEditorPendingArtNote = document.getElementById('album-art-pending-note');

  const closeBtn = document.getElementById('close-tag-editor') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cancel-tag-editor') as HTMLButtonElement;
  const changeAlbumArtBtn = document.getElementById('change-album-art') as HTMLButtonElement;

  closeBtn.addEventListener('click', closeTagEditor);
  cancelBtn.addEventListener('click', closeTagEditor);

  _tagEditorModal.addEventListener('click', (e) => {
    if (e.target === _tagEditorModal) closeTagEditor();
  });

  // It's a dialog: say so, keep Tab inside it, and let Escape close it. A
  // confirm or the art viewer opened on top handles those keys first (and
  // stops or marks them), so they never reach this.
  const drawer = _tagEditorModal.querySelector<HTMLElement>('.drawer');
  drawer?.setAttribute('role', 'dialog');
  drawer?.setAttribute('aria-modal', 'true');
  drawer?.setAttribute('aria-labelledby', 'tag-editor-title');
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || _tagEditorModal.style.display === 'none') return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeTagEditor();
    } else if (e.key === 'Tab') {
      trapDialogFocus(drawer ?? _tagEditorModal, e);
    }
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
    el.addEventListener('input', updateTagEditorMoreHint);
  }
  // The "artist needed" note clears as soon as there's a name in the box.
  document.getElementById('edit-artist')?.addEventListener('input', () => {
    if (getValue('edit-artist')) setTagEditorArtistError(false);
  });

  changeAlbumArtBtn.addEventListener('click', async () => {
    pushTagEditorUndo();
    const imageData = await window.candybar.selectImage();
    if (imageData) {
      setTagEditorPendingArt(imageData);
      _tagEditorAlbumArtPreview.innerHTML = `<img src="${imageData}" alt="Cover art" />`;
    }
  });

  _tagEditorSearchAlbumArtBtn.addEventListener('click', () => tagEditorSearchAlbumArt());

  _tagEditorScanTagsBtn.addEventListener('click', () => tagEditorScanTags());

  _tagEditorSaveBtn.addEventListener('click', async () => {
    const filePath = getValue('edit-file-path');
    const title = getValue('edit-title');
    const artist = getValue('edit-artist');

    if (!artist) {
      setTagEditorArtistError(true);
      document.getElementById('edit-artist')?.focus();
      return;
    }

    // Locked before the WAV confirm, so a double-click can't open two of them
    // and save twice.
    if (_tagEditorSaveBtn.disabled) return;
    _tagEditorSaveBtn.disabled = true;

    if (!(await confirmTagWriteConversion(filePath))) {
      _tagEditorSaveBtn.disabled = false;
      return;
    }

    _tagEditorSaveBtn.textContent = 'Saving…';

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
      showToast('success', 'Track info saved', `Saved your changes to "${title || updatedTrack.fileName}".`);
    } catch (err) {
      showToast('error', 'Couldn\'t save track info', getErrorMessage(err));
    } finally {
      _tagEditorSaveBtn.disabled = false;
      _tagEditorSaveBtn.textContent = 'Save changes';
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
  setTagEditorArtistError(false);
  updateTagEditorMoreHint();
  const more = document.getElementById('tag-editor-more') as HTMLDetailsElement | null;
  if (more) more.open = false;

  // Which file this is, so two tracks with the same title can't be mixed up.
  const fileLabel = document.getElementById('tag-editor-file');
  if (fileLabel) {
    fileLabel.textContent = track.filePath.split('/').pop() || track.filePath;
    fileLabel.title = track.filePath;
  }

  setTagEditorPendingArt(null);
  // Each open gets a token, so a slow art read for the previous track can't
  // land in this one's preview.
  const artToken = ++tagEditorArtLoadToken;
  const hasArt = track.albumArt || track.hasAlbumArt;
  if (track.albumArt) {
    _tagEditorAlbumArtPreview.innerHTML = `<img src="${track.albumArt}" alt="Cover art" />`;
  } else if (track.hasAlbumArt) {
    _tagEditorAlbumArtPreview.innerHTML = `<div class="inspector-art-loading album-art-loading">Loading cover…</div>`;
    window.candybar.getTrackAlbumArt(track.filePath).then((dataUrl) => {
      if (artToken !== tagEditorArtLoadToken) return;
      _tagEditorAlbumArtPreview.innerHTML = dataUrl
        ? `<img src="${dataUrl}" alt="Cover art" />`
        : TAG_EDITOR_ART_PLACEHOLDER;
    }).catch(() => {});
  } else {
    _tagEditorAlbumArtPreview.innerHTML = TAG_EDITOR_ART_PLACEHOLDER;
  }

  tagEditorArtSuggestions = [];
  _tagEditorAlbumArtSuggestions.style.display = 'none';
  _tagEditorAlbumArtSuggestionsGrid.innerHTML = '';

  tagEditorUndoStack = [];
  tagEditorRedoStack = [];

  if (_tagEditorModal.style.display === 'none') tagEditorFocusReturn = captureFocusReturn();
  _tagEditorModal.style.display = 'flex';
  // Opened to add a missing artist? Start there.
  const firstField = track.artist ? 'edit-title' : 'edit-artist';
  requestAnimationFrame(() => document.getElementById(firstField)?.focus());

  if (!hasArt) {
    tagEditorSearchAlbumArt(true);
  }
}

export function closeTagEditor() {
  const wasOpen = _tagEditorModal.style.display !== 'none';
  _tagEditorModal.style.display = 'none';
  setTagEditorPendingArt(null);
  tagEditorOnSave = null;
  tagEditorArtSuggestions = [];
  _tagEditorAlbumArtSuggestions.style.display = 'none';
  _tagEditorAlbumArtSuggestionsGrid.innerHTML = '';
  if (wasOpen) tagEditorFocusReturn?.();
  tagEditorFocusReturn = null;
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
    showToast('warning', 'Add an artist or title first', 'Track Lab searches online using them.');
    return;
  }

  _tagEditorScanTagsBtn.disabled = true;
  setTagEditorButtonLabel(_tagEditorScanTagsBtn, '.tag-editor-fill-label', 'Searching…');

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
      showToast('warning', 'No close match online', 'Track Lab couldn\'t find a track that clearly matches. Check the artist and title are spelled right, then try again.');
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
    updateTagEditorMoreHint();
    // Filled something that lives under "More details"? Show it.
    if (populated.some((f) => f === 'album' || f === 'year' || f === 'genre')) {
      const more = document.getElementById('tag-editor-more') as HTMLDetailsElement | null;
      if (more) more.open = true;
    }

    const sourceName = top.source === 'spotify' ? 'Spotify' : 'SoundCloud';
    if (populated.length === 0) {
      showToast('info', 'Nothing new to add', `The closest match on ${sourceName} (${top.confidence}% match) has nothing for your empty fields.`);
    } else {
      const filled = populated.join(', ').replace(/, ([^,]*)$/, ' and $1');
      showToast('success', `Filled in from ${sourceName}`, `Added the ${filled} (${top.confidence}% match). Check them, then press Save changes.`);
    }
  } catch (err) {
    showToast('error', 'Couldn\'t search online', getErrorMessage(err));
  } finally {
    _tagEditorScanTagsBtn.disabled = false;
    setTagEditorButtonLabel(_tagEditorScanTagsBtn, '.tag-editor-fill-label', 'Fill in from the internet');
  }
}

/** `auto`: the search that runs on open for a track with no cover, which
 *  stays quiet when there's nothing to search with yet. */
async function tagEditorSearchAlbumArt(auto = false) {
  const artist = getValue('edit-artist');
  const title = getValue('edit-title');
  const query = `${artist} ${title}`.trim();
  if (!query) {
    if (!auto) showToast('warning', 'Add an artist or title first', 'Track Lab searches for the cover using them.');
    return;
  }

  const token = ++tagEditorArtSearchToken;
  _tagEditorSearchAlbumArtBtn.disabled = true;
  setTagEditorButtonLabel(_tagEditorSearchAlbumArtBtn, '.album-art-search-label', 'Searching…');
  _tagEditorAlbumArtSuggestions.style.display = 'block';
  _tagEditorAlbumArtSuggestionsStatus.textContent = 'Looking for covers on Spotify and SoundCloud…';
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
      _tagEditorAlbumArtSuggestionsStatus.textContent = 'No covers found online for this track. You can choose an image from your computer instead.';
    } else {
      const n = tagEditorArtSuggestions.length;
      _tagEditorAlbumArtSuggestionsStatus.textContent = `${n === 1 ? '1 cover' : `${n} covers`} found, closest match first. Pick one to use it.`;
      tagEditorRenderArtSuggestions();
    }
  } catch {
    if (token !== tagEditorArtSearchToken) return;
    _tagEditorAlbumArtSuggestionsStatus.textContent = 'Couldn\'t search for covers. Check your internet connection, then try Find cover online again.';
  } finally {
    _tagEditorSearchAlbumArtBtn.disabled = false;
    setTagEditorButtonLabel(_tagEditorSearchAlbumArtBtn, '.album-art-search-label', 'Find cover online');
  }
}

function tagEditorRenderArtSuggestions() {
  _tagEditorAlbumArtSuggestionsGrid.innerHTML = '';
  for (const suggestion of tagEditorArtSuggestions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'album-art-suggestion-thumb';
    const sourceName = suggestion.source === 'spotify' ? 'Spotify' : 'SoundCloud';
    const label = `${suggestion.artist} — ${suggestion.title}. From ${sourceName}, ${suggestion.confidence}% match.`;
    btn.setAttribute('data-tooltip', label);
    btn.setAttribute('aria-label', `Use this cover: ${label}`);
    btn.setAttribute('aria-pressed', 'false');

    const img = document.createElement('img');
    img.src = suggestion.imageUrl;
    img.alt = '';
    btn.appendChild(img);

    btn.addEventListener('click', async () => {
      try {
        pushTagEditorUndo();
        const dataUrl = await fetchImageAsDataUrl(suggestion.imageUrl);
        setTagEditorPendingArt(dataUrl);
        _tagEditorAlbumArtPreview.innerHTML = `<img src="${dataUrl}" alt="Cover art" />`;

        _tagEditorAlbumArtSuggestionsGrid.querySelectorAll('.album-art-suggestion-thumb').forEach((el) => {
          el.classList.remove('selected');
          el.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('selected');
        btn.setAttribute('aria-pressed', 'true');
      } catch {
        showToast('error', 'Couldn\'t load that cover', 'Try another one, or choose an image from your computer.');
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

      // Merge-write just this key: a full getConfig → setConfig here could
      // overwrite a Settings or tour save that landed in between.
      try {
        await window.candybar.updateConfig({ activeTab: targetPage });
      } catch (err) {
        console.error('[Navigation] saving activeTab failed:', err);
      }
    });
  });
}
