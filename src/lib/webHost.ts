// ============================================================
// Track Lab as a web app: the same main process serving its page
// over HTTP on 127.0.0.1:7792 (electron-kit's web host), so it opens
// in a Benhäus tab, and on Ben's phone through Benhäus's phone remote,
// with or without its own window.
//
//   `npm run web`  starts Track Lab with no window, serving only;
//   any launch     serves too, so a web tab joins a Track Lab that's
//                  already open (a second launch only reaches the
//                  first one's second-instance).
//
// A page's calls go to the same handlers the window's do (ipcOps), each
// recorded as an operation with source "web"; what a handler sends its
// caller, and what the app tells every window, is pushed to the pages.
// A phone gets the sourcing-only page (mobile.html): index.html sends it
// there on a small touch screen.
// ============================================================

import fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { Readable } from 'stream';
import { createWebHost, isWebLaunch, type IpcRegistry, type WebHost } from '@btkulka/electron-kit/main';
import type { InvokeContext } from './ipcOps';
import { createScopedLogger } from './logger';

const log = createScopedLogger('Web');

/** Benhäus's config names this port for Track Lab's web app (candybar-manager@web). */
export const WEB_PORT = Number(process.env.TRACK_LAB_WEB_PORT) || 7792;

/** The audio preview route, what media:// is in the window. */
export const WEB_MEDIA_PREFIX = '/media/';

let host: WebHost | null = null;

/** This launch is the web app alone, no window (`npm run web`, `--web`). */
export function isWebOnlyLaunch(argv?: readonly string[]): boolean {
  return argv ? isWebLaunch(argv, {}) : isWebLaunch();
}

/** Tell every page the web host serves what the window is told. */
export function pushToWeb(channel: string, payload?: unknown): void {
  host?.push(channel, payload);
}

export type WebHostDeps = {
  /** Default WEB_PORT; 0 for any free one (tests). */
  port?: number;
  rendererDir: string;
  preloadFile: string;
  version: string;
  ipc: {
    invoke: (channel: string, args: unknown[], ctx: InvokeContext) => Promise<unknown>;
    has: (channel: string) => boolean;
    channels: () => string[];
  };
  /** ipcMain's listeners on a channel (what the window's ipcRenderer.send reaches). */
  listeners: (channel: string) => Array<(event: unknown, ...args: unknown[]) => void>;
  /** The audio preview for a file, as media:// serves it in the window. */
  media: (filePath: string, range: string | null) => Promise<Response>;
};

const WEB_EVENT = Object.freeze({ sender: null, senderFrame: null, frameId: 0, processId: 0, web: true });

export async function startWebHost(deps: WebHostDeps): Promise<WebHost | null> {
  if (host) return host;
  const index = `${deps.rendererDir}/index.html`;
  if (!fs.existsSync(index) || !fs.existsSync(deps.preloadFile)) {
    // `npm run dev` serves the page from Vite; there's nothing built to serve.
    log.info(`Web app not served: no built page at ${index}`);
    return null;
  }
  const registry: IpcRegistry = {
    invoke: (channel, args = []) => deps.ipc.invoke(channel, args, { source: 'web', send: (ch, payload) => pushToWeb(ch, payload) }),
    send: (channel, args = []) => {
      const listeners = deps.listeners(channel);
      for (const l of listeners) l(WEB_EVENT, ...args);
      return listeners.length;
    },
    has: (channel) => deps.ipc.has(channel) || deps.listeners(channel).length > 0,
    channels: () => deps.ipc.channels(),
  };
  try {
    host = await createWebHost({
      port: deps.port ?? WEB_PORT,
      rendererDir: deps.rendererDir,
      preloadFile: deps.preloadFile,
      ipc: registry,
      info: { app: 'Track Lab', version: deps.version },
      handle: (req, res) => serveMedia(req, res, deps.media),
      log: (line) => log.warn(line),
    });
    log.info(`Web app at ${host.url}`);
    return host;
  } catch (err) {
    // Another Track Lab (a checkout beside the installed app) already serves it.
    log.warn(`Web app not served on port ${deps.port ?? WEB_PORT}:`, err);
    return null;
  }
}

export async function stopWebHost(): Promise<void> {
  const h = host;
  host = null;
  await h?.close().catch(() => undefined);
}

/** GET /media/<path>: an audio preview for the page's player. Only for the
 *  page itself (or a direct visit): another site can't point an <audio> at it. */
async function serveMedia(req: IncomingMessage, res: ServerResponse, media: WebHostDeps['media']): Promise<boolean> {
  const url = req.url ?? '/';
  if (!url.startsWith(WEB_MEDIA_PREFIX)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    res.writeHead(403).end('Forbidden');
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method not allowed');
    return true;
  }
  let filePath: string;
  try {
    filePath = decodeURIComponent(url.slice(WEB_MEDIA_PREFIX.length - 1).split('?')[0]);
  } catch {
    res.writeHead(400).end('Bad path');
    return true;
  }
  const out = await media(filePath, typeof req.headers.range === 'string' ? req.headers.range : null);
  const headers: Record<string, string> = {};
  out.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(out.status, headers);
  if (req.method === 'HEAD' || !out.body) {
    res.end();
    return true;
  }
  Readable.fromWeb(out.body as import('stream/web').ReadableStream).on('error', () => res.destroy()).pipe(res);
  return true;
}
