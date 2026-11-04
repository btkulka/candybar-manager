import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { checkForUpdate, checkForRelease, isNewerVersion, oneClickBlocker, type UpdateStatus } from '../updateCheck';

let tmp: string;

function git(cwd: string, ...args: string[]) {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });
}

async function commit(cwd: string, file: string, msg: string) {
  await fs.writeFile(path.join(cwd, file), msg);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-m', msg);
}

describe('checkForUpdate', () => {
  let app: string;
  let upstream: string;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'update-check-test-'));
    const origin = path.join(tmp, 'origin.git');
    app = path.join(tmp, 'app');
    upstream = path.join(tmp, 'upstream');
    git(tmp, 'init', '--bare', '-b', 'main', origin);
    git(tmp, 'clone', origin, upstream);
    git(upstream, 'checkout', '-b', 'main');
    await commit(upstream, 'a.txt', 'first');
    git(upstream, 'push', 'origin', 'main');
    git(tmp, 'clone', origin, app);
  });

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('reports up to date when HEAD matches origin/main', async () => {
    const s = await checkForUpdate(app);
    expect(s).toMatchObject({ branch: 'main', behind: 0, ahead: 0, dirty: false });
  });

  it('reports incoming commits newest first', async () => {
    await commit(upstream, 'b.txt', 'second');
    await commit(upstream, 'c.txt', 'third');
    git(upstream, 'push', 'origin', 'main');
    const s = await checkForUpdate(app);
    expect(s?.behind).toBe(2);
    expect(s?.incoming).toEqual(['third', 'second']);
    expect(oneClickBlocker(s!)).toBeNull();
  });

  it('flags uncommitted changes', async () => {
    await fs.writeFile(path.join(app, 'a.txt'), 'edited');
    const s = await checkForUpdate(app);
    expect(s?.dirty).toBe(true);
    expect(oneClickBlocker(s!)).toMatch(/uncommitted/);
    git(app, 'checkout', '--', 'a.txt');
  });

  it('finds untracked local files that an incoming commit adds', async () => {
    await commit(upstream, 'collide.txt', 'adds collide.txt');
    git(upstream, 'push', 'origin', 'main');
    await fs.writeFile(path.join(app, 'collide.txt'), 'local, untracked');
    const s = await checkForUpdate(app);
    expect(s?.dirty).toBe(false); // untracked files don't count as dirty...
    expect(s?.untrackedCollisions).toEqual(['collide.txt']); // ...but this one would block the pull
    expect(oneClickBlocker(s!)).toMatch(/collide\.txt/);
    await fs.rm(path.join(app, 'collide.txt'));
  });

  it('returns null outside a git checkout', async () => {
    expect(await checkForUpdate(tmp)).toBeNull();
  });
});

describe('oneClickBlocker', () => {
  const base: UpdateStatus = { repoDir: '/x', branch: 'main', behind: 3, ahead: 0, dirty: false, untrackedCollisions: [], incoming: [] };

  it('blocks on another branch or local commits', () => {
    expect(oneClickBlocker({ ...base, branch: 'feature' })).toMatch(/feature/);
    expect(oneClickBlocker({ ...base, ahead: 1 })).toMatch(/1 local commit /);
  });

  it('explains a detached HEAD instead of calling it a branch named "HEAD"', () => {
    expect(oneClickBlocker({ ...base, branch: 'HEAD' })).toMatch(/detached HEAD/);
  });

  it('blocks when untracked files would be overwritten by the pull', () => {
    expect(oneClickBlocker({ ...base, untrackedCollisions: ['src/lib/new.ts'] })).toMatch(/src\/lib\/new\.ts/);
    expect(oneClickBlocker(base)).toBeNull();
  });
});

describe('isNewerVersion', () => {
  it('compares dotted versions numerically', () => {
    expect(isNewerVersion('v0.10.0', '0.9.3')).toBe(true);
    expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false);
    expect(isNewerVersion('v1.0', '1.0.1')).toBe(false);
    expect(isNewerVersion('1.0.0-beta.2', '0.9.9')).toBe(true);
  });
});

describe('checkForRelease', () => {
  const release = {
    tag_name: 'v0.2.0',
    html_url: 'https://github.com/btkulka/candybar-manager/releases/tag/v0.2.0',
    assets: [
      { name: 'Track-Lab-0.2.0-arm64.dmg', browser_download_url: 'https://example.test/arm64.dmg', size: 170 },
      { name: 'Track-Lab-0.2.0-arm64.dmg.blockmap', browser_download_url: 'https://example.test/arm64.blockmap', size: 1 },
      { name: 'Track-Lab-0.2.0-x64.dmg', browser_download_url: 'https://example.test/x64.dmg', size: 160 },
    ],
  };
  const answer = (status: number, body?: unknown) =>
    (async () => new Response(body === undefined ? null : JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("returns a newer release with this Mac's dmg", async () => {
    await expect(checkForRelease('0.1.0', 'x64', answer(200, release))).resolves.toEqual({
      version: '0.2.0',
      pageUrl: release.html_url,
      dmg: { name: 'Track-Lab-0.2.0-x64.dmg', url: 'https://example.test/x64.dmg', size: 160 },
    });
  });

  it('is up to date on the same version, a prerelease, or no releases at all', async () => {
    await expect(checkForRelease('0.2.0', 'arm64', answer(200, release))).resolves.toBeNull();
    await expect(checkForRelease('0.1.0', 'arm64', answer(200, { ...release, prerelease: true }))).resolves.toBeNull();
    await expect(checkForRelease('0.1.0', 'arm64', answer(404))).resolves.toBeNull();
  });

  it('throws rather than reporting "up to date" when GitHub fails', async () => {
    await expect(checkForRelease('0.1.0', 'arm64', answer(403, { message: 'rate limited' }))).rejects.toThrow(/403/);
  });
});
