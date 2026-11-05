import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppConfig,
  SoundCloudSignIn,
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
  ClaudeStatus,
  StoreMatch,
  StoreCartProgress,
  StoreCartResult,
  StoreCartCheck,
  UpdateState,
  VolumeInfo
} from './types';

/**
 * Subscribe to a main → renderer channel. Every `on*` below returns its own
 * unsubscribe: a callback crosses the context bridge as a new proxy on every
 * call, so an `off(callback)` could never find the listener `on()` added, and
 * `removeAllListeners` would knock out other screens' listeners on the channel.
 */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
}

contextBridge.exposeInMainWorld('candybar', {
  selectPath: (type: 'file' | 'dir') => ipcRenderer.invoke('select-path', { type }),
  /**
   * @deprecated Use `librarySourcingRun` instead (phase 1 + phase 2 combined).
   * Kept for one release so external callers (MCP, scripts) that drive the
   * phase-1 library-match path independently don't break. Ownership comes from
   * the Rekordbox collection; there is no cached result any more, so
   * `cacheOnly` always comes back empty.
   */
  checkLibrary: (source: { csvPath?: string; spotifyPlaylistUrl?: string }, useCache = true, cacheOnly = false) =>
    ipcRenderer.invoke('check-library', { ...source, useCache, cacheOnly }),
  getConfig: () => ipcRenderer.invoke('get-config'),
  getConfigPath: (): Promise<string> => ipcRenderer.invoke('get-config-path'),
  getLibraryRoot: () => ipcRenderer.invoke('get-library-root'),
  setConfig: (config: AppConfig) => ipcRenderer.invoke('set-config', config),
  // Merge just these fields into the saved config and get the result back.
  // Prefer this to setConfig, which replaces everything with the caller's copy.
  updateConfig: (partial: Partial<AppConfig>): Promise<AppConfig> =>
    ipcRenderer.invoke('update-config', partial),
  migrateArchive: (oldPath: string, newPath: string) =>
    ipcRenderer.invoke('migrate-archive', { oldPath, newPath }),
  onMigrateProgress: (callback: (payload: { current: number; total: number; file: string }) => void): (() => void) =>
    subscribe('migrate-progress', callback),
  searchMusic: (query: string, sources: ('spotify' | 'soundcloud' | 'beatport' | 'qobuz')[]) =>
    ipcRenderer.invoke('search-music', { query, sources }),
  checkSpotify: () => ipcRenderer.invoke('check-spotify'),
  soundcloudSignInStatus: (): Promise<SoundCloudSignIn | null> => ipcRenderer.invoke('soundcloud-sign-in-status'),
  soundcloudSignIn: (): Promise<{ success: boolean; status?: SoundCloudSignIn; error?: string }> =>
    ipcRenderer.invoke('soundcloud-sign-in'),
  onOutput: (callback: (payload: ScriptOutput) => void): (() => void) =>
    subscribe('script-output', callback),
  onCheckProgress: (callback: (payload: CheckProgress) => void): (() => void) =>
    subscribe('check-progress', callback),

  // Track scanning and organization
  scanTracks: (sourceDir: string): Promise<TrackInfo[]> =>
    ipcRenderer.invoke('scan-tracks', { sourceDir }),
  onScanProgress: (callback: (payload: ScanProgress) => void): (() => void) =>
    subscribe('scan-progress', callback),
  autopopulateTracks: (tracks: Array<{ filePath: string; title: string; artist: string; album: string; year: string; genre: string; label: string; key: string; bpm: string; remixer: string; hasAlbumArt: boolean }>, force = false): Promise<Array<{ filePath: string; updated: boolean; fieldsPopulated: string[]; error?: string }>> =>
    ipcRenderer.invoke('autopopulate-tracks', { tracks, force }),
  // Callers must keep the returned unsubscribe and call it when their run ends.
  onAutopopulateProgress: (callback: (payload: { current: number; total: number; filePath: string }) => void): (() => void) =>
    subscribe('autopopulate-progress', callback),
  scanMissingAlbumArt: (): Promise<{ id: string; tracks: AlbumArtMissingTrack[] }> =>
    ipcRenderer.invoke('scan-missing-album-art'),
  onPolishScanProgress: (callback: (payload: AlbumArtScanProgress) => void): (() => void) =>
    subscribe('polish-scan-progress', callback),
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
  onOrganizeProgress: (callback: (payload: OrganizeProgress) => void): (() => void) =>
    subscribe('organize-progress', callback),

  organizeResolveConflict: (
    incomingPath: string, existingPath: string, targetPath: string, keep: 'incoming' | 'existing'
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('organize-resolve-conflict', { incomingPath, existingPath, targetPath, keep }),

  // Album art extraction from audio file
  getTrackAlbumArt: (filePath: string): Promise<string | null> =>
    ipcRenderer.invoke('get-track-album-art', { filePath }),

  // DevTools toggle
  toggleDevTools: (): Promise<void> => ipcRenderer.invoke('toggle-devtools'),

  // Update check (top-bar button)
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke('get-update-state'),
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke('check-for-updates'),
  onUpdateState: (callback: (payload: UpdateState) => void): (() => void) =>
    subscribe('update-state', callback),

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open-external', { url }),
  showInFinder: (filePath: string): Promise<void> => ipcRenderer.invoke('show-in-finder', { filePath }),

  // Track conversion
  convertTrack: (filePath: string): Promise<ConversionResult> =>
    ipcRenderer.invoke('convert-track', { filePath }),

  // Library health scan
  scanLibraryHealth: (useCache = true, cacheOnly = false): Promise<{ id: string; result?: LibraryHealthResult; fromCache: boolean; cacheOnly?: boolean }> =>
    ipcRenderer.invoke('scan-library-health', { useCache, cacheOnly }),
  onHealthScanProgress: (callback: (payload: HealthScanProgress) => void): (() => void) =>
    subscribe('health-scan-progress', callback),
  // Fails (success: false) rather than reporting success if the file couldn't be
  // moved to the Trash. A file deleted from the intake folder is never fetched again.
  deleteTrackFile: (filePath: string): Promise<{ success: boolean; trashPath?: string; error?: string }> =>
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
  onJobUpdate: (callback: (info: JobInfo) => void): (() => void) =>
    subscribe('job-update', callback),
  // Progress for every job-queue job (library scans, USB health scans, …);
  // filter on progress.jobId / jobType.
  onJobProgress: (callback: (progress: JobProgress) => void): (() => void) =>
    subscribe('job-progress', callback),
  // Wait for a job started with jobEnqueue (enqueue first to hold its id).
  jobWait: (jobId: string): Promise<{ success: boolean; result?: unknown; error?: string; cancelled?: boolean }> =>
    ipcRenderer.invoke('job-wait', { jobId }),
  // Log lines from every job; filter on entry.jobId.
  onJobLog: (callback: (entry: { jobId: string; text: string; stream: 'stdout' | 'stderr' | 'status' }) => void): (() => void) =>
    subscribe('job-log', callback),

  // Claude Code: jobs run on the signed-in Claude subscription
  claudeStatus: (): Promise<ClaudeStatus> =>
    ipcRenderer.invoke('claude-status'),
  claudeOpenLogin: (): Promise<{ opened: boolean; command: string }> =>
    ipcRenderer.invoke('claude-open-login'),

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
  // and source-search in the merged tab). Phase 1 checks the Rekordbox
  // collection, phase 2 is store search for the probable + missing subset.
  librarySourcingRun: (source: { csvPath?: string; spotifyPlaylistUrl?: string; soundcloudSetUrl?: string }) =>
    ipcRenderer.invoke('library-sourcing:run', source),
  onLibrarySourcingPhase1Progress: (callback: (payload: { phase?: string; current: number; total: number; message?: string }) => void): (() => void) =>
    subscribe('library-sourcing:phase1-progress', callback),
  onLibrarySourcingPhase2Progress: (callback: (payload: { current: number; total: number; currentTrack: string }) => void): (() => void) =>
    subscribe('library-sourcing:phase2-progress', callback),
  onLibrarySourcingPhase2Match: (callback: (match: unknown) => void): (() => void) =>
    subscribe('library-sourcing:phase2-match', callback),
  onLibrarySourcingPlaylistInfo: (callback: (info: import('./types').SourcePlaylistInfo) => void): (() => void) =>
    subscribe('library-sourcing:playlist-info', callback),
  /** Phase 3: Claude picking each track's store record. */
  onLibrarySourcingFinderProgress: (callback: (p: import('./types').SourcingFinderProgress) => void): (() => void) =>
    subscribe('library-sourcing:finder-progress', callback),
  // A SoundCloud set's own free downloads, by track key; each downloader
  // line arrives on onLibrarySourcingFreeProgress.
  librarySourcingFetchFree: (keys: string[], opts: { accountActions: boolean }): Promise<{ success: boolean; outcomes?: Record<string, import('./lib/freeSources').FreeUpgradeOutcome>; error?: string }> =>
    ipcRenderer.invoke('library-sourcing:fetch-free', { keys, accountActions: opts.accountActions }),
  librarySourcingFetchFreeStop: (): Promise<void> => ipcRenderer.invoke('library-sourcing:fetch-free-stop'),
  onLibrarySourcingFreeProgress: (callback: (p: { message: string }) => void): (() => void) =>
    subscribe('library-sourcing:free-progress', callback),

  // Saved playlists ("Your playlists" on Find and buy), kept in candybar.db
  savedSourcesList: (): Promise<{ success: boolean; sources?: import('./types').SavedSource[]; error?: string }> =>
    ipcRenderer.invoke('saved-sources:list'),
  savedSourcesSave: (input: import('./types').SavedSourceInput, opts?: { keepExisting?: boolean }): Promise<{ success: boolean; source?: import('./types').SavedSource; error?: string }> =>
    ipcRenderer.invoke('saved-sources:save', input, opts),
  savedSourcesUpdate: (id: number, patch: { name?: string | null }): Promise<{ success: boolean; source?: import('./types').SavedSource; error?: string }> =>
    ipcRenderer.invoke('saved-sources:update', { id, ...patch }),
  savedSourcesRemove: (id: number): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('saved-sources:remove', { id }),

  // Lossless upgrades (Rekordbox playlist → lossless copies of its lossy tracks)
  upgradeListPlaylists: (): Promise<{ success: boolean; playlists?: import('./types').RekordboxPlaylistSummary[]; error?: string }> =>
    ipcRenderer.invoke('lossless-upgrade:list-playlists'),
  upgradeRun: (playlistId: string): Promise<{ success: boolean; result?: import('./types').LosslessUpgradeResult; error?: string }> =>
    ipcRenderer.invoke('lossless-upgrade:run', { playlistId }),
  onUpgradeProgress: (callback: (p: import('./types').LosslessUpgradeProgress) => void): (() => void) =>
    subscribe('lossless-upgrade:progress', callback),
  // Free downloads for the last check's rows (SoundCloud, then Bandcamp). Main
  // keeps the download links; this only names the rows. Progress comes on
  // onUpgradeProgress with phase 'fetching'.
  upgradeFetchFree: (rbIds: string[], opts: { accountActions: boolean }): Promise<{ success: boolean; outcomes?: Record<string, import('./lib/freeSources').FreeUpgradeOutcome>; error?: string }> =>
    ipcRenderer.invoke('lossless-upgrade:fetch-free', { rbIds, accountActions: opts.accountActions }),
  upgradeFetchFreeStop: (): Promise<void> => ipcRenderer.invoke('lossless-upgrade:fetch-free-stop'),
  // A free download link Ben found himself, for one row; kept across checks.
  upgradeUseLink: (rbId: string, url: string): Promise<{ success: boolean; hit?: import('./lib/freeSources').FreeSourceHit; pasted?: { url: string; warning: string | null }; error?: string }> =>
    ipcRenderer.invoke('lossless-upgrade:use-link', { rbId, url }),
  upgradeForgetLink: (rbId: string): Promise<{ success: boolean; forgotten?: boolean; error?: string }> =>
    ipcRenderer.invoke('lossless-upgrade:forget-link', { rbId }),
  // Settings → Save a report: one zip on the Desktop to send when something doesn't work.
  supportSaveReport: (pages: Record<string, string | null>): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('support:save-report', { pages }),
  // "Check with Claude": apply the verdicts that change a row (free links, store refs).
  upgradeApplyClaude: (items: Array<{ rbId: string; verdict: import('./types').UpgradeVerdictKind; note: string; freeUrl?: string; ref?: string; match?: import('./lib/qobuzCart').QobuzCartMatch | null; artist?: string; title?: string; duration?: number }>): Promise<{ success: boolean; results: Array<{ rbId: string; hit?: import('./lib/freeSources').FreeSourceHit; pasted?: { url: string; warning: string | null }; match?: import('./lib/qobuzCart').QobuzCartMatch; error?: string }> }> =>
    ipcRenderer.invoke('lossless-upgrade:apply-claude', { items }),
  librarySourcingResolvePick: (match: import('./lib/qobuzCart').QobuzCartMatch, ref: string, note?: string): Promise<{ success: boolean; match?: import('./lib/qobuzCart').QobuzCartMatch; changed?: boolean; error?: string }> =>
    ipcRenderer.invoke('library-sourcing:resolve-pick', { match, ref, note }),

  // Lossless swap: put a downloaded lossless file in place of a Rekordbox
  // entry's file, keeping the entry (cues, Date Added, play count, playlists).
  // Plan is read-only; apply runs main's own cached plan for those ids (it
  // never takes paths from here) and needs Rekordbox closed.
  upgradeSwapPreflight: (): Promise<import('./types').UpgradeSwapPreflight> =>
    ipcRenderer.invoke('upgrade-swap:preflight'),
  upgradeSwapPlan: (inputs: import('./types').UpgradeSwapInput[]): Promise<{ success: boolean; items?: import('./types').UpgradeSwapPlanItem[]; error?: string }> =>
    ipcRenderer.invoke('upgrade-swap:plan', { inputs }),
  upgradeSwapApply: (rbIds: string[]): Promise<{ success: boolean; result?: import('./types').UpgradeSwapResult; error?: string }> =>
    ipcRenderer.invoke('upgrade-swap:apply', { rbIds }),
  onUpgradeSwapProgress: (callback: (p: import('./types').UpgradeSwapProgress) => void): (() => void) =>
    subscribe('upgrade-swap:progress', callback),

  // Qobuz + Beatport search (no cart add here — see storeCartAdd)
  qobuzCartSearch: (tracks: Array<{ key: string; artist: string; title: string; album?: string; duration?: number }>) =>
    ipcRenderer.invoke('qobuz-cart-search', { tracks }),
  onQobuzCartSearchProgress: (callback: (payload: { current: number; total: number; currentTrack: string }) => void): (() => void) =>
    subscribe('qobuz-cart-search-progress', callback),
  onQobuzCartSearchMatch: (callback: (match: unknown) => void): (() => void) =>
    subscribe('qobuz-cart-search-match', callback),

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
  // `errors` names accounts whose purchases couldn't be read; `complete` is false
  // then, and an empty `owned` means "couldn't check", not "owns nothing".
  fetchStorePurchases: (source: 'qobuz' | 'beatport'): Promise<{ success: boolean; owned?: Array<{ source: 'qobuz' | 'beatport'; trackId: string; artist: string; title: string }>; errors?: string[]; complete?: boolean; error?: string }> =>
    ipcRenderer.invoke('fetch-store-purchases', { source }),
  downloadBeatportMatches: (matches: unknown[], destDir: string): Promise<{ success: boolean; downloaded?: string[]; failed?: Array<{ artist: string; title: string; error: string }>; destDir?: string; error?: string }> =>
    ipcRenderer.invoke('download-beatport-matches', { matches, destDir }),
  downloadBeatportMatchesConcurrent: (matches: unknown[], destDir: string, concurrency: number): Promise<{ success: boolean; downloaded?: string[]; failed?: Array<{ artist: string; title: string; error: string }>; destDir?: string; error?: string }> =>
    ipcRenderer.invoke('download-beatport-matches-concurrent', { matches, destDir, concurrency }),
  downloadQobuzMatchesConcurrent: (matches: unknown[], destDir: string, concurrency: number): Promise<{ success: boolean; downloaded?: string[]; failed?: Array<{ artist: string; title: string; error: string }>; destDir?: string; error?: string }> =>
    ipcRenderer.invoke('download-qobuz-matches-concurrent', { matches, destDir, concurrency }),
  onDownloadQobuzProgress: (callback: (p: { current: number; total: number; currentTrack: string; phase: string; message: string }) => void): (() => void) =>
    subscribe('download-qobuz-progress', callback),
  onDownloadBeatportProgress: (callback: (p: { current: number; total: number; currentTrack: string; phase: string; message: string }) => void): (() => void) =>
    subscribe('download-beatport-progress', callback),
  // Lossless only: main excludes any match whose `lossless` isn't true and
  // returns it in result.failed ("Excluded: not a lossless match").
  storeCartAdd: (matches: StoreMatch[], source: 'qobuz' | 'beatport'): Promise<{ success: boolean; result?: StoreCartResult; error?: string }> =>
    ipcRenderer.invoke('store-cart-add', { matches, source }),
  onStoreCartProgress: (callback: (payload: StoreCartProgress) => void): (() => void) =>
    subscribe('store-cart-progress', callback),
  storeOpenCart: (store: 'qobuz' | 'beatport'): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('store-open-cart', { store }),
  // Which of these tracks are still in the store's real cart. Read-only; unknown
  // (signed out, unreachable) is never reported as empty.
  storeCartCheck: (store: 'qobuz' | 'beatport', items: Array<{ trackId: string; articleId?: string }>): Promise<StoreCartCheck> =>
    ipcRenderer.invoke('store-cart-check', { store, items }),
  // `skipped` are tracks you deleted earlier, left out on purpose (deleted stays deleted).
  // `files` maps each downloaded match's input key (`rb:<id>` on Lossless
  // Upgrades) to the file it became — what upgradeSwapPlan takes.
  storeDownloadPurchases: (matches: StoreMatch[]): Promise<{ success: boolean; downloaded?: number; files?: Array<{ key: string; path: string }>; failed?: Array<{ artist: string; title: string; error: string }>; skipped?: Array<{ trackId: string; artist: string; title: string; reason: string }>; destDir?: string; error?: string }> =>
    ipcRenderer.invoke('store-download-purchases', { matches }),
  onStoreDownloadProgress: (callback: (payload: { current: number; total: number; currentTrack: string; phase: string; message: string }) => void): (() => void) =>
    subscribe('store-download-progress', callback),

  // Store panel (embedded browser)
  storePanelOpen: (store: 'qobuz' | 'beatport', url: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('store-panel-open', { store, url }),
  storePanelClose: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('store-panel-close'),
  // Registers the in-DOM <webview> guest's webContents id so main can drive the
  // scripted checkout. Pass null on unmount.
  storePanelAttach: (contentsId: number | null): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('store-panel-attach', { contentsId }),
  // Reports each guest navigation to main, which re-broadcasts it (see
  // onStorePanelNavigated) for the purchase-success auto-download watcher.
  storePanelNav: (url: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('store-panel-nav', { url }),
  storePanelStatus: (): Promise<{ open: boolean; store: string | null; url: string | null }> =>
    ipcRenderer.invoke('store-panel-status'),
  // Both refuse (success: false) unless the panel is on the store's own cart or
  // checkout pages. `itemCount` is scraped from the page; null when it says none.
  storePanelCheckoutAdvance: (store: 'qobuz' | 'beatport'): Promise<{
    success: boolean;
    result?: { phase: 'place-order-ready'; total: string | null; itemCount: number | null; buttonText: string }
            | { phase: 'advanced'; clickedText: string }
            | { phase: 'unknown' };
    error?: string;
  }> =>
    ipcRenderer.invoke('store-panel-checkout-advance', { store }),
  storePanelPlaceOrder: (store: 'qobuz' | 'beatport'): Promise<{ success: boolean; clickedText?: string; error?: string }> =>
    ipcRenderer.invoke('store-panel-place-order', { store }),
  onStorePanelState: (callback: (state: { open: boolean; store?: string | null; url?: string; partition?: string }) => void): (() => void) =>
    subscribe('store-panel-state', callback),
  onStorePanelAuth: (callback: (auth: { store: string; loggedIn: boolean }) => void): (() => void) =>
    subscribe('store-panel-auth', callback),
  onStorePanelNavigated: (callback: (nav: { url: string }) => void): (() => void) =>
    subscribe('store-panel-navigated', callback),

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
  // (USB health scan progress arrives on onJobProgress; nothing sends the old
  // usb-health-progress channel.)

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
      /** deletedSkipped: tracks left out because you deleted them before (they stay deleted). */
      totals: { totalXmlTracks: number; alreadyInLibrary: number; missing: number; recovered: number; stillMissing: number; deletedSkipped?: number };
      elapsedSec: number;
      estRemainingSec?: number;
      rate?: number;
      perAccount?: Array<{ accountId: string; service: 'qobuz' | 'beatport'; label?: string; email?: string; ownedCount?: number; matchedCount?: number; downloadedCount?: number; failedCount?: number }>;
      log?: { level: 'info' | 'warn' | 'error'; phase: string; message: string; timestamp: number; currentTrack?: string };
    }) => void,
  ): (() => void) => subscribe('restore-progress', callback),

  // Splice recovery (Ableton .als sample re-download)
  spliceLoginStatus: (): Promise<{ success: boolean; status?: { connected: boolean; tokenExpiresAt: number | null; hasProfile: boolean }; error?: string }> =>
    ipcRenderer.invoke('splice-login-status'),
  spliceStartLogin: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('splice-start-login'),
  splicePickAls: (): Promise<{ success: boolean; path: string | null }> =>
    ipcRenderer.invoke('splice-pick-als'),
  spliceScan: (alsPath: string): Promise<{ success: boolean; result?: { alsPath: string; totalRefs: number; spliceRefs: number; missing: Array<{ originalPath: string; basename: string; searchKey: string }> }; error?: string }> =>
    ipcRenderer.invoke('splice-scan', { alsPath }),
  spliceClassify: (missing: Array<{ originalPath: string; basename: string; searchKey: string }>): Promise<{
    success: boolean;
    buckets?: {
      owned: Array<{ originalPath: string; basename: string; searchKey: string; asset: { uuid: string; filename: string; name: string; coverUrl: string | null; packName: string | null; packSlug: string | null } }>;
      credits: Array<{ originalPath: string; basename: string; searchKey: string; asset: { uuid: string; filename: string; name: string; coverUrl: string | null; packName: string | null; packSlug: string | null }; spliceUrl: string }>;
      notFound: Array<{ originalPath: string; basename: string; searchKey: string; error?: string }>;
    };
    manifestPath?: string | null;
    error?: string;
  }> =>
    ipcRenderer.invoke('splice-classify', { missing }),
  spliceDownloadOwned: (items: Array<{ originalPath: string; basename: string; searchKey: string; asset: { uuid: string; filename: string; name: string; coverUrl: string | null; packName: string | null; packSlug: string | null } }>): Promise<{
    success: boolean;
    report?: {
      attempted: number;
      succeeded: number;
      failed: Array<{ sample: { originalPath: string; basename: string }; error: string }>;
    };
    error?: string;
  }> =>
    ipcRenderer.invoke('splice-download-owned', { items }),
  spliceCreditsBalance: (): Promise<{
    success: boolean;
    balance?: { credits: number; state: string; planName: string | null; planTier: string | null };
    error?: string;
  }> =>
    ipcRenderer.invoke('splice-credits-balance'),
  spliceBuyCredits: (items: Array<{ originalPath: string; basename: string; searchKey: string; asset: { uuid: string; filename: string; name: string; coverUrl: string | null; packName: string | null; packSlug: string | null }; spliceUrl: string }>): Promise<{
    success: boolean;
    report?: {
      attempted: number;
      succeeded: number;
      failed: Array<{ sample: { originalPath: string; basename: string }; error: string }>;
    };
    error?: string;
  }> =>
    ipcRenderer.invoke('splice-buy-credits', { items }),
  onSpliceProgress: (
    callback: (p:
      | { phase: 'parsing'; alsPath: string }
      | { phase: 'searching'; index: number; total: number; sample: { originalPath: string; basename: string; searchKey: string }; result?: 'owned' | 'credits' | 'notFound' }
      | { phase: 'downloading'; index: number; total: number; sample: { originalPath: string; basename: string }; status?: 'ok' | 'fail'; error?: string }
      | { phase: 'complete' }
    ) => void,
  ): (() => void) => subscribe('splice-progress', callback),
});
