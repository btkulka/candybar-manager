/**
 * Store requests that need the user's signed-in session run INSIDE that
 * session's browser context, never as a Node fetch carrying cookies copied out
 * of the partition.
 *
 * One hidden WebContentsView per (partition, origin), created on first use and
 * reused for every call after: no window per call, nothing shown, nothing added
 * to a window (so it can never be mistaken for the app's main window). Requests
 * are made with the page's own fetch, so the store sees its own origin, its own
 * cookies and a real Chromium — the same thing the store panel is.
 */

import { WebContentsView } from 'electron';
import { createScopedLogger } from './logger';

const log = createScopedLogger('StoreBrowser');

type Host = { view: WebContentsView; ready: Promise<void> };
const hosts = new Map<string, Host>();

// A small same-origin document to stand the page on. Anything served by the
// store's own host gives the page that origin; robots.txt is tiny and isn't
// behind a login.
const LANDING = 'robots.txt';

function hostKey(partition: string, origin: string): string {
  return `${partition}|${origin}`;
}

async function getHost(partition: string, origin: string): Promise<Electron.WebContents> {
  const key = hostKey(partition, origin);
  const existing = hosts.get(key);
  if (existing && !existing.view.webContents.isDestroyed()) {
    await existing.ready;
    const wc = existing.view.webContents;
    // A redirect (sign-in, consent, a challenge) can move the page off the
    // store's origin; every fetch must start from that origin.
    if (safeOrigin(wc.getURL()) === origin) return wc;
    hosts.delete(key);
    try { wc.close(); } catch { /* already gone */ }
  }

  const view = new WebContentsView({
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const wc = view.webContents;
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  const ready = wc.loadURL(`${origin}/${LANDING}`).catch((err) => {
    log.warn(`Could not open ${origin} in ${partition}:`, err);
    throw err;
  });
  hosts.set(key, { view, ready });
  try {
    await ready;
  } catch (err) {
    hosts.delete(key);
    try { wc.close(); } catch { /* already gone */ }
    throw new Error(`Couldn't reach ${origin}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return wc;
}

function safeOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return ''; }
}

export type SessionFetchInit = {
  method?: 'GET' | 'POST' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  /** Default 30 s. */
  timeoutMs?: number;
};

export type SessionFetchResult = {
  /** 0 when the request never got an answer (network, CORS, timeout). */
  status: number;
  ok: boolean;
  /** The final URL after redirects — a bounce to /signin shows up here. */
  url: string;
  text: string;
};

/**
 * `fetch(url)` from a page on `origin` in `partition`. Same-origin requests
 * carry the session's cookies; cross-origin ones don't (their API takes a
 * Bearer token instead, and asking for credentials would fail CORS).
 */
export async function sessionFetch(
  partition: string,
  origin: string,
  url: string,
  init: SessionFetchInit = {}
): Promise<SessionFetchResult> {
  const wc = await getHost(partition, origin);
  const absolute = new URL(url, origin).toString();
  const sameOrigin = safeOrigin(absolute) === origin;
  const request = {
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
    body: init.body,
    credentials: sameOrigin ? 'include' : 'omit',
  };
  const timeoutMs = init.timeoutMs ?? 30_000;
  const script = `(async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ${Number(timeoutMs)});
    try {
      const r = await fetch(${JSON.stringify(absolute)}, { ...${JSON.stringify(request)}, signal: ctl.signal });
      return { status: r.status, ok: r.ok, url: r.url, text: await r.text() };
    } catch (e) {
      return { status: 0, ok: false, url: '', text: String((e && e.message) || e) };
    } finally {
      clearTimeout(timer);
    }
  })()`;
  return await wc.executeJavaScript(script, true) as SessionFetchResult;
}

/** `sessionFetch` + JSON.parse. `data` is null when the body isn't JSON. */
export async function sessionFetchJson<T = unknown>(
  partition: string,
  origin: string,
  url: string,
  init: SessionFetchInit = {}
): Promise<SessionFetchResult & { data: T | null }> {
  const res = await sessionFetch(partition, origin, url, {
    ...init,
    headers: { Accept: 'application/json', ...(init.headers ?? {}) },
  });
  let data: T | null = null;
  try { data = JSON.parse(res.text) as T; } catch { /* not JSON */ }
  return { ...res, data };
}

/** Drop the hidden pages for a partition (logout), or all of them (quit). */
export function closeStoreBrowsers(partition?: string): void {
  for (const [key, host] of hosts) {
    if (partition && !key.startsWith(`${partition}|`)) continue;
    hosts.delete(key);
    try { host.view.webContents.close(); } catch { /* already gone */ }
  }
}
