// ============================================================
// Track Lab's MCP parity map. The rule: everything the app can do,
// Claude can do over MCP (src/mcp-server.ts, server
// candybar-audio-tools). Every IPC action in src/main.ts is listed
// with the MCP tool(s) that do the same thing, or with the reason
// it is window-only or internal.
//
// src/lib/__tests__/mcpParity.test.ts fails when an action isn't
// listed here, when a listed action no longer exists, or when a
// listed tool isn't in the MCP server. When you add an IPC action:
// add (or extend) an MCP tool that runs it through the app's socket
// (`invokeApp` in mcp-server.ts), then list it here.
//
// The app refuses window-only actions over the socket (storeBridge
// `invoke`): they need a picker, the embedded store panel, or Ben.
// ============================================================

const W = (why: string) => `window-only: ${why}`;
const I = (why: string) => `internal: ${why}`;

const PICKER = W('a file or folder picker; the MCP tools take the path as an argument');
const STORE_PANEL = W('the store panel embedded in the window; checking out and placing an order stay Ben\'s clicks (store_cart_add fills the cart)');
const SCREEN_STATE = I('the window saving its own screen state');

export const PARITY: Record<string, readonly string[] | string> = {
  // Settings, status, connections
  'get-config': ['get_settings'],
  'get-config-path': ['get_settings'],
  'get-library-root': ['get_settings'],
  'set-config': ['update_settings'],
  'update-config': ['update_settings'],
  // Profiles (each person's data folder; switching restarts the app in it)
  'profiles:list': ['profiles'],
  'profiles:create': ['profiles'],
  'profiles:rename': ['profiles'],
  'profiles:set-default': ['profiles'],
  'profiles:delete': ['profiles'],
  'profiles:switch': ['profiles'],
  'get-cache-status': ['scan_cache'],
  'clear-cache': ['scan_cache'],
  'get-storage-stats': ['storage_stats'],
  'claude-status': ['connections'],
  'claude-open-login': W('Ben signs in to Claude Code himself, in the Terminal window it opens'),
  'check-spotify': ['connections'],
  'store-login-status': ['connections'],
  'store-login-account': ['connections'],
  'store-logout-account': ['connections'],
  'soundcloud-sign-in-status': ['connections'],
  'spotify-sign-in-status': ['connections'],
  'store-login': ['store_login'],
  'soundcloud-sign-in': ['store_login'],
  'spotify-sign-in': ['store_login'],
  'get-update-state': ['app_status'],
  'check-for-updates': W('shows the update dialog, where Ben chooses Update & Restart himself'),

  // What's in the library
  'check-library': ['check_playlist_ownership'],
  'preview-csv': ['preview_csv'],
  'ignore-track': ['ignored_tracks'],
  'unignore-track': ['ignored_tracks'],
  'get-ignored-tracks': ['ignored_tracks'],
  'dismiss-duplicate': ['dismissed_issues'],
  'dismiss-health-issue': ['dismissed_issues'],
  'undismiss-health-issue': ['dismissed_issues'],
  'get-dismissed-issues': ['dismissed_issues'],
  'rekordbox-scan': ['rekordbox_collection'],
  'rekordbox-import': ['rekordbox_collection'],
  'rekordbox-resync': ['rekordbox_collection'],
  'scan-library-health': ['library_health'],
  'scan-missing-album-art': ['album_art_scan'],

  // Exports
  'export-tracks-csv': ['export_tracks'],
  'export-playlist-m3u8': ['export_tracks'],
  'export-playlist-rekordbox': ['export_tracks'],
  'source-export-csv': ['export_tracks'],
  'export-catalog': ['export_catalog'],
  'show-save-dialog': PICKER,
  'show-save-dialog-m3u8': PICKER,
  'show-save-dialog-rekordbox': PICKER,
  'show-save-dialog-json': PICKER,

  // Searching and sourcing
  'search-music': ['search_music'],
  'library-sourcing:run': ['find_sources'],
  // A set's free downloads: source_soundcloud_likes with `set` runs the same downloader.
  'library-sourcing:fetch-free': ['source_soundcloud_likes'],
  'library-sourcing:fetch-free-stop': I('stops the window\'s own free-download run; an MCP run ends with its tool call'),
  'source-search': I('no screen calls it any more; find_sources runs the same store search'),
  'qobuz-cart-search': I('no screen calls it any more; find_sources and search_qobuz run the same Qobuz search'),
  'saved-sources:list': ['saved_sources'],
  'saved-sources:save': ['saved_sources'],
  'saved-sources:update': ['saved_sources'],
  'saved-sources:remove': ['saved_sources'],

  // Lossless upgrades
  'lossless-upgrade:list-playlists': ['lossless_upgrade'],
  'lossless-upgrade:run': ['lossless_upgrade'],
  'lossless-upgrade:fetch-free': ['lossless_upgrade'],
  'lossless-upgrade:fetch-free-stop': ['lossless_upgrade'],
  'lossless-upgrade:use-link': ['lossless_upgrade'],
  'lossless-upgrade:forget-link': ['lossless_upgrade'],
  'support:save-report': I('a file for a person to send; over MCP, Claude reads the logs itself (app_logs, list_operations)'),
  'lossless-upgrade:apply-claude': I('applies the verdicts of Claude\'s own upgrade check; over MCP, Claude is the one checking and uses use_link'),
  'library-sourcing:resolve-pick': I('applies a ref from Claude\'s own Find & buy review; over MCP, Claude searches with search_store_catalog itself'),
  'upgrade-swap:preflight': ['upgrade_swap'],
  'upgrade-swap:plan': ['upgrade_swap'],
  'upgrade-swap:apply': ['upgrade_swap'],

  // Stores
  'fetch-store-purchases': ['list_purchases'],
  'store-cart-add': ['store_cart_add'],
  'store-cart-check': ['store_cart_check'],
  'store-download-purchases': ['download_purchases'],
  'download-beatport-matches': ['download_purchases'],
  'download-qobuz-matches-concurrent': ['download_purchases'],
  'download-beatport-matches-concurrent': ['download_purchases'],
  'store-open-cart': STORE_PANEL,
  'store-panel-open': STORE_PANEL,
  'store-panel-close': STORE_PANEL,
  'store-panel-attach': STORE_PANEL,
  'store-panel-nav': STORE_PANEL,
  'store-panel-status': STORE_PANEL,
  'store-panel-checkout-advance': STORE_PANEL,
  'store-panel-place-order': STORE_PANEL,

  // Tracks and files
  'scan-tracks': ['scan_intake'],
  'get-track-info': ['track_info'],
  'get-track-album-art': ['track_info'],
  'update-track-tags': ['update_track_tags'],
  'autopopulate-tracks': ['autopopulate_tags'],
  'diagnose-aiff-header': ['aiff_header'],
  'repair-aiff-header': ['aiff_header'],
  'convert-track': ['track_file'],
  'fix-track-file': ['track_file'],
  'reencode-track-file': ['track_file'],
  'delete-track-file': ['track_file'],
  'archive-track-file': ['track_file'],
  'organize-tracks': ['organize_tracks'],
  'organize-resolve-conflict': ['organize_tracks'],
  'migrate-archive': ['migrate_archive'],
  'open-external': ['reveal'],
  'show-in-finder': ['reveal'],
  'select-path': PICKER,
  'select-image': PICKER,
  'toggle-devtools': W('developer tools for the window itself'),

  // The job queue (library scans, Claude jobs)
  'job-enqueue': ['jobs'],
  'job-enqueue-and-wait': ['jobs'],
  'job-cancel': ['jobs'],
  'job-list': ['jobs'],
  'job-wait': ['jobs'],

  // Drives and restore
  'list-volumes': ['volumes'],
  'exclude-volume': ['volumes'],
  'restore-list-volumes': ['volumes'],
  'restore-run': ['restore_library'],
  'restore-abort': ['restore_library'],
  'restore-pick-xml': PICKER,

  // Splice
  'splice-login-status': ['splice'],
  'splice-start-login': ['splice'],
  'splice-scan': ['splice'],
  'splice-classify': ['splice'],
  'splice-download-owned': ['splice'],
  'splice-credits-balance': ['splice'],
  'splice-buy-credits': ['splice'],
  'splice-pick-als': PICKER,

  // The window's own state
  'update-check-result': SCREEN_STATE,
  'update-health-result': SCREEN_STATE,
  'get-organize-state': SCREEN_STATE,
  'update-organize-state': SCREEN_STATE,
};

/** Why an action can't run outside the window, or null when it can. Unknown
 *  actions return null; the registry refuses those itself. */
export function windowOnlyReason(channel: string): string | null {
  const entry = PARITY[channel];
  return typeof entry === 'string' && entry.startsWith('window-only: ') ? entry.slice('window-only: '.length) : null;
}

/** Every MCP tool the map names. */
export function parityTools(): Set<string> {
  return new Set(Object.values(PARITY).flatMap((v) => (typeof v === 'string' ? [] : v)));
}
