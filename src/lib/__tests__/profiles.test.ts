import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import fs from 'fs';
import { pathToFileURL } from 'url';
import os from 'os';
import path from 'path';
import {
  readRegistry, writeRegistry, createProfile, renameProfile, setDefaultProfile, removeProfile, markActive,
  listProfiles, resolveProfile, findProfile, profileDir, profileCacheDir, activeUserDataDir, activeProfile,
  sharedSecretsFrom, MAIN_PROFILE_ID,
} from '../profiles';

// The sourcing engine's read-only twin (plain ESM) must agree on every path.
type Twin = {
  activeProfileId: (env?: NodeJS.ProcessEnv) => string;
  userDataDir: (env?: NodeJS.ProcessEnv) => string;
  cacheDir: (env?: NodeJS.ProcessEnv) => string;
};
let twin: Twin;
beforeAll(async () => {
  twin = await import(pathToFileURL(path.resolve(__dirname, '..', '..', '..', 'lib', 'profilePaths.mjs')).href) as Twin;
});

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-profiles-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('registry', () => {
  it('reads as just main when there is no profiles.json', () => {
    const reg = readRegistry(root);
    expect(reg.profiles.map(p => p.id)).toEqual([MAIN_PROFILE_ID]);
    expect(reg.defaultId).toBe(MAIN_PROFILE_ID);
    expect(reg.active).toBe(MAIN_PROFILE_ID);
  });

  it('survives a broken file and drops bad entries', () => {
    fs.writeFileSync(path.join(root, 'profiles.json'), '{not json');
    expect(readRegistry(root).profiles).toHaveLength(1);
    fs.writeFileSync(path.join(root, 'profiles.json'), JSON.stringify({
      defaultId: 'gone', active: 'gone',
      profiles: [{ id: '../escape', name: 'x' }, { id: 'ok-1a2b', name: '  Kay ' }, { id: 'ok-1a2b', name: 'dup' }, null],
    }));
    const reg = readRegistry(root);
    expect(reg.profiles.map(p => [p.id, p.name])).toEqual([[MAIN_PROFILE_ID, 'Main'], ['ok-1a2b', 'Kay']]);
    expect(reg.defaultId).toBe(MAIN_PROFILE_ID);
    expect(reg.active).toBe(MAIN_PROFILE_ID);
  });

  it('keeps main first and lets it be renamed', () => {
    createProfile(root, 'Kay');
    renameProfile(root, MAIN_PROFILE_ID, 'Ben');
    const reg = readRegistry(root);
    expect(reg.profiles[0]).toMatchObject({ id: MAIN_PROFILE_ID, name: 'Ben' });
    expect(profileDir(root, MAIN_PROFILE_ID)).toBe(root);
  });
});

describe('createProfile', () => {
  it('makes a folder that goes through setup with Rekordbox off and only shared secrets', () => {
    const p = createProfile(root, 'Kay', { sharedSecrets: { spotifyClientId: 'id', claudeOauthToken: 'tok' } });
    const dir = profileDir(root, p.id);
    expect(dir).toBe(path.join(root, 'profiles', p.id));
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))).toEqual({ setupCompleted: false, tutorialCompleted: false, rekordboxEnabled: false });
    const secretsFile = path.join(dir, 'secrets.json');
    expect(JSON.parse(fs.readFileSync(secretsFile, 'utf8'))).toEqual({ spotifyClientId: 'id', claudeOauthToken: 'tok' });
    expect(fs.statSync(secretsFile).mode & 0o777).toBe(0o600);
    expect(p.id).toMatch(/^kay-[0-9a-f]{4}$/);
  });

  it('the first profile stays the default until another is picked', () => {
    const p = createProfile(root, 'Kay');
    expect(readRegistry(root).defaultId).toBe(MAIN_PROFILE_ID);
    setDefaultProfile(root, p.id);
    expect(readRegistry(root).defaultId).toBe(p.id);
    expect(resolveProfile(readRegistry(root)).id).toBe(p.id);
  });

  it('refuses empty, too-long and duplicate names (case-insensitive)', () => {
    createProfile(root, 'Kay');
    expect(() => createProfile(root, '  ')).toThrow(/name/);
    expect(() => createProfile(root, 'x'.repeat(41))).toThrow(/characters/);
    expect(() => createProfile(root, 'kay')).toThrow(/already/);
    expect(() => createProfile(root, 'main')).toThrow(/already/);
  });
});

describe('sharedSecretsFrom', () => {
  it('copies only the app keys, never accounts or gate details', () => {
    const f = path.join(root, 'secrets.json');
    fs.writeFileSync(f, JSON.stringify({
      spotifyClientId: 'a', spotifyClientSecret: 'b', claudeOauthToken: 'c',
      gateEmail: 'me@example.com', qobuzAccounts: [{ id: 'q' }], beatportAccounts: [{ id: 'b' }],
    }));
    expect(sharedSecretsFrom(f)).toEqual({ spotifyClientId: 'a', spotifyClientSecret: 'b', claudeOauthToken: 'c' });
    expect(sharedSecretsFrom(path.join(root, 'missing.json'))).toEqual({});
  });
});

describe('removeProfile', () => {
  it('never removes main or the running profile; removing the default falls back to main', () => {
    const p = createProfile(root, 'Kay');
    expect(() => removeProfile(root, MAIN_PROFILE_ID, p.id)).toThrow(/original/);
    expect(() => removeProfile(root, p.id, p.id)).toThrow(/running/);
    setDefaultProfile(root, p.id);
    const { dir } = removeProfile(root, p.id, MAIN_PROFILE_ID);
    expect(dir).toBe(path.join(root, 'profiles', p.id));
    const reg = readRegistry(root);
    expect(reg.profiles).toHaveLength(1);
    expect(reg.defaultId).toBe(MAIN_PROFILE_ID);
  });
});

describe('finding and listing', () => {
  it('finds by id or by name, ignoring case', () => {
    const p = createProfile(root, 'Kay');
    const reg = readRegistry(root);
    expect(findProfile(reg, p.id)?.id).toBe(p.id);
    expect(findProfile(reg, 'KAY')?.id).toBe(p.id);
    expect(findProfile(reg, 'nobody')).toBeUndefined();
    expect(resolveProfile(reg, 'nobody').id).toBe(MAIN_PROFILE_ID);
  });

  it('marks running and default', () => {
    const p = createProfile(root, 'Kay');
    setDefaultProfile(root, p.id);
    const views = listProfiles(root, MAIN_PROFILE_ID);
    expect(views.find(v => v.isMain)).toMatchObject({ isRunning: true, isDefault: false, dir: root });
    expect(views.find(v => v.id === p.id)).toMatchObject({ isRunning: false, isDefault: true });
  });
});

describe('whose files a process outside the app uses', () => {
  it('follows what the app hands down, else the profile the app is running', () => {
    const p = createProfile(root, 'Kay');
    const env = { CANDYBAR_PROFILES_ROOT: root } as NodeJS.ProcessEnv;
    expect(activeUserDataDir(env)).toBe(root);
    markActive(root, p.id);
    expect(activeUserDataDir(env)).toBe(path.join(root, 'profiles', p.id));
    expect(activeProfile(env).id).toBe(p.id);
    expect(activeUserDataDir({ ...env, CANDYBAR_USER_DATA: '/handed/down' })).toBe('/handed/down');
  });

  it('the plain-ESM twin agrees on data and cache folders', () => {
    const p = createProfile(root, 'Kay');
    const env = { CANDYBAR_PROFILES_ROOT: root } as NodeJS.ProcessEnv;
    for (const active of [MAIN_PROFILE_ID, p.id]) {
      markActive(root, active);
      expect(twin.activeProfileId(env)).toBe(active);
      expect(twin.userDataDir(env)).toBe(activeUserDataDir(env));
      expect(twin.cacheDir(env)).toBe(profileCacheDir(root, active));
    }
    expect(profileCacheDir(root, MAIN_PROFILE_ID)).toBe(path.join(os.homedir(), '.cache', 'candybar-manager'));
    expect(profileCacheDir(root, p.id)).toBe(path.join(root, 'profiles', p.id, 'cache'));
    // A profile the registry no longer lists falls back to the default.
    writeRegistry(root, { ...readRegistry(root), active: 'deleted-0000' });
    expect(twin.activeProfileId(env)).toBe(MAIN_PROFILE_ID);
  });
});
