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

/** Migrate legacy config values (tab renames + legacy single-account credentials).
 *  Returns a fresh object and never mutates its input — callers pass in the shared
 *  module-level DEFAULTS (and shallow-spread copies that alias its arrays), so
 *  in-place mutation here would corrupt every later config read. */
function migrateConfig(config: AppConfig): AppConfig {
  const out: AppConfig = {
    ...config,
    // Fresh, deep-copied account arrays so a push/delete below can't reach a
    // shared array (e.g. DEFAULTS.qobuzAccounts) aliased in via `{...DEFAULTS}`.
    qobuzAccounts: Array.isArray(config.qobuzAccounts) ? config.qobuzAccounts.map((a) => ({ ...a })) : [],
    beatportAccounts: Array.isArray(config.beatportAccounts) ? config.beatportAccounts.map((a) => ({ ...a })) : [],
  };

  // health, polish, and browse tabs were merged into 'library'
  if (out.activeTab === 'health' || out.activeTab === 'polish' || out.activeTab === 'browse') {
    out.activeTab = 'library';
  }

  // Migrate legacy single-account credentials into account arrays.
  // The 'legacy' id is preserved so the existing electron session partition (persist:qobuz /
  // persist:beatport) continues to be used — the user does not need to re-login.
  if (out.qobuzEmail && out.qobuzAccounts.length === 0) {
    out.qobuzAccounts.push({ id: 'legacy', email: out.qobuzEmail, label: 'Default' });
  }
  if (out.beatportEmail && out.beatportAccounts.length === 0) {
    out.beatportAccounts.push({ id: 'legacy', email: out.beatportEmail, label: 'Default' });
  }
  delete out.qobuzEmail;
  delete out.qobuzPassword;
  delete out.beatportEmail;
  delete out.beatportPassword;

  // Drop any stored passwords from existing accounts (auth is browser-session only now).
  for (const acct of out.qobuzAccounts) delete (acct as Record<string, unknown>).password;
  for (const acct of out.beatportAccounts) delete (acct as Record<string, unknown>).password;

  return out;
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

/** Write a file atomically (temp + rename) so a crash mid-write can't truncate it. */
async function atomicWriteFile(filePath: string, data: string, mode?: number): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, data, mode !== undefined ? { mode } : {});
  await fs.rename(tmp, filePath);
}

// Serialize config writes so concurrent read-modify-write cycles can't clobber
// each other (last-writer-wins truncation / lost updates).
let writeChain: Promise<unknown> = Promise.resolve();

export function writeConfig(configPath: string, config: AppConfig): Promise<AppConfig> {
  const result = writeChain.then(() => doWriteConfig(configPath, config));
  writeChain = result.catch(() => {}); // keep the chain alive across failures
  return result;
}

async function doWriteConfig(configPath: string, config: AppConfig): Promise<AppConfig> {
  log.debug('Writing config to:', configPath);
  try {
    // Run through migration so legacy fields passed in don't get persisted.
    const merged: AppConfig = migrateConfig({ ...DEFAULTS, ...config });

    // Separate credentials from general config: secrets are persisted ONLY to the
    // untracked secrets.json (0600), and stripped from the primary/shareable config
    // so they never land in a committable config file. Without a secrets path
    // configured we fall back to writing everything to the primary file (legacy).
    const primaryOut = { ...merged } as Record<string, unknown>;
    if (secretsPath) {
      // Read the existing secrets RAW (not via readFileConfig, which would inject
      // DEFAULTS and bloat secrets.json with non-secret fields), preserving any
      // unmanaged keys already present.
      let existingSecrets: Record<string, unknown> = {};
      try {
        existingSecrets = JSON.parse(await fs.readFile(secretsPath, 'utf8')) as Record<string, unknown>;
      } catch { /* no existing secrets file */ }
      const secretsOut: Record<string, unknown> = { ...existingSecrets };
      for (const key of SECRET_STRING_KEYS) {
        if (merged[key]) secretsOut[key] = merged[key];
        delete primaryOut[key];
      }
      for (const key of SECRET_ARRAY_KEYS) {
        if (merged[key]?.length) secretsOut[key] = merged[key];
        delete primaryOut[key];
      }
      await fs.mkdir(path.dirname(secretsPath), { recursive: true });
      await atomicWriteFile(secretsPath, JSON.stringify(secretsOut, null, 2), 0o600);
    }

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await atomicWriteFile(configPath, JSON.stringify(primaryOut, null, 2));
    return merged;
  } catch (error) {
    log.error('Failed to write config:', configPath, error);
    throw error;
  }
}
