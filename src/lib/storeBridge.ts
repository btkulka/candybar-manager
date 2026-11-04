/**
 * The app's store accounts, for processes outside it.
 *
 * Qobuz and Beatport sign-ins live in the app (Settings → Qobuz / Beatport):
 * one session partition per account, read invisibly. Claude's MCP tools and
 * the playlist-sourcing cart fill used to keep Chrome profiles of their own,
 * so signing in on one side didn't count on the other. Now they ask the
 * running app over this socket (lib/storeBridge.mjs is the client), and the
 * app does the work with its own sessions and its own rules: lossless-only
 * carts, never-overwrite downloads, deleted stays deleted.
 *
 * A Unix socket in userData, mode 0600, so only this user's processes can
 * connect. One JSON request per line, `{id, method, params}`; the reply is
 * zero or more `{id, progress}` lines while it works, then one
 * `{id, ok, result}` or `{id, ok: false, error}`. A request may carry
 * `meta` (BridgeMeta) saying who sent it.
 *
 * Besides the store methods, `invoke {channel, args}` runs any of the
 * window's IPC actions (ipcOps.ts), which is how Claude's MCP tools reach
 * everything the app can do.
 */

import fs from 'fs';
import net from 'net';

/** Who's asking: `client` is "mcp" for Claude's tools (anything else is a
 *  script), `tool` the MCP tool, `parentOp` its operation in the operations
 *  log, so the app's record of the work links back to it. */
export type BridgeMeta = { client?: string; tool?: string; parentOp?: string };

export type BridgeHandler = (
  params: Record<string, unknown>,
  progress: (message: string) => void,
  meta: BridgeMeta
) => Promise<unknown>;

/** A request bigger than this is refused (a cart of matches is a few KB). */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
/** sun_path is 104 bytes on macOS, including the terminator. */
const MAX_SOCKET_PATH = 103;

/** Remove a socket left by a run that didn't shut down, but never a live one
 *  and never anything that isn't a socket. */
async function clearStaleSocket(socketPath: string): Promise<void> {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(socketPath); } catch { return; }
  if (!stat.isSocket()) throw new Error(`${socketPath} exists and isn't a socket; leaving it alone`);
  const live = await new Promise<boolean>((resolve) => {
    const probe = net.connect(socketPath);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
  if (live) throw new Error('Another Track Lab is already answering store requests');
  fs.unlinkSync(socketPath);
}

/** Start answering on `socketPath`. Resolves with a function that stops it. */
export async function startStoreBridge(
  socketPath: string,
  handlers: Record<string, BridgeHandler>
): Promise<() => Promise<void>> {
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
    throw new Error(`Socket path is too long for macOS (${socketPath})`);
  }
  await clearStaleSocket(socketPath);

  const answer = async (line: string, send: (msg: unknown) => void): Promise<void> => {
    let req: { id?: unknown; method?: unknown; params?: unknown; meta?: unknown };
    try {
      req = JSON.parse(line);
    } catch {
      send({ id: null, ok: false, error: 'Request was not JSON' });
      return;
    }
    const id = req?.id ?? null;
    const method = typeof req?.method === 'string' ? req.method : '';
    const handler = Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : null;
    if (!handler) {
      send({ id, ok: false, error: `Unknown method: ${method || '(none)'}` });
      return;
    }
    const params = req.params && typeof req.params === 'object' && !Array.isArray(req.params)
      ? req.params as Record<string, unknown>
      : {};
    const raw = req.meta && typeof req.meta === 'object' && !Array.isArray(req.meta) ? req.meta as Record<string, unknown> : {};
    const meta: BridgeMeta = {};
    for (const key of ['client', 'tool', 'parentOp'] as const) if (typeof raw[key] === 'string') meta[key] = raw[key] as string;
    try {
      const result = await handler(params, (message) => send({ id, progress: String(message) }), meta);
      send({ id, ok: true, result });
    } catch (err) {
      send({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    const send = (msg: unknown) => {
      if (!sock.destroyed && sock.writable) sock.write(`${JSON.stringify(msg)}\n`);
    };
    sock.on('data', (chunk: string) => {
      buf += chunk;
      if (Buffer.byteLength(buf) > MAX_REQUEST_BYTES) {
        send({ id: null, ok: false, error: 'Request too large' });
        sock.destroy();
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) void answer(line, send);
      }
    });
    // A client that hangs up mid-request just stops getting answers.
    sock.on('error', () => { /* client went away */ });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  // Connecting needs write permission on the socket, so 0600 keeps it to this
  // user. (Before this line the umask's default already denies others write.)
  fs.chmodSync(socketPath, 0o600);

  // Unlinking first refuses new connections at once; close() then resolves as
  // the requests already running finish.
  return async () => {
    try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
