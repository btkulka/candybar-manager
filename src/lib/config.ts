import fs from 'fs/promises';
import path from 'path';
import { createScopedLogger } from './logger';
import type { AppConfig } from '../types';
export type { AppConfig };

const log = createScopedLogger('Config');

// Default library root
export const DEFAULT_LIBRARY_ROOT = '/Volumes/Candy Bar/Music';

// Default archive path is .archive next to the library root
export function getDefaultArchivePath(libraryRoot = DEFAULT_LIBRARY_ROOT): string {
  const parentDir = path.dirname(libraryRoot);
  return path.join(parentDir, '.archive');
}

// Default organize source dir is tracks_to_organize next to the library root
export function getDefaultOrganizeSourceDir(libraryRoot = DEFAULT_LIBRARY_ROOT): string {
  const parentDir = path.dirname(libraryRoot);
  return path.join(parentDir, 'tracks_to_organize');
}

// Default restore staging dir (where recovered tracks land before moving into library)
export function getDefaultRestoreStageDir(libraryRoot = DEFAULT_LIBRARY_ROOT): string {
  return path.join(getDefaultOrganizeSourceDir(libraryRoot), 'restore_recovered');
}

// macOS system volumes that should never appear in the Devices panel
export const DEFAULT_EXCLUDED_VOLUMES = [
  'Macintosh HD',
  'Macintosh HD - Data',
  'Recovery',
  'Preboot',
  'VM',
  'Update',
  'xarts',
  'iSCPreboot'
];

const DEFAULTS: AppConfig = {
  libraryRoot: DEFAULT_LIBRARY_ROOT,
  organizeSourceDir: getDefaultOrganizeSourceDir(),
  archivePath: getDefaultArchivePath(),
  spotifyClientId: '',
  spotifyClientSecret: '',
  floatingConsoleEnabled: true,
  activeTab: 'organize',
  checkCsvPath: '',
  checkSpotifyPlaylistUrl: '',
  checkTabFilter: 'missing',
  healthTabFilter: 'all',
  qobuzAccounts: [],
  beatportAccounts: [],
  excludedVolumes: DEFAULT_EXCLUDED_VOLUMES,
  rekordboxXmlPath: ''
};

/** Migrate legacy config values (tab renames + legacy single-account credentials) */
function migrateConfig(config: AppConfig): AppConfig {
  // health, polish, and browse tabs were merged into 'library'
  if (config.activeTab === 'health' || config.activeTab === 'polish' || config.activeTab === 'browse') {
    config.activeTab = 'library';
  }

  // Migrate legacy single-account credentials into account arrays.
  // The 'legacy' id is preserved so the existing electron session partition (persist:qobuz /
  // persist:beatport) continues to be used — the user does not need to re-login.
  if (!config.qobuzAccounts) config.qobuzAccounts = [];
  if (!config.beatportAccounts) config.beatportAccounts = [];

  if (config.qobuzEmail && config.qobuzAccounts.length === 0) {
    config.qobuzAccounts.push({
      id: 'legacy',
      email: config.qobuzEmail,
      label: 'Default',
    });
  }
  if (config.beatportEmail && config.beatportAccounts.length === 0) {
    config.beatportAccounts.push({
      id: 'legacy',
      email: config.beatportEmail,
      label: 'Default',
    });
  }
  delete config.qobuzEmail;
  delete config.qobuzPassword;
  delete config.beatportEmail;
  delete config.beatportPassword;

  // Drop any stored passwords from existing accounts (auth is browser-session only now).
  // We don't ask the user — `password` is just silently removed on next read/write.
  for (const acct of config.qobuzAccounts) delete (acct as Record<string, unknown>).password;
  for (const acct of config.beatportAccounts) delete (acct as Record<string, unknown>).password;

  return config;
}

async function readFileConfig(configPath: string): Promise<AppConfig | null> {
  try {
    const content = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(content) as Partial<AppConfig>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return null;
  }
}

// Secret fields live in a separate, untracked file. Anything user-identifying
// or auth-related goes here so the repo-level `config.json` stays shareable.
const SECRET_STRING_KEYS = ['spotifyClientId', 'spotifyClientSecret'] as const;
const SECRET_ARRAY_KEYS = ['qobuzAccounts', 'beatportAccounts'] as const;

// Module-level secrets path. Set once at app startup so all existing
// readConfig()/writeConfig() call sites pick it up without passing it through.
let secretsPath: string | null = null;

/** Path of the secrets file — read and written alongside every config operation. */
export function setSecretsPath(p: string): void {
  secretsPath = p;
}

export function getSecretsPath(): string | null {
  return secretsPath;
}

function mergeSecretsInto(
  target: AppConfig,
  ...sources: (AppConfig | null)[]
): AppConfig {
  for (const key of SECRET_STRING_KEYS) {
    if (target[key]) continue;
    for (const src of sources) {
      if (src?.[key]) { target[key] = src[key]; break; }
    }
  }
  for (const key of SECRET_ARRAY_KEYS) {
    if (target[key]?.length) continue;
    for (const src of sources) {
      if (src?.[key]?.length) { target[key] = src[key]; break; }
    }
  }
  return target;
}

export async function readConfig(
  primaryPath: string,
  fallbackPath?: string
): Promise<AppConfig> {
  log.debug('Reading config from:', primaryPath);
  const primary = await readFileConfig(primaryPath);
  const fallback = fallbackPath ? await readFileConfig(fallbackPath) : null;
  const secrets = secretsPath ? await readFileConfig(secretsPath) : null;

  // If no primary config exists, use fallback (or secrets, or defaults).
  if (!primary) {
    const base = migrateConfig(fallback ?? DEFAULTS);
    return secrets ? mergeSecretsInto(base, migrateConfig(secrets)) : base;
  }

  const mPrimary = migrateConfig(primary);
  const mFallback = fallback ? migrateConfig(fallback) : null;
  const mSecrets = secrets ? migrateConfig(secrets) : null;

  // Primary wins for non-secret fields. Secret fields fall back to secrets.json
  // first (untracked, authoritative for this machine), then to the tracked
  // fallback config — only used if secrets.json lacks the field entirely.
  return mergeSecretsInto(mPrimary, mSecrets, mFallback);
}

export async function writeConfig(configPath: string, config: AppConfig) {
  log.debug('Writing config to:', configPath);
  try {
    // Run through migration so legacy fields passed in don't get persisted.
    const safeConfig: AppConfig = migrateConfig({ ...DEFAULTS, ...config });

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(safeConfig, null, 2));
    return safeConfig;
  } catch (error) {
    log.error('Failed to write config:', configPath, error);
    throw error;
  }
}
