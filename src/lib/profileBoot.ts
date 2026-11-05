// ============================================================
// Which profile this run of Track Lab is: decided before anything else in
// the main process touches the data folder. main.ts imports this first.
//
// - The single-instance lock is taken on the original data folder (the
//   profiles root) BEFORE userData moves into a profile, so one Track Lab
//   runs at a time whichever profile it's in. A scratch run with
//   --user-data-dir has its own root, and so its own lock and profiles.
// - The profile is `--profile=<id>` when given (a switch relaunches with it),
//   otherwise the default profile.
// - Child processes (the sourcing CLI, Python readers, Claude jobs and the MCP
//   server they start) get the profile in their environment, so they read
//   and write this profile's files and nobody else's.
// ============================================================

import { app } from 'electron';
import fs from 'fs';
import {
  readRegistry, resolveProfile, profileDir, profileCacheDir, markActive,
  MAIN_PROFILE_ID, MAIN_PROFILE_NAME, type Profile,
} from './profiles';

/** The original data folder: profiles.json, the store-bridge socket and
 *  main's data. */
export const PROFILES_ROOT = app.getPath('userData');

const isTest = process.env.NODE_ENV === 'test';

/** False when another Track Lab already runs on this root (main.ts exits). */
export const GOT_SINGLE_INSTANCE_LOCK = isTest ? true : app.requestSingleInstanceLock();

function bootProfile(): Profile {
  // e2e tests share the real data folder and never switch profiles.
  if (isTest || !GOT_SINGLE_INSTANCE_LOCK) return { id: MAIN_PROFILE_ID, name: MAIN_PROFILE_NAME };
  const reg = readRegistry(PROFILES_ROOT);
  const asked = app.commandLine.getSwitchValue('profile') || null;
  const profile = resolveProfile(reg, asked);
  const dir = profileDir(PROFILES_ROOT, profile.id);
  if (dir !== PROFILES_ROOT) {
    fs.mkdirSync(dir, { recursive: true });
    app.setPath('userData', dir);
  }
  markActive(PROFILES_ROOT, profile.id);
  return profile;
}

/** The profile this run is in. */
export const RUNNING_PROFILE: Profile = bootProfile();

process.env.CANDYBAR_PROFILES_ROOT = PROFILES_ROOT;
process.env.CANDYBAR_PROFILE = RUNNING_PROFILE.id;
process.env.CANDYBAR_USER_DATA = app.getPath('userData');
process.env.CANDYBAR_CACHE_DIR = profileCacheDir(PROFILES_ROOT, RUNNING_PROFILE.id);
