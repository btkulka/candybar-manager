import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createIpcRegistry } from '../ipcOps';
import { initOpLog, resetOpLog, flushOpLog } from '../opLog';
import { listOps } from '../logQuery';

let userData: string;
let opsDir: string;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ipcops-'));
  opsDir = initOpLog(userData, { proc: 'app' });
});

afterEach(() => {
  resetOpLog();
  fs.rmSync(userData, { recursive: true, force: true });
});

function fakeIpc() {
  const listeners = new Map<string, (event: any, ...args: unknown[]) => unknown>();
  return { listeners, handle: (channel: string, fn: (event: any, ...args: unknown[]) => unknown) => { listeners.set(channel, fn); } };
}

describe('IPC registry', () => {
  it('records a window call as a ui operation', async () => {
    const ipc = fakeIpc();
    const reg = createIpcRegistry(ipc);
    reg.handle('convert-track', async (_event, { filePath }: { filePath: string }) => ({ success: true, outputPath: `${filePath}.aif` }));
    const result = await ipc.listeners.get('convert-track')!({}, { filePath: '/a.mp3' });
    expect(result).toEqual({ success: true, outputPath: '/a.mp3.aif' });
    await flushOpLog();
    expect(listOps(opsDir)[0]).toMatchObject({ name: 'convert-track', source: 'ui', status: 'ok', args: { filePath: '/a.mp3' } });
  });

  it('runs the same handler for Claude with a sender that forwards to progress', async () => {
    const reg = createIpcRegistry(fakeIpc());
    reg.handle('scan-tracks', async (event, { sourceDir }: { sourceDir: string }) => {
      event.sender.send('scan-progress', { current: 1, total: 2 });
      return [{ filePath: `${sourceDir}/x.aif` }];
    });
    const sent: Array<[string, unknown]> = [];
    const result = await reg.invoke('scan-tracks', [{ sourceDir: '/in' }], {
      send: (ch, p) => sent.push([ch, p]), source: 'claude', parent: 'mcp-abc-1', meta: { tool: 'scan_intake' },
    });
    expect(result).toEqual([{ filePath: '/in/x.aif' }]);
    expect(sent).toEqual([['scan-progress', { current: 1, total: 2 }]]);
    await flushOpLog();
    expect(listOps(opsDir)[0]).toMatchObject({ name: 'scan-tracks', source: 'claude', parent: 'mcp-abc-1' });
  });

  it('refuses unknown channels and double registration', async () => {
    const reg = createIpcRegistry(fakeIpc());
    reg.handle('a', () => 1);
    expect(() => reg.handle('a', () => 2)).toThrow(/twice/);
    await expect(reg.invoke('nope', [], { send: () => {}, source: 'claude' })).rejects.toThrow(/no action "nope"/);
    expect(reg.channels()).toEqual(['a']);
  });

  it('keeps quiet channels out of the log unless they fail', async () => {
    const ipc = fakeIpc();
    const reg = createIpcRegistry(ipc, { quiet: new Set(['get-track-album-art']) });
    reg.handle('get-track-album-art', async () => null);
    await ipc.listeners.get('get-track-album-art')!({}, { filePath: '/a' });
    await flushOpLog();
    expect(listOps(opsDir)).toEqual([]);
  });
});
