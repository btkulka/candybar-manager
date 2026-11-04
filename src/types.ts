// Shared type definitions for the Candy Bar Manager application
// These types are used across main, preload, and renderer processes

export type ScriptOutput = {
  id: string;
  stream: 'stdout' | 'stderr' | 'status';
  text: string;
};

export type SuggestedAction = 'convert_aiff' | 'reencode_mp3' | 'archive' | 'delete' | 'populate_tags' | 'search_art' | 'none';

export type HealthIssue = {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  detail?: string;
  suggestedAction: SuggestedAction;
  dismissed?: boolean;
};

export type TrackHealthFormat = {
  container: string | null;
  codec: string | null;
  sampleRate: number | null;
  bitDepth: number | null;
  bitRate: number | null;
  channels: number | null;
  duration: number | null;
  lossless: boolean | null;
};

export type TrackHealth = {
  isHealthy: boolean;
  issues: HealthIssue[];
  format: TrackHealthFormat;
};

export type TrackInfo = {
  id: string;
  filePath: string;
  fileName: string;
  title: string;
  artist: string;
  album: string;
  year: string;
  genre: string;
  label: string;
  key: string;
  bpm: string;
  remixer: string;
  comment: string;
  albumArt: string | null;
  hasArtist: boolean;
  ignored: boolean;
  status: 'pending' | 'success' | 'error';
  resultPath?: string;
  errorMessage?: string;
  health?: TrackHealth;
};

export type AlbumArtMissingTrack = {
  id: string;
  filePath: string;
  fileName: string;
  title: string;
  artist: string;
  album: string;
  year: string;
  genre: string;
};

export type AlbumArtScanProgress = {
  id?: string;
  phase: 'discovering' | 'scanning' | 'complete';
  current: number;
  total: number;
  filePath?: string;
};

export type ScanProgress = {
  phase: 'flattening' | 'scanning' | 'done';
  current: number;
  total: number;
  filePath?: string;
};

export type UpdateTagsParams = {
  filePath: string;
  title?: string;
  artist?: string;
  album?: string;
  year?: string;
  genre?: string;
  label?: string;
  key?: string;
  bpm?: string;
  remixer?: string;
  comment?: string;
  albumArt?: string;
};

export type OrganizeConflictFile = {
  filePath: string;
  fileName: string;
  format: string;
  bitRate: number | null;
  duration: number | null;
  sizeBytes: number;
  artist: string;
  title: string;
};

export type OrganizeResult = {
  filePath: string;
  success: boolean;
  resultPath?: string;
  errorMessage?: string;
  conflict?: {
    incoming: OrganizeConflictFile;
    existing: OrganizeConflictFile;
    targetPath: string;
  };
};

export type OrganizeConflict = {
  incoming: OrganizeConflictFile;
  existing: OrganizeConflictFile;
  targetPath: string;
};

export type OrganizeState = {
  tracks: TrackInfo[];
  conflicts: OrganizeConflict[];
};

export type OrganizeProgress = {
  current: number;
  total: number;
  filePath: string;
  phase: 'start' | 'processing' | 'done';
  status?: 'success' | 'error' | 'conflict' | 'ignored' | 'skipped';
  resultPath?: string;
  errorMessage?: string;
};

export type ConversionResult = {
  success: boolean;
  originalPath: string;
  outputPath?: string;
  errorMessage?: string;
  /** The caller asked for the original to be removed, but Rekordbox still
   *  references it (or the collection couldn't be read), so it was kept. The
   *  entry needs relinking to `outputPath` in Rekordbox first. */
  keptOriginalForRekordbox?: boolean;
  /** The conversion succeeded but the original couldn't be moved to the Trash
   *  (it is still in place); `originalDeleteError` says why. */
  originalTrashFailed?: boolean;
  originalDeleteError?: string;
};

export type HealthSummary = {
  total: number;
  healthy: number;
  warnings: number;
  errors: number;
  byIssueCode: Record<string, number>;
};

export type LibraryHealthTrack = {
  filePath: string;
  fileName: string;
  artist: string;
  title: string;
  album: string;
  year: number | null;
  genre: string;
  hasAlbumArt: boolean;
  dateAdded: number | null;
  /** Tempo from tags (or Rekordbox's AverageBpm); null when the file carries none. */
  bpm: number | null;
  isHealthy: boolean;
  issues: HealthIssue[];
  format: TrackHealthFormat;
};

export type DuplicateTrackInfo = {
  filePath: string;
  fileName: string;
  artist: string;
  title: string;
  format: string;
  bitRate: number | null;
  duration: number | null;
  album: string | null;
  year: number | null;
  genre: string | null;
  hasAlbumArt: boolean;
  tagCompleteness: number; // 0-1 based on filled metadata fields
  dateAdded: number | null; // file birthtime (ms since epoch)
};

export type DuplicatePair = {
  track1: DuplicateTrackInfo;
  track2: DuplicateTrackInfo;
  similarity: number;
  reason: string;
};

export type LibraryHealthResult = {
  summary: HealthSummary;
  tracks: LibraryHealthTrack[];
  duplicates: DuplicatePair[];
  scannedAt: number;
  libraryRoot: string;
};

export type CheckTrackRecord = {
  key: string;
  artist: string;
  title: string;
  filePath?: string;
  album?: string;
  year?: string;
  genre?: string;
  duration?: number;
  format?: string;
  bitRate?: number;
  dateAdded?: number;
  ignored?: boolean;
};

export type IgnoredTrack = {
  key: string;
  artist: string;
  title: string;
  ignored_at: string;
};

export type CheckMatchCandidate = {
  track: CheckTrackRecord;
  confidence: number;
};

// A matched track with confidence score
export type CheckMatchedTrack = CheckTrackRecord & {
  confidence: number;
  matchedLibraryTrack?: CheckTrackRecord;
  topMatches?: CheckMatchCandidate[];
};

// An uncertain match that needs user confirmation (60-90% confidence)
export type CheckUncertainMatch = {
  csvTrack: CheckTrackRecord;
  libraryTrack: CheckTrackRecord;
  confidence: number;
  topMatches?: CheckMatchCandidate[];
};

// A missing track with its closest library match (if any)
export type CheckMissingTrack = CheckTrackRecord & {
  bestMatch?: {
    track: CheckTrackRecord;
    confidence: number;
  };
  topMatches?: CheckMatchCandidate[];
};

export type CheckResultFull = {
  csvTotal: number;
  libraryTotal: number;
  matchedCount: number;
  missingCount: number;
  uncertainCount: number;
  csvTracks: CheckTrackRecord[];
  libraryTracks: CheckTrackRecord[];
  matchedTracks: CheckMatchedTrack[];
  missingTracks: CheckMissingTrack[];
  uncertainMatches: CheckUncertainMatch[];
  missing: string[];
  total: number;
};

export type CheckProgress = {
  id: string;
  phase: 'csv' | 'playlist' | 'discovering' | 'scanning' | 'matching' | 'complete';
  current: number;
  total: number;
  message: string;
};

export type HealthScanProgress = {
  id: string;
  phase: 'discovering' | 'scanning' | 'duplicates' | 'complete';
  current: number;
  total: number;
  track?: LibraryHealthTrack;
};

export type CsvPreview = {
  columns: string[];
  rows: Record<string, string>[];
  totalRows: number;
  hasArtistColumn: boolean;
  hasTitleColumn: boolean;
};

export type StorageStats = {
  volumePath: string;
  totalSpace: number;
  freeSpace: number;
  musicSize: number;
  archiveSize: number;
  otherSpace: number;
};

export type CacheStatus = {
  libraryCheck: { valid: boolean; age: number | null; libraryRoot: string | null } | null;
  libraryHealth: { valid: boolean; age: number | null; libraryRoot: string | null } | null;
};

export type StoreAccount = {
  id: string;
  /** Optional free-form identifier (kept for display). Auth no longer uses it. */
  email?: string;
  label?: string;
};

export type AppConfig = {
  libraryRoot: string;
  organizeSourceDir: string;
  spotifyClientId: string;
  spotifyClientSecret: string;
  floatingConsoleEnabled: boolean;
  activeTab: string;
  checkCsvPath: string;
  checkSpotifyPlaylistUrl: string;
  archivePath: string;
  checkTabFilter: string;
  healthTabFilter: string;
  qobuzAccounts: StoreAccount[];
  beatportAccounts: StoreAccount[];
  /** @deprecated migrated into qobuzAccounts */
  qobuzEmail?: string;
  /** @deprecated migrated into qobuzAccounts */
  qobuzPassword?: string;
  /** @deprecated migrated into beatportAccounts */
  beatportEmail?: string;
  /** @deprecated migrated into beatportAccounts */
  beatportPassword?: string;
  soundcloudClientId?: string;
  soundcloudClientSecret?: string;
  excludedVolumes: string[]; // volume names to hide from the Devices panel
  rekordboxXmlPath: string; // path to rekordbox export.xml (used for backwards repair)
  rekordboxEnabled?: boolean; // when false, hides rekordbox UI (settings tab, Restore page) for machines that don't manage a rekordbox library
  showAdvancedTools?: boolean; // when false (default), hides developer and repair controls marked data-advanced
  tutorialCompleted?: boolean; // false until the first-run tour is finished or skipped; config files that predate the tour read as true
  tourOffered?: boolean; // set once someone who predates the tour has been offered it, so the nudge shows only once
};

// Store purchase types
export type StoreTrackInput = {
  key: string;
  artist: string;
  title: string;
  album?: string;
  duration?: number;
};

export type StoreMatch = {
  input: StoreTrackInput;
  trackId: string;
  title: string;
  artist: string;
  album: string;
  label: string;
  price: string;
  quality: string;
  format: string;
  lossless: boolean;
  rx3Compatible: boolean;
  confidence: number;
  url: string;
  source: 'qobuz' | 'beatport';
  ownedOn?: 'qobuz' | 'beatport';
  // Qobuz-specific: articleId for cart add
  articleId?: string;
  cartLink?: string;
  /** Qobuz: the release the match was found on. Set with an empty `trackId`
   *  when search couldn't pin the track down; the cart add resolves it. */
  albumId?: string;
  /** Which account this match came from (for owned-track downloads). */
  sourceAccountId?: string;
  /** Beatport-specific: needed to generate the signed download URL for this purchase. */
  orderItemDownloadId?: string;
  /** Album cover URL (600px Qobuz CDN for Qobuz matches; null for Beatport
   *  since Beatport's search doesn't expose a cover). Used by the cart review
   *  UI to render thumbnails next to each queued track. */
  image?: string | null;
};

export type StoreSearchResult = {
  matches: StoreMatch[];
  notFound: StoreTrackInput[];
  errors: Array<{ input: StoreTrackInput; error: string }>;
};

export type StoreCartResult = {
  added: StoreMatch[];
  failed: Array<{ match: StoreMatch; error: string }>;
  totalCost: string;
};

/** A single row in the "already in library" bucket returned by
 *  `library-sourcing:run`. Minimal shape so the renderer can render the list
 *  and export playlists without additional round-trips. */
export type LibraryMatchedRow = {
  artist: string;
  title: string;
  album?: string;
  genre?: string;
  filePath: string;
  duration?: number;
};

/** A row in the "probably in library" bucket — store match still produced so
 *  the user can decide whether to treat it as missing and buy it. */
export type LibraryProbableRow = {
  artist: string;
  title: string;
  suspectedFilePath: string;
  suspectedFileArtist: string;
  suspectedFileTitle: string;
  confidence: number;
  /** Why it's only probable: "file on disk, not in Rekordbox" (you have the
   *  file but never imported it) or "uncertain match". */
  reason?: string;
};

/** Playlist metadata surfaced to the renderer as soon as a Spotify playlist or
 *  SoundCloud set is fetched, so the source flow can show the cover art / name /
 *  track count while the (slower) library scan runs. Emitted on
 *  `library-sourcing:playlist-info`. */
export type SourcePlaylistInfo = {
  name: string;
  imageUrl: string | null;
  /** Total tracks in the playlist (the service's own count). */
  trackCount: number;
  /** Playable tracks actually fetched (excludes local/unavailable). */
  fetchedCount: number;
  owner: string;
  /** Where the list came from; drives the card's badge. Unset on snapshots
   *  saved before SoundCloud sets were supported, which were all Spotify. */
  source?: 'spotify' | 'soundcloud' | 'rekordbox';
};

/** The combined response from `library-sourcing:run`: phase 1's library match
 *  (split into `matched` vs `probable`) plus phase 2's store-search results.
 *  The renderer joins by looking up each `storeMatch.trackInput.key` and
 *  rendering it alongside any matching `probable` row. */
export type LibrarySourcingResult = {
  matched: LibraryMatchedRow[];
  probable: LibraryProbableRow[];
  /** Store matches for the missing + probable buckets (confirmed rows aren't
   *  searched). Each has `libraryStatus` set so the renderer can place it. */
  storeMatches: import('./lib/qobuzCart').QobuzCartMatch[];
  /** Inputs that had no library match and no store match — so the user can
   *  see what fully slipped through. */
  notFound: import('./lib/qobuzCart').QobuzCartTrackInput[];
};

// ---------- Lossless upgrades (Rekordbox playlist → lossless store copies) ----------

/** A regular or smart playlist in the live Rekordbox collection. Folders are
 *  flattened into `path` ("Gigs / 2026"); they aren't pickable themselves. */
export type RekordboxPlaylistSummary = {
  id: string;
  name: string;
  /** Parent folders, outermost first, joined with " / ". Empty at the root. */
  path: string;
  kind: 'playlist' | 'smart';
  count: number;
  /** Set on a smart playlist whose rules pyrekordbox can't evaluate; it can't be picked. */
  unreadable?: string;
  /** A smart playlist the reader ran out of time to count; `count` is 0 but
   *  the playlist may well have tracks, so it stays pickable. */
  countUnknown?: boolean;
};

/** How a Rekordbox entry's audio is held. `streaming` is a Spotify/SoundCloud
 *  &c. entry with no file behind it; `unknown` is a format we can't call. */
export type UpgradeFormatClass = 'lossless' | 'lossy' | 'streaming' | 'unknown';

/** One playlist entry, classified and (when it needs an upgrade) searched. */
export type LosslessUpgradeRow = {
  rbId: string;
  artist: string;
  title: string;
  album: string;
  /** Rekordbox FolderPath: a file path, or a `spotify:track:…` style URI. */
  filePath: string;
  format: UpgradeFormatClass;
  /** Short human label for what's held now: "MP3 320", "AAC 256", "Spotify stream", "AIFF 16/44.1". */
  formatLabel: string;
  duration?: number;
  /** A lossless entry for the same track (same version) is already in the
   *  collection, so this one needs relinking in Rekordbox, not buying. */
  losslessCopy?: { rbId: string; filePath: string; formatLabel: string };
  /** Store search result. Only set for lossy/streaming rows with no lossless copy. */
  match?: import('./lib/qobuzCart').QobuzCartMatch;
  /** Why a row couldn't be searched (e.g. a streaming title that couldn't be read). */
  note?: string;
};

export type LosslessUpgradeResult = {
  playlist: RekordboxPlaylistSummary;
  rows: LosslessUpgradeRow[];
};

export type LosslessUpgradeProgress = {
  phase: 'reading' | 'resolving' | 'searching';
  current: number;
  total: number;
  message: string;
};

export type StoreSearchProgress = {
  current: number;
  total: number;
  currentTrack: string;
  source: 'qobuz' | 'beatport';
};

export type StoreCartProgress = {
  current: number;
  total: number;
  currentTrack: string;
  phase: 'logging_in' | 'adding' | 'complete' | 'error';
  message: string;
};

export type ArchiveResult = {
  success: boolean;
  originalPath: string;
  archivePath?: string;
  errorMessage?: string;
};

// Job Queue types (re-exported for renderer consumption)
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type JobType =
  | 'library-scan'
  | 'library-check'
  | 'library-health'
  | 'album-art-scan'
  | 'catalog-export'
  | 'organize-tracks'
  | 'usb-health-scan';

export type JobProgress = {
  jobId: string;
  jobType: JobType;
  phase: string;
  current: number;
  total: number;
  message: string;
  detail?: unknown;
};

export type JobInfo = {
  id: string;
  type: JobType;
  status: JobStatus;
  progress: JobProgress | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
};

// ========== USB Health ==========

export type VolumeInfo = {
  name: string;
  path: string;
  fileSystem: string;    // e.g. "MS-DOS FAT32", "ExFAT", "APFS"
  totalBytes: number;
  freeBytes: number;
  isCompatible: boolean; // true only if FAT32
  deviceNode: string;    // e.g. /dev/disk2s1
  isLibrary?: boolean;   // volume contains the configured library root
};

export type UsbVolumeIssue = {
  code: string;          // 'WRONG_FILESYSTEM' | 'LOW_FREE_SPACE'
  severity: 'error' | 'warning';
  message: string;
  detail?: string;
};

export type UsbHealthResult = {
  volume: VolumeInfo;
  volumeIssues: UsbVolumeIssue[];
  tracks: LibraryHealthTrack[];
  summary: HealthSummary;
  scannedAt: number;
};

export type UsbHealthProgress = {
  id: string;
  phase: 'discovering' | 'scanning' | 'complete';
  current: number;
  total: number;
  currentFile?: string;
};
