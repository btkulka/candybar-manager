// The web app (a Benhäus tab, the phone): a page's calls reach the same
// handlers the window's do, what they send comes back to the page, and the
// audio preview route answers only the page itself.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { WebHost } from '@btkulka/electron-kit/main';
import { startWebHost, stopWebHost, pushToWeb } from '../webHost';
import type { InvokeContext } from '../ipcOps';

let dir: string;
let host: WebHost;
const calls: Array<{ channel: string; args: unknown[]; source: string }> = [];
const heard: unknown[][] = [];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhost-'));
  fs.mkdirSync(path.join(dir, 'renderer'));
  fs.mkdirSync(path.join(dir, 'preload'));
  fs.writeFileSync(path.join(dir, 'renderer', 'index.html'), '<html><head></head><body>app</body></html>');
  fs.writeFileSync(path.join(dir, 'renderer', 'mobile.html'), '<html><head></head><body>phone</body></html>');
  fs.writeFileSync(path.join(dir, 'preload', 'preload.js'), 'require("electron");');
  const started = await startWebHost({
    port: 0,
    rendererDir: path.join(dir, 'renderer'),
    preloadFile: path.join(dir, 'preload', 'preload.js'),
    version: '0.0.0',
    ipc: {
      invoke: async (channel: string, args: unknown[], ctx: InvokeContext) => {
        calls.push({ channel, args, source: ctx.source });
        ctx.send('progress', { step: 1 });
        return { ok: args[0] };
      },
      has: (channel: string) => channel === 'echo',
      channels: () => ['echo'],
    },
    listeners: (channel: string) => (channel === 'renderer:ready' ? [(...a: unknown[]) => void heard.push(a)] : []),
    media: async (filePath: string) => new Response(`audio:${filePath}`, { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
  });
  if (!started) throw new Error('web host did not start');
  host = started;
});

afterAll(async () => {
  await stopWebHost();
  fs.rmSync(dir, { recursive: true, force: true });
});

const ipc = (route: string, channel: string, args: unknown[]) =>
  fetch(`${host.url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kit-ipc': '1' }, body: JSON.stringify({ channel, args }) })
    .then((r) => r.json());

describe('web host', () => {
  it('serves the page and the phone page with the web preload', async () => {
    for (const page of ['/', '/mobile.html']) {
      const html = await (await fetch(`${host.url}${page}`)).text();
      expect(html).toContain('<script src="/__kit/preload.js"></script>');
    }
  });

  it('runs a page call through the handlers as a web operation', async () => {
    const res = await ipc('/__kit/invoke', 'echo', ['hi']);
    expect(res).toEqual({ ok: true, result: { ok: 'hi' } });
    expect(calls.at(-1)).toEqual({ channel: 'echo', args: ['hi'], source: 'web' });
  });

  it('sends a page\'s send to main\'s listeners', async () => {
    const res = await ipc('/__kit/send', 'renderer:ready', []);
    expect(res).toEqual({ ok: true, heard: 1 });
    expect(heard).toHaveLength(1);
  });

  it('pushes what a handler and the app send to the pages', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${host.url}/__kit/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const text: string[] = [];
    const read = (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text.push(dec.decode(value));
        if (text.join('').includes('"update-state"')) break;
      }
    })();
    await new Promise((r) => setTimeout(r, 50));
    await ipc('/__kit/invoke', 'echo', ['x']);
    pushToWeb('update-state', { available: false });
    await read;
    ctrl.abort();
    const all = text.join('');
    expect(all).toContain('"channel":"progress"');
    expect(all).toContain('"channel":"update-state"');
  });

  it('serves audio previews to the page, not to other sites', async () => {
    const ok = await fetch(`${host.url}/media/Volumes/Candy%20Bar/a%20b.mp3`, { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('audio:/Volumes/Candy Bar/a b.mp3');
    const cross = await fetch(`${host.url}/media/Volumes/x.mp3`, { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(cross.status).toBe(403);
  });

  it('refuses a call from another site', async () => {
    const res = await fetch(`${host.url}/__kit/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kit-ipc': '1', origin: 'https://evil.example' },
      body: JSON.stringify({ channel: 'echo', args: [] }),
    });
    expect(res.status).toBe(403);
  });
});
