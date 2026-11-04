// Ask the running Track Lab to do something with its store accounts.
//
// Qobuz and Beatport sign-ins live in the app (Settings → Qobuz / Beatport),
// so the MCP server and the sourcing CLI don't keep store logins of their own:
// they send the request over the app's socket (src/lib/storeBridge.ts) and the
// app answers with its own sessions. When the app isn't running it's started
// (the same way the Applications shortcut does) and waited for.
//
// Methods: status · appStatus · login {store} · purchases {store} ·
//          download {matches, destDir?} · cartAdd {store, matches} · catalogSearch {store, query} ·
//          invoke {channel, args} (any of the window's actions)

import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawn } from 'child_process';
import { REPO_ROOT, USER_DATA_DIR } from './sourcing/config.mjs';

const START_TIMEOUT_MS = 90_000;

/** CANDYBAR_STORE_BRIDGE overrides the path (tests, a scratch user-data dir). */
export function storeBridgePath() {
  return process.env.CANDYBAR_STORE_BRIDGE || path.join(USER_DATA_DIR, 'store-bridge.sock');
}

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    sock.once('connect', () => { sock.off('error', reject); resolve(sock); });
    sock.once('error', reject);
  });
}

/** Start Track Lab from this checkout, detached, the way the Applications
 *  shortcut does (scripts/_common.sh → candybar_launch). The packaged app has
 *  no scripts/, so it's just opened. */
function startApp() {
  const script = fs.existsSync(path.join(REPO_ROOT, 'scripts', '_common.sh'))
    ? 'REPO_DIR="$1"; . "$1/scripts/_common.sh" && candybar_setup_path && candybar_node_ok && cd "$1" && candybar_launch'
    : 'open -b com.btkulka.tracklab';
  const child = spawn('/bin/bash', ['-c', script, 'start-track-lab', REPO_ROOT], { detached: true, stdio: 'ignore' });
  child.on('error', () => { /* reported as "didn't come up" below */ });
  child.unref();
}

async function waitForApp(socketPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await connect(socketPath);
    } catch {
      if (Date.now() > deadline) {
        const built = fs.existsSync(path.join(REPO_ROOT, 'dist', 'main', 'main.js'));
        throw new Error(built
          ? `Track Lab didn't come up within ${Math.round(timeoutMs / 1000)} s. Open it yourself, then try again (an older Track Lab without this connection needs an update first).`
          : `Track Lab isn't built in ${REPO_ROOT}. Run scripts/install.sh, then try again.`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

function request(sock, method, params, { onProgress, timeoutMs, meta }) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`Track Lab didn't finish "${method}" within ${Math.round(timeoutMs / 60000)} min`)), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== 1) continue;
        if ('progress' in msg) { onProgress?.(msg.progress); continue; }
        if (msg.ok) finish(resolve, msg.result);
        else finish(reject, new Error(msg.error || `Track Lab couldn't do "${method}"`));
      }
    });
    sock.on('error', (err) => finish(reject, err));
    sock.on('close', () => finish(reject, new Error(`Track Lab closed the connection before answering "${method}"`)));
    sock.write(`${JSON.stringify({ id: 1, method, params, ...(meta ? { meta } : {}) })}\n`);
  });
}

/**
 * Run `method` in Track Lab and resolve with its result.
 *   onProgress  called with each progress message
 *   timeoutMs   how long the request may take once sent (default 10 min)
 *   launch      start Track Lab when it isn't running (default true)
 *   meta        who's asking ({client, tool, parentOp}), for the app's operations log
 */
export async function callApp(method, params = {}, { onProgress, timeoutMs = 10 * 60_000, launch = true, meta } = {}) {
  const socketPath = storeBridgePath();
  let sock;
  try {
    sock = await connect(socketPath);
  } catch (err) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(err.code)) throw err;
    if (!launch || process.env.CANDYBAR_NO_LAUNCH === '1') {
      throw new Error('Track Lab isn\'t running. Open it, then try again: store sign-ins live in the app.');
    }
    onProgress?.('Starting Track Lab, where the store sign-ins live…');
    startApp();
    sock = await waitForApp(socketPath, START_TIMEOUT_MS);
  }
  return request(sock, method, params, { onProgress, timeoutMs, meta });
}
