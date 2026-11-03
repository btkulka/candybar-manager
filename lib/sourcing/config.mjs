// Shared config/paths for the playlist-sourcing engine.
//
// Reads the same files the Electron app uses, so the skill and the app can
// never disagree about where the library lives or which Spotify app to use:
//   - app config:  ~/Library/Application Support/candybar-manager/config.json
//   - secrets:     ~/Library/Application Support/candybar-manager/secrets.json,
//                  falling back to <repo>/secrets.json until the app has migrated it

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

export const USER_DATA_DIR = path.join(
  os.homedir(), 'Library', 'Application Support', 'candybar-manager'
);
export const APP_CONFIG_PATH = path.join(USER_DATA_DIR, 'config.json');
export const CANDYBAR_DB_PATH = path.join(USER_DATA_DIR, 'candybar.db');
// The app moved secrets.json into userData; the repo copy is only the
// pre-migration location.
export const SECRETS_PATH = fs.existsSync(path.join(USER_DATA_DIR, 'secrets.json'))
  ? path.join(USER_DATA_DIR, 'secrets.json')
  : path.join(REPO_ROOT, 'secrets.json');
export const REKORDBOX_DB_DIR = path.join(os.homedir(), 'Library', 'Pioneer', 'rekordbox');

/** Python interpreter that has pyrekordbox installed (the .venv-rbx the
 *  rekordbox-* skills already use). Falls back to system python3. */
export const PYTHON = fs.existsSync(path.join(REPO_ROOT, '.venv-rbx', 'bin', 'python'))
  ? path.join(REPO_ROOT, '.venv-rbx', 'bin', 'python')
  : 'python3';

function readJson(p, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

export function loadConfig() {
  const app = readJson(APP_CONFIG_PATH);
  const secrets = readJson(SECRETS_PATH);
  return {
    libraryRoot: app.libraryRoot || path.join(os.homedir(), 'Music'),
    organizeSourceDir: app.organizeSourceDir || '',
    spotifyClientId: secrets.spotifyClientId || app.spotifyClientId || '',
    spotifyClientSecret: secrets.spotifyClientSecret || app.spotifyClientSecret || '',
  };
}

/** Where a sourcing session's JSON + review page are written. */
export function sessionDir() {
  const dir = path.join(USER_DATA_DIR, 'sourcing-sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
