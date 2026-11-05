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

/** Who the saved SoundCloud sign-in belonged to at its last check. The sign-in
 *  itself is the 'soundcloud' Chrome profile that every SoundCloud run opens
 *  (src/lib/soundcloudSession.ts); this is only the note each check leaves. */
export type SoundCloudSignIn = {
  signedIn: boolean;
  username: string | null;
  permalink: string | null;
  url: string | null;
  checkedAt: string;
  reason?: string | null;
};

/** Ask Claude's first-run questions (src/lib/claude/userProfile.ts). A
 *  skipped question stays unset. */
export type ClaudeProfile = {
  techSavvy?: 'simple' | 'comfortable' | 'technical';
  rekordbox?: 'new' | 'regular' | 'expert';
  gear?: 'usb' | 'controller' | 'both' | 'none';
  /** When the questions were answered or skipped; they only show while unset. */
  answeredAt: string;
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
  /** Long-lived token from `claude setup-token`, for a machine where Claude Code
   *  isn't signed in. Empty uses the install's own login. Kept in secrets.json. */
  claudeOauthToken: string;
  /** Model alias for Claude jobs ('opus', 'sonnet', …); empty is Claude Code's default. */
  claudeModel: string;
  /** Find & buy has Claude pick each track's store record (falls back to the
   *  plain search when Claude Code isn't ready). */
  claudeFindMatches: boolean;
  /** What Ben told Ask Claude about himself the first time it opened; tunes
   *  how Claude answers (src/lib/claude/userProfile.ts). Null until answered
   *  or skipped. */
  claudeProfile: ClaudeProfile | null;
  /** Given to free-download gates (Hypeddit &c) that won't release a file
   *  without an email. Saving it is the go-ahead for every run (the app's,
   *  Claude's and the CLI's); empty skips those gates. Kept in secrets.json. */
  gateEmail: string;
  /** What a download gate's comment box gets (Hypeddit, Droploud, Influence
   *  Planner: some post it to SoundCloud for you). Every run uses it — the
   *  app's, Claude's and the CLI's. Empty skips gates that insist on one. */
  gateComment: string;
  /** The name download gates get when they ask for one (Hypeddit's first-name
   *  box, a "your name" field). Asked in the setup guide with the email; kept
   *  in secrets.json. */
  gateFirstName: string;
  gateLastName: string;
  /** The address download gates get when they ask (Bandcamp's ZIP, a gate's
   *  country or full address form). Asked in the setup guide; kept in secrets.json. */
  gateAddressLine1: string;
  gateCity: string;
  /** State, province or region. */
  gateRegion: string;
  /** ZIP or postcode. */
  gatePostcode: string;
  gateCountry: string;
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
  setupCompleted?: boolean; // true once the setup guide has been finished or skipped; a first launch opens it before the tour
  rekordboxBackupDir: string; // master.db snapshots go here before the app writes to Rekordbox; '' = <library's parent>/backups/rekordbox (resolveRekordboxBackupDir)
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

/** Which of the tracks Track Lab added are still in the store's real cart.
 *  `present` lists their trackIds; null when the cart holds things that can't
 *  be matched to them. Unknown (signed out, store unreachable) is never read
 *  as empty. */
export type StoreCartCheck =
  | { known: false; reason: string }
  | { known: true; empty: boolean; present: string[] | null };

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
  /** Who picked the store matches this run: Claude, or the plain search
   *  because Claude wasn't there (with why). */
  finder: SourcingFinderSummary;
};

/** A track in a SoundCloud set that the set itself offers free: SoundCloud's
 *  own download button, or a free link behind a gate (Hypeddit &c). The file's
 *  format is only known once it lands, so the store match stays as a fallback. */
export type SetFreeDownload = {
  kind: 'native' | 'gate';
  /** The track's SoundCloud page. */
  url: string;
  /** The title as the set lists it ("… [FREE DL]"). */
  listedAs: string;
  uploader: string;
  gateHost: string | null;
  /** One line for the UI: "SoundCloud download button", "Free download via hypeddit.com". */
  reason: string;
};

/** How a row's store match was chosen. `claude` verdicts: kept the plain
 *  search's pick, changed it to another record, found one the plain search
 *  missed, or said the store doesn't sell it. */
export type MatchFinder =
  | { by: 'claude'; verdict: 'kept' | 'changed' | 'found' | 'none'; confidence: FinderConfidence; note: string }
  | { by: 'search' };

export type FinderConfidence = 'high' | 'medium' | 'low';

export type SourcingFinderSummary = {
  by: 'claude' | 'search';
  /** Plain words for the summary line: what Claude did, or why it didn't run. */
  note: string;
};

/** Progress of the Claude finder, on `library-sourcing:finder-progress`. */
export type SourcingFinderProgress = { done: number; total: number; message: string };

// ---------- Saved playlists (Find and buy → "Your playlists") ----------

export type SavedSourceKind = 'spotify' | 'soundcloud' | 'csv';

/** What the last check of a saved source found, in the page's own buckets. */
export type SavedSourceCounts = {
  /** Not in the library, with a full-quality copy for sale. */
  toBuy: number;
  /** Something close is in the library; a full-quality copy is for sale too. */
  maybeOwned: number;
  /** Already in the library. */
  owned: number;
  /** No full-quality copy on Qobuz or Beatport (compressed-only included). */
  notForSale: number;
};

/** A playlist, SoundCloud set or spreadsheet checked on Find and buy, kept so
 *  it can be checked again in one click. Stored in candybar.db (saved_sources). */
export type SavedSource = {
  id: number;
  kind: SavedSourceKind;
  /** The link or CSV path the check ran on (as last given). */
  ref: string;
  /** Shown name: the user's rename when there is one, else the playlist's own. */
  name: string;
  /** The playlist's own name, as the service (or file name) gave it. */
  originalName: string;
  renamed: boolean;
  imageUrl: string | null;
  owner: string;
  trackCount: number;
  counts: SavedSourceCounts;
  createdAt: number;
  lastCheckedAt: number;
  /** CSV only: no file at `ref` any more (moved, renamed or deleted). */
  missing?: boolean;
};

export type SavedSourceInput = {
  kind: SavedSourceKind;
  ref: string;
  name: string;
  imageUrl?: string | null;
  owner?: string;
  trackCount: number;
  counts: SavedSourceCounts;
  /** When the check ran; defaults to now. */
  checkedAt?: number;
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
  /** Store search result. Only set for lossy/streaming rows with no lossless
   *  copy, and skipped when Bandcamp gives the track away (no email needed). */
  match?: import('./lib/qobuzCart').QobuzCartMatch;
  /** Free and cheap copies, looked for before the stores: a SoundCloud free
   *  download first, then Bandcamp. Set on the same rows as `match`. */
  free?: import('./lib/freeSources').FreeSources;
  /** What "Get free downloads" did for this row: the full-quality file that
   *  landed (for the swap step), or why none did. */
  freeOutcome?: import('./lib/freeSources').FreeUpgradeOutcome;
  /** Why a row couldn't be searched (e.g. a streaming title that couldn't be read). */
  note?: string;
  /** What "Check with Claude" said about this row. */
  claude?: { verdict: UpgradeVerdictKind; note: string };
};

export type LosslessUpgradeResult = {
  playlist: RekordboxPlaylistSummary;
  rows: LosslessUpgradeRow[];
};

export type LosslessUpgradeProgress = {
  /** free: SoundCloud + Bandcamp search. searching: Qobuz + Beatport.
   *  fetching: "Get free downloads" running (message is the downloader's line). */
  phase: 'reading' | 'resolving' | 'free' | 'searching' | 'fetching';
  current: number;
  total: number;
  message: string;
};

// ---------- Lossless swap (a downloaded lossless file replaces a Rekordbox entry's file in place) ----------
//
// The entry keeps its DjmdContent row (same ID), so cue points, loops, Date
// Added, play count, rating, colour, comments, playlists and MyTags all stay.

export type UpgradeSwapInput = { rbId: string; newFilePath: string };

/** Where the same music sits in the two files. `offsetMs` is how much later (+)
 *  or earlier (−) a moment is in the new file than on the original's Rekordbox
 *  timeline (which, for an MP3, includes the encoder's start-up delay).
 *  `confidence` is the weakest window's correlation, 0–1. */
export type UpgradeSwapAlignment = { status: 'aligned' | 'shifted' | 'mismatch' | 'unchecked'; offsetMs: number; confidence: number; note: string };

export type UpgradeSwapPlanItem = {
  rbId: string; title: string; artist: string;
  action: 'swap' | 'skip'; reason?: string;
  before: { path: string; format: string; bitRate: number; sampleRate: number; bitDepth: number; fileSize: number; lengthSec: number };
  /** fileSize is null until the file is written (apply). */
  after: { path: string; format: string; sampleRate: number; bitDepth: number; fileSize: number | null; lengthSec: number };
  keeps: { hotCues: number; memoryCues: number; loops: number; playlists: number; myTags: number; playCount: number; dateAdded: string; rating: number };
  alignment: UpgradeSwapAlignment;
  cueShiftMs: number;          // 0 when cues stay as they are; else added to every cue (whole ms)
  checkBeatgrid: boolean;      // true when the user should eyeball the grid in Rekordbox afterwards
  oldFileGoesTo: string | null;
};

export type UpgradeSwapPreflight = { rekordboxRunning: boolean; dbFound: boolean; backupDir: string; backupDirOk: boolean; archiveDir: string; libraryRoot: string; error?: string };

export type UpgradeSwapProgress = { phase: 'planning' | 'converting' | 'writing' | 'verifying' | 'archiving' | 'done'; current: number; total: number; message: string };

export type UpgradeSwapResultItem = { rbId: string; title: string; artist: string; status: 'swapped' | 'skipped' | 'failed'; detail: string; cueShiftMs: number; checkBeatgrid: boolean };

export type UpgradeSwapResult = { swapped: number; skipped: number; failed: number; backupPath: string | null; rollbackPath: string | null; items: UpgradeSwapResultItem[] };

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
  | 'usb-health-scan'
  | 'claude-ask'
  | 'claude-sourcing-review'
  | 'claude-track-tags'
  | 'claude-soundcloud'
  | 'claude-store-finder'
  | 'claude-upgrade-review';

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

// ========== Claude jobs ==========
// Jobs that run a headless Claude Code session on the signed-in subscription.

/** The subscription's rate-limit state, as the stream reports it. */
export type ClaudeRateLimit = {
  status: string;
  rateLimitType: string | null;
  /** 0..1 share of the window used, when reported. */
  utilization: number | null;
  /** Epoch seconds. */
  resetsAt: number | null;
};

export type ClaudeStatus = {
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  loggedIn: boolean;
  /** 'claude.ai' (signed in), 'oauth_token' (setup-token), or an API method. */
  authMethod: string | null;
  email: string | null;
  subscriptionType: string | null;
  /** The login is a Claude subscription, so jobs bill the plan. */
  subscription: boolean;
  usingAppToken: boolean;
  /** Last rate-limit state a job saw, so Settings can show how much is left. */
  rateLimit: ClaudeRateLimit | null;
  error: string | null;
};

export type ClaudeAskParams = { prompt: string; /** Continue this conversation. */ sessionId?: string };
export type ClaudeAskResult = { text: string; sessionId: string | null };

/** One Sources row sent for review: what was wanted, what the library thinks
 *  it has, and the store link the engine picked. */
export type SourcingReviewRow = {
  id: string;
  wanted: { artist: string; title: string; album?: string };
  library?: { ownedArtist: string; ownedTitle: string; confidence: number; reason?: string };
  store: {
    source: 'qobuz' | 'beatport';
    artists: string[];
    title: string;
    remixers?: string[];
    release?: string;
    label?: string;
    confidence: number;
    /** The engine already suspects a different version. */
    versionFlag: boolean;
    /** The link is a whole release, not the one track. */
    releaseLevel: boolean;
    note?: string;
  };
};
export type SourcingVerdictKind = 'buy' | 'skip' | 'wrong' | 'flag';
/** `ref`: on a "wrong" verdict, the right record Claude found (a search_store_catalog ref). */
export type SourcingVerdict = { id: string; verdict: SourcingVerdictKind; note: string; ref?: string };
export type SourcingReviewResult = { verdicts: SourcingVerdict[]; summary: string };

// ---------- Upgrade quality: Claude's check (the playlist-sourcing skill's upgrade rules) ----------

/** One Upgrades row as Claude sees it: the Rekordbox entry and what the app's own search found. */
export type UpgradeReviewRow = {
  rbId: string;
  artist: string;
  title: string;
  /** Seconds. */
  duration?: number;
  /** What it is now: "MP3 320", "Spotify stream". */
  formatLabel: string;
  free: {
    soundcloud: import('./lib/freeSources').FreeSourceHit | null;
    bandcamp: import('./lib/freeSources').FreeSourceHit | null;
    nearMisses: import('./lib/freeSources').FreeSourceMiss[];
  } | null;
  store: { source: 'qobuz' | 'beatport'; title: string; artists: string[]; price: string; lossless: boolean; confidence: number; ref: string | null } | null;
};
export type UpgradeVerdictKind = 'free' | 'store' | 'none' | 'keep';
export type UpgradeVerdict = { rbId: string; verdict: UpgradeVerdictKind; note: string; freeUrl?: string; ref?: string };
export type ClaudeUpgradeReviewParams = { rows: UpgradeReviewRow[] };
export type ClaudeUpgradeReviewResult = { verdicts: UpgradeVerdict[]; summary: string };

export type TrackTagField = 'title' | 'artist' | 'remixer' | 'album' | 'genre' | 'year' | 'bpm' | 'key' | 'label';
export type ClaudeTrackTagsParams = { filePath: string; tags: Record<TrackTagField | 'comment', string> };
/** Suggested values; '' means Claude found nothing it trusts for that field. */
export type ClaudeTrackTagsResult = {
  fields: Record<TrackTagField, string>;
  confidence: 'high' | 'medium' | 'low';
  source: string;
  sourceUrl: string;
  notes: string;
};

/** One store result as the Claude finder sees it; `ref` names it back to the app. */
export type FinderCandidate = {
  /** 'bp:<track id>' or 'qz:<release id>'. */
  ref: string;
  store: 'beatport' | 'qobuz';
  artists: string;
  /** Beatport: the track with its mix. Qobuz: the release's title. */
  title: string;
  remixers?: string;
  label?: string;
  released?: string;
  bpm?: number;
  /** Qobuz only: the release's lossless tier ("24/96"), or null when it may be sold compressed only. */
  quality?: string | null;
  price?: string | null;
  /** The plain search's 0..1 score against the wanted track. */
  score?: number;
};

export type FinderTrack = {
  key: string;
  artist: string;
  title: string;
  album?: string;
  durationSec?: number;
  /** The plain search's pick, as a candidate ref, or null. */
  searchPick: string | null;
  candidates: FinderCandidate[];
};

/** Claude's answer for one track: a candidate ref, or '' for "not sold". */
export type FinderPick = { key: string; ref: string; confidence: FinderConfidence; note: string };

export type ClaudeStoreFinderParams = { tracks: FinderTrack[] };
export type ClaudeStoreFinderResult = {
  picks: FinderPick[];
  /** Tracks whose session failed or never ran; they keep the plain search's match. */
  unchecked: number;
  firstError: string | null;
};

export type ClaudeSoundcloudParams = {
  /** A set link; empty means the signed-in account's likes. */
  setUrl?: string;
  limit?: number;
  /** ISO date: likes made on/after it. */
  since?: string;
  listOnly?: boolean;
  dropLossy?: boolean;
  /** Handed to gates that ask for an address; never sent otherwise. */
  email?: string;
  /** Let gates follow/like/comment for real through the SoundCloud session. */
  accountActions?: boolean;
  /** Retry the stalled gates of an earlier run. */
  resumeSessionPath?: string;
};
export type SoundcloudReview = {
  summary: string;
  needsYou: { artist: string; title: string; reason: string; action: string }[];
  possibleDuplicates: { artist: string; title: string; file: string; ownedAs: string }[];
  nextSteps: string[];
  resumeWorthIt: boolean;
};
export type ClaudeSoundcloudResult = {
  sessionPath: string;
  counts: Record<string, number>;
  review: SoundcloudReview | null;
  /** Why the review step failed, when the downloads themselves went fine. */
  reviewError?: string;
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

/** The top-bar update button's state, from the last GitHub check. */
export type UpdateState = {
  /** What's waiting ("3 changes on GitHub", "Track Lab 0.2.0"); null when up to date or not checked yet. */
  available: string | null;
};

/** A Track Lab profile as the window sees it (src/lib/profiles.ts ProfileView). */
export interface TrackLabProfile {
  id: string;
  name: string;
  createdAt?: string;
  /** Its data folder. */
  dir: string;
  /** The original profile (the data folder Track Lab always used). */
  isMain: boolean;
  /** The one Track Lab opens in. */
  isDefault: boolean;
  /** The one this Track Lab is running. */
  isRunning: boolean;
}

export interface ProfilesState {
  running: string;
  defaultId: string;
  profiles: TrackLabProfile[];
}
