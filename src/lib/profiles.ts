// ============================================================
// Profiles: one Track Lab, several people's data.
//
// A profile is a data folder. The first one ("main") is the folder Track
// Lab has always used (~/Library/Application Support/candybar-manager, the
// "profiles root"); every other profile lives under <root>/profiles/<id>/
// with its own config.json, secrets.json, candybar.db, store sign-ins
// (Electron partitions), download ledger, sourcing history and logs. Its
// browser sign-ins (SoundCloud, Spotify for gates, Splice) live in
// <profile>/cache/, while main keeps ~/.cache/candybar-manager.
//
// <root>/profiles.json records them:
//   defaultId  the profile Track Lab opens in on launch (the first one,
//              main, until Ben picks another)
//   active     the profile the app is running now (or ran last), so the MCP
//              server and the sourcing CLI, which aren't started by the app,
//              know whose files to use
//
// No Electron here: the app, the MCP server and the tests share this file.
// lib/profilePaths.mjs is its read-only twin for the plain-ESM sourcing
// engine (src/lib/__tests__/profiles.test.ts keeps the two in step).
// ============================================================

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

export const MAIN_PROFILE_ID = 'main';
export const MAIN_PROFILE_NAME = 'Main';
const REGISTRY_FILE = 'profiles.json';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_NAME = 40;

/** Secrets a new profile starts with: the app's own keys, not a person's
 *  sign-ins. Store accounts, the gate email and the gate name/address are
 *  each person's own and start empty. */
export const SHARED_SECRET_KEYS = ['spotifyClientId', 'spotifyClientSecret', 'claudeOauthToken'] as const;

export interface Profile {
  id: string;
  name: string;
  createdAt?: string;
}

export interface ProfileRegistry {
  version: 1;
  defaultId: string;
  active: string;
  profiles: Profile[];
}

export interface ProfileView extends Profile {
  dir: string;
  isMain: boolean;
  isDefault: boolean;
  /** The profile this Track Lab is running. */
  isRunning: boolean;
}

/** The app's data folder worked out without Electron, exactly as
 *  app.getPath('userData') resolves it: the platform's app-data folder plus
 *  the app name. */
export function defaultProfilesRoot(): string {
  const home = os.homedir();
  const name = 'candybar-manager';
  if (os.platform() === 'darwin') return path.join(home, 'Library', 'Application Support', name);
  if (os.platform() === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), name);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), name);
}

export function registryPath(root: string): string {
  return path.join(root, REGISTRY_FILE);
}

export function profileDir(root: string, id: string): string {
  return id === MAIN_PROFILE_ID ? root : path.join(root, 'profiles', id);
}

/** Where a profile's browser sign-ins and session notes live. Main keeps the
 *  folder it always used, so nobody is signed out by the update. */
export function profileCacheDir(root: string, id: string): string {
  return id === MAIN_PROFILE_ID
    ? path.join(os.homedir(), '.cache', 'candybar-manager')
    : path.join(profileDir(root, id), 'cache');
}

function mainProfile(): Profile {
  return { id: MAIN_PROFILE_ID, name: MAIN_PROFILE_NAME };
}

/** The registry, tidied: main always present and first, unknown or broken
 *  entries dropped, defaultId/active pointing at a profile that exists. A
 *  missing or unreadable file reads as "just main". */
export function readRegistry(root: string): ProfileRegistry {
  let raw: Partial<ProfileRegistry> = {};
  try {
    raw = JSON.parse(fs.readFileSync(registryPath(root), 'utf8')) ?? {};
  } catch {
    /* no registry yet: only main */
  }
  return normalize(raw);
}

function normalize(raw: Partial<ProfileRegistry>): ProfileRegistry {
  const seen = new Set<string>();
  const profiles: Profile[] = [];
  const listed = Array.isArray(raw.profiles) ? raw.profiles : [];
  const main = listed.find(p => p && p.id === MAIN_PROFILE_ID);
  profiles.push({ ...mainProfile(), ...(main && typeof main.name === 'string' && main.name.trim() ? { name: main.name.trim() } : {}), ...(main?.createdAt ? { createdAt: main.createdAt } : {}) });
  seen.add(MAIN_PROFILE_ID);
  for (const p of listed) {
    if (!p || typeof p.id !== 'string' || !ID_RE.test(p.id) || seen.has(p.id)) continue;
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, MAX_NAME) : p.id;
    profiles.push({ id: p.id, name, ...(p.createdAt ? { createdAt: p.createdAt } : {}) });
    seen.add(p.id);
  }
  const has = (id: unknown): id is string => typeof id === 'string' && seen.has(id);
  const defaultId = has(raw.defaultId) ? raw.defaultId : MAIN_PROFILE_ID;
  const active = has(raw.active) ? raw.active : defaultId;
  return { version: 1, defaultId, active, profiles };
}

export function writeRegistry(root: string, reg: ProfileRegistry): void {
  const clean = normalize(reg);
  fs.mkdirSync(root, { recursive: true });
  const target = registryPath(root);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n');
  fs.renameSync(tmp, target);
}

/** A profile by id, or by name (case-insensitive) for the MCP tool. */
export function findProfile(reg: ProfileRegistry, idOrName: string | undefined | null): Profile | undefined {
  if (!idOrName) return undefined;
  const key = idOrName.trim();
  return reg.profiles.find(p => p.id === key) ?? reg.profiles.find(p => p.name.toLowerCase() === key.toLowerCase());
}

/** The profile to open: the one asked for if it exists, else the default. */
export function resolveProfile(reg: ProfileRegistry, wanted?: string | null): Profile {
  return findProfile(reg, wanted) ?? findProfile(reg, reg.defaultId) ?? reg.profiles[0];
}

export function listProfiles(root: string, runningId?: string): ProfileView[] {
  const reg = readRegistry(root);
  const running = runningId ?? reg.active;
  return reg.profiles.map(p => ({
    ...p,
    dir: profileDir(root, p.id),
    isMain: p.id === MAIN_PROFILE_ID,
    isDefault: p.id === reg.defaultId,
    isRunning: p.id === running,
  }));
}

function cleanName(reg: ProfileRegistry, name: unknown, exceptId?: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) throw new Error('Give the profile a name.');
  if (trimmed.length > MAX_NAME) throw new Error(`Keep the name under ${MAX_NAME + 1} characters.`);
  const clash = reg.profiles.find(p => p.id !== exceptId && p.name.toLowerCase() === trimmed.toLowerCase());
  if (clash) throw new Error(`There's already a profile called "${clash.name}".`);
  return trimmed;
}

function newId(reg: ProfileRegistry, name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'profile';
  for (;;) {
    const id = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
    if (id !== MAIN_PROFILE_ID && !reg.profiles.some(p => p.id === id)) return id;
  }
}

/** Only the app's own keys, picked out of a secrets.json. */
export function sharedSecretsFrom(secretsPath: string): Record<string, string> {
  try {
    const all = JSON.parse(fs.readFileSync(secretsPath, 'utf8')) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const k of SHARED_SECRET_KEYS) if (typeof all[k] === 'string' && all[k]) out[k] = all[k] as string;
    return out;
  } catch {
    return {};
  }
}

/**
 * Add a profile: its folder, a config.json that sends it through the setup
 * guide with Rekordbox off (the Rekordbox collection on this Mac belongs to
 * whoever set it up; turn it on in the new profile only if it's theirs too),
 * and a secrets.json holding only the shared app keys.
 */
export function createProfile(
  root: string,
  name: unknown,
  opts: { sharedSecrets?: Record<string, string>; now?: Date } = {},
): Profile {
  const reg = readRegistry(root);
  const cleaned = cleanName(reg, name);
  const profile: Profile = { id: newId(reg, cleaned), name: cleaned, createdAt: (opts.now ?? new Date()).toISOString() };
  const dir = profileDir(root, profile.id);
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  if (!fs.existsSync(configPath)) {
    // tutorialCompleted false: a config.json without it reads as someone who
    // used Track Lab before the tour existed, which would skip the setup guide.
    fs.writeFileSync(configPath, JSON.stringify({ setupCompleted: false, tutorialCompleted: false, rekordboxEnabled: false }, null, 2) + '\n');
  }
  const secretsPath = path.join(dir, 'secrets.json');
  if (!fs.existsSync(secretsPath)) {
    fs.writeFileSync(secretsPath, JSON.stringify(opts.sharedSecrets ?? {}, null, 2) + '\n', { mode: 0o600 });
  }
  writeRegistry(root, { ...reg, profiles: [...reg.profiles, profile] });
  return profile;
}

export function renameProfile(root: string, id: string, name: unknown): Profile {
  const reg = readRegistry(root);
  const profile = findProfile(reg, id);
  if (!profile) throw new Error(`No profile ${id}.`);
  const cleaned = cleanName(reg, name, profile.id);
  const renamed = { ...profile, name: cleaned };
  writeRegistry(root, { ...reg, profiles: reg.profiles.map(p => (p.id === profile.id ? renamed : p)) });
  return renamed;
}

export function setDefaultProfile(root: string, id: string): Profile {
  const reg = readRegistry(root);
  const profile = findProfile(reg, id);
  if (!profile) throw new Error(`No profile ${id}.`);
  writeRegistry(root, { ...reg, defaultId: profile.id });
  return profile;
}

/** Record which profile the app is running. Never throws: a read-only disk
 *  must not stop the app from starting. */
export function markActive(root: string, id: string): void {
  try {
    const reg = readRegistry(root);
    if (reg.active === id && fs.existsSync(registryPath(root))) return;
    writeRegistry(root, { ...reg, active: id });
  } catch {
    /* the MCP server falls back to the default profile */
  }
}

/**
 * Take a profile out of the registry and hand back its folder for the caller
 * to move to the Trash. Main (the original folder) and the running profile
 * can't be removed; removing the default makes main the default again.
 */
export function removeProfile(root: string, id: string, runningId: string): { profile: Profile; dir: string } {
  const reg = readRegistry(root);
  const profile = findProfile(reg, id);
  if (!profile) throw new Error(`No profile ${id}.`);
  if (profile.id === MAIN_PROFILE_ID) throw new Error(`"${profile.name}" is the original profile and can't be removed.`);
  if (profile.id === runningId) throw new Error(`Track Lab is running as "${profile.name}". Switch to another profile first.`);
  writeRegistry(root, {
    ...reg,
    defaultId: reg.defaultId === profile.id ? MAIN_PROFILE_ID : reg.defaultId,
    active: reg.active === profile.id ? runningId : reg.active,
    profiles: reg.profiles.filter(p => p.id !== profile.id),
  });
  return { profile, dir: profileDir(root, profile.id) };
}

/** The data folder whose files a process outside the app should use: what the
 *  app handed down (CANDYBAR_USER_DATA), else the profile the app is running. */
export function activeUserDataDir(env: NodeJS.ProcessEnv = process.env, root = env.CANDYBAR_PROFILES_ROOT || defaultProfilesRoot()): string {
  if (env.CANDYBAR_USER_DATA) return env.CANDYBAR_USER_DATA;
  const reg = readRegistry(root);
  return profileDir(root, resolveProfile(reg, reg.active).id);
}

export function activeProfile(env: NodeJS.ProcessEnv = process.env, root = env.CANDYBAR_PROFILES_ROOT || defaultProfilesRoot()): Profile {
  const reg = readRegistry(root);
  return resolveProfile(reg, env.CANDYBAR_PROFILE || reg.active);
}
