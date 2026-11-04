// The store bridge end to end: the app's server (src/lib/storeBridge.ts) and
// the client the MCP server and cart.mjs use (lib/storeBridge.mjs), over a
// real socket in a temp dir.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { startStoreBridge } from '../../src/lib/storeBridge.ts';
import { callApp } from '../storeBridge.mjs';

let dir, sock, stop;

beforeEach(() => {
  // macOS caps socket paths at 104 bytes; its temp dir leaves plenty of room.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-'));
  sock = path.join(dir, 'b.sock');
  process.env.CANDYBAR_STORE_BRIDGE = sock;
});

afterEach(async () => {
  await stop?.();
  stop = null;
  delete process.env.CANDYBAR_STORE_BRIDGE;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('store bridge', () => {
  it('answers a request, passing progress along on the way', async () => {
    stop = await startStoreBridge(sock, {
      cartAdd: async (params, progress) => {
        progress('Adding: one');
        progress('Adding: two');
        return { added: params.matches.length, store: params.store };
      },
    });
    const seen = [];
    const result = await callApp('cartAdd', { store: 'qobuz', matches: [{}, {}] }, { onProgress: m => seen.push(m), launch: false });
    expect(result).toEqual({ added: 2, store: 'qobuz' });
    expect(seen).toEqual(['Adding: one', 'Adding: two']);
  });

  it('keeps the socket to this user', async () => {
    stop = await startStoreBridge(sock, {});
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
  });

  it('turns a handler failure and an unknown method into errors', async () => {
    stop = await startStoreBridge(sock, {
      purchases: async () => { throw new Error('Not signed in to Beatport'); },
    });
    await expect(callApp('purchases', { store: 'beatport' }, { launch: false })).rejects.toThrow('Not signed in to Beatport');
    await expect(callApp('deleteEverything', {}, { launch: false })).rejects.toThrow('Unknown method: deleteEverything');
  });

  it('says the app is closed instead of starting it when asked not to', async () => {
    await expect(callApp('status', {}, { launch: false })).rejects.toThrow(/isn't running/);
  });

  it('replaces a socket left by a run that crashed', async () => {
    // A process that exits without closing its server leaves the file behind,
    // with nothing answering on it.
    spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(sock)}, () => process.exit(0))`]);
    expect(fs.lstatSync(sock).isSocket()).toBe(true);
    stop = await startStoreBridge(sock, { status: async () => 'ok' });
    expect(await callApp('status', {}, { launch: false })).toBe('ok');
  });

  it('never takes over a live socket or deletes a file that isn\'t one', async () => {
    stop = await startStoreBridge(sock, {});
    await expect(startStoreBridge(sock, {})).rejects.toThrow(/already answering/);

    const plain = path.join(dir, 'plain');
    fs.writeFileSync(plain, 'not a socket');
    await expect(startStoreBridge(plain, {})).rejects.toThrow(/isn't a socket/);
    expect(fs.readFileSync(plain, 'utf8')).toBe('not a socket');
  });
});
