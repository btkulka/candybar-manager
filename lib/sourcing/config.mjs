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

/** Python interpreter that has pyrekordbox installed: a checkout's .venv-rbx
 *  (the one the rekordbox-* skills already use), else the one the packaged app
 *  builds in userData (src/lib/rbxPython.ts). Falls back to system python3. */
export const PYTHON = [path.join(REPO_ROOT, '.venv-rbx'), path.join(USER_DATA_DIR, '.venv-rbx')]
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
  const app = readJson(APP_CONFIG_PATH);
  const secrets = readJson(SECRETS_PATH);
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
    // Settings → SoundCloud: what a gate's comment box gets. Empty: gates that
    // insist on a comment are left for a person.
    gateComment: typeof app.gateComment === 'string' ? app.gateComment.trim() : '',
  };
}

/** Where a sourcing session's JSON + review page are written. */
export function sessionDir() {
  const dir = path.join(USER_DATA_DIR, 'sourcing-sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
