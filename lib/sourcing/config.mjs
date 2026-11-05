// Shared config/paths for the playlist-sourcing engine.
//
// Reads the same files the Electron app uses, so the skill and the app can
// never disagree about where the library lives or which Spotify app to use.
// The files are the active Track Lab profile's (lib/profilePaths.mjs):
//   - app config:  <profile data folder>/config.json
//   - secrets:     <profile data folder>/secrets.json, falling back to
//                  <repo>/secrets.json for main until the app has migrated it
// Main's data folder is ~/Library/Application Support/candybar-manager; other
// profiles live under its profiles/<id>/. Paths are worked out per call, so the
// long-lived MCP server follows a profile switch.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { userDataDir, profilesRoot, activeProfileId, MAIN_PROFILE_ID } from '../profilePaths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

/** The active profile's data folder. */
export function userDataPath() {
  return userDataDir();
}
export function appConfigPath() {
  return path.join(userDataDir(), 'config.json');
}
export function candybarDbPath() {
  return path.join(userDataDir(), 'candybar.db');
}
// The app moved secrets.json into userData; the repo copy is only main's
// pre-migration location.
export function secretsPath() {
  const own = path.join(userDataDir(), 'secrets.json');
  if (fs.existsSync(own) || activeProfileId() !== MAIN_PROFILE_ID) return own;
  return path.join(REPO_ROOT, 'secrets.json');
}

// Snapshots for callers that read them once at start-up (short CLI runs).
// Long-lived code calls the functions above.
export const USER_DATA_DIR = userDataPath();
export const APP_CONFIG_PATH = appConfigPath();
export const CANDYBAR_DB_PATH = candybarDbPath();
export const SECRETS_PATH = secretsPath();
export const REKORDBOX_DB_DIR = path.join(os.homedir(), 'Library', 'Pioneer', 'rekordbox');

/** Python interpreter that has pyrekordbox installed: a checkout's .venv-rbx
 *  (the one the rekordbox-* skills already use), else the one the packaged app
 *  builds in its original data folder (src/lib/rbxPython.ts; shared by every
 *  profile). Falls back to system python3. */
export const PYTHON = [path.join(REPO_ROOT, '.venv-rbx'), path.join(profilesRoot(), '.venv-rbx')]
  .map((venv) => path.join(venv, 'bin', 'python'))
  .find((python) => fs.existsSync(python)) ?? 'python3';

function readJson(p, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

export function loadConfig() {
  const app = readJson(appConfigPath());
  const secrets = readJson(secretsPath());
  return {
    libraryRoot: app.libraryRoot || path.join(os.homedir(), 'Music'),
    organizeSourceDir: app.organizeSourceDir || '',
    spotifyClientId: secrets.spotifyClientId || app.spotifyClientId || '',
    spotifyClientSecret: secrets.spotifyClientSecret || app.spotifyClientSecret || '',
    // Saved in Settings → SoundCloud; every SoundCloud run hands it to gates that ask.
    gateEmail: secrets.gateEmail || '',
    // The name gates get when they ask (setup guide → Your details).
    gateFirstName: secrets.gateFirstName || '',
    gateLastName: secrets.gateLastName || '',
    // …and the address, for gates that ask (Bandcamp's ZIP, a country box).
    gateAddress: {
      line1: secrets.gateAddressLine1 || '', city: secrets.gateCity || '', region: secrets.gateRegion || '',
      postcode: secrets.gatePostcode || '', country: secrets.gateCountry || '',
    },
    // …and the phone number, for gates with a phone or mobile box.
    gatePhone: secrets.gatePhone || '',
    // Settings → SoundCloud: what a gate's comment box gets. Empty: gates that
    // insist on a comment are left for a person.
    gateComment: typeof app.gateComment === 'string' ? app.gateComment.trim() : '',
    // Settings → Rekordbox. Off: this profile has no Rekordbox collection, so
    // ownership comes from Track Lab's own library scan only (the collection on
    // this Mac belongs to whoever set it up).
    rekordboxEnabled: app.rekordboxEnabled !== false,
  };
}

/** Where a sourcing session's JSON + review page are written. */
export function sessionDir() {
  const dir = path.join(userDataDir(), 'sourcing-sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
