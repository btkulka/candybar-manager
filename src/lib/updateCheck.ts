// ============================================================
// Startup update check.
//
// Two kinds of install, two answers to "is there a newer version":
//   - a git checkout (scripts/install.sh) asks git itself: fetch
//     origin and count the commits HEAD doesn't have, then
//     scripts/update.sh pulls and rebuilds.
//   - the packaged app (a .dmg from GitHub Releases) asks the
//     Releases API for the latest version and downloads its .dmg.
//
// Electron-free so it can be unit tested; main.ts owns the dialogs,
// the download and the hand-off to scripts/update.sh.
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
  /** Untracked local files that an incoming commit adds — `pull --ff-only` refuses these. */
  untrackedCollisions: string[];
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
    const [branch, behind, ahead, porcelain, incoming, addedUpstream, untracked] = await Promise.all([
      git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(repoDir, ['rev-list', '--count', `HEAD..${remote}`]),
      git(repoDir, ['rev-list', '--count', `${remote}..HEAD`]),
      git(repoDir, ['status', '--porcelain', '--untracked-files=no']),
      git(repoDir, ['log', '--format=%s', '-n', '8', `HEAD..${remote}`]),
      git(repoDir, ['diff', '--name-only', '--diff-filter=A', `HEAD...${remote}`]),
      git(repoDir, ['ls-files', '--others', '--exclude-standard']),
    ]);
    const untrackedSet = new Set(untracked ? untracked.split('\n') : []);
    const status: UpdateStatus = {
      repoDir,
      branch,
      behind: Number(behind) || 0,
      ahead: Number(ahead) || 0,
      dirty: porcelain.length > 0,
      untrackedCollisions: (addedUpstream ? addedUpstream.split('\n') : []).filter(f => untrackedSet.has(f)),
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
  // `rev-parse --abbrev-ref HEAD` prints "HEAD" when no branch is checked out.
  if (s.branch === 'HEAD') return `This checkout isn't on a branch (detached HEAD); check out ${UPDATE_BRANCH} first.`;
  if (s.branch !== UPDATE_BRANCH) return `You're on branch "${s.branch}", not ${UPDATE_BRANCH}.`;
  if (s.dirty) return 'This checkout has uncommitted changes.';
  if (s.untrackedCollisions?.length) {
    const shown = s.untrackedCollisions.slice(0, 3).join(', ');
    const more = s.untrackedCollisions.length > 3 ? ` and ${s.untrackedCollisions.length - 3} more` : '';
    return `Untracked local files would be overwritten by the update: ${shown}${more}.`;
  }
  if (s.ahead > 0) return `This checkout has ${s.ahead} local commit${s.ahead === 1 ? '' : 's'} not on GitHub.`;
  return null;
}

// ---------- Packaged app: GitHub Releases ----------

export const RELEASES_REPO = 'btkulka/candybar-manager';

export type ReleaseUpdate = {
  /** "0.2.0", without the tag's "v". */
  version: string;
  /** The release's page on GitHub. */
  pageUrl: string;
  /** This Mac's .dmg (Track-Lab-<version>-<arch>.dmg), or null if the release has none. */
  dmg: { name: string; url: string; size: number } | null;
};

function versionParts(v: string): number[] {
  return v.replace(/^v/, '').split(/[-+]/)[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
}

/** Whether `latest` is a higher dotted version than `current` ("v" and pre-release suffixes ignored). */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = versionParts(latest);
  const b = versionParts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

type GithubRelease = {
  tag_name: string;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: Array<{ name: string; browser_download_url: string; size: number }>;
};

/**
 * The latest GitHub Release if it's newer than `current`, else null (a repo
 * with no releases yet counts as up to date). Throws when GitHub can't be
 * reached, so a failed check isn't mistaken for "up to date". The repo is
 * public, so this needs no token; unauthenticated calls get 60 an hour.
 */
export async function checkForRelease(
  current: string,
  arch: string,
  fetchFn: typeof fetch = fetch,
): Promise<ReleaseUpdate | null> {
  const res = await fetchFn(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Track-Lab-update-check' },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText}`);
  const rel = (await res.json()) as GithubRelease;
  if (rel.draft || rel.prerelease || !isNewerVersion(rel.tag_name, current)) return null;
  const asset = rel.assets.find((a) => a.name.endsWith(`-${arch}.dmg`));
  log.info(`Release check: latest=${rel.tag_name} current=${current} dmg=${asset?.name ?? 'none'}`);
  return {
    version: rel.tag_name.replace(/^v/, ''),
    pageUrl: rel.html_url,
    dmg: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
  };
}
