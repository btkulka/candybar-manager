#!/usr/bin/env node
/**
 * MCP stdio server exposing audio file conversion and quality testing tools.
 * Reuses existing lib functions from the Candy Bar Manager project.
 *
 * Build:  npm run build:mcp
 * Output: dist/mcp/mcp-server.js
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { checkTrackHealth, TrackHealth } from './lib/trackHealthCheck';
import { convertToAiff, reencodeToMp3 } from './lib/trackConverter';
import * as mm from 'music-metadata';
import path from 'path';
import fs from 'fs/promises';
import url from 'url';

import { initWriteJournal, getWriteJournalDir } from './lib/writeJournal';
import { consoleToStderr, enableFileLog } from './lib/logger';
import { initOpLog, withOp, currentOp, summarize, flushOpLogSync } from './lib/opLog';
import { listOps, getOp, readTextLog, textLogFiles, queryWriteJournal, type OpStatus } from './lib/logQuery';
import { activeUserDataDir, activeProfile, defaultProfilesRoot, listProfiles, readRegistry } from './lib/profiles';

// The data folder of the Track Lab profile in use (src/lib/profiles.ts): the
// one handed down when the app started this server (a Claude job), else the one
// the app is running. Logs, operations and the write journal are that
// profile's, and they follow a profile switch: this server outlives one.
let USER_DATA_DIR = '';
let LOGS_DIR = '';
let OPS_DIR = '';

function followProfile(): void {
  const dir = activeUserDataDir();
  if (dir === USER_DATA_DIR) return;
  USER_DATA_DIR = dir;
  LOGS_DIR = path.join(dir, 'logs');
  // stdout carries the MCP protocol; log lines go to stderr and logs/mcp.log.
  enableFileLog(LOGS_DIR, 'mcp');
  // Every tool call is an operation in logs/ops (YYYY-MM-DD.mcp.jsonl); the app
  // records the work it does for a call there too, linked by `parent`.
  OPS_DIR = initOpLog(dir, { proc: 'mcp' });
  // Share the Electron app's write journal so conversions/deletes driven via
  // MCP land in the same recovery log.
  initWriteJournal(dir);
}

consoleToStderr();
followProfile();

const server = new McpServer(
  { name: 'candybar-audio-tools', version: '0.1.0' },
  {
    instructions: [
      'Track Lab keeps each person\'s data in a profile: settings, library, SoundCloud/Spotify/store sign-ins, the email download gates get, download ledger and history.',
      'Before running anything that reads or writes a profile\'s data (sourcing, downloads, gates, carts, library checks, settings), call `profiles` with action "list".',
      'If there is more than one profile, ALWAYS ask Ben which profile to use, even when the running one looks right, then `profiles` "switch" to it if it is not the one running.',
      'Skip the question only inside a Track Lab Claude job the app itself started: that job is tied to the profile the app is running.',
    ].join(' '),
  },
);

/** A tool's reply carrying `"error"` (or flagged isError) failed. */
function toolFailure(r: { content?: Array<{ text?: string }>; isError?: boolean }): string | null {
  const text = r?.content?.[0]?.text ?? '';
  if (r?.isError) return text.slice(0, 500) || 'error';
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' && typeof body.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
}

/** server.tool, with each call recorded as an operation (source "claude"). */
const tool = ((name: string, ...rest: unknown[]) => {
  const handler = rest.pop() as (...a: unknown[]) => Promise<any>;
  return (server.tool as (...a: unknown[]) => unknown).call(server, name, ...rest, (...a: unknown[]) => {
    followProfile();
    return withOp(name, { source: 'claude', args: a[0] }, () => handler(...a), { failure: toolFailure });
  });
}) as typeof server.tool;

// ---------------------------------------------------------------------------
// Tool 1: check_health
// ---------------------------------------------------------------------------
tool(
  'check_health',
  'Run a health check on an audio file. Reports format details (container, codec, sample rate, bit depth, bitrate, channels, duration), compatibility issues for DJ equipment (XDJ-RX3/CDJ), and suggested actions.',
  { filePath: z.string().describe('Absolute path to the audio file') },
  async ({ filePath }) => {
    const health = await checkTrackHealth(filePath);
    return {
      content: [{ type: 'text', text: JSON.stringify(health, null, 2) }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool 2: convert_to_aiff
// ---------------------------------------------------------------------------
tool(
  'convert_to_aiff',
  'Convert an audio file to AIFF (PCM 24-bit, 44.1kHz stereo) using bundled ffmpeg. Output is written alongside the original as <name>.aif; an AIFF-family input is converted in place under the same name. Refuses to overwrite a different existing file.',
  { filePath: z.string().describe('Absolute path to the audio file to convert') },
  async ({ filePath }) => {
    const result = await convertToAiff(filePath);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool 3: reencode_mp3
// ---------------------------------------------------------------------------
tool(
  'reencode_mp3',
  'Re-encode an audio file to 320kbps MP3 with preserved metadata using bundled ffmpeg. Output is written alongside the original as <name>.mp3; an .mp3 input is re-encoded in place. Refuses to overwrite a different existing file.',
  { filePath: z.string().describe('Absolute path to the audio file to re-encode') },
  async ({ filePath }) => {
    const result = await reencodeToMp3(filePath);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool 4: compare_quality
// ---------------------------------------------------------------------------

function deriveVerdict(a: TrackHealth, b: TrackHealth): string {
  const parts: string[] = [];

  // Lossless vs lossy
  if (a.format.lossless && !b.format.lossless) {
    parts.push('fileA is lossless, fileB is lossy');
  } else if (!a.format.lossless && b.format.lossless) {
    parts.push('fileB is lossless, fileA is lossy');
  }

  // Bit depth
  if (a.format.bitDepth && b.format.bitDepth && a.format.bitDepth !== b.format.bitDepth) {
    const better = a.format.bitDepth > b.format.bitDepth ? 'fileA' : 'fileB';
    parts.push(`${better} has higher bit depth (${Math.max(a.format.bitDepth, b.format.bitDepth)} vs ${Math.min(a.format.bitDepth, b.format.bitDepth)})`);
  }

  // Sample rate
  if (a.format.sampleRate && b.format.sampleRate && a.format.sampleRate !== b.format.sampleRate) {
    const better = a.format.sampleRate > b.format.sampleRate ? 'fileA' : 'fileB';
    parts.push(`${better} has higher sample rate (${Math.max(a.format.sampleRate, b.format.sampleRate)} vs ${Math.min(a.format.sampleRate, b.format.sampleRate)} Hz)`);
  }

  // Bitrate (only meaningful for lossy)
  if (a.format.bitRate && b.format.bitRate && a.format.bitRate !== b.format.bitRate) {
    const better = a.format.bitRate > b.format.bitRate ? 'fileA' : 'fileB';
    parts.push(`${better} has higher bitrate (${Math.max(a.format.bitRate, b.format.bitRate)} vs ${Math.min(a.format.bitRate, b.format.bitRate)} kbps)`);
  }

  // Health issues
  const issueCountA = a.issues.length;
  const issueCountB = b.issues.length;
  if (issueCountA !== issueCountB) {
    const better = issueCountA < issueCountB ? 'fileA' : 'fileB';
    parts.push(`${better} has fewer issues (${Math.min(issueCountA, issueCountB)} vs ${Math.max(issueCountA, issueCountB)})`);
  }

  if (parts.length === 0) {
    return 'Files are equivalent in quality';
  }
  return parts.join('. ');
}

tool(
  'compare_quality',
  'Compare two audio files side-by-side. Shows format details, quality differences, and a verdict on which file is higher quality. Useful for before/after conversion comparison.',
  {
    fileA: z.string().describe('Absolute path to the first audio file (e.g., original)'),
    fileB: z.string().describe('Absolute path to the second audio file (e.g., converted)'),
  },
  async ({ fileA, fileB }) => {
    const [healthA, healthB] = await Promise.all([
      checkTrackHealth(fileA),
      checkTrackHealth(fileB),
    ]);

    const formatKeys = Object.keys(healthA.format) as (keyof typeof healthA.format)[];
    const formatDiff: Record<string, { fileA: unknown; fileB: unknown; changed: boolean }> = {};
    for (const key of formatKeys) {
      formatDiff[key] = {
        fileA: healthA.format[key],
        fileB: healthB.format[key],
        changed: healthA.format[key] !== healthB.format[key],
      };
    }

    const comparison = {
      fileA: {
        path: fileA,
        fileName: healthA.fileName,
        artist: healthA.artist,
        title: healthA.title,
        isHealthy: healthA.isHealthy,
        issueCount: healthA.issues.length,
        issues: healthA.issues,
        format: healthA.format,
      },
      fileB: {
        path: fileB,
        fileName: healthB.fileName,
        artist: healthB.artist,
        title: healthB.title,
        isHealthy: healthB.isHealthy,
        issueCount: healthB.issues.length,
        issues: healthB.issues,
        format: healthB.format,
      },
      formatDiff,
      qualityVerdict: deriveVerdict(healthA, healthB),
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(comparison, null, 2) }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool 5: get_metadata
// ---------------------------------------------------------------------------
tool(
  'get_metadata',
  'Get detailed metadata for an audio file: title, artist, album, year, genre, track number, album art presence, and full format details.',
  { filePath: z.string().describe('Absolute path to the audio file') },
  async ({ filePath }) => {
    const metadata = await mm.parseFile(filePath);
    const result = {
      filePath,
      fileName: path.basename(filePath),
      title: metadata.common.title || null,
      artist: metadata.common.artist || null,
      artists: metadata.common.artists || [],
      album: metadata.common.album || null,
      year: metadata.common.year || null,
      genre: metadata.common.genre?.[0] || null,
      trackNumber: metadata.common.track?.no || null,
      discNumber: metadata.common.disk?.no || null,
      hasAlbumArt: !!(metadata.common.picture && metadata.common.picture.length > 0),
      format: {
        container: metadata.format.container || null,
        codec: metadata.format.codec || null,
        sampleRate: metadata.format.sampleRate || null,
        bitDepth: metadata.format.bitsPerSample || null,
        bitRate: metadata.format.bitrate ? Math.round(metadata.format.bitrate / 1000) : null,
        channels: metadata.format.numberOfChannels || null,
        duration: metadata.format.duration || null,
        lossless: metadata.format.lossless ?? null,
      },
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ---------------------------------------------------------------------------
// Store helpers (standalone, no Electron dependency)
// ---------------------------------------------------------------------------

// The sourcing engine lives in `lib/sourcing/*.mjs` (plain ESM, no build step)
// so the Electron app, this server, and the playlist-sourcing skill all share
// one definition of the matching rules and one way of talking to the stores.
//
// This file compiles to CommonJS, and a literal `await import()` would be
// downleveled to require() — which cannot load ESM — so the import goes through
// a Function constructor that TypeScript leaves alone.
const esmImport = new Function('p', 'return import(p)') as (p: string) => Promise<any>;

const SOURCING_ROOT = path.join(__dirname, '..', '..');
const sourcingModule = (name: string) =>
  esmImport(url.pathToFileURL(path.join(SOURCING_ROOT, 'lib', 'sourcing', `${name}.mjs`)).href);

// ---------------------------------------------------------------------------
// One browser window per store, one tool at a time
// ---------------------------------------------------------------------------
//
// Every store tool used to launch Chrome, open a window and quit it again. The
// launcher now keeps one context per profile for the life of the server (closed
// after ten idle minutes), and tool calls that drive a browser are queued so two
// never steer the same window — or fight over the same profile — at once.
// The same module URL the sourcing modules import, so they share its state.
const launcherModule = () =>
  esmImport(url.pathToFileURL(path.join(SOURCING_ROOT, 'lib', 'launchBrowser.mjs')).href) as Promise<{
    enableSharedBrowsers: (opts?: { idleMs?: number }) => void;
    closeSharedBrowsers: () => Promise<void>;
  }>;

let sharedBrowsersReady: Promise<void> | null = null;
function ensureSharedBrowsers(): Promise<void> {
  sharedBrowsersReady ??= launcherModule().then(m => m.enableSharedBrowsers({ idleMs: 10 * 60_000 }));
  return sharedBrowsersReady;
}

let browserQueue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = browserQueue.then(async () => {
    await ensureSharedBrowsers();
    return fn();
  });
  browserQueue = run.catch(() => {});
  return run;
}

/** Child scripts launch their own Chrome on the same profiles, which a profile
 *  directory another Chrome holds would refuse — so hand them over first. */
async function releaseSharedBrowsers(): Promise<void> {
  await (await launcherModule()).closeSharedBrowsers();
}

// Store accounts live in the app (Settings → Qobuz / Beatport): its own
// per-account sessions, read without a window. These tools ask the running
// app over its socket (lib/storeBridge.mjs → src/lib/storeBridge.ts), starting
// it when it's closed, so a sign-in in the app counts here and one made here
// shows up in the app. There are no store logins in this server.
const storeBridgeModule = () =>
  esmImport(url.pathToFileURL(path.join(SOURCING_ROOT, 'lib', 'storeBridge.mjs')).href) as Promise<{
    callApp: (method: string, params?: Record<string, unknown>, opts?: {
      timeoutMs?: number;
      launch?: boolean;
      onProgress?: (message: string) => void;
      meta?: Record<string, unknown>;
    }) => Promise<any>;
  }>;

/** Who's asking, so the app's record of the work links to this tool call. */
function bridgeMeta() {
  const op = currentOp();
  return { client: 'mcp', tool: op?.name, parentOp: op?.id };
}

async function askApp<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
  return (await storeBridgeModule()).callApp(method, params, { timeoutMs, meta: bridgeMeta() });
}

const STORE_NAME = { qobuz: 'Qobuz', beatport: 'Beatport' } as const;
const SIGN_IN_HINT = (store: 'qobuz' | 'beatport') =>
  `Sign in to ${STORE_NAME[store]} in Track Lab (Settings → ${STORE_NAME[store]}), or run store_login for "${store}", which opens Track Lab's own sign-in window.`;

// ---------------------------------------------------------------------------
// Tools 6-10: the stores
//
// Qobuz search is public, so it runs over plain HTTP. Beatport search needs no
// account but does need real Chrome, since Cloudflare 403s any other client.
// Everything that needs the user's account (purchases, downloads, sign-in)
// runs in Track Lab on the accounts in its Settings, through askApp().
// ---------------------------------------------------------------------------

tool(
  'search_qobuz',
  'Search Qobuz for a track and resolve a lossless add-to-cart link. Needs no login: Qobuz search is public. The returned cart URL is the article id carrier, not a clickable link — Qobuz only accepts it as an XHR from its own site, so opening it in a tab 404s; lib/sourcing/cart.mjs adds it from the signed-in profile. Returns the best match with its quality tier, price, and cart link.',
  {
    artist: z.string().describe('Artist name'),
    title: z.string().describe('Track title'),
    prefer: z.enum(['hires', 'cd']).optional().describe('Which lossless tier to link (default hires)'),
  },
  async ({ artist, title, prefer }) => {
    const qobuz = await sourcingModule('qobuz');
    const want = { artist, title };
    const match = await qobuz.bestQobuzMatch(want);
    if (!match) {
      return { content: [{ type: 'text', text: JSON.stringify({ query: `${artist} - ${title}`, match: null, note: 'No Qobuz result cleared the match floor.' }, null, 2) }] };
    }
    const resolved = await qobuz.resolveCart(match, want, { prefer: prefer || 'hires' }).catch((err: Error) => ({ ...match, cartError: err.message }));
    return {
      content: [{ type: 'text', text: JSON.stringify({
        query: `${artist} - ${title}`,
        match: {
          title: resolved.title, artists: resolved.artists, score: resolved.score,
          quality: resolved.quality, lossless: resolved.lossless, price: resolved.price,
          trackId: resolved.trackId, url: resolved.url,
          cartUrl: resolved.cartUrl, cartLabel: resolved.cartLabel,
          cartError: resolved.cartError,
          scoreParts: resolved.scoreParts,
        },
      }, null, 2) }]
    };
  }
);

tool(
  'search_beatport',
  'Search Beatport for a track. Opens the user\'s real Chrome (Beatport returns 403 to plain HTTP and to headless Chrome alike — Cloudflare fingerprints both), so a browser window will appear. Returns the best match with price and track URL. No login needed for search.',
  {
    artist: z.string().describe('Artist name'),
    title: z.string().describe('Track title'),
  },
  async ({ artist, title }) => oneAtATime(async () => {
    const bp = await sourcingModule('beatport');
    const session = await bp.openBeatport();
    try {
      const token = await bp.getAccessToken(session.page);
      const search = bp.makeSearcher({ page: session.page, token });
      const match = await bp.bestBeatportMatch(search, { artist, title });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          query: `${artist} - ${title}`,
          signedIn: Boolean(token),
          match: match && {
            title: match.title, artists: match.artists, score: match.score,
            price: match.price, label: match.label, url: match.url,
            lossless: match.lossless, trackId: match.id, scoreParts: match.scoreParts,
          },
          format: 'WAV/AIFF (RX3-compatible)',
        }, null, 2) }]
      };
    } finally {
      await session.close();
    }
  })
);

tool(
  'search_store_catalog',
  'List what a Beatport or Qobuz catalog search returns (up to 10 results), each with a ref, artists, the title with its mix, label, release date and price, for picking the exact record yourself rather than taking a best-match score. Runs in Track Lab on its own store sessions, starting it if it is closed; no browser window. Qobuz results are releases (singles, EPs, albums), not tracks.',
  {
    store: z.enum(['beatport', 'qobuz']).describe('Which catalog to search'),
    query: z.string().describe('What to search for, e.g. "Fred again.. Jungle" or a title alone'),
  },
  async ({ store, query }) => {
    const result = await askApp<unknown>('catalogSearch', { store, query }, 60_000);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 1) }] };
  }
);

tool(
  'find_free_sources',
  'Look for free or cheap copies of tracks the way Upgrade quality does: a SoundCloud upload with a download (its own button, or a gate like Hypeddit, Droploud or Influence Planner, read signed out to say what the page gives — WAV or MP3 — and asks for), then Bandcamp (free, name your price, or a price). Read-only and signed out: nothing is downloaded, followed or bought. Each track gets its best SoundCloud hit, its Bandcamp copy, and its near misses (close uploads passed over, with why: no download, another version or length, an MP3-only gate). Give `duration` in seconds whenever you know it: a copy of another length is another cut.',
  {
    tracks: z.array(z.object({
      artist: z.string(),
      title: z.string(),
      duration: z.number().optional().describe('Seconds'),
    })).min(1).max(20).describe('Up to 20 tracks'),
  },
  async ({ tracks }) => {
    const m = await sourcingModule('freeSources');
    const strip = (h: any) => {
      if (!h) return null;
      const { fetchRow: _fetchRow, ...rest } = h;
      return rest;
    };
    const out: unknown[] = [];
    for (const t of tracks) {
      const found = await m.findFreeSources(t);
      out.push({ want: t, soundcloud: strip(found.soundcloud), bandcamp: strip(found.bandcamp), nearMisses: found.soundcloudMisses ?? [], errors: found.errors });
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 1) }] };
  }
);

tool(
  'list_purchases',
  'List tracks already purchased on Qobuz and/or Beatport, across every account signed in to Track Lab (Settings → Qobuz / Beatport). Runs in the Track Lab app, which is started if it is closed; no browser window. An account that couldn\'t be read is reported as such rather than counted as owning nothing — an empty result and a signed-out account are very different answers.',
  {
    source: z.enum(['qobuz', 'beatport', 'both']).default('both').describe('Which store(s) to read'),
    hoursAgo: z.number().optional().describe('Only return purchases from the last N hours (purchases without a date are kept)'),
  },
  async ({ source, hoursAgo }) => {
    const cutoff = hoursAgo ? Date.now() - hoursAgo * 3600 * 1000 : 0;
    const out: Record<string, unknown> = {};
    const all: any[] = [];

    for (const store of (source === 'both' ? ['qobuz', 'beatport'] : [source]) as Array<'qobuz' | 'beatport'>) {
      try {
        const result = await askApp<{ accounts: number; owned: any[]; errors: string[] }>('purchases', { store }, 30 * 60_000);
        if (result.accounts === 0) {
          out[store] = { signedIn: false, error: `No ${STORE_NAME[store]} account in Track Lab. ${SIGN_IN_HINT(store)}` };
          continue;
        }
        const tracks = cutoff
          ? result.owned.filter((t: any) => !t.purchasedAt || new Date(t.purchasedAt).getTime() >= cutoff)
          : result.owned;
        out[store] = result.errors.length
          ? { complete: false, count: tracks.length, errors: result.errors, hint: SIGN_IN_HINT(store) }
          : { complete: true, accounts: result.accounts, count: tracks.length };
        all.push(...tracks);
      } catch (err) {
        out[store] = { error: (err as Error).message };
      }
    }

    // Every purchase seen goes in the sourcing history; each is recorded once.
    const history = await sourcingModule('history');
    history.recordEvents(all.map((t: any) => history.eventFromPurchase(t)));

    return { content: [{ type: 'text' as const, text: JSON.stringify({ stores: out, totalFound: all.length, purchases: all }, null, 2) }] };
  }
);

tool(
  'store_login',
  'Sign the user in to a store once. Qobuz and Beatport sign in through Track Lab (started if closed), which opens its own sign-in window for each of its accounts — making the first account if there is none — and every later call, the app and the cart fill use that sign-in. SoundCloud opens its saved Chrome profile, which every SoundCloud run uses. Blocks until sign-in is detected, the window closes, or the timeout passes.',
  {
    store: z.enum(['qobuz', 'beatport', 'soundcloud']).describe('Which store to sign in to'),
    timeoutSeconds: z.number().optional().describe('How long to wait for sign-in (default 300)'),
  },
  async ({ store, timeoutSeconds }) => {
    const timeoutMs = (timeoutSeconds || 300) * 1000;
    if (store !== 'soundcloud') {
      const reply = (body: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(body) }] });
      try {
        const r = await askApp<{ signedIn: boolean; accounts: Array<{ label: string; signedIn: boolean }> }>('login', { store }, timeoutMs + 60_000);
        return reply({
          store, signedIn: r.signedIn, accounts: r.accounts,
          note: r.signedIn
            ? `Signed in to ${STORE_NAME[store]} in Track Lab; the app, these tools and the cart fill all use it.`
            : 'Track Lab\'s sign-in window closed before sign-in finished.',
        });
      } catch (err) {
        return reply({ store, signedIn: false, error: (err as Error).message });
      }
    }
    return oneAtATime(async () => {
      const sc = await sourcingModule('soundcloud');
      const session = await sc.openSoundCloud();
      try {
        const ok = await sc.waitForSoundCloudLogin(session.page, { timeoutMs });
        // Capturing confirms the session answers /me and records whose it is,
        // which is what the app's SoundCloud status shows.
        const sess = ok ? await sc.captureSession(session.page) : null;
        const signedIn = !!sess?.signedIn;
        return { content: [{ type: 'text' as const, text: JSON.stringify({ store, signedIn, account: sess?.me?.username ?? null, note: signedIn ? 'SoundCloud session saved; the app and every SoundCloud run use it.' : ok ? `Signed in, but the session didn't verify (${sess?.diagnostic ?? 'unknown'}).` : 'No sign-in detected before the timeout.' }) }] };
      } finally {
        await session.close();
      }
    });
  }
);

tool(
  'download_track',
  'Download an already-purchased track into the organize source directory, through the Track Lab account that bought it (the app is started if closed; no browser window). Converted to AIFF when it is lossless. A lossy file (e.g. MP3) is never converted: it is kept under lossy/ and reported. Never overwrites an existing file, re-uses a file it already downloaded, and never fetches a track the user deleted.',
  {
    source: z.enum(['qobuz', 'beatport']).describe('Which store the track was bought from'),
    trackId: z.string().describe('Track ID from the store'),
    artist: z.string().describe('Artist name (for the filename)'),
    title: z.string().describe('Track title (for the filename)'),
    destDir: z.string().optional().describe('Destination directory (defaults to organizeSourceDir from config)'),
  },
  async ({ source, trackId, artist, title, destDir }) => {
    const reply = (body: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(body) }] });
    try {
      const r = await askApp<{
        downloaded: string[];
        failed: Array<{ error: string }>;
        skipped: Array<{ reason: string }>;
        destDir: string;
      }>('download', { matches: [{ source, trackId, artist, title }], destDir }, 60 * 60_000);
      if (r.downloaded.length) {
        const file = r.downloaded[0];
        return reply({ success: true, path: file, format: path.extname(file).slice(1).toUpperCase() });
      }
      if (r.skipped.length) return reply({ skipped: true, reason: r.skipped[0].reason });
      const error = r.failed[0]?.error ?? 'Nothing was downloaded';
      // A lossy arrival is kept under lossy/ and named in the error.
      return reply(/lossy|unrecognised format/i.test(error) ? { success: true, lossy: true, note: error } : { error, hint: SIGN_IN_HINT(source) });
    } catch (err) {
      return reply({ error: (err as Error).message });
    }
  }
);

// ---------------------------------------------------------------------------
// Tools 10-12: playlist sourcing
// ---------------------------------------------------------------------------
//
// The sourcing engine lives in `lib/sourcing/*.mjs` (plain ESM, no build step)
// so the Electron app, this server, and the playlist-sourcing skill all share
// one definition of the matching rules. This file compiles to CommonJS, and a
// literal `await import()` would be downleveled to require() — which cannot
// load ESM — so the import goes through a Function constructor that TypeScript
// leaves alone.
tool(
  'check_library_for_tracks',
  'Check a list of artist/title pairs against the Rekordbox collection (plus candybar-manager\'s scan reflection) and bucket them into owned / probable / missing. Fast — no network, no browser. Ownership means present in Rekordbox; a file that exists on disk but was never imported is reported as probable with the reason "file on disk, not in Rekordbox".',
  {
    tracks: z.array(z.object({
      artist: z.string().describe('Artist name'),
      title: z.string().describe('Track title'),
    })).describe('Tracks to check')
  },
  async ({ tracks }) => {
    const [{ loadLibrary, bucketTracks }] = await Promise.all([sourcingModule('library')]);
    const lib = await loadLibrary();
    const { owned, probable, missing } = bucketTracks(tracks, lib);
    return {
      content: [{ type: 'text', text: JSON.stringify({
        stats: { ...lib.stats, owned: owned.length, probable: probable.length, missing: missing.length },
        owned, probable, missing,
      }, null, 2) }]
    };
  }
);

tool(
  'source_playlist',
  'Run the full sourcing pipeline over a Spotify playlist or CSV: fetch the tracklist, check it against Rekordbox, then search Beatport and Qobuz for whatever is missing and resolve lossless purchase links. Beatport takes precedence over Qobuz; lossy matches are excluded from the buy list. Opens a real Chrome window (Cloudflare blocks headless Beatport). Takes roughly 2 seconds per missing track — use limit for a quick sample. Returns the session summary and the path to the full session JSON.',
  {
    playlistUrl: z.string().optional().describe('Spotify playlist URL'),
    csvPath: z.string().optional().describe('Path to a CSV export (alternative to playlistUrl)'),
    limit: z.number().optional().describe('Only source the first N tracks'),
    prefer: z.enum(['hires', 'cd']).optional().describe('Which lossless Qobuz tier to link (default hires)'),
    skipBeatport: z.boolean().optional().describe('Qobuz only — no browser launch'),
  },
  async ({ playlistUrl, csvPath, limit, prefer, skipBeatport }) => oneAtATime(async () => {
    if (!playlistUrl && !csvPath) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Provide playlistUrl or csvPath' }) }] };
    }
    const args = [path.join(SOURCING_ROOT, 'bin', 'source-playlist.mjs')];
    if (playlistUrl) args.push('--playlist', playlistUrl);
    if (csvPath) args.push('--csv', csvPath);
    if (limit) args.push('--limit', String(limit));
    if (prefer) args.push('--prefer', prefer);
    if (skipBeatport) args.push('--skip-beatport');

    // The script launches Chrome on the same store profiles; let go of ours first.
    await releaseSharedBrowsers();
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    try {
      // 30 min ceiling: a long playlist plus a cold library read can legitimately
      // run for a while, and killing it mid-run wastes every store lookup done.
      const { stdout, stderr } = await execFileAsync(process.execPath, args, {
        cwd: SOURCING_ROOT,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30 * 60 * 1000,
      });
      const sessionPath = stdout.trim().split('\n').pop() || '';
      const session = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          sessionPath,
          stats: session.stats,
          buy: session.buy.map((r: any) => ({
            artist: r.artist, title: r.title, store: r.store,
            match: r.match?.title, score: r.match?.score,
            price: r.match?.price, link: r.match?.cartUrl || r.match?.url,
          })),
          probable: session.probable,
          flagged: session.flagged,
          notFound: session.notFound.map((r: any) => ({ artist: r.artist, title: r.title })),
          progressLog: stderr.trim().split('\n').slice(-20),
        }, null, 2) }]
      };
    } catch (err) {
      const e = err as { message?: string; stderr?: string };
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e.message, stderr: (e.stderr || '').slice(-2000) }) }] };
    }
  })
);

tool(
  'render_sourcing_review',
  'Render a sourcing session JSON into a self-contained review page. A playlist session gets the buy list (cover art, prices, store chips, cart links) plus the owned/probable/flagged sections; a SoundCloud-likes session gets the downloaded / needs-your-call / queued / not-free sections. Returns the HTML file path, ready to publish as an artifact.',
  {
    sessionPath: z.string().describe('Path to a session JSON produced by source_playlist'),
    outPath: z.string().optional().describe('Where to write the HTML (default: alongside the session)'),
  },
  async ({ sessionPath, outPath }) => {
    const dest = outPath || sessionPath.replace(/\.json$/, '.html');
    const kind = JSON.parse(await fs.readFile(sessionPath, 'utf8')).kind;
    const written = kind === 'soundcloud-likes'
      ? await (await sourcingModule('likesReview')).writeLikesReview(sessionPath, dest)
      : await (await sourcingModule('review')).writeReview(sessionPath, dest);
    return { content: [{ type: 'text', text: JSON.stringify({ path: written }) }] };
  }
);

tool(
  'sourcing_history',
  'The lasting record of what playlist sourcing acquired: free downloads, lossy files deleted or kept, store cart adds and purchases, across every run. Purchases are recorded when list_purchases sees them. Newest first.',
  {
    event: z.enum(['downloaded', 'lossy-dropped', 'lossy-kept', 'duplicate-removed', 'cart-added', 'purchased']).optional().describe('Only this kind of event'),
    source: z.enum(['soundcloud', 'beatport', 'qobuz']).optional().describe('Only this source'),
    since: z.string().optional().describe('Only events on or after this ISO date'),
    search: z.string().optional().describe('Match artist or title'),
  },
  async ({ event, source, since, search }) => {
    const history = await sourcingModule('history');
    const rows = history.queryHistory({ event, source, since, search });
    return { content: [{ type: 'text', text: JSON.stringify({ path: history.historyPath(), count: rows.length, events: rows }, null, 2) }] };
  }
);

tool(
  'source_soundcloud_likes',
  'Walk the user\'s SoundCloud likes — or a SoundCloud set (playlist) given with `set` — and fetch every free download that is not already in the Rekordbox collection. Reads likes through the signed-in Chrome profile (or a public profile with `user`); reads a set publicly, falling back to the signed-in session when it is one of the user\'s own private sets. Checks ownership against Rekordbox, classifies each track as a native SoundCloud download, a gate (Hypeddit etc.), or not free, then downloads: native files through the session, gates by walking them in the same Chrome (Hypeddit is automated; other hosts need `assistSeconds` so the user can finish the gate by hand). Lossless files land in the intake folder; lossy ones are kept under lossy/ and flagged, never mixed in. A ledger makes re-runs incremental. Returns the session summary and the session JSON path — render it with render_sourcing_review.',
  {
    user: z.string().optional().describe('SoundCloud username or profile URL to read likes from publicly, instead of the signed-in session'),
    set: z.union([z.string(), z.array(z.string())]).optional().describe('SoundCloud set (playlist) URL, or several, to source instead of likes. Public sets need no sign-in; the user\'s own private sets are read through the signed-in session'),
    limit: z.number().optional().describe('Only the newest N likes, or the first N tracks of each set'),
    since: z.string().optional().describe('Only likes made on or after this ISO date (no effect on a set)'),
    listOnly: z.boolean().optional().describe('Classify and report only; download nothing'),
    noGates: z.boolean().optional().describe('Native SoundCloud downloads only; list gates without walking them'),
    dropLossy: z.boolean().optional().describe('Delete lossy files (MP3 etc.) the moment they arrive instead of keeping them under lossy/; the ledger still remembers them so the gate is not walked again'),
    dest: z.string().optional().describe('Folder for downloaded files (default: <organizeSourceDir>)'),
    assistSeconds: z.number().optional().describe('When a gate stalls, wait this long for the user to finish it in the Chrome window (default 0 = record it and move on)'),
    email: z.string().optional().describe('Email address to give gates that demand one. Defaults to the one the user saved in Track Lab\'s Settings → SoundCloud (saving it is their go-ahead for every run); with none saved and none given, email gates are skipped'),
    scActions: z.string().optional().describe('Account actions a gate may perform for real: "follow,like,comment" (default), add "repost" to allow reposts, or "none"'),
    comment: z.string().optional().describe('Comment text for gates that ask for one, for this run only (default: the gateComment saved in Settings)'),
    resume: z.string().optional().describe('Path of an earlier session JSON; its pending rows are fetched and gates that stalled are retried'),
  },
  async ({ user, set, limit, since, listOnly, noGates, dropLossy, dest, assistSeconds, email, scActions, comment, resume }) => oneAtATime(async () => {
    const args = [path.join(SOURCING_ROOT, 'bin', 'source-soundcloud-likes.mjs')];
    if (user) args.push('--user', user);
    for (const u of ([] as string[]).concat(set || [])) args.push('--set', u);
    if (limit) args.push('--limit', String(limit));
    if (since) args.push('--since', since);
    if (listOnly) args.push('--list-only');
    if (noGates) args.push('--no-gates');
    if (dropLossy) args.push('--drop-lossy');
    if (dest) args.push('--dest', dest);
    if (assistSeconds) args.push('--assist', String(assistSeconds));
    if (email) args.push('--email', email);
    if (scActions) args.push('--sc-actions', scActions);
    if (comment) args.push('--comment', comment);
    if (resume) args.push('--resume', resume);

    // The script launches Chrome on the same store profiles; let go of ours first.
    await releaseSharedBrowsers();
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    try {
      // Gates are walked one at a time and may wait on the user; give it an hour.
      const { stdout, stderr } = await execFileAsync(process.execPath, args, {
        cwd: SOURCING_ROOT,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60 * 60 * 1000,
      });
      const sessionPath = stdout.trim().split('\n').pop() || '';
      const session = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
      const brief = (r: any) => ({ artist: r.artist, title: r.title, url: r.url, free: r.free?.kind, gate: r.free?.gate?.host || null, status: r.outcome?.status || 'pending', reason: r.outcome?.reason || null, files: (r.outcome?.files || []).map((f: any) => ({ path: f.path, codec: f.codec || f.ext, lossless: f.lossless })) });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          sessionPath,
          destDir: session.destDir,
          source: session.source,
          stats: session.stats,
          downloaded: session.downloaded.map(brief),
          flagged: session.flagged.map(brief),
          dropped: (session.dropped || []).map(brief),
          queue: session.queue.map(brief),
          probable: session.probable.map((r: any) => ({ artist: r.artist, title: r.title, reason: r.reason, confidence: r.libraryConfidence, match: r.libraryMatch })),
          notFree: session.notFree.map((r: any) => ({ artist: r.artist, title: r.title, reason: r.free?.reason })),
          progressLog: stderr.trim().split('\n').slice(-25),
        }, null, 2) }]
      };
    } catch (err) {
      const e = err as { message?: string; stderr?: string };
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e.message, stderr: (e.stderr || '').slice(-2000) }) }] };
    }
  })
);

// ---------------------------------------------------------------------------
// The logs: what the app and these tools did (no app needed)
// ---------------------------------------------------------------------------
//
// logs/main.log and logs/mcp.log are the text logs; logs/ops holds every
// operation (a window action, a tool call, a queue job, a socket request) with
// who asked, its arguments, progress, output, log lines and outcome. They are
// read straight from disk, so they answer even while Track Lab is closed or
// after it crashed.

const OP_STATUSES = ['ok', 'error', 'running', 'interrupted'] as const;
const OP_SOURCES = ['ui', 'claude', 'cli', 'job', 'app'] as const;

tool(
  'app_status',
  'Is Track Lab running, what is it doing right now (work in progress, queue jobs), where does everything live (config, library, intake, archive, logs, write journal), and what failed lately. Never starts the app. Start here when asked what the app is doing or why something went wrong.',
  {},
  async () => {
    let app: unknown;
    try {
      const bridge = await storeBridgeModule();
      const opts = { launch: false, timeoutMs: 15_000, meta: bridgeMeta() };
      const status = await bridge.callApp('appStatus', {}, opts);
      // Whether origin/main has commits this checkout doesn't.
      const update = await bridge.callApp('invoke', { channel: 'get-update-state', args: [] }, opts).catch(() => null);
      app = { running: true, ...status, update };
    } catch (err) {
      app = { running: false, note: (err as Error).message };
    }
    const since = new Date(Date.now() - 24 * 3600_000);
    const lastStart = listOps(OPS_DIR, { name: 'app:start', since: new Date(Date.now() - 30 * 86_400_000), limit: 1 })[0];
    return reply({
      app,
      profile: activeProfile(),
      lastAppStart: lastStart?.startedAt ?? null,
      runningOperations: listOps(OPS_DIR, { status: 'running', since, limit: 20 }),
      failedLast24h: listOps(OPS_DIR, { status: 'error', since, limit: 10 }),
      interruptedLast24h: listOps(OPS_DIR, { status: 'interrupted', since, limit: 10 }),
      logs: { dir: LOGS_DIR, appLog: path.join(LOGS_DIR, 'main.log'), mcpLog: path.join(LOGS_DIR, 'mcp.log'), operations: OPS_DIR, writeJournal: getWriteJournalDir() },
    });
  }
);

tool(
  'app_logs',
  'The text log of Track Lab (process "app", the default) or of these MCP tools ("mcp"): every logged line, debug and up, newest last. Each line logged during an operation starts with its id ([app-…]), which get_operation expands. Filter by level, text or time.',
  {
    process: z.enum(['app', 'mcp']).optional().describe('Whose log (default app)'),
    level: z.enum(['error', 'warn', 'info', 'debug']).optional().describe('This level or more severe (default: all)'),
    search: z.string().optional().describe('Only entries containing this text (case-insensitive)'),
    since: z.string().optional().describe('Only entries at or after this ISO time'),
    lines: z.number().optional().describe('How many entries (default 100)'),
  },
  async ({ process: which, level, search, since, lines }) => {
    const files = textLogFiles(LOGS_DIR, which === 'mcp' ? 'mcp' : 'main');
    const entries = readTextLog(files, { level, search, since, lines });
    return reply({ files, count: entries.length, entries });
  }
);

tool(
  'list_operations',
  'Operations Track Lab and these tools ran, newest first: every action Ben took in the window (source "ui"), every tool call and the app work it caused ("claude"), scripts over the app\'s socket ("cli"), queue jobs, and app events (app:start, window:crashed). Each has its name, label, status (ok, error, running, interrupted = the process died mid-way), timing, arguments, result summary and counts of its progress/output/log lines. Defaults to the last 7 days, 50 operations.',
  {
    since: z.string().optional().describe('Started at or after this ISO time (default 7 days ago)'),
    until: z.string().optional().describe('Started at or before this ISO time'),
    name: z.string().optional().describe('Name or label contains this, e.g. "organize", "upgrade-swap", "job:", "search_beatport"'),
    source: z.enum(OP_SOURCES).optional().describe('Who asked'),
    status: z.enum(OP_STATUSES).optional(),
    search: z.string().optional().describe('Text anywhere in the operation: arguments, output, log lines, error (a file name, a track title)'),
    parent: z.string().optional().describe('Only operations started by this one'),
    limit: z.number().optional().describe('Default 50'),
  },
  async (q) => reply({ dir: OPS_DIR, operations: listOps(OPS_DIR, { ...q, status: q.status as OpStatus | undefined }) })
);

tool(
  'get_operation',
  'One operation in full: its summary, every event in order (start, label, state, progress, output, log, end), and the operations it started (a tool call\'s work in the app, a job\'s steps). Very long operations keep their first and last events.',
  {
    id: z.string().describe('Operation id from list_operations or a log line, e.g. app-mf3k2x1-1a'),
    events: z.array(z.enum(['start', 'label', 'state', 'progress', 'output', 'log', 'end'])).optional().describe('Only these kinds of event'),
    limit: z.number().optional().describe('Most events to return (default 500)'),
  },
  async ({ id, events, limit }) => {
    const op = getOp(OPS_DIR, id, { events, limit });
    return reply(op ?? { error: `No operation ${id} in ${OPS_DIR} (they are kept 30 days)` });
  }
);

tool(
  'write_journal',
  'The write journal: every file Track Lab moved, deleted (to the Trash), converted, re-tagged, header-repaired, or every Rekordbox XML it rewrote, with before/after paths, sizes, which feature did it and whether it worked. Newest first. Use it to trace where a file went.',
  {
    since: z.string().optional().describe('At or after this ISO time'),
    op: z.enum(['move', 'delete', 'convert', 'tag-write', 'header-repair', 'xml-rewrite']).optional(),
    outcome: z.enum(['ok', 'error']).optional(),
    search: z.string().optional().describe('Text in the entry: a path, artist or title'),
    limit: z.number().optional().describe('Default 100'),
  },
  async (q) => {
    const dir = getWriteJournalDir();
    return reply(dir ? { dir, entries: queryWriteJournal(dir, q) } : { error: 'The write journal is not set up' });
  }
);

// ---------------------------------------------------------------------------
// Everything else the app does (src/lib/mcpParity.ts maps each action)
// ---------------------------------------------------------------------------
//
// These run the window's own IPC actions inside Track Lab, over its socket
// (bridge `invoke`): one implementation, one set of rules (lossless only,
// deleted stays deleted, never overwrite, Trash not unlink) and one operations
// log for Ben and for Claude. Track Lab is started when it's closed. Actions
// that need the window (pickers, the store panel's checkout) aren't here.

const resultsDir = () => path.join(LOGS_DIR, 'results');
const MAX_INLINE_CHARS = 60_000;

type ToolReply = { content: Array<{ type: 'text'; text: string }> };

/** JSON for Claude. A result too big to read inline is saved whole under
 *  logs/results and summarized, with the path to read or jq. */
async function reply(body: unknown): Promise<ToolReply> {
  const text = JSON.stringify(body, null, 2) ?? 'null';
  if (text.length <= MAX_INLINE_CHARS) return { content: [{ type: 'text', text }] };
  await fs.mkdir(resultsDir(), { recursive: true });
  const file = path.join(resultsDir(), `${currentOp()?.id ?? Date.now()}.json`);
  await fs.writeFile(file, text, 'utf8');
  return {
    content: [{ type: 'text', text: JSON.stringify({
      note: `The full result is ${Math.round(text.length / 1024)} KB, saved to resultPath; this is a summary. Read or jq the file for the rest.`,
      resultPath: file,
      summary: summarize(body, { maxItems: 12, maxString: 300, maxDepth: 5 }),
    }, null, 2) }],
  };
}

/** Run one of the window's actions in Track Lab; resolves with its result and
 *  the progress it reported. */
async function invokeApp(channel: string, args: unknown[] = [], timeoutMs = 60 * 60_000): Promise<{ result: unknown; progress: string[] }> {
  const progress: string[] = [];
  const result = await (await storeBridgeModule()).callApp('invoke', { channel, args }, {
    timeoutMs,
    meta: bridgeMeta(),
    onProgress: (m) => {
      progress.push(m);
      if (progress.length > 300) progress.shift();
    },
  });
  return { result, progress };
}

/** A tool's whole job: run an action and reply with its result (plus the last
 *  progress lines, when it reported any). */
async function runApp(channel: string, args: unknown[] = [], opts: { timeoutMs?: number; tail?: number } = {}): Promise<ToolReply> {
  try {
    const { result, progress } = await invokeApp(channel, args, opts.timeoutMs);
    const tail = opts.tail ?? 20;
    return reply(progress.length && tail > 0 ? { result, progressLog: progress.slice(-tail) } : result);
  } catch (err) {
    return reply({ error: (err as Error).message, hint: 'list_operations and app_logs show what Track Lab did' });
  }
}

/** Secrets stay "[redacted]" in anything that echoes the settings back. */
const redactAll = (v: unknown) => summarize(v, { maxString: 100_000, maxItems: 100_000, maxDepth: 20, maxKeys: 1000 });

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined || value === null || value === '') throw new Error(`${what} is required for this action`);
  return value;
}

/** For actions whose arguments are checked per action. */
async function guarded(fn: () => Promise<ToolReply>): Promise<ToolReply> {
  try {
    return await fn();
  } catch (err) {
    return reply({ error: (err as Error).message });
  }
}

const anyRows = z.array(z.record(z.string(), z.unknown()));

// ---------- Settings and connections ----------

tool(
  'get_settings',
  'Track Lab\'s settings (Settings page): library root, intake folder (organizeSourceDir), archive, store accounts, Claude model, and the rest, plus the config file path. Secrets show as "[redacted]".',
  {},
  async () => guarded(async () => {
    const [config, configPath, libraryRoot] = await Promise.all([
      invokeApp('get-config'), invokeApp('get-config-path'), invokeApp('get-library-root'),
    ]);
    return reply({ configPath: configPath.result, libraryRoot: libraryRoot.result, config: redactAll(config.result) });
  })
);

tool(
  'update_settings',
  'Change Track Lab settings, as saving the Settings page does: only the keys given change (names as get_settings shows them). Confirm with Ben before changing folders or accounts.',
  { changes: z.record(z.string(), z.unknown()).describe('Settings to change, e.g. {"organizeSourceDir": "/Volumes/…"}') },
  async ({ changes }) => guarded(async () => reply({ config: redactAll((await invokeApp('update-config', [changes])).result) }))
);

/** The app's profile list without starting it: over the socket when Track
 *  Lab is up, else read from profiles.json (it opens in the default). */
async function profilesNow(): Promise<{ appRunning: boolean; running: string | null; defaultId: string; profiles: unknown[] }> {
  try {
    const bridge = await storeBridgeModule();
    const state = await bridge.callApp('invoke', { channel: 'profiles:list', args: [] }, { launch: false, timeoutMs: 10_000, meta: bridgeMeta() }) as { running: string; defaultId: string; profiles: unknown[] };
    return { appRunning: true, ...state };
  } catch {
    const root = process.env.CANDYBAR_PROFILES_ROOT || defaultProfilesRoot();
    const reg = readRegistry(root);
    return { appRunning: false, running: null, defaultId: reg.defaultId, profiles: listProfiles(root, '').map(({ isRunning: _r, ...p }) => p) };
  }
}

tool(
  'profiles',
  'Track Lab profiles. Each profile is one person\'s data: settings and library, SoundCloud/Spotify/store sign-ins, the email gates get, download ledger and history. "list" shows them, which one Track Lab is running and which is the default (the one it opens in). From Claude Code or Claude Desktop with more than one profile, ALWAYS ask Ben which profile to use before anything else, then "switch" to it if it isn\'t running. Track Lab swaps to it in place, without restarting. "create" adds one, which Ben fills in through the setup guide after switching. "rename", "set_default", and "delete" also exist. Delete sends the profile\'s folder to the Trash, and never works on the running profile or the original one.',
  {
    action: z.enum(['list', 'create', 'switch', 'rename', 'set_default', 'delete']),
    profile: z.string().optional().describe('Profile id or name (switch, rename, set_default, delete)'),
    name: z.string().optional().describe('The name (create, rename)'),
    switchTo: z.boolean().optional().describe('create: switch to it straight away'),
  },
  async ({ action, profile, name, switchTo }) => guarded(async () => {
    if (action === 'list') return reply(await profilesNow());
    if (action === 'create') return runApp('profiles:create', [{ name: need(name, 'name'), switchTo: switchTo ?? false }]);
    if (action === 'rename') return runApp('profiles:rename', [{ id: need(profile, 'profile'), name: need(name, 'name') }]);
    if (action === 'set_default') return runApp('profiles:set-default', [{ id: need(profile, 'profile') }]);
    if (action === 'delete') return runApp('profiles:delete', [{ id: need(profile, 'profile') }]);
    const asked = (await invokeApp('profiles:switch', [{ id: need(profile, 'profile') }])).result as { switched: boolean; profile: { id: string; name: string }; reason?: string };
    return reply({ ...asked, state: await profilesNow() });
  })
);

tool(
  'connections',
  'Accounts and connections: Qobuz and Beatport accounts (each signed in or not), SoundCloud, Spotify credentials, Claude Code and Splice ("status"); sign one store account in (opens its sign-in window) or out. store_login signs in every account of a store at once.',
  {
    action: z.enum(['status', 'sign_in_account', 'sign_out_account']),
    store: z.enum(['qobuz', 'beatport']).optional().describe('For sign_in_account / sign_out_account'),
    accountId: z.string().optional().describe('The account\'s id, from status'),
  },
  async ({ action, store, accountId }) => guarded(async () => {
    if (action === 'status') {
      const settle = async (p: Promise<{ result: unknown }>) => p.then((r) => r.result, (e: Error) => ({ error: e.message }));
      const [stores, soundcloud, spotify, claude, splice] = await Promise.all([
        askApp('status', {}).catch((e: Error) => ({ error: e.message })),
        settle(invokeApp('soundcloud-sign-in-status')),
        settle(invokeApp('check-spotify')),
        settle(invokeApp('claude-status')),
        settle(invokeApp('splice-login-status')),
      ]);
      return reply({ stores, soundcloud, spotifyCredentialsWork: spotify, claude, splice });
    }
    const s = need(store, 'store');
    const id = need(accountId, 'accountId');
    if (action === 'sign_out_account') return runApp('store-logout-account', [{ store: s, accountId: id }]);
    const status = await askApp<Record<string, Array<{ id: string; label: string }>>>('status', {});
    const account = status[s]?.find((a) => a.id === id);
    if (!account) throw new Error(`No ${s} account ${id}; connections status lists them`);
    return runApp('store-login-account', [{ store: s, account: { id: account.id, label: account.label } }], { timeoutMs: 15 * 60_000 });
  })
);

tool(
  'scan_cache',
  'The library scan cache: how fresh it is ("status"), or clear it so the next scan reads every file again ("clear").',
  { action: z.enum(['status', 'clear']) },
  async ({ action }) => runApp(action === 'status' ? 'get-cache-status' : 'clear-cache')
);

tool(
  'storage_stats',
  'How much space the library, intake folder, archive and app data take, and what\'s free on their drives.',
  {},
  async () => runApp('get-storage-stats', [], { timeoutMs: 10 * 60_000 })
);

// ---------- What's in the library ----------

tool(
  'check_playlist_ownership',
  'Check a Spotify playlist or a CSV against the Rekordbox collection: which tracks Ben owns, which might match (uncertain), which are missing, with ignored tracks marked. No store search; find_sources adds that.',
  {
    spotifyPlaylistUrl: z.string().optional(),
    csvPath: z.string().optional().describe('Absolute path to a CSV (Exportify or any artist/title list)'),
  },
  async ({ spotifyPlaylistUrl, csvPath }) => runApp('check-library', [{ spotifyPlaylistUrl, csvPath }])
);

tool(
  'preview_csv',
  'Read a CSV the way Track Lab will: which columns it takes as artist/title/album, the row count and the first rows.',
  { csvPath: z.string() },
  async ({ csvPath }) => runApp('preview-csv', [{ csvPath }])
);

tool(
  'ignored_tracks',
  'Tracks Ben chose to ignore in checks and sourcing: list them, ignore one, or un-ignore one. `key` is the track key in check_playlist_ownership / find_sources results.',
  {
    action: z.enum(['list', 'ignore', 'unignore']),
    key: z.string().optional(),
    artist: z.string().optional().describe('For ignore'),
    title: z.string().optional().describe('For ignore'),
  },
  async ({ action, key, artist, title }) => guarded(async () => {
    if (action === 'list') return runApp('get-ignored-tracks');
    if (action === 'unignore') return runApp('unignore-track', [{ key: need(key, 'key') }]);
    return runApp('ignore-track', [{ key: need(key, 'key'), artist: need(artist, 'artist'), title: need(title, 'title') }]);
  })
);

tool(
  'dismissed_issues',
  'Library health issues and duplicate pairs Ben dismissed ("not a problem"): list the dismissed issues, dismiss or restore one, or dismiss a duplicate pair.',
  {
    action: z.enum(['list', 'dismiss_issue', 'undismiss_issue', 'dismiss_duplicate']),
    filePath: z.string().optional().describe('For dismiss_issue / undismiss_issue'),
    issueCode: z.string().optional().describe('The issue code from library_health, for dismiss_issue / undismiss_issue'),
    libraryRoot: z.string().optional().describe('Default: the library root in settings'),
    track1Artist: z.string().optional(), track1Title: z.string().optional(),
    track2Artist: z.string().optional(), track2Title: z.string().optional(),
  },
  async (a) => guarded(async () => {
    if (a.action === 'dismiss_duplicate') {
      return runApp('dismiss-duplicate', [{
        track1Artist: need(a.track1Artist, 'track1Artist'), track1Title: need(a.track1Title, 'track1Title'),
        track2Artist: need(a.track2Artist, 'track2Artist'), track2Title: need(a.track2Title, 'track2Title'),
      }]);
    }
    const libraryRoot = a.libraryRoot || String((await invokeApp('get-library-root')).result);
    if (a.action === 'list') return runApp('get-dismissed-issues', [{ libraryRoot }]);
    const args = { libraryRoot, filePath: need(a.filePath, 'filePath'), issueCode: need(a.issueCode, 'issueCode') };
    return runApp(a.action === 'dismiss_issue' ? 'dismiss-health-issue' : 'undismiss-health-issue', [args]);
  })
);

tool(
  'rekordbox_collection',
  'The Rekordbox collection: "find_missing" lists collection tracks whose files are gone; "import" reads the collection into Track Lab\'s library; "resync" re-reads it after changes in Rekordbox.',
  { action: z.enum(['find_missing', 'import', 'resync']) },
  async ({ action }) => runApp({ find_missing: 'rekordbox-scan', import: 'rekordbox-import', resync: 'rekordbox-resync' }[action], [], { timeoutMs: 30 * 60_000 })
);

tool(
  'library_health',
  'The Library page\'s health scan: every track in the library root checked for problems DJ gear chokes on (format, sample rate, broken headers, missing tags or art, duplicates) with an issue code per problem. Uses the cache unless useCache is false. Large; the full result is saved to a file.',
  { useCache: z.boolean().optional().describe('Default true') },
  async ({ useCache }) => runApp('scan-library-health', [{ useCache: useCache ?? true, cacheOnly: false }], { timeoutMs: 60 * 60_000 })
);

tool(
  'album_art_scan',
  'Find library tracks without embedded album art.',
  {},
  async () => runApp('scan-missing-album-art', [], { timeoutMs: 30 * 60_000 })
);

// ---------- Exports ----------

tool(
  'export_tracks',
  'Write tracks to a file: "csv" (artist, title, album, genre), "m3u8" playlist (grouped by artist; rows need filePath), "rekordbox_xml" playlist Rekordbox can import (rows need filePath; give playlistName), or "text" (write `content` as-is, e.g. a sourcing CSV).',
  {
    format: z.enum(['csv', 'm3u8', 'rekordbox_xml', 'text']),
    filePath: z.string().describe('Absolute path to write'),
    tracks: z.array(z.object({
      artist: z.string(), title: z.string(),
      album: z.string().optional(), genre: z.string().optional(),
      filePath: z.string().optional(), duration: z.number().optional(),
    })).optional(),
    playlistName: z.string().optional().describe('For rekordbox_xml'),
    content: z.string().optional().describe('For text'),
  },
  async ({ format, filePath, tracks, playlistName, content }) => guarded(async () => {
    if (format === 'text') return runApp('source-export-csv', [{ content: need(content, 'content'), filePath }]);
    const rows = need(tracks, 'tracks');
    if (format === 'csv') return runApp('export-tracks-csv', [{ tracks: rows, filePath }]);
    if (format === 'm3u8') return runApp('export-playlist-m3u8', [{ tracks: rows, filePath }]);
    return runApp('export-playlist-rekordbox', [{ tracks: rows, filePath, playlistName: playlistName || path.basename(filePath, path.extname(filePath)) }]);
  })
);

tool(
  'export_catalog',
  'Export the whole library catalog (every track with its tags and file details) to a JSON file.',
  { outputPath: z.string().describe('Absolute path of the JSON to write') },
  async ({ outputPath }) => runApp('export-catalog', [{ outputPath }], { timeoutMs: 30 * 60_000 })
);

// ---------- Searching and sourcing ----------

tool(
  'search_music',
  'The Search page: look a track up on Spotify, SoundCloud, Beatport and Qobuz at once.',
  {
    query: z.string(),
    sources: z.array(z.enum(['spotify', 'soundcloud', 'beatport', 'qobuz'])).optional().describe('Default: all four'),
  },
  async ({ query, sources }) => runApp('search-music', [{ query, sources: sources ?? ['spotify', 'soundcloud', 'beatport', 'qobuz'] }])
);

tool(
  'find_sources',
  'Find & buy, as the Sources tab runs it inside Track Lab: read a Spotify playlist, CSV or SoundCloud set, check it against Rekordbox, and find lossless store copies of what\'s missing (Beatport before Qobuz; lossy matches excluded). Returns owned / probable / store matches / not found. source_playlist is the script version of the same search.',
  {
    spotifyPlaylistUrl: z.string().optional(),
    csvPath: z.string().optional(),
    soundcloudSetUrl: z.string().optional(),
  },
  async ({ spotifyPlaylistUrl, csvPath, soundcloudSetUrl }) => runApp('library-sourcing:run', [{ spotifyPlaylistUrl, csvPath, soundcloudSetUrl }], { timeoutMs: 60 * 60_000 })
);

tool(
  'saved_sources',
  'Playlists and sets saved on the Sources tab with what their last check found: list them, save one (as find_sources results describe it), rename or remove one.',
  {
    action: z.enum(['list', 'save', 'rename', 'remove']),
    id: z.number().optional().describe('For rename / remove'),
    name: z.string().optional().describe('For rename'),
    source: z.object({
      kind: z.enum(['spotify', 'soundcloud', 'csv']),
      ref: z.string().describe('Playlist URL or CSV path'),
      name: z.string(),
      imageUrl: z.string().nullable().optional(),
      owner: z.string().optional(),
      trackCount: z.number(),
      counts: z.record(z.string(), z.number()).describe('{toBuy, maybeOwned, owned, …} from the check'),
      checkedAt: z.number().optional(),
    }).optional().describe('For save'),
    keepExisting: z.boolean().optional().describe('For save: keep an existing entry\'s name'),
  },
  async ({ action, id, name, source, keepExisting }) => guarded(async () => {
    if (action === 'list') return runApp('saved-sources:list');
    if (action === 'save') return runApp('saved-sources:save', [need(source, 'source'), { keepExisting }]);
    if (action === 'rename') return runApp('saved-sources:update', [{ id: need(id, 'id'), name }]);
    return runApp('saved-sources:remove', [{ id: need(id, 'id') }]);
  })
);

// ---------- Lossless upgrades ----------

tool(
  'lossless_upgrade',
  'The Lossless Upgrades page: list Rekordbox playlists; check one ("check_playlist") for lossy tracks with a lossless copy on disk, free (SoundCloud / Bandcamp) or in a store; fetch the free downloads for chosen tracks ("fetch_free", by Rekordbox id); or stop a fetch. A row\'s free.soundcloudMisses say why a close SoundCloud upload was passed over (no download, another version, another length); free.soundcloud.gateInfo says what a download page gives (WAV/MP3) and asks for. "use_link" sets a free download link Ben found himself for one row (a SoundCloud page or the download page, e.g. an ipln.io link): it is checked against his copy, kept across checks, and fetched first; "forget_link" drops it. Swapping the new files in is upgrade_swap.',
  {
    action: z.enum(['list_playlists', 'check_playlist', 'fetch_free', 'stop_fetch', 'use_link', 'forget_link']),
    playlistId: z.string().optional().describe('For check_playlist, from list_playlists'),
    rbIds: z.array(z.string()).optional().describe('For fetch_free: Rekordbox track ids from check_playlist'),
    rbId: z.string().optional().describe('For use_link / forget_link: one Rekordbox track id from check_playlist'),
    url: z.string().optional().describe('For use_link: the SoundCloud track page or download page link'),
    accountActions: z.boolean().optional().describe('For fetch_free: let gates follow/like/comment with the SoundCloud account'),
  },
  async ({ action, playlistId, rbIds, rbId, url, accountActions }) => guarded(async () => {
    if (action === 'list_playlists') return runApp('lossless-upgrade:list-playlists');
    if (action === 'stop_fetch') return runApp('lossless-upgrade:fetch-free-stop');
    if (action === 'use_link') return runApp('lossless-upgrade:use-link', [{ rbId: need(rbId, 'rbId'), url: need(url, 'url') }], { timeoutMs: 60_000 });
    if (action === 'forget_link') return runApp('lossless-upgrade:forget-link', [{ rbId: need(rbId, 'rbId') }]);
    if (action === 'check_playlist') return runApp('lossless-upgrade:run', [{ playlistId: need(playlistId, 'playlistId') }], { timeoutMs: 60 * 60_000 });
    return runApp('lossless-upgrade:fetch-free', [{ rbIds: need(rbIds, 'rbIds'), accountActions }], { timeoutMs: 2 * 60 * 60_000 });
  })
);

tool(
  'upgrade_swap',
  'Replace in Rekordbox: swap lossless files in for lossy ones while keeping each track\'s row (cues, grid, playlists, play count, date added). "preflight" checks Rekordbox is closed and backups work; "plan" shows what each swap keeps and how the audio lines up; "apply" writes master.db (after a backup). Only apply what Ben approved from a plan.',
  {
    action: z.enum(['preflight', 'plan', 'apply']),
    inputs: z.array(z.object({ rbId: z.string(), newFilePath: z.string() })).optional().describe('For plan'),
    rbIds: z.array(z.string()).optional().describe('For apply: ids from the plan whose action is "swap"'),
  },
  async ({ action, inputs, rbIds }) => guarded(async () => {
    if (action === 'preflight') return runApp('upgrade-swap:preflight');
    if (action === 'plan') return runApp('upgrade-swap:plan', [{ inputs: need(inputs, 'inputs') }], { timeoutMs: 30 * 60_000 });
    return runApp('upgrade-swap:apply', [{ rbIds: need(rbIds, 'rbIds') }], { timeoutMs: 30 * 60_000 });
  })
);

// ---------- Stores ----------

tool(
  'store_cart_add',
  'Add store matches (from find_sources) to the real Qobuz or Beatport cart of the signed-in Track Lab account. Lossy matches are refused. Nothing is bought; Ben checks out himself.',
  {
    store: z.enum(['qobuz', 'beatport']),
    matches: anyRows.describe('Store matches as find_sources returns them'),
  },
  async ({ store, matches }) => runApp('store-cart-add', [{ matches, source: store }], { timeoutMs: 30 * 60_000 })
);

tool(
  'store_cart_check',
  'Which of these tracks are already in the Qobuz or Beatport cart of the first Track Lab account. `known: false` means the cart couldn\'t be read (and why).',
  {
    store: z.enum(['qobuz', 'beatport']),
    items: z.array(z.object({ trackId: z.string(), articleId: z.string().optional() })).describe('Track ids (and Qobuz article ids) from store matches'),
  },
  async ({ store, items }) => runApp('store-cart-check', [{ store, items }])
);

tool(
  'download_purchases',
  'Download purchased tracks (store matches Ben owns, from find_sources or list_purchases) into the intake folder through the accounts that bought them: lossless converted to AIFF, lossy kept apart, never overwriting, never re-fetching something Ben deleted. download_track does a single track.',
  { matches: anyRows.describe('Store matches with source and trackId') },
  async ({ matches }) => runApp('store-download-purchases', [{ matches }], { timeoutMs: 2 * 60 * 60_000 })
);

// ---------- Tracks and files ----------

tool(
  'scan_intake',
  'Sort new music: scan the intake folder (or another folder) and read every track\'s tags, format and health, ready for organize_tracks and autopopulate_tags.',
  { sourceDir: z.string().optional().describe('Default: the intake folder (organizeSourceDir) in settings') },
  async ({ sourceDir }) => guarded(async () => {
    const dir = sourceDir || ((await invokeApp('get-config')).result as { organizeSourceDir?: string })?.organizeSourceDir;
    return runApp('scan-tracks', [{ sourceDir: need(dir, 'sourceDir (no intake folder is set)') }], { timeoutMs: 30 * 60_000 });
  })
);

tool(
  'track_info',
  'One file\'s tags, format, DJ data and health as the track info editor shows it. With includeArt, its album art is saved to a file and the path returned.',
  { filePath: z.string(), includeArt: z.boolean().optional() },
  async ({ filePath, includeArt }) => guarded(async () => {
    const info = (await invokeApp('get-track-info', [{ filePath }])).result;
    if (!includeArt) return reply(info);
    const art = (await invokeApp('get-track-album-art', [{ filePath }])).result as string | null;
    let artPath: string | null = null;
    const m = art && /^data:image\/(\w+);base64,(.*)$/s.exec(art);
    if (m) {
      await fs.mkdir(resultsDir(), { recursive: true });
      artPath = path.join(resultsDir(), `art-${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
      await fs.writeFile(artPath, Buffer.from(m[2], 'base64'));
    }
    return reply({ info, artPath });
  })
);

tool(
  'update_track_tags',
  'Write tags to a file, as saving the track info editor does (journaled; may rewrite the file). Only the tags given change.',
  {
    filePath: z.string(),
    title: z.string().optional(), artist: z.string().optional(), album: z.string().optional(),
    year: z.string().optional(), genre: z.string().optional(), label: z.string().optional(),
    key: z.string().optional(), bpm: z.string().optional(), remixer: z.string().optional(),
    comment: z.string().optional(),
    albumArt: z.string().optional().describe('Path to an image to embed'),
  },
  async (params) => runApp('update-track-tags', [params])
);

tool(
  'autopopulate_tags',
  'Fill in missing tags (album, year, genre, label, key, BPM, art) from Spotify and the stores for tracks from scan_intake. Already-filled tracks are skipped unless force.',
  { tracks: anyRows.describe('Rows from scan_intake'), force: z.boolean().optional() },
  async ({ tracks, force }) => runApp('autopopulate-tracks', [{ tracks, force }], { timeoutMs: 60 * 60_000 })
);

tool(
  'aiff_header',
  'AIFF files whose header says "compressed" when they aren\'t (CDJs refuse them): "diagnose" one, or "repair" it in place (journaled).',
  { action: z.enum(['diagnose', 'repair']), filePath: z.string() },
  async ({ action, filePath }) => runApp(action === 'diagnose' ? 'diagnose-aiff-header' : 'repair-aiff-header', [filePath])
);

tool(
  'track_file',
  'Act on one audio file as the Library page does: "convert_to_aiff" (new AIFF beside it), "fix" (convert to AIFF for DJ gear; deleteOriginal moves the old file to the Trash), "reencode_mp3" (320 kbps), "archive" (move into the archive), "delete" (to the Trash). All journaled; confirm deletes with Ben.',
  {
    action: z.enum(['convert_to_aiff', 'fix', 'reencode_mp3', 'archive', 'delete']),
    filePath: z.string(),
    deleteOriginal: z.boolean().optional().describe('For fix / reencode_mp3 (default false)'),
  },
  async ({ action, filePath, deleteOriginal }) => {
    const channel = { convert_to_aiff: 'convert-track', fix: 'fix-track-file', reencode_mp3: 'reencode-track-file', archive: 'archive-track-file', delete: 'delete-track-file' }[action];
    const args = action === 'fix' || action === 'reencode_mp3' ? { filePath, deleteOriginal: deleteOriginal ?? false } : { filePath };
    return runApp(channel, [args], { timeoutMs: 15 * 60_000 });
  }
);

tool(
  'organize_tracks',
  'Organize by artist: move scanned intake tracks into the library (Artist/Title), skipping ignored ones and reporting conflicts with files already there; then settle a conflict by keeping the incoming or the existing file. Moves are journaled.',
  {
    action: z.enum(['organize', 'resolve_conflict']),
    tracks: z.array(z.object({ filePath: z.string(), ignored: z.boolean().optional(), isHealthy: z.boolean().optional() })).optional().describe('For organize: rows from scan_intake'),
    incomingPath: z.string().optional(), existingPath: z.string().optional(), targetPath: z.string().optional(),
    keep: z.enum(['incoming', 'existing']).optional(),
  },
  async (a) => guarded(async () => {
    if (a.action === 'organize') {
      const tracks = need(a.tracks, 'tracks').map((t) => ({ ...t, ignored: t.ignored ?? false }));
      return runApp('organize-tracks', [{ tracks }], { timeoutMs: 60 * 60_000 });
    }
    return runApp('organize-resolve-conflict', [{
      incomingPath: need(a.incomingPath, 'incomingPath'), existingPath: need(a.existingPath, 'existingPath'),
      targetPath: need(a.targetPath, 'targetPath'), keep: need(a.keep, 'keep'),
    }]);
  })
);

tool(
  'migrate_archive',
  'Move the archive folder somewhere else (every archived file, journaled) and point settings at the new place.',
  { oldPath: z.string(), newPath: z.string() },
  async ({ oldPath, newPath }) => runApp('migrate-archive', [{ oldPath, newPath }], { timeoutMs: 2 * 60 * 60_000 })
);

tool(
  'reveal',
  'Show a file in Finder, or open a web page in Ben\'s browser.',
  { filePath: z.string().optional(), url: z.string().optional() },
  async ({ filePath, url: link }) => guarded(async () => (filePath
    ? runApp('show-in-finder', [{ filePath }])
    : runApp('open-external', [{ url: need(link, 'filePath or url') }])))
);

// ---------- Jobs, drives, restore, Splice ----------

tool(
  'jobs',
  'Track Lab\'s job queue (library scans, USB health scans, catalog exports, Claude jobs): list jobs, enqueue one (optionally waiting for its result), wait for one, or cancel one. The window\'s Activity panel shows the same queue.',
  {
    action: z.enum(['list', 'enqueue', 'wait', 'cancel']),
    type: z.string().optional().describe('For enqueue: library-scan, library-health, album-art-scan, catalog-export, usb-health-scan, claude-ask, claude-track-tags, claude-soundcloud, …'),
    params: z.record(z.string(), z.unknown()).optional().describe('For enqueue: the job\'s parameters'),
    contextKey: z.string().optional().describe('For enqueue: groups shared results (default "claude")'),
    wait: z.boolean().optional().describe('For enqueue: wait for the result'),
    jobId: z.string().optional().describe('For wait / cancel'),
  },
  async ({ action, type, params, contextKey, wait, jobId }) => guarded(async () => {
    if (action === 'list') return runApp('job-list');
    if (action === 'wait') return runApp('job-wait', [{ jobId: need(jobId, 'jobId') }], { timeoutMs: 3 * 60 * 60_000 });
    if (action === 'cancel') return runApp('job-cancel', [{ jobId: need(jobId, 'jobId') }]);
    const job = { type: need(type, 'type'), params: params ?? {}, contextKey: contextKey || 'claude' };
    return wait ? runApp('job-enqueue-and-wait', [job], { timeoutMs: 3 * 60 * 60_000 }) : runApp('job-enqueue', [job]);
  })
);

tool(
  'volumes',
  'Drives: the mounted volumes Track Lab sees (the library drive flagged), hide one from the list ("exclude"), or the volumes a restore can pull from.',
  { action: z.enum(['list', 'exclude', 'list_for_restore']), name: z.string().optional().describe('For exclude: the volume name') },
  async ({ action, name }) => guarded(async () => {
    if (action === 'list') return runApp('list-volumes');
    if (action === 'list_for_restore') return runApp('restore-list-volumes');
    return runApp('exclude-volume', [{ name: need(name, 'name') }]);
  })
);

tool(
  'restore_library',
  'Restore missing tracks listed in a Rekordbox XML: copy them back from USB drives and re-download them from Beatport/Qobuz purchases into a staging folder, optionally rewriting the XML to point at them; or abort a running restore.',
  {
    action: z.enum(['run', 'abort']),
    options: z.object({
      xmlPath: z.string(),
      libraryRoot: z.string(),
      stageDir: z.string(),
      sources: z.object({ usb: z.boolean(), beatport: z.boolean(), qobuz: z.boolean(), soundcloud: z.boolean().optional() }),
      concurrency: z.number().optional(),
      usbVolumesAllowlist: z.array(z.string()).optional(),
      usbTagMatching: z.boolean().optional(),
      rewriteXml: z.boolean().optional(),
    }).optional().describe('For run'),
  },
  async ({ action, options }) => guarded(async () => {
    if (action === 'abort') return runApp('restore-abort');
    const o = need(options, 'options');
    return runApp('restore-run', [{ options: { ...o, concurrency: o.concurrency ?? 2, sources: { soundcloud: false, ...o.sources } } }], { timeoutMs: 6 * 60 * 60_000 });
  })
);

tool(
  'splice',
  'Splice recovery for an Ableton project: "status" / "sign_in"; "scan" an .als for missing samples; "classify" them into owned / buyable with credits / not found; "download_owned"; "credits_balance"; "buy_with_credits" (spends Ben\'s Splice credits; only with his go-ahead).',
  {
    action: z.enum(['status', 'sign_in', 'scan', 'classify', 'download_owned', 'credits_balance', 'buy_with_credits']),
    alsPath: z.string().optional().describe('For scan'),
    missing: anyRows.optional().describe('For classify: the missing samples from scan'),
    items: anyRows.optional().describe('For download_owned / buy_with_credits: rows from classify'),
  },
  async ({ action, alsPath, missing, items }) => guarded(async () => {
    switch (action) {
      case 'status': return runApp('splice-login-status');
      case 'sign_in': return runApp('splice-start-login', [], { timeoutMs: 15 * 60_000 });
      case 'scan': return runApp('splice-scan', [{ alsPath: need(alsPath, 'alsPath') }]);
      case 'classify': return runApp('splice-classify', [{ missing: need(missing, 'missing') }], { timeoutMs: 30 * 60_000 });
      case 'download_owned': return runApp('splice-download-owned', [{ items: need(items, 'items') }], { timeoutMs: 60 * 60_000 });
      case 'credits_balance': return runApp('splice-credits-balance');
      default: return runApp('splice-buy-credits', [{ items: need(items, 'items') }], { timeoutMs: 60 * 60_000 });
    }
  })
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Close the shared store windows when the client goes away.
  const shutdown = () => {
    flushOpLogSync();
    void releaseSharedBrowsers().catch(() => {}).finally(() => process.exit(0));
  };
  process.stdin.on('end', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('MCP server failed to start:', err);
  process.exit(1);
});
