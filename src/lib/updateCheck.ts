// ============================================================
// Startup update check.
//
// The app runs from a git checkout of a private repo, so "is there
// a newer version" is answered with git itself (`git fetch` uses
// the credentials the checkout was cloned with) rather than the
// GitHub API, which would need a token.
//
// Electron-free so it can be unit tested; main.ts owns the dialog
// and hands the actual update off to scripts/update.sh.
// ============================================================

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createScopedLogger } from './logger';

const log = createScopedLogger('UpdateCheck');

export const UPDATE_BRANCH = 'main';

export type UpdateStatus = {
  repoDir: string;
  branch: string;
  /** Commits on origin/main that HEAD doesn't have. */
  behind: number;
  /** Local commits not on origin/main (someone developing here). */
  ahead: number;
  /** Tracked files modified — a one-click pull could conflict. */
  dirty: boolean;
  /** Subjects of the incoming commits, newest first (capped). */
  incoming: string[];
};

function git(repoDir: string, args: string[], timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      // Never let a credential prompt hang the check.
      { cwd: repoDir, timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
    );
  });
}

/**
 * Fetch origin and compare HEAD to origin/main. Returns null when the app
 * isn't running from a git checkout or the fetch fails (offline, no access) —
 * the check is advisory and must never block startup.
 */
export async function checkForUpdate(repoDir: string): Promise<UpdateStatus | null> {
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    log.info(`Not a git checkout, skipping update check: ${repoDir}`);
    return null;
  }
  try {
    await git(repoDir, ['fetch', '--quiet', 'origin', UPDATE_BRANCH]);
    const remote = `origin/${UPDATE_BRANCH}`;
    const [branch, behind, ahead, porcelain, incoming] = await Promise.all([
      git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(repoDir, ['rev-list', '--count', `HEAD..${remote}`]),
      git(repoDir, ['rev-list', '--count', `${remote}..HEAD`]),
      git(repoDir, ['status', '--porcelain', '--untracked-files=no']),
      git(repoDir, ['log', '--format=%s', '-n', '8', `HEAD..${remote}`]),
    ]);
    const status: UpdateStatus = {
      repoDir,
      branch,
      behind: Number(behind) || 0,
      ahead: Number(ahead) || 0,
      dirty: porcelain.length > 0,
      incoming: incoming ? incoming.split('\n') : [],
    };
    log.info(`Update check: branch=${branch} behind=${status.behind} ahead=${status.ahead} dirty=${status.dirty}`);
    return status;
  } catch (err) {
    log.warn('Update check failed (offline or no repo access?):', err);
    return null;
  }
}

/**
 * Why a one-click update isn't safe here, or null when it is. scripts/update.sh
 * does a fast-forward-only pull, so local edits, local commits or another
 * branch mean the user should pull by hand.
 */
export function oneClickBlocker(s: UpdateStatus): string | null {
  if (s.branch !== UPDATE_BRANCH) return `You're on branch "${s.branch}", not ${UPDATE_BRANCH}.`;
  if (s.dirty) return 'This checkout has uncommitted changes.';
  if (s.ahead > 0) return `This checkout has ${s.ahead} local commit${s.ahead === 1 ? '' : 's'} not on GitHub.`;
  return null;
}
