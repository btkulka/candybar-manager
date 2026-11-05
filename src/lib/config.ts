import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createScopedLogger } from './logger';
import type { AppConfig } from '../types';
export type { AppConfig };

const log = createScopedLogger('Config');

// Default library root: the user's Music folder on every platform. It always
// exists after an OS install and is a starting point the user changes in
// Settings. (This used to be one person's external drive on macOS, which
// leaked into every fresh install.) Existing configs keep their explicit value.
function defaultLibraryRoot(): string {
  return path.join(os.homedir(), 'Music');
}

export const DEFAULT_LIBRARY_ROOT = defaultLibraryRoot();

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

// Default home for master.db snapshots taken before the app writes to
// Rekordbox: backups/rekordbox next to the library root.
export function getDefaultRekordboxBackupDir(libraryRoot = DEFAULT_LIBRARY_ROOT): string {
  return path.join(path.dirname(libraryRoot), 'backups', 'rekordbox');
}

/** The configured snapshot folder, or the default beside the CONFIGURED library
 *  root. The stored default is '' rather than a path: a path baked from the
 *  default library root would point every existing config at ~/backups. */
export function resolveRekordboxBackupDir(config: Pick<AppConfig, 'libraryRoot' | 'rekordboxBackupDir'>): string {
  return config.rekordboxBackupDir || getDefaultRekordboxBackupDir(config.libraryRoot || DEFAULT_LIBRARY_ROOT);
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
  claudeOauthToken: '',
  claudeModel: '',
  claudeFindMatches: true,
  claudeProfile: null,
  gateEmail: '',
  gateComment: '',
  gateFirstName: '',
  gateLastName: '',
  floatingConsoleEnabled: true,
  activeTab: 'organize',
  checkCsvPath: '',
  checkSpotifyPlaylistUrl: '',
  checkTabFilter: 'missing',
  healthTabFilter: 'all',
  qobuzAccounts: [],
  beatportAccounts: [],
  excludedVolumes: DEFAULT_EXCLUDED_VOLUMES,
  rekordboxXmlPath: '',
  rekordboxEnabled: true,
  showAdvancedTools: false,
  rekordboxBackupDir: ''
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

type FileConfigRead =
  | { kind: 'ok'; config: AppConfig; raw: Record<string, unknown> }
  | { kind: 'missing' }
  | { kind: 'corrupt'; error: string };

// Warnings worth showing the user (a corrupt config that was backed up).
const configWarnings: string[] = [];
// "<path>:<mtime>" of corrupt files already backed up, so the many readConfig
// calls per session don't each write another copy.
const backedUpCorrupt = new Set<string>();

/** Problems found while loading config this session (e.g. a corrupt file that was backed up). */
export function getConfigWarnings(): string[] {
  return [...configWarnings];
}

async function readFileConfigDetailed(configPath: string): Promise<FileConfigRead> {
  let content: string;
  try {
    content = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'corrupt', error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
    return { kind: 'ok', config: { ...DEFAULTS, ...(parsed as Partial<AppConfig>) }, raw: parsed };
  } catch (err) {
    return { kind: 'corrupt', error: err instanceof Error ? err.message : String(err) };
  }
}

async function readFileConfig(configPath: string): Promise<AppConfig | null> {
  const r = await readFileConfigDetailed(configPath);
  return r.kind === 'ok' ? r.config : null;
}

/** Copy an unreadable config aside (once per version of it) before anything can overwrite it. */
async function backUpCorruptConfig(configPath: string, error: string): Promise<void> {
  const mtime = await fs.stat(configPath).then(s => s.mtimeMs, () => 0);
  const key = `${configPath}:${mtime}`;
  if (backedUpCorrupt.has(key)) return;
  backedUpCorrupt.add(key);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${configPath}.corrupt-${stamp}`;
  try {
    await fs.copyFile(configPath, backupPath);
    const msg = `Settings file was unreadable (${error}). Saved a copy to ${backupPath}; using defaults until you change a setting.`;
    log.warn(msg);
    configWarnings.push(msg);
  } catch (err) {
    log.error('Could not back up corrupt config:', configPath, err);
    configWarnings.push(`Settings file was unreadable (${error}) and could not be backed up.`);
  }
}

// Secret fields live in a separate, untracked file. Anything user-identifying
// or auth-related goes here so the repo-level `config.json` stays shareable.
const SECRET_STRING_KEYS = ['spotifyClientId', 'spotifyClientSecret', 'claudeOauthToken', 'gateEmail', 'gateFirstName', 'gateLastName'] as const;
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

/**
 * Fill secret fields into `target`. A key present in secrets.json (`rawSecrets`)
 * is authoritative even when empty — that is how a cleared account or client
 * secret stays cleared instead of being resurrected from an older source.
 * Otherwise keep a non-empty target value, then the first non-empty source.
 */
function mergeSecretsInto(
  target: AppConfig,
  rawSecrets: Record<string, unknown> | null,
  secrets: AppConfig | null,
  ...fallbacks: (AppConfig | null)[]
): AppConfig {
  const has = (key: string) => !!rawSecrets && Object.prototype.hasOwnProperty.call(rawSecrets, key);
  const sources = [secrets, ...fallbacks];
  for (const key of SECRET_STRING_KEYS) {
    if (has(key) && secrets) { target[key] = secrets[key]; continue; }
    if (target[key]) continue;
    for (const src of sources) {
      if (src?.[key]) { target[key] = src[key]; break; }
    }
  }
  for (const key of SECRET_ARRAY_KEYS) {
    if (has(key) && secrets) { target[key] = secrets[key]; continue; }
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
  const primaryRead = await readFileConfigDetailed(primaryPath);
  const primary = primaryRead.kind === 'ok' ? primaryRead.config : null;
  const fallback = fallbackPath ? await readFileConfig(fallbackPath) : null;
  const secretsRead = secretsPath ? await readFileConfigDetailed(secretsPath) : null;
  const secrets = secretsRead?.kind === 'ok' ? secretsRead.config : null;
  const rawSecrets = secretsRead?.kind === 'ok' ? secretsRead.raw : null;
  if (secretsRead?.kind === 'corrupt' && secretsPath) await backUpCorruptConfig(secretsPath, secretsRead.error);
  const mSecrets = secrets ? migrateConfig(secrets) : null;

  if (primaryRead.kind === 'corrupt') {
    // A config file exists but can't be read: this is an existing user, not a
    // first launch. Keep a copy before the next write replaces it, warn, and
    // run on defaults without restarting the tour.
    await backUpCorruptConfig(primaryPath, primaryRead.error);
    const base = migrateConfig(fallback ?? DEFAULTS);
    base.tutorialCompleted = true;
    return mergeSecretsInto(base, rawSecrets, mSecrets);
  }

  // If no primary config exists, use fallback (or secrets, or defaults).
  if (!primary) {
    const base = migrateConfig(fallback ?? DEFAULTS);
    // Nothing written on this machine yet: a first launch. Set the flag explicitly
    // so it survives the first config write and the tour still runs.
    base.tutorialCompleted ??= false;
    return mSecrets ? mergeSecretsInto(base, rawSecrets, mSecrets) : base;
  }

  const mPrimary = migrateConfig(primary);
  // Config files from before the tour existed belong to people already using the app.
  mPrimary.tutorialCompleted ??= true;
  const mFallback = fallback ? migrateConfig(fallback) : null;

  // Primary wins for non-secret fields. Secret fields come from secrets.json
  // (untracked, authoritative for this machine — including deliberately empty
  // values), then the tracked fallback config only when secrets.json lacks the key.
  return mergeSecretsInto(mPrimary, rawSecrets, mSecrets, mFallback);
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
      // A secret the caller passed is written as-is, empty included, so clearing
      // the last account or a client secret sticks. A caller that didn't pass the
      // field at all leaves the stored value alone.
      const passed = (key: string) => Object.prototype.hasOwnProperty.call(config, key);
      for (const key of SECRET_STRING_KEYS) {
        if (passed(key)) secretsOut[key] = merged[key] ?? '';
        delete primaryOut[key];
      }
      for (const key of SECRET_ARRAY_KEYS) {
        if (passed(key)) secretsOut[key] = merged[key] ?? [];
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
