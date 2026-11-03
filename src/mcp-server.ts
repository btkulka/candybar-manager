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
import { convertToAiff, reencodeToMp3, deleteOriginalAfterConversion } from './lib/trackConverter';
import * as mm from 'music-metadata';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import { readConfig, setSecretsPath } from './lib/config';
import url from 'url';

import { initWriteJournal, recordWrite } from './lib/writeJournal';

/** The Electron app's userData directory, worked out without Electron: the
 *  platform's app-data folder plus the app name ('candybar-manager'), exactly
 *  as app.getPath('userData') resolves it. */
function appUserDataDir(): string {
  const home = os.homedir();
  const name = 'candybar-manager';
  if (os.platform() === 'darwin') return path.join(home, 'Library', 'Application Support', name);
  if (os.platform() === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), name);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), name);
}

const USER_DATA_DIR = appUserDataDir();

// Share the Electron app's write journal so conversions/deletes driven via MCP
// land in the same recovery log.
initWriteJournal(USER_DATA_DIR);

const server = new McpServer({
  name: 'candybar-audio-tools',
  version: '0.1.0',
});

// ---------------------------------------------------------------------------
// Tool 1: check_health
// ---------------------------------------------------------------------------
server.tool(
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
server.tool(
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
server.tool(
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

server.tool(
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
server.tool(
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

function getConfigPaths(): { primary: string; fallback: string } {
  return {
    primary: path.join(USER_DATA_DIR, 'config.json'),
    fallback: path.join(__dirname, '..', '..', 'config.json')
  };
}

// Secrets live in userData beside config.json (the app moves them there on its
// first launch after the change). Until that has happened, the old repo-root
// copy is still the one with the credentials, so fall back to it.
const USER_SECRETS_PATH = path.join(USER_DATA_DIR, 'secrets.json');
const REPO_SECRETS_PATH = path.join(__dirname, '..', '..', 'secrets.json');
setSecretsPath(
  fsSync.existsSync(USER_SECRETS_PATH) || !fsSync.existsSync(REPO_SECRETS_PATH) ? USER_SECRETS_PATH : REPO_SECRETS_PATH
);

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

// Store accounts are reached by driving the user's real logged-in Chrome — see
// lib/sourcing/storeSession.mjs. There are deliberately no stored credentials
// here: the previous email/password paths died silently (Qobuz changed its auth,
// Beatport now 403s every non-browser client) and reported "0 purchases" rather
// than "signed out", which is worse than failing.
async function withStore<T>(
  open: 'qobuz' | 'beatport',
  fn: (page: any, mod: any) => Promise<T>
): Promise<T> {
  const mod = await sourcingModule('storeSession');
  const session = open === 'qobuz' ? await mod.openQobuz() : await mod.openBeatportSession();
  try {
    return await fn(session.page, mod);
  } finally {
    await session.close();
  }
}

const SIGN_IN_HINT = (store: string) =>
  `Not signed in to ${store}. Run the store_login tool for "${store}" — a Chrome window opens, you sign in once, and the session persists for future calls.`;

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim();
}

/** The container a downloaded file really is, from its first bytes. Store
 *  download URLs often carry no extension, and the old guess ("Qobuz means
 *  FLAC") would have named an MP3 `.flac`. */
async function sniffAudioExtension(filePath: string): Promise<string | null> {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(12);
    await fh.read(buf, 0, 12, 0);
    const ascii = (start: number, end: number) => buf.toString('latin1', start, end);
    if (ascii(0, 4) === 'fLaC') return 'flac';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
    if (ascii(0, 4) === 'FORM' && (ascii(8, 12) === 'AIFF' || ascii(8, 12) === 'AIFC')) return 'aiff';
    if (ascii(4, 8) === 'ftyp') return 'm4a';
    if (ascii(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'mp3';
    if (ascii(0, 4) === 'OggS') return 'ogg';
    return null;
  } finally {
    await fh.close();
  }
}

/** Move `src` to `dest` without ever replacing an existing file (link + unlink
 *  fails with EEXIST instead of clobbering), and journal it. */
async function moveNoClobber(src: string, dest: string, context: string, detail?: Record<string, unknown>): Promise<void> {
  const bytes = (await fs.stat(src).catch(() => null))?.size;
  try {
    await fs.link(src, dest);
    await fs.unlink(src);
    recordWrite({ op: 'move', src, dest, bytes, context, outcome: 'ok', detail });
  } catch (err) {
    recordWrite({ op: 'move', src, dest, bytes, context, outcome: 'error', error: (err as Error).message, detail });
    throw err;
  }
}

const AUDIO_EXTS_FOR_NAME = ['aif', 'aiff', 'wav', 'flac', 'mp3', 'm4a'];

// ---------------------------------------------------------------------------
// Tools 6-10: the stores
//
// Qobuz search is public, so it runs over plain HTTP. Everything that needs the
// user's account — Beatport search included, since Cloudflare 403s any
// non-browser client — runs through their real Chrome profile.
// ---------------------------------------------------------------------------

server.tool(
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

server.tool(
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

server.tool(
  'list_purchases',
  'List tracks already purchased on Qobuz and/or Beatport, read from the user\'s signed-in browser session (no stored credentials). Opens a Chrome window. If a store is signed out this says so explicitly rather than returning an empty list — an empty result and a signed-out session are very different answers.',
  {
    source: z.enum(['qobuz', 'beatport', 'both']).default('both').describe('Which store(s) to read'),
    hoursAgo: z.number().optional().describe('Only return purchases from the last N hours'),
  },
  async ({ source, hoursAgo }) => oneAtATime(async () => {
    const cutoff = hoursAgo ? Date.now() - hoursAgo * 3600 * 1000 : 0;
    const out: Record<string, unknown> = {};
    const all: any[] = [];

    for (const store of (source === 'both' ? ['qobuz', 'beatport'] : [source]) as Array<'qobuz' | 'beatport'>) {
      try {
        const result = await withStore<{ tracks: any[]; signedIn: boolean; diagnostic: string }>(
          store,
          (page, mod) => (store === 'qobuz' ? mod.qobuzPurchases(page) : mod.beatportPurchases(page))
        );
        const tracks = cutoff
          ? result.tracks.filter((t: any) => !t.purchasedAt || new Date(t.purchasedAt).getTime() >= cutoff)
          : result.tracks;
        out[store] = result.signedIn
          ? { signedIn: true, count: tracks.length, note: result.diagnostic }
          : { signedIn: false, error: SIGN_IN_HINT(store), detail: result.diagnostic };
        all.push(...tracks);
      } catch (err) {
        out[store] = { signedIn: false, error: (err as Error).message };
      }
    }

    // Every purchase seen goes in the sourcing history; each is recorded once.
    const history = await sourcingModule('history');
    history.recordEvents(all.map((t: any) => history.eventFromPurchase(t)));

    return { content: [{ type: 'text' as const, text: JSON.stringify({ stores: out, totalFound: all.length, purchases: all }, null, 2) }] };
  })
);

server.tool(
  'store_login',
  'Open a store (Qobuz, Beatport or SoundCloud) in the user\'s real Chrome so they can sign in once. The session is saved to a persistent profile and reused by every later call, so this is normally needed only the first time (or after a sign-out). Blocks until sign-in is detected or the timeout passes.',
  {
    store: z.enum(['qobuz', 'beatport', 'soundcloud']).describe('Which store to sign in to'),
    timeoutSeconds: z.number().optional().describe('How long to wait for sign-in (default 300)'),
  },
  async ({ store, timeoutSeconds }) => oneAtATime(async () => {
    const timeoutMs = (timeoutSeconds || 300) * 1000;
    if (store === 'soundcloud') {
      const sc = await sourcingModule('soundcloud');
      const session = await sc.openSoundCloud();
      try {
        const ok = await sc.waitForSoundCloudLogin(session.page, { timeoutMs });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ store, signedIn: ok, note: ok ? 'SoundCloud session saved.' : 'No sign-in detected before the timeout.' }) }] };
      } finally {
        await session.close();
      }
    }
    if (store === 'beatport') {
      const bp = await sourcingModule('beatport');
      const session = await bp.openBeatport();
      try {
        const token = await bp.waitForLogin(session.page, { timeoutMs });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ store, signedIn: Boolean(token), note: token ? 'Beatport session saved.' : 'No sign-in detected before the timeout.' }) }] };
      } finally {
        await session.close();
      }
    }
    const mod = await sourcingModule('storeSession');
    const session = await mod.openQobuz();
    try {
      const ok = await mod.waitForQobuzLogin(session.page, { timeoutMs });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ store, signedIn: ok, note: ok ? 'Qobuz session saved.' : 'No sign-in detected before the timeout.' }) }] };
    } finally {
      await session.close();
    }
  })
);

server.tool(
  'download_track',
  'Download an already-purchased track through the user\'s signed-in browser session and save it to the organize source directory, converted to AIFF when it is lossless. A lossy file (e.g. MP3) is never converted: it is kept under lossy/ and flagged. Never overwrites an existing file. Requires a signed-in store profile (use store_login first) — this reads the download from the store\'s own page rather than replaying a private API with stored credentials.',
  {
    source: z.enum(['qobuz', 'beatport']).describe('Which store the track was bought from'),
    trackId: z.string().describe('Track ID from the store'),
    artist: z.string().describe('Artist name (for the filename)'),
    title: z.string().describe('Track title (for the filename)'),
    destDir: z.string().optional().describe('Destination directory (defaults to organizeSourceDir from config)'),
  },
  async ({ source, trackId, artist, title, destDir }) => oneAtATime(async () => {
    const reply = (body: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(body) }] });
    const { primary, fallback } = getConfigPaths();
    const config = await readConfig(primary, fallback);
    const outputDir = destDir || config.organizeSourceDir;
    if (!outputDir) {
      return reply({ error: 'No destination directory. Set organizeSourceDir in settings or pass destDir.' });
    }
    await fs.mkdir(outputDir, { recursive: true });

    // Refuse up front if this track is already sitting there under any audio extension.
    const base = sanitizeFilename(`${artist} - ${title}`);
    const lossyDir = path.join(outputDir, 'lossy');
    for (const dir of [outputDir, lossyDir]) {
      for (const ext of AUDIO_EXTS_FOR_NAME) {
        const existing = path.join(dir, `${base}.${ext}`);
        if (fsSync.existsSync(existing)) return reply({ error: `Already there, not overwritten: ${existing}` });
      }
    }
    // Download under a hidden temp name (scans skip it), then move into place.
    const partialPath = path.join(outputDir, `.${base}.${Date.now()}.partial`);

    try {
      const result = await withStore<{ downloaded?: true; error?: string }>(source, async (page, mod) => {
        // Ask the store for this track's download URL from inside its own
        // origin, so the request carries the live session and a real browser
        // fingerprint — no token handling on our side.
        const resolved = await (source === 'beatport'
          ? page.evaluate(async (id: string) => {
              for (const endpoint of [
                `/api/v4/catalog/tracks/${id}/download/?audio_format_id=14`,
                `/api/v4/my/downloads/${id}?audio_format_id=14`,
              ]) {
                try {
                  const r = await fetch(endpoint, { credentials: 'include', headers: { Accept: 'application/json' } });
                  if (!r.ok) continue;
                  const j = await r.json();
                  const u = j.download_url || j.url;
                  if (u) return { url: u as string };
                } catch { /* try the next endpoint */ }
              }
              return null;
            }, trackId)
          : page.evaluate(async (id: string) => {
              try {
                const r = await fetch(`/api.json/0.2/track/getFileUrl?track_id=${id}&format_id=27&intent=download`, { credentials: 'include' });
                if (!r.ok) return null;
                const j = await r.json();
                return j.url ? { url: j.url as string } : null;
              } catch {
                return null;
              }
            }, trackId));

        if (!resolved?.url) return { error: `${SIGN_IN_HINT(source)} (No download URL came back for track ${trackId} — it may also not be in this account's purchases.)` };

        await mod.downloadViaBrowser(page, resolved.url, partialPath);
        return { downloaded: true };
      });

      if (result.error) return reply({ error: result.error });

      // What actually arrived — by its bytes, not the URL — and whether it's
      // lossless. Only a confirmed-lossless file goes into the intake folder
      // and gets converted; anything else is kept aside, never made into an AIFF.
      const ext = (await sniffAudioExtension(partialPath)) ?? 'bin';
      const typedPartial = `${partialPath}.${ext}`;
      await fs.rename(partialPath, typedPartial);
      const health = await checkTrackHealth(typedPartial).catch(() => null);
      const lossless = health?.format.lossless === true;
      const finalDir = lossless ? outputDir : lossyDir;
      await fs.mkdir(finalDir, { recursive: true });
      const rawPath = path.join(finalDir, `${base}.${ext}`);
      try {
        await moveNoClobber(typedPartial, rawPath, 'mcp-download', { source, trackId, lossless });
      } catch (err) {
        return reply({ error: `Downloaded, but ${rawPath} already exists, so nothing was overwritten. The download is at ${typedPartial}. (${(err as Error).message})` });
      }

      if (!lossless) {
        return reply({
          success: true, lossy: true, path: rawPath, format: ext.toUpperCase(),
          codec: health?.format.codec ?? null,
          note: health
            ? 'The store sent a lossy file. It was kept under lossy/ and not converted — lossless only for the library.'
            : 'Couldn’t confirm the file is lossless, so it was kept under lossy/ and not converted.',
        });
      }
      if (ext !== 'aiff') {
        const conv = await convertToAiff(rawPath);
        if (conv.success && conv.outputPath) {
          await deleteOriginalAfterConversion(rawPath, conv.outputPath);
          return reply({ success: true, path: conv.outputPath, format: 'AIFF' });
        }
        return reply({ success: true, path: rawPath, format: ext.toUpperCase(), note: `AIFF conversion failed; original kept. ${conv.errorMessage ?? ''}`.trim() });
      }
      return reply({ success: true, path: rawPath, format: 'AIFF' });
    } catch (err) {
      // A half-finished download is our own temp file, not the user's audio.
      await fs.unlink(partialPath).catch(() => {});
      return reply({ error: (err as Error).message });
    }
  })
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
server.tool(
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

server.tool(
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

server.tool(
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

server.tool(
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
    return { content: [{ type: 'text', text: JSON.stringify({ path: history.HISTORY_PATH, count: rows.length, events: rows }, null, 2) }] };
  }
);

server.tool(
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
    email: z.string().optional().describe('Email address to give gates that demand one (never sent unless provided)'),
    scActions: z.string().optional().describe('Account actions a gate may perform for real: "follow,like,comment" (default), add "repost" to allow reposts, or "none"'),
    comment: z.string().optional().describe('Comment text for gates that ask for one (default "dis shit nasty" — the user\'s standing choice)'),
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
// Start server
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Close the shared store windows when the client goes away.
  const shutdown = () => {
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
