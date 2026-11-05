// ============================================================
// Which profile Track Lab is in. main.ts imports this first, so the profile is
// known before anything reads the data folder.
//
// - The app's own Chromium data folder never moves: app.getPath('userData')
//   stays the profiles root (main's folder). The single-instance lock is taken
//   there, so one Track Lab runs at a time whichever profile it's in. A
//   scratch run with --user-data-dir has its own root, lock and profiles.
// - The profile's files (config, secrets, candybar.db, logs, ledgers) live in
//   dataDir(), and its window gets a browser session stored in that folder
//   (main.ts profileSession). Switching swaps both in place, no restart.
// - It opens in `--profile=<id>` when given, otherwise the default profile.
// - Child processes (the sourcing CLI, Python readers, Claude jobs and the MCP
//   server they start) get the current profile in their environment.
// ============================================================

import { app } from 'electron';
import fs from 'fs';
import {
  readRegistry, resolveProfile, profileDir, profileCacheDir, markActive,
  MAIN_PROFILE_ID, MAIN_PROFILE_NAME, type Profile,
} from './profiles';

/** The original data folder: profiles.json, the store-bridge socket, main's
 *  data and the app's Chromium storage. */
export const PROFILES_ROOT = app.getPath('userData');

const isTest = process.env.NODE_ENV === 'test';

/** False when another Track Lab already runs on this root (main.ts exits). */
export const GOT_SINGLE_INSTANCE_LOCK = isTest ? true : app.requestSingleInstanceLock();

function bootProfile(): Profile {
  // e2e tests share the real data folder and never switch profiles.
  if (isTest || !GOT_SINGLE_INSTANCE_LOCK) return { id: MAIN_PROFILE_ID, name: MAIN_PROFILE_NAME };
  return resolveProfile(readRegistry(PROFILES_ROOT), app.commandLine.getSwitchValue('profile') || null);
}

let current: Profile = bootProfile();

/** The profile Track Lab is in now. */
export function currentProfile(): Profile {
  return current;
}

/** The current profile's data folder. */
export function dataDir(): string {
  return profileDir(PROFILES_ROOT, current.id);
}

function announce(): void {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  process.env.CANDYBAR_PROFILES_ROOT = PROFILES_ROOT;
  process.env.CANDYBAR_PROFILE = current.id;
  process.env.CANDYBAR_USER_DATA = dir;
  process.env.CANDYBAR_CACHE_DIR = profileCacheDir(PROFILES_ROOT, current.id);
  if (!isTest && GOT_SINGLE_INSTANCE_LOCK) markActive(PROFILES_ROOT, current.id);
}

/** Make `profile` the current one: its folder, the environment children get,
 *  and profiles.json's `active`. The caller reopens the profile's files. */
export function setCurrentProfile(profile: Profile): void {
  current = profile;
  announce();
}

announce();
