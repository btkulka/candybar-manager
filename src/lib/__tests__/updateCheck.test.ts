import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { checkForUpdate, oneClickBlocker, type UpdateStatus } from '../updateCheck';

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
