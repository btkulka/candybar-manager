// Splice API recon: opens splice.com in a real browser, lets you log in,
// then records every XHR/fetch as you exercise the flows we want to
// automate. Writes a JSON log we can analyze to design a headless client.
//
// Usage:
//   node splice-api-recon.mjs
//
// What to do once the browser opens:
//   1. Log in to your Splice account.
//   2. Go to Sounds. Search for a sample you know you've downloaded before.
//   3. Click into the sample's detail view.
//   4. Click the download button on at least one sample.
//   5. Visit the "Likes" / "Purchased" / "Downloaded" view (whatever the
//      "samples I have access to" surface is called these days).
//   6. Page through it once.
//   7. Close the browser tab, or hit Ctrl+C in the terminal.
//
// Output:
//   /tmp/splice-recon-traffic.jsonl   one JSON object per request
//   /tmp/splice-recon-state.json      cookies + localStorage at exit
//   /tmp/splice-recon-log.txt         human-readable timeline

import fs from 'fs';
import { launchSiteBrowser } from './lib/launchBrowser.mjs';

const TRAFFIC = '/tmp/splice-recon-traffic.jsonl';
const STATE = '/tmp/splice-recon-state.json';
const LOG = '/tmp/splice-recon-log.txt';

// Only record requests that hit a Splice-owned host. Splice's web app talks
// to a handful of subdomains (api.splice.com, splice.com, etc) plus a CDN
// for the actual audio bytes. We want all of them.
const SPLICE_HOST_RE = /(^|\.)splice\.com$/i;

fs.writeFileSync(TRAFFIC, '');
fs.writeFileSync(LOG, '');

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
}

function record(entry) {
  fs.appendFileSync(TRAFFIC, JSON.stringify(entry) + '\n');
}

const ctx = await launchSiteBrowser({ profile: 'splice' });
const page = await ctx.newPage();

// Map requestId -> request metadata so we can pair responses back to their
// original request when the response event fires.
const inflight = new Map();

page.on('request', (req) => {
  try {
    const url = new URL(req.url());
    if (!SPLICE_HOST_RE.test(url.hostname)) return;
    const id = req._guid || `${Date.now()}-${Math.random()}`;
    const meta = {
      id,
      ts: new Date().toISOString(),
      phase: 'request',
      method: req.method(),
      url: req.url(),
      host: url.hostname,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      resourceType: req.resourceType(),
      headers: req.headers(),
      postData: req.postData() || null,
    };
    inflight.set(req, meta);
    record(meta);
  } catch (err) {
    log(`request handler error: ${err.message}`);
  }
});

page.on('response', async (res) => {
  try {
    const req = res.request();
    const reqMeta = inflight.get(req);
    if (!reqMeta) return; // not a Splice request
    inflight.delete(req);

    const url = new URL(res.url());
    const headers = res.headers();
    const ct = headers['content-type'] || '';

    // For JSON-ish responses, capture the body. For binary (audio) just
    // record metadata — we don't want megabytes of WAV in the log.
    let body = null;
    let bodyKind = 'skipped';
    if (/json|javascript|text/i.test(ct)) {
      try {
        const text = await res.text();
        // Cap at 200KB per response so the log stays workable.
        if (text.length > 200_000) {
          body = text.slice(0, 200_000);
          bodyKind = 'text-truncated';
        } else {
          body = text;
          bodyKind = 'text';
        }
      } catch (err) {
        bodyKind = `text-error:${err.message}`;
      }
    } else if (ct) {
      bodyKind = `binary:${ct}`;
    }

    record({
      id: reqMeta.id,
      ts: new Date().toISOString(),
      phase: 'response',
      method: req.method(),
      url: res.url(),
      host: url.hostname,
      path: url.pathname,
      status: res.status(),
      contentType: ct,
      contentLength: headers['content-length'] || null,
      bodyKind,
      body,
    });
  } catch (err) {
    log(`response handler error: ${err.message}`);
  }
});

page.on('framenavigated', (frame) => {
  if (frame === page.mainFrame()) {
    log(`navigated: ${frame.url()}`);
  }
});

log('Opening https://splice.com/');
await page.goto('https://splice.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

log('Browser is open. Log in, then exercise: search, sample detail, download, library/likes view.');
log(`Recording Splice traffic to ${TRAFFIC}`);
log('Close the browser window or press Ctrl+C when done.');

async function dumpState(label) {
  try {
    const cookies = await ctx.cookies();
    const splice = cookies.filter((c) => /splice/i.test(c.domain));
    const ls = await page.evaluate(() => {
      const out = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (!k) continue;
        out[k] = window.localStorage.getItem(k);
      }
      return out;
    }).catch(() => ({}));

    fs.writeFileSync(
      STATE,
      JSON.stringify(
        {
          label,
          ts: new Date().toISOString(),
          url: page.url(),
          spliceCookies: splice.map((c) => ({
            name: c.name,
            domain: c.domain,
            path: c.path,
            // Truncate values — we're only documenting *which* cookies exist
            // and where they live, not exfiltrating the auth token to disk.
            value: c.value.length > 40 ? c.value.slice(0, 40) + `… [${c.value.length}]` : c.value,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite,
          })),
          localStorageKeys: Object.keys(ls).sort(),
        },
        null,
        2,
      ),
    );
    log(`[${label}] state dumped: ${splice.length} splice cookies, ${Object.keys(ls).length} ls keys`);
  } catch (err) {
    log(`[${label}] dump error: ${err.message}`);
  }
}

// Periodic state dump so we can see when login lands without parsing the log.
const stateInterval = setInterval(() => dumpState('tick'), 15_000);

// Clean shutdown on Ctrl+C and on browser close.
let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(stateInterval);
  log(`shutdown: ${reason}`);
  await dumpState('final');
  try { await ctx.close(); } catch {}
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
ctx.on('close', () => shutdown('browser-closed'));

// Keep alive — handlers do all the real work.
await new Promise(() => {});
