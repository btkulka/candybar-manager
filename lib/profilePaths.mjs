// Whose files? The sourcing engine's view of Track Lab profiles.
//
// Read-only twin of src/lib/profiles.ts (the app owns writes). A process the
// app starts gets its profile handed down in the environment:
//   CANDYBAR_PROFILES_ROOT  the original data folder, where profiles.json lives
//   CANDYBAR_PROFILE        the profile id
//   CANDYBAR_USER_DATA      that profile's data folder
//   CANDYBAR_CACHE_DIR      its browser sign-ins and session notes
// Anything else (the MCP server, a CLI run from a terminal) reads
// profiles.json for the profile the app is running. Everything here is
// worked out per call, so a long-lived process follows a profile switch.

import fs from 'fs';
import os from 'os';
import path from 'path';

export const MAIN_PROFILE_ID = 'main';

export function profilesRoot(env = process.env) {
  return env.CANDYBAR_PROFILES_ROOT || path.join(os.homedir(), 'Library', 'Application Support', 'candybar-manager');
}

function readRegistry(root) {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(root, 'profiles.json'), 'utf8')) || {};
    return reg;
  } catch {
    return {};
  }
}

function profileExists(reg, id) {
  return id === MAIN_PROFILE_ID || (Array.isArray(reg.profiles) && reg.profiles.some(p => p && p.id === id));
}

/** The profile id in use: handed down, else the one the app is running, else
 *  the default, else main. */
export function activeProfileId(env = process.env) {
  if (env.CANDYBAR_PROFILE) return env.CANDYBAR_PROFILE;
  const reg = readRegistry(profilesRoot(env));
  for (const id of [reg.active, reg.defaultId]) if (typeof id === 'string' && profileExists(reg, id)) return id;
  return MAIN_PROFILE_ID;
}

export function profileDir(id, env = process.env) {
  const root = profilesRoot(env);
  return id === MAIN_PROFILE_ID ? root : path.join(root, 'profiles', id);
}

/** The active profile's data folder (config.json, secrets.json, candybar.db,
 *  ledgers, sessions, history). */
export function userDataDir(env = process.env) {
  return env.CANDYBAR_USER_DATA || profileDir(activeProfileId(env), env);
}

/** The active profile's browser sign-ins and session notes. Main keeps
 *  ~/.cache/candybar-manager. */
export function cacheDir(env = process.env) {
  if (env.CANDYBAR_CACHE_DIR) return env.CANDYBAR_CACHE_DIR;
  const id = activeProfileId(env);
  return id === MAIN_PROFILE_ID
    ? path.join(os.homedir(), '.cache', 'candybar-manager')
    : path.join(profileDir(id, env), 'cache');
}
