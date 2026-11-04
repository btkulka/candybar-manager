/**
 * The Python the Rekordbox scripts run on (pyrekordbox + mutagen, from
 * requirements-rbx.txt). A checkout has .venv-rbx beside the code, made by
 * scripts/install.sh. The packaged app can't write inside itself, so it builds
 * the same thing in Application Support on launch (ensureSharedVenv).
 * lib/sourcing/config.mjs looks in the same two places.
 */

import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { createScopedLogger } from './logger';

const log = createScopedLogger('RbxPython');
const execFileAsync = promisify(execFile);

/** Fixed rather than app.getPath('userData'), so the CLI scripts find it too. */
export const SHARED_VENV = path.join(os.homedir(), 'Library', 'Application Support', 'candybar-manager', '.venv-rbx');

/** Shown when a Rekordbox feature runs without its Python environment. */
export const RBX_PYTHON_MISSING =
  'Track Lab sets up its Rekordbox helper when it opens, which takes a minute the first time and needs '
  + "Apple's Command Line Tools. If it still isn't working, run `xcode-select --install` in Terminal, then reopen Track Lab.";

export function rbxPython(appRoot: string): string {
  for (const venv of [path.join(appRoot, '.venv-rbx'), SHARED_VENV]) {
    const python = path.join(venv, 'bin', 'python');
    if (fs.existsSync(python)) return python;
  }
  return 'python3';
}

/**
 * Create or refresh SHARED_VENV from requirements-rbx.txt, mirroring
 * candybar_python_env in scripts/_common.sh. Only reaches the network when the
 * requirements change. Without the Command Line Tools this stops instead of
 * calling /usr/bin/python3, which would pop up Apple's installer unasked.
 */
export async function ensureSharedVenv(appRoot: string): Promise<void> {
  const requirements = path.join(appRoot, 'requirements-rbx.txt');
  if (!fs.existsSync(requirements)) return;
  const stamp = path.join(SHARED_VENV, '.requirements-sha');
  const python = path.join(SHARED_VENV, 'bin', 'python');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(requirements)).digest('hex');
  const works = await execFileAsync(python, ['-c', 'import pyrekordbox, mutagen']).then(() => true, () => false);
  if (works && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === sha) return;

  try {
    await execFileAsync('xcode-select', ['-p']);
  } catch {
    log.warn("Command Line Tools aren't installed, so the Rekordbox helper can't be set up");
    return;
  }
  const pip = (args: string[]) =>
    execFileAsync(python, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', ...args], { timeout: 15 * 60_000 });
  try {
    if (!(await execFileAsync(python, ['-c', 'import sys']).then(() => true, () => false))) {
      log.info(`Creating the Rekordbox helper's Python environment in ${SHARED_VENV}`);
      fs.mkdirSync(path.dirname(SHARED_VENV), { recursive: true });
      await execFileAsync('/usr/bin/python3', ['-m', 'venv', '--clear', SHARED_VENV], { timeout: 5 * 60_000 });
      await pip(['--upgrade', 'pip']);
    }
    log.info('Installing pyrekordbox into the Rekordbox helper');
    await pip(['-r', requirements]);
    await execFileAsync(python, ['-c', 'import pyrekordbox, mutagen']);
    fs.writeFileSync(stamp, sha);
    log.info('Rekordbox helper ready');
  } catch (err) {
    log.warn('Setting up the Rekordbox helper failed:', err);
  }
}
