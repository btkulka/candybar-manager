import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppConfig,
  ScriptOutput,
  TrackInfo,
  AlbumArtMissingTrack,
  AlbumArtScanProgress,
  UpdateTagsParams,
  OrganizeResult,
  OrganizeProgress,
  ConversionResult,
  LibraryHealthResult,
  CheckResultFull,
  CheckProgress,
  HealthScanProgress,
  ScanProgress,
  CsvPreview,
  CacheStatus,
  StorageStats,
  ArchiveResult,
  JobInfo,
  JobProgress,
  StoreTrackInput,
  StoreMatch,
  StoreSearchProgress,
  StoreCartProgress,
  StoreSearchResult,
  StoreCartResult,
  VolumeInfo,
  UsbHealthProgress
} from './types';

contextBridge.exposeInMainWorld('candybar', {
  selectPath: (type: 'file' | 'dir') => ipcRenderer.invoke('select-path', { type }),
  /**
   * @deprecated Use `librarySourcingRun` instead (phase 1 + phase 2 combined).
   * Kept for one release so external callers (MCP, scripts) that drive the
   * phase-1 library-match path independently don't break.
   */
  checkLibrary: (source: { csvPath?: string; spotifyPlaylistUrl?: string }, useCache = true, cacheOnly = false) =>
    ipcRenderer.invoke('check-library', { ...source, useCache, cacheOnly }),
  getConfig: () => ipcRenderer.invoke('get-config'),
  getLibraryRoot: () => ipcRenderer.invoke('get-library-root'),
  setConfig: (config: AppConfig) => ipcRenderer.invoke('set-config', config),
  migrateArchive: (oldPath: string, newPath: string) =>
    ipcRenderer.invoke('migrate-archive', { oldPath, newPath }),
  onMigrateProgress: (callback: (payload: { current: number; total: number; file: string }) => void) =>
    ipcRenderer.on('migrate-progress', (_event, payload) => callback(payload)),
  searchMusic: (query: string, sources: ('spotify' | 'soundcloud' | 'beatport' | 'qobuz')[]) =>
    ipcRenderer.invoke('search-music', { query, sources }),
  checkSpotify: () => ipcRenderer.invoke('check-spotify'),
  getSpotifyPlaylistInfo: (url: string) => ipcRenderer.invoke('get-spotify-playlist-info', url),
  checkSoundCloud: () => ipcRenderer.invoke('check-soundcloud'),
  onOutput: (callback: (payload: ScriptOutput) => void) =>
    ipcRenderer.on('script-output', (_event, payload: ScriptOutput) => callback(payload)),
  onCheckProgress: (callback: (payload: CheckProgress) => void) =>
    ipcRenderer.on('check-progress', (_event, payload: CheckProgress) => callback(payload)),

  // Track scanning and organization
  scanTracks: (sourceDir: string): Promise<TrackInfo[]> =>
    ipcRenderer.invoke('scan-tracks', { sourceDir }),
  onScanProgress: (callback: (payload: ScanProgress) => void) => {
    const listener = (_e: unknown, payload: ScanProgress) => callback(payload);
    ipcRenderer.on('scan-progress', listener);
    return () => ipcRenderer.off('scan-progress', listener);
  },
  autopopulateTracks: (tracks: Array<{ filePath: string; title: string; artist: string; album: string; year: string; genre: string; label: string; key: string; bpm: string; remixer: string; hasAlbumArt: boolean }>, force = false): Promise<Array<{ filePath: string; updated: boolean; fieldsPopulated: string[]; error?: string }>> =>
    ipcRenderer.invoke('autopopulate-tracks', { tracks, force }),
  onAutopopulateProgress: (callback: (payload: { current: number; total: number; filePath: string }) => void) => {
    // Registered once per scan (organize + bulk-populate flows). Remove any prior
    // listener so repeated scans replace rather than accumulate leaked listeners.
    ipcRenderer.removeAllListeners('autopopulate-progress');
    const listener = (_e: unknown, payload: { current: number; total: number; filePath: string }) => callback(payload);
    ipcRenderer.on('autopopulate-progress', listener);
    return () => ipcRenderer.off('autopopulate-progress', listener);
  },
  scanMissingAlbumArt: (): Promise<{ id: string; tracks: AlbumArtMissingTrack[] }> =>
    ipcRenderer.invoke('scan-missing-album-art'),
  onPolishScanProgress: (callback: (payload: AlbumArtScanProgress) => void) =>
    ipcRenderer.on('polish-scan-progress', (_event, payload: AlbumArtScanProgress) => callback(payload)),
  updateTrackTags: (params: UpdateTagsParams): Promise<TrackInfo> =>
    ipcRenderer.invoke('update-track-tags', params),
  getTrackInfo: (filePath: string): Promise<TrackInfo | null> =>
    ipcRenderer.invoke('get-track-info', { filePath }),
  diagnoseAiffHeader: (filePath: string) =>
    ipcRenderer.invoke('diagnose-aiff-header', filePath),
  repairAiffHeader: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('repair-aiff-header', filePath),
  selectImage: (): Promise<string | null> => ipcRenderer.invoke('select-image'),
  organizeTracks: (
    tracks: Array<{ filePath: string; ignored: boolean; isHealthy?: boolean }>
  ): Promise<OrganizeResult[]> => ipcRenderer.invoke('organize-tracks', { tracks }),
  onOrganizeProgress: (callback: (payload: OrganizeProgress) => void) => {
    const listener = (_e: unknown, payload: OrganizeProgress) => callback(payload);
    ipcRenderer.on('organize-progress', listener);
    return () => ipcRenderer.off('organize-progress', listener);
  },

  organizeResolveConflict: (
    incomingPath: string, existingPath: string, targetPath: string, keep: 'incoming' | 'existing'
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('organize-resolve-conflict', { incomingPath, existingPath, targetPath, keep }),

  // Album art extraction from audio file
  getTrackAlbumArt: (filePath: string): Promise<string | null> =>
    ipcRenderer.invoke('get-track-album-art', { filePath }),

  // DevTools toggle
  toggleDevTools: (): Promise<void> => ipcRenderer.invoke('toggle-devtools'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open-external', { url }),
  showInFinder: (filePath: string): Promise<void> => ipcRenderer.invoke('show-in-finder', { filePath }),

  // Track conversion
  convertTrack: (filePath: string): Promise<ConversionResult> =>
    ipcRenderer.invoke('convert-track', { filePath }),

  // Library health scan
  scanLibraryHealth: (useCache = true, cacheOnly = false): Promise<{ id: string; result?: LibraryHealthResult; fromCache: boolean; cacheOnly?: boolean }> =>
    ipcRenderer.invoke('scan-library-health', { useCache, cacheOnly }),
  onHealthScanProgress: (callback: (payload: HealthScanProgress) => void) =>
    ipcRenderer.on('health-scan-progress', (_event, payload: HealthScanProgress) => callback(payload)),
  deleteTrackFile: (filePath: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('delete-track-file', { filePath }),
  fixTrackFile: (filePath: string, deleteOriginal: boolean): Promise<ConversionResult> =>
    ipcRenderer.invoke('fix-track-file', { filePath, deleteOriginal }),
  reencodeTrackFile: (filePath: string, deleteOriginal: boolean): Promise<ConversionResult> =>
    ipcRenderer.invoke('reencode-track-file', { filePath, deleteOriginal }),
  archiveTrackFile: (filePath: string): Promise<ArchiveResult> =>
    ipcRenderer.invoke('archive-track-file', { filePath }),

  // CSV preview
  previewCsv: (csvPath: string): Promise<CsvPreview> =>
    ipcRenderer.invoke('preview-csv', { csvPath }),

  // Cache management
  getCacheStatus: (): Promise<CacheStatus> =>
    ipcRenderer.invoke('get-cache-status'),
  clearCache: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('clear-cache'),
  updateCheckResult: (result: any): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('update-check-result', { result }),
  updateHealthResult: (result: any): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('update-health-result', { result }),
  getOrganizeState: (): Promise<any> =>
    ipcRenderer.invoke('get-organize-state'),
  updateOrganizeState: (state: any): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('update-organize-state', { state }),
  getStorageStats: (): Promise<StorageStats> =>
    ipcRenderer.invoke('get-storage-stats'),

  // CSV export
  showSaveDialog: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('show-save-dialog', { defaultName }),
  exportTracksCsv: (
    tracks: Array<{ artist: string; title: string; album?: string; genre?: string }>,
    filePath: string
  ): Promise<{ success: boolean; filePath?: string; error?: string }> =>
    ipcRenderer.invoke('export-tracks-csv', { tracks, filePath }),

  // M3U8 playlist export
  showSaveDialogM3u8: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('show-save-dialog-m3u8', { defaultName }),
  exportPlaylistM3u8: (
    tracks: Array<{ artist: string; title: string; filePath?: string }>,
    filePath: string
  ): Promise<{ success: boolean; filePath?: string; trackCount?: number; error?: string }> =>
    ipcRenderer.invoke('export-playlist-m3u8', { tracks, filePath }),

  // Rekordbox XML playlist export
  showSaveDialogRekordbox: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('show-save-dialog-rekordbox', { defaultName }),
  exportPlaylistRekordbox: (
    tracks: Array<{ artist: string; title: string; filePath?: string; duration?: number }>,
    filePath: string,
    playlistName: string
  ): Promise<{ success: boolean; filePath?: string; trackCount?: number; error?: string }> =>
    ipcRenderer.invoke('export-playlist-rekordbox', { tracks, filePath, playlistName }),

  // Catalog JSON export
  showSaveDialogJson: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('show-save-dialog-json', { defaultName }),
  exportCatalog: (outputPath: string): Promise<{ id: string; success: boolean; total?: number; exported?: number; skipped?: number; error?: string }> =>
    ipcRenderer.invoke('export-catalog', { outputPath }),

  // Job queue API
  jobEnqueue: (type: string, params: unknown, contextKey: string): Promise<{ jobId: string }> =>
    ipcRenderer.invoke('job-enqueue', { type, params, contextKey }),
  jobEnqueueAndWait: (type: string, params: unknown, contextKey: string): Promise<{ jobId: string; success: boolean; result?: unknown; error?: string }> =>
    ipcRenderer.invoke('job-enqueue-and-wait', { type, params, contextKey }),
  jobCancel: (jobId: string): Promise<boolean> =>
    ipcRenderer.invoke('job-cancel', { jobId }),
  jobList: (): Promise<JobInfo[]> =>
    ipcRenderer.invoke('job-list'),
  onJobUpdate: (callback: (info: JobInfo) => void) =>
    ipcRenderer.on('job-update', (_event, info: JobInfo) => callback(info)),
  onJobProgress: (callback: (progress: JobProgress) => void) =>
    ipcRenderer.on('job-progress', (_event, progress: JobProgress) => callback(progress)),

  // Ignored tracks
  ignoreTrack: (key: string, artist: string, title: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('ignore-track', { key, artist, title }),
  unignoreTrack: (key: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('unignore-track', { key }),
  getIgnoredTracks: (): Promise<Array<{ key: string; artist: string; title: string; ignored_at: string }>> =>
    ipcRenderer.invoke('get-ignored-tracks'),

  // Dismissed duplicates
  dismissDuplicate: (track1Artist: string, track1Title: string, track2Artist: string, track2Title: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('dismiss-duplicate', { track1Artist, track1Title, track2Artist, track2Title }),

  // Dismissed health issues
  dismissHealthIssue: (libraryRoot: string, filePath: string, issueCode: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('dismiss-health-issue', { libraryRoot, filePath, issueCode }),
  undismissHealthIssue: (libraryRoot: string, filePath: string, issueCode: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('undismiss-health-issue', { libraryRoot, filePath, issueCode }),
  getDismissedIssues: (libraryRoot: string): Promise<Array<{ filePath: string; issueCode: string }>> =>
    ipcRenderer.invoke('get-dismissed-issues', { libraryRoot }),

  // Source search (CSV or Spotify playlist → lossless purchase sources)
  sourceSearch: (source: { csvPath?: string; spotifyPlaylistUrl?: string }) =>
    ipcRenderer.invoke('source-search', source),
  sourceExportCsv: (content: string, filePath: string) =>
    ipcRenderer.invoke('source-export-csv', { content, filePath }),

  // Combined library-check + store-search pipeline (replaces both check-library
  // and source-search in the merged tab). Phase 1 is library fuzzy-match,
  // phase 2 is store search for the uncertain + missing subset.
  librarySourcingRun: (source: { csvPath?: string; spotifyPlaylistUrl?: string }) =>
    ipcRenderer.invoke('library-sourcing:run', source),
  onLibrarySourcingPhase1Progress: (callback: (payload: { phase?: string; current: number; total: number; message?: string }) => void) =>
    ipcRenderer.on('library-sourcing:phase1-progress', (_event, payload) => callback(payload)),
  onLibrarySourcingPhase2Progress: (callback: (payload: { current: number; total: number; currentTrack: string }) => void) =>
    ipcRenderer.on('library-sourcing:phase2-progress', (_event, payload) => callback(payload)),
  onLibrarySourcingPhase2Match: (callback: (match: unknown) => void) =>
    ipcRenderer.on('library-sourcing:phase2-match', (_event, match) => callback(match)),
  onLibrarySourcingPlaylistInfo: (callback: (info: import('./types').SourcePlaylistInfo) => void) =>
    ipcRenderer.on('library-sourcing:playlist-info', (_event, info) => callback(info)),

  // Qobuz cart integration
  qobuzCartSearch: (tracks: Array<{ key: string; artist: string; title: string; album?: string; duration?: number }>) =>
    ipcRenderer.invoke('qobuz-cart-search', { tracks }),
  onQobuzCartSearchProgress: (callback: (payload: { current: number; total: number; currentTrack: string }) => void) =>
    ipcRenderer.on('qobuz-cart-search-progress', (_event, payload) => callback(payload)),
  onQobuzCartSearchMatch: (callback: (match: unknown) => void) =>
    ipcRenderer.on('qobuz-cart-search-match', (_event, match) => callback(match)),
  qobuzCartAdd: (tracks: Array<{ id: string; url: string; name: string; artists: string[] }>) =>
    ipcRenderer.invoke('qobuz-cart-add', { tracks }),
  onQobuzCartAddProgress: (callback: (payload: { current: number; total: number; currentTrack: string; phase: string; message: string }) => void) =>
    ipcRenderer.on('qobuz-cart-add-progress', (_event, payload) => callback(payload)),
  qobuzBrowserClose: () => ipcRenderer.invoke('qobuz-browser-close'),
  qobuzBrowserStatus: () => ipcRenderer.invoke('qobuz-browser-status'),

  // Store purchase integration
  storeLogin: (store: 'qobuz' | 'beatport'): Promise<{ success: boolean; error?: string; perAccount?: Record<string, boolean> }> =>
    ipcRenderer.invoke('store-login', { store }),
  storeLoginStatus: (): Promise<{ qobuz: boolean; beatport: boolean; qobuzAccounts: Record<string, boolean>; beatportAccounts: Record<string, boolean> }> =>
    ipcRenderer.invoke('store-login-status'),
  storeLoginAccount: (
    store: 'qobuz' | 'beatport',
    account: { id: string; email?: string; label?: string }
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('store-login-account', { store, account }),
  storeLogoutAccount: (
    store: 'qobuz' | 'beatport',
    accountId: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('store-logout-account', { store, accountId }),
  fetchStorePurchases: (source: 'qobuz' | 'beatport'): Promise<{ success: boolean; owned?: Array<{ source: 'qobuz' | 'beatport'; trackId: string; artist: string; title: string }>; error?: string }> =>
    ipcRenderer.invoke('fetch-store-purchases', { source }),
  probeBeatportPurchases: (): Promise<{ success: boolean; results?: Array<{ url: string; auth: string; status: number; ok: boolean; bodySnippet: string; topLevelKeys?: string[]; count?: number; firstResultKeys?: string[]; firstResultSample?: unknown }>; outPath?: string; error?: string }> =>
    ipcRenderer.invoke('probe-beatport-purchases'),
  probeQobuzDownload: (trackId: string): Promise<{ success: boolean; results?: Array<{ url: string; method: string; status: number; ok: boolean; body: string; parsed?: unknown }>; error?: string }> =>
    ipcRenderer.invoke('probe-qobuz-download', { trackId }),
  probeQobuzPurchases: (): Promise<{ success: boolean; results?: Array<{ url: string; method: string; status: number; ok: boolean; bodyLength: number; bodySnippet: string; hasListItems?: boolean; jsonTopLevelKeys?: string[] }>; outPath?: string; error?: string }> =>
    ipcRenderer.invoke('probe-qobuz-purchases'),
  openQobuzLoginWindow: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('open-qobuz-login-window'),
  sniffQobuzHeaders: (): Promise<{ success: boolean; capturedCount?: number; totalUrls?: number; outPath?: string; sample?: Array<{ url: string; headers: Record<string, string> }>; urlSample?: string[]; error?: string }> =>
    ipcRenderer.invoke('sniff-qobuz-headers'),
  sniffBeatportHeaders: (): Promise<{ success: boolean; capturedCount?: number; totalUrls?: number; outPath?: string; error?: string }> =>
    ipcRenderer.invoke('sniff-beatport-headers'),
  probeBeatportDownloadLink: (trackId: string, orderItemDownloadId?: string): Promise<{ success: boolean; results?: Array<{ url: string; auth: string; status: number; ok: boolean; bodySnippet: string; topLevelKeys?: string[]; firstResultSample?: unknown }>; error?: string }> =>
    ipcRenderer.invoke('probe-beatport-download-link', { trackId, orderItemDownloadId }),
  downloadBeatportMatches: (matches: unknown[], destDir: string): Promise<{ success: boolean; downloaded?: string[]; failed?: Array<{ artist: string; title: string; error: string }>; destDir?: string; error?: string }> =>
    ipcRenderer.invoke('download-beatport-matches', { matches, destDir }),
  downloadBeatportMatchesConcurrent: (matches: unknown[], destDir: string, concurrency: number): Promise<{ success: boolean; downloaded?: string[]; failed?: Array<{ artist: string; title: string; error: string }>; destDir?: string; error?: string }> =>
    ipcRenderer.invoke('download-beatport-matches-concurrent', { matches, destDir, concurrency }),
  downloadQobuzMatchesConcurrent: (matches: unknown[], destDir: string, concurrency: number): Promise<{ success: boolean; downloaded?: string[]; failed?: Array<{ artist: string; title: string; error: string }>; destDir?: string; error?: string }> =>
    ipcRenderer.invoke('download-qobuz-matches-concurrent', { matches, destDir, concurrency }),
  onDownloadQobuzProgress: (callback: (p: { current: number; total: number; currentTrack: string; phase: string; message: string }) => void) => {
    const listener = (_e: unknown, p: Parameters<typeof callback>[0]) => callback(p);
    ipcRenderer.on('download-qobuz-progress', listener);
    return () => ipcRenderer.off('download-qobuz-progress', listener);
  },
  onDownloadBeatportProgress: (callback: (p: { current: number; total: number; currentTrack: string; phase: string; message: string }) => void) => {
    const listener = (_e: unknown, p: Parameters<typeof callback>[0]) => callback(p);
    ipcRenderer.on('download-beatport-progress', listener);
    return () => ipcRenderer.off('download-beatport-progress', listener);
  },
  storeSearch: (tracks: StoreTrackInput[], source: 'qobuz' | 'beatport'): Promise<{ success: boolean; result?: StoreSearchResult; error?: string }> =>
    ipcRenderer.invoke('store-search', { tracks, source }),
  storeSearchAll: (tracks: StoreTrackInput[]): Promise<{ success: boolean; matchCount?: number; error?: string }> =>
    ipcRenderer.invoke('store-search-all', { tracks }),
  onStoreSearchProgress: (callback: (payload: StoreSearchProgress) => void) =>
    ipcRenderer.on('store-search-progress', (_event, payload: StoreSearchProgress) => callback(payload)),
  onStoreSearchMatch: (callback: (match: StoreMatch) => void) =>
    ipcRenderer.on('store-search-match', (_event, match: StoreMatch) => callback(match)),
  storeCartAdd: (matches: StoreMatch[], source: 'qobuz' | 'beatport'): Promise<{ success: boolean; result?: StoreCartResult; error?: string }> =>
    ipcRenderer.invoke('store-cart-add', { matches, source }),
  onStoreCartProgress: (callback: (payload: StoreCartProgress) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: StoreCartProgress) => callback(payload);
    ipcRenderer.on('store-cart-progress', wrapped);
    // Tag the callback so offStoreCartProgress can find and remove it.
    (callback as unknown as { __wrapped?: typeof wrapped }).__wrapped = wrapped;
  },
  offStoreCartProgress: (callback: (payload: StoreCartProgress) => void) => {
    const wrapped = (callback as unknown as { __wrapped?: (event: Electron.IpcRendererEvent, payload: StoreCartProgress) => void }).__wrapped;
    if (wrapped) ipcRenderer.removeListener('store-cart-progress', wrapped);
  },
  storeOpenCart: (store: 'qobuz' | 'beatport'): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('store-open-cart', { store }),
  storeLoadResults: (): Promise<{ success: boolean; matches?: StoreMatch[]; savedAt?: string; trackCount?: number }> =>
    ipcRenderer.invoke('store-load-results'),
  storeClearResults: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('store-clear-results'),
  storeDownloadPurchases: (matches: StoreMatch[]): Promise<{ success: boolean; downloaded?: number; failed?: Array<{ artist: string; title: string; error: string }>; destDir?: string; error?: string }> =>
    ipcRenderer.invoke('store-download-purchases', { matches }),
  onStoreDownloadProgress: (callback: (payload: { current: number; total: number; currentTrack: string; phase: string; message: string }) => void) =>
    ipcRenderer.on('store-download-progress', (_event, payload) => callback(payload)),

  // Store panel (embedded browser)
  storePanelOpen: (store: 'qobuz' | 'beatport', url: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('store-panel-open', { store, url }),
  storePanelClose: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('store-panel-close'),
  storePanelBack: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('store-panel-back'),
  storePanelForward: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('store-panel-forward'),
  storePanelResize: (width: number): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('store-panel-resize', { width }),
  storePanelResizeBegin: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('store-panel-resize-begin'),
  storePanelResizeEnd: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('store-panel-resize-end'),
  storePanelZoom: (direction: 'in' | 'out' | 'reset'): Promise<{ zoom: number }> =>
    ipcRenderer.invoke('store-panel-zoom', { direction }),
  storePanelStatus: (): Promise<{ open: boolean; store: string | null; url: string | null }> =>
    ipcRenderer.invoke('store-panel-status'),
  storePanelCheckoutAdvance: (store: 'qobuz' | 'beatport'): Promise<{
    success: boolean;
    result?: { phase: 'place-order-ready'; total: string | null; buttonText: string }
            | { phase: 'advanced'; clickedText: string }
            | { phase: 'unknown' };
    error?: string;
  }> =>
    ipcRenderer.invoke('store-panel-checkout-advance', { store }),
  storePanelPlaceOrder: (store: 'qobuz' | 'beatport'): Promise<{ success: boolean; clickedText?: string; error?: string }> =>
    ipcRenderer.invoke('store-panel-place-order', { store }),
  onStorePanelState: (callback: (state: { open: boolean; store: string | null; panelWidth: number; zoom: number; resizing: boolean }) => void) =>
    ipcRenderer.on('store-panel-state', (_event, state) => callback(state)),
  onStorePanelAuth: (callback: (auth: { store: string; loggedIn: boolean }) => void) =>
    ipcRenderer.on('store-panel-auth', (_event, auth) => callback(auth)),
  onStorePanelNavigated: (callback: (nav: { url: string }) => void) =>
    ipcRenderer.on('store-panel-navigated', (_event, nav) => callback(nav)),

  // Rekordbox XML repair
  rekordboxScan: (): Promise<{ total: number; missing: Array<{ trackId: string; filePath: string; artist: string; title: string; album: string }>; libraryRoot: string; xmlPath: string }> =>
    ipcRenderer.invoke('rekordbox-scan'),
  rekordboxImport: (): Promise<{ libraryRoot: string; totalInXml: number; inLibraryRoot: number; missingOnDisk: number; imported: number }> =>
    ipcRenderer.invoke('rekordbox-import'),
  rekordboxResync: (): Promise<{ libraryRoot: string; totalInXml: number; inLibraryRoot: number; missingOnDisk: number; imported: number }> =>
    ipcRenderer.invoke('rekordbox-resync'),

  // USB Health
  listVolumes: (): Promise<{ success: boolean; volumes?: VolumeInfo[]; error?: string }> =>
    ipcRenderer.invoke('list-volumes'),
  excludeVolume: (name: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('exclude-volume', { name }),
  onUsbHealthProgress: (callback: (payload: UsbHealthProgress) => void) =>
    ipcRenderer.on('usb-health-progress', (_event, payload: UsbHealthProgress) => callback(payload)),
  offUsbHealthProgress: () =>
    ipcRenderer.removeAllListeners('usb-health-progress'),

  // Restore Library
  restoreListVolumes: (): Promise<{ success: boolean; volumes?: Array<{ name: string; mountPath: string; scanRoot: string }>; error?: string }> =>
    ipcRenderer.invoke('restore-list-volumes'),
  restorePickXml: (): Promise<{ success: boolean; path: string | null }> =>
    ipcRenderer.invoke('restore-pick-xml'),
  restoreRun: (options: {
    xmlPath: string; libraryRoot: string; stageDir: string;
    sources: { usb: boolean; beatport: boolean; qobuz: boolean; soundcloud: boolean };
    concurrency: number;
    usbVolumesAllowlist?: string[];
    usbTagMatching?: boolean;
    rewriteXml?: boolean;
  }): Promise<{ success: boolean; report?: unknown; reportPath?: string; error?: string; aborted?: boolean }> =>
    ipcRenderer.invoke('restore-run', { options }),
  abortRestore: (): Promise<{ success: boolean; aborting: boolean }> =>
    ipcRenderer.invoke('restore-abort'),
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
  ) => {
    const listener = (_e: unknown, p: Parameters<typeof callback>[0]) => callback(p);
    ipcRenderer.on('restore-progress', listener);
    return () => ipcRenderer.off('restore-progress', listener);
  },
});
