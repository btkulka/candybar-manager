import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { readConfig, writeConfig, setSecretsPath, getConfigWarnings, DEFAULT_LIBRARY_ROOT } from '../config';

let tmp: string;
let configPath: string;

describe('config tutorialCompleted', () => {
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'config-test-'));
    configPath = path.join(tmp, 'config.json');
    setSecretsPath(path.join(tmp, 'secrets.json'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('is false on a first launch, with no config on disk', async () => {
    const config = await readConfig(configPath);
    expect(config.tutorialCompleted).toBe(false);
  });

  it('stays false through config writes made before the tour finishes', async () => {
    const config = await readConfig(configPath);
    await writeConfig(configPath, { ...config, activeTab: 'source' });
    expect((await readConfig(configPath)).tutorialCompleted).toBe(false);
  });

  it('is true for a config file written before the tour existed', async () => {
    await fs.writeFile(configPath, JSON.stringify({ activeTab: 'library' }));
    expect((await readConfig(configPath)).tutorialCompleted).toBe(true);
  });

  it('persists completion', async () => {
    const config = await readConfig(configPath);
    await writeConfig(configPath, { ...config, tutorialCompleted: true });
    expect((await readConfig(configPath)).tutorialCompleted).toBe(true);
  });
});

describe('config secrets and recovery', () => {
  let secretsPath: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'config-test-'));
    configPath = path.join(tmp, 'config.json');
    secretsPath = path.join(tmp, 'secrets.json');
    setSecretsPath(secretsPath);
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('clearing the last store account and a client secret persists', async () => {
    let c = await readConfig(configPath);
    c.qobuzAccounts = [{ id: 'a1', email: 'x@y', label: 'A' }];
    c.spotifyClientSecret = 'sek';
    await writeConfig(configPath, c);
    c = await readConfig(configPath);
    expect(c.qobuzAccounts).toHaveLength(1);
    expect(c.spotifyClientSecret).toBe('sek');

    c.qobuzAccounts = [];
    c.spotifyClientSecret = '';
    await writeConfig(configPath, c);
    c = await readConfig(configPath);
    expect(c.qobuzAccounts).toEqual([]);
    expect(c.spotifyClientSecret).toBe('');
    // Secrets never land in the shareable config file.
    const primary = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(primary).not.toHaveProperty('spotifyClientSecret');
    expect(primary).not.toHaveProperty('qobuzAccounts');
  });

  it("a write that doesn't carry a secret field leaves the stored one alone", async () => {
    const c = await readConfig(configPath);
    await writeConfig(configPath, { ...c, spotifyClientSecret: 'keep-me' });
    const { spotifyClientSecret: _drop, ...withoutSecret } = await readConfig(configPath);
    await writeConfig(configPath, withoutSecret as typeof c);
    expect((await readConfig(configPath)).spotifyClientSecret).toBe('keep-me');
  });

  it('a corrupt config.json is backed up and warned about, not treated as a first launch', async () => {
    const corrupt = '{"libraryRoot": "/x", "tutorialCompleted": tr';
    await fs.writeFile(configPath, corrupt);
    const c = await readConfig(configPath);
    expect(c.tutorialCompleted).toBe(true); // existing user: don't restart the tour
    const backups = (await fs.readdir(tmp)).filter(n => n.startsWith('config.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(await fs.readFile(path.join(tmp, backups[0]), 'utf8')).toBe(corrupt);
    expect(getConfigWarnings().some(w => w.includes(backups[0]))).toBe(true);
    // Repeated reads of the same corrupt file don't pile up more copies.
    await readConfig(configPath);
    expect((await fs.readdir(tmp)).filter(n => n.startsWith('config.json.corrupt-'))).toHaveLength(1);
  });

  it("defaults the library root to the user's Music folder, never someone's drive", () => {
    expect(DEFAULT_LIBRARY_ROOT).toBe(path.join(os.homedir(), 'Music'));
    expect(DEFAULT_LIBRARY_ROOT).not.toContain('/Volumes/');
  });

  it('an existing config keeps its explicit library root', async () => {
    await fs.writeFile(configPath, JSON.stringify({ libraryRoot: '/Volumes/Some Drive/Music' }));
    expect((await readConfig(configPath)).libraryRoot).toBe('/Volumes/Some Drive/Music');
  });
});
