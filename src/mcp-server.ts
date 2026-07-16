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
import { safeDelete } from './lib/safeDelete';
import * as mm from 'music-metadata';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { readConfig, setSecretsPath } from './lib/config';
import { JSDOM } from 'jsdom';
import crypto from 'crypto';

import { initWriteJournal } from './lib/writeJournal';

// Share the Electron app's write journal so conversions/deletes driven via MCP
// land in the same recovery log (userData for app name 'candybar-manager').
initWriteJournal(path.join(os.homedir(), 'Library', 'Application Support', 'candybar-manager'));

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

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function getConfigPaths(): { primary: string; fallback: string } {
  const platform = os.platform();
  const home = os.homedir();
  let userData: string;
  if (platform === 'darwin') {
    userData = path.join(home, 'Library', 'Application Support', 'candybar-manager');
  } else if (platform === 'win32') {
    userData = path.join(home, 'AppData', 'Roaming', 'candybar-manager');
  } else {
    userData = path.join(home, '.config', 'candybar-manager');
  }
  return {
    primary: path.join(userData, 'config.json'),
    fallback: path.join(__dirname, '..', '..', 'config.json')
  };
}

// Secrets file lives next to the repo-root config.json (untracked).
setSecretsPath(path.join(__dirname, '..', '..', 'secrets.json'));

// Qobuz API credentials (extracted from play.qobuz.com web player)
const QOBUZ_APP_ID = '798273057';
const QOBUZ_APP_SECRET = 'abb21364945c0583309667d13ca3d93a';

// Per-account auth caches (keyed by email so multiple accounts can be active).
const qobuzTokens = new Map<string, string>();
const beatportCookieJars = new Map<string, string>();

/**
 * The main app no longer stores passwords — auth moved to browser-session
 * cookies. The MCP server (which has no browser) can only use legacy password
 * data if it still happens to be in the config file. This helper reads those
 * optional fields without breaking the typed StoreAccount shape.
 */
function legacyCreds(account: { email?: string } | undefined): { email: string; password: string } | null {
  if (!account) return null;
  const raw = account as { email?: string; password?: string };
  if (!raw.email || !raw.password) return null;
  return { email: raw.email, password: raw.password };
}

async function loginQobuzStandalone(email: string, password: string): Promise<string | null> {
  const cached = qobuzTokens.get(email);
  if (cached) return cached;
  try {
    const loginRes = await fetch('https://www.qobuz.com/api.json/0.2/user/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: new URLSearchParams({ email, password, app_id: QOBUZ_APP_ID }).toString(),
    });
    const data = await loginRes.json() as { user_auth_token?: string };
    if (!data.user_auth_token) return null;
    qobuzTokens.set(email, data.user_auth_token);
    return data.user_auth_token;
  } catch { return null; }
}

function qobuzApiHeaders(token: string): Record<string, string> {
  return { 'User-Agent': USER_AGENT, 'X-User-Auth-Token': token, 'X-App-Id': QOBUZ_APP_ID };
}

function signQobuzRequest(method: string, params: Record<string, string>): { request_ts: string; request_sig: string } {
  const sortedKeys = Object.keys(params).sort();
  let paramStr = '';
  for (const key of sortedKeys) paramStr += `${key}${params[key]}`;
  const requestTs = Math.floor(Date.now() / 1000).toString();
  const sigInput = `${method}${paramStr}${requestTs}${QOBUZ_APP_SECRET}`;
  const requestSig = crypto.createHash('md5').update(sigInput).digest('hex');
  return { request_ts: requestTs, request_sig: requestSig };
}

async function loginBeatportStandalone(email: string, password: string): Promise<string | null> {
  const cached = beatportCookieJars.get(email);
  if (cached) return cached;
  try {
    const loginRes = await fetch('https://api.beatport.com/v4/auth/login/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': USER_AGENT,
        'Origin': 'https://www.beatport.com',
        'Referer': 'https://www.beatport.com/'
      },
      body: JSON.stringify({ username: email, password })
    });
    if (!loginRes.ok) return null;
    const jar = (loginRes.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
    beatportCookieJars.set(email, jar);
    return jar;
  } catch { return null; }
}

async function fetchQobuz(token: string, url: string, options: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: { ...qobuzApiHeaders(token), ...(options.headers || {}) }
  });
}

async function fetchBeatport(cookies: string, url: string, options: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: { 'User-Agent': USER_AGENT, 'Cookie': cookies, ...(options.headers || {}) }
  });
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Tool 6: search_qobuz
// ---------------------------------------------------------------------------
server.tool(
  'search_qobuz',
  'Search the Qobuz store for a track by artist and title. Returns matching tracks with pricing and quality info. Uses saved Qobuz credentials from app config.',
  {
    artist: z.string().describe('Artist name'),
    title: z.string().describe('Track title')
  },
  async ({ artist, title }) => {
    const { primary, fallback } = getConfigPaths();
    const config = await readConfig(primary, fallback);
    const qobuzAccount = config.qobuzAccounts[0];
    if (!qobuzAccount) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Qobuz credentials not configured. Add a Qobuz account in settings.' }) }] };
    }

    const __q_qobuzAccount = legacyCreds(qobuzAccount); if (!__q_qobuzAccount) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Qobuz auth no longer available to the MCP server — use the desktop app' }) }] }; const token = await loginQobuzStandalone(__q_qobuzAccount.email, __q_qobuzAccount.password);
    if (!token) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Qobuz login failed' }) }] };
    }

    const query = encodeURIComponent(`${artist} ${title}`);
    const res = await fetchQobuz(token, `https://www.qobuz.com/us-en/search/tracks/${query}`);
    const html = await res.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const items = doc.querySelectorAll('.ListItem');

    const results: Array<{ title: string; artist: string; album: string; trackId: string; url: string }> = [];
    for (const item of items) {
      const t = item.querySelector('.ListItem__title')?.textContent?.trim() || '';
      const a = item.querySelector('.ListItem__artists')?.textContent?.trim()?.split('\u2022')[0]?.trim() || '';
      const album = item.querySelector('.ListItem__artists')?.textContent?.trim()?.split('\u2022')[1]?.trim() || '';
      const cartBtn = item.querySelector('.add_to_cart[data-url]');
      const trackId = cartBtn?.getAttribute('data-url')?.split('/').pop() || '';
      const albumLink = item.querySelector('a[href*="/album/"]');
      const url = albumLink ? `https://www.qobuz.com${albumLink.getAttribute('href')}` : '';

      if (t && trackId) results.push({ title: t, artist: a, album, trackId, url });
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ query: `${artist} - ${title}`, matches: results, format: 'FLAC (will be converted to AIFF on download)' }, null, 2) }]
    };
  }
);

// ---------------------------------------------------------------------------
// Tool 7: search_beatport
// ---------------------------------------------------------------------------
server.tool(
  'search_beatport',
  'Search the Beatport store for a track by artist and title. Returns matching tracks with pricing info. Uses saved Beatport credentials from app config.',
  {
    artist: z.string().describe('Artist name'),
    title: z.string().describe('Track title')
  },
  async ({ artist, title }) => {
    const { primary, fallback } = getConfigPaths();
    const config = await readConfig(primary, fallback);
    const beatportAccount = config.beatportAccounts[0];
    if (!beatportAccount) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Beatport credentials not configured. Add a Beatport account in settings.' }) }] };
    }

    const __b_beatportAccount = legacyCreds(beatportAccount); if (!__b_beatportAccount) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Beatport auth no longer available to the MCP server — use the desktop app' }) }] }; const cookies = await loginBeatportStandalone(__b_beatportAccount.email, __b_beatportAccount.password);
    if (!cookies) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Beatport login failed' }) }] };
    }

    const query = encodeURIComponent(`${artist} ${title}`);
    const res = await fetchBeatport(cookies, `https://www.beatport.com/search/tracks?q=${query}`);
    const html = await res.text();

    const ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    const results: Array<{ title: string; artist: string; trackId: string; price: string; label: string; url: string }> = [];

    if (ndMatch) {
      try {
        const data = JSON.parse(ndMatch[1]);
        const qd = data?.props?.pageProps?.dehydratedState?.queries?.[0]?.state?.data;
        const searchTracks = qd?.data ? Object.values(qd.data) : [];
        for (const st of searchTracks as Array<Record<string, unknown>>) {
          if (!st?.track_name) continue;
          const artistName = ((st.artists || []) as Array<{ artist_name: string }>).map(a => a.artist_name).join(', ');
          const mixName = st.mix_name as string || '';
          const titleWithMix = (st.track_name as string) + (mixName && mixName !== 'Original Mix' ? ` (${mixName})` : '');
          const price = (st.price as { display?: string })?.display || '';
          const label = (st.label as { label_name?: string })?.label_name || '';
          const slug = (st.track_name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-');
          results.push({
            title: titleWithMix,
            artist: artistName,
            trackId: String(st.track_id),
            price,
            label,
            url: `https://www.beatport.com/track/${slug}/${st.track_id}`
          });
        }
      } catch { /* parse error */ }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ query: `${artist} - ${title}`, matches: results, format: 'WAV/AIFF (RX3-compatible)' }, null, 2) }]
    };
  }
);

// ---------------------------------------------------------------------------
// Tool 8: list_purchases
// ---------------------------------------------------------------------------
server.tool(
  'list_purchases',
  'List recently purchased tracks from Qobuz and/or Beatport. Returns track artist, title, and ID for each purchase. Use the source parameter to query one or both stores. Optionally filter by a time window (e.g., last 24 hours).',
  {
    source: z.enum(['qobuz', 'beatport', 'both']).default('both').describe('Which store(s) to query'),
    hoursAgo: z.number().optional().describe('Only return purchases from the last N hours (default: all)')
  },
  async ({ source, hoursAgo }) => {
    const { primary, fallback } = getConfigPaths();
    const config = await readConfig(primary, fallback);
    const cutoff = hoursAgo ? Date.now() - hoursAgo * 60 * 60 * 1000 : 0;
    const allPurchases: Array<{ source: string; artist: string; title: string; trackId: string; album: string; purchasedAt?: string; sourceAccount?: string }> = [];

    // Track trackIds we've already added so duplicates across accounts collapse.
    const seenQobuzTracks = new Set<string>();
    const seenBeatportTracks = new Set<string>();

    // ---- Qobuz (via API) — loop every configured account ----
    if (source === 'qobuz' || source === 'both') {
      if (config.qobuzAccounts.length === 0) {
        if (source === 'qobuz') {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Qobuz credentials not configured' }) }] };
        }
      }
      for (const qobuzAccount of config.qobuzAccounts) {
        const __q_qobuzAccount = legacyCreds(qobuzAccount); if (!__q_qobuzAccount) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Qobuz auth no longer available to the MCP server — use the desktop app' }) }] }; const token = await loginQobuzStandalone(__q_qobuzAccount.email, __q_qobuzAccount.password);
        if (!token) continue;

        let offset = 0;
        const limit = 50;
        for (let page = 0; page < 10; page++) {
          const res = await fetch(
            `https://www.qobuz.com/api.json/0.2/purchase/getUserPurchases?limit=${limit}&offset=${offset}&app_id=${QOBUZ_APP_ID}`,
            { headers: qobuzApiHeaders(token) }
          );
          if (!res.ok) break;
          const data = await res.json() as {
            tracks?: {
              total?: number;
              items?: Array<{
                id: number;
                title?: string;
                performer?: { name: string };
                album?: { title: string };
                purchased_at?: number;
              }>;
            };
          };
          const items = data.tracks?.items || [];
          if (items.length === 0) break;

          for (const item of items) {
            const t = item.title || '';
            const a = item.performer?.name || '';
            const album = item.album?.title || '';
            const trackId = String(item.id || '');
            if (seenQobuzTracks.has(trackId)) continue;
            const purchasedAt = item.purchased_at
              ? new Date(item.purchased_at * 1000).toISOString()
              : undefined;

            if (t && a) {
              if (cutoff && item.purchased_at) {
                if (item.purchased_at * 1000 < cutoff) continue;
              }
              seenQobuzTracks.add(trackId);
              allPurchases.push({ source: 'qobuz', artist: a, title: t, trackId, album, purchasedAt, sourceAccount: qobuzAccount.label || qobuzAccount.email });
            }
          }

          offset += limit;
          if (items.length < limit) break;
        }
      }
    }

    // ---- Beatport — loop every configured account ----
    if (source === 'beatport' || source === 'both') {
      if (config.beatportAccounts.length === 0) {
        if (source === 'beatport') {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Beatport credentials not configured' }) }] };
        }
      }
      for (const beatportAccount of config.beatportAccounts) {
        const __b_beatportAccount = legacyCreds(beatportAccount); if (!__b_beatportAccount) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Beatport auth no longer available to the MCP server — use the desktop app' }) }] }; const cookies = await loginBeatportStandalone(__b_beatportAccount.email, __b_beatportAccount.password);
        if (!cookies) continue;

        const res = await fetchBeatport(cookies, 'https://www.beatport.com/library/tracks', {
          headers: { 'Accept': 'text/html' }
        });
        const html = await res.text();

        const ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (ndMatch) {
          try {
            const data = JSON.parse(ndMatch[1]);
            const items = data?.props?.pageProps?.dehydratedState?.queries?.[0]?.state?.data?.results
              || data?.props?.pageProps?.dehydratedState?.queries?.[0]?.state?.data?.data
              || [];
            const trackList = Array.isArray(items) ? items : Object.values(items);
            for (const item of trackList as Array<Record<string, unknown>>) {
              const t = (item.track_name || item.name || '') as string;
              const artistArr = (item.artists || []) as Array<{ artist_name?: string; name?: string }>;
              const a = artistArr.map(x => x.artist_name || x.name || '').join(', ');
              const trackId = String(item.track_id || item.id || '');
              if (seenBeatportTracks.has(trackId)) continue;
              const album = ((item.release as Record<string, unknown>)?.release_name || '') as string;
              const dateStr = (item.purchased_at || item.created_at || '') as string;

              if (t && a) {
                if (cutoff && dateStr) {
                  const purchaseTime = new Date(dateStr).getTime();
                  if (purchaseTime && purchaseTime < cutoff) continue;
                }
                seenBeatportTracks.add(trackId);
                allPurchases.push({ source: 'beatport', artist: a, title: t, trackId, album, purchasedAt: dateStr || undefined, sourceAccount: beatportAccount.label || beatportAccount.email });
              }
            }
          } catch { /* parse error */ }
        }
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          totalFound: allPurchases.length,
          filter: hoursAgo ? `last ${hoursAgo} hours` : 'all',
          purchases: allPurchases
        }, null, 2)
      }]
    };
  }
);

// ---------------------------------------------------------------------------
// Tool 9: download_track
// ---------------------------------------------------------------------------
server.tool(
  'download_track',
  'Download a purchased track from Qobuz or Beatport by track ID, convert to AIFF, and save to the organize source directory (or a specified directory). Uses saved store credentials.',
  {
    source: z.enum(['qobuz', 'beatport']).describe('Which store to download from'),
    trackId: z.string().describe('Track ID from the store'),
    artist: z.string().describe('Artist name (for filename)'),
    title: z.string().describe('Track title (for filename)'),
    destDir: z.string().optional().describe('Destination directory (defaults to organize source dir from config)')
  },
  async ({ source, trackId, artist, title, destDir }) => {
    const { primary, fallback } = getConfigPaths();
    const config = await readConfig(primary, fallback);

    const outputDir = destDir || config.organizeSourceDir;
    if (!outputDir) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'No destination directory. Set organizeSourceDir in settings or provide destDir.' }) }] };
    }

    await fs.mkdir(outputDir, { recursive: true });

    if (source === 'qobuz') {
      if (config.qobuzAccounts.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Qobuz credentials not configured' }) }] };
      }

      // Fetch track metadata from Qobuz API (uses any working account)
      type QobuzTrackInfo = {
        title?: string;
        performer?: { name: string };
        album?: {
          title?: string;
          artist?: { name: string };
          release_date_original?: string;
          genre?: { name: string };
          tracks_count?: number;
          image?: { large?: string; small?: string };
        };
        track_number?: number;
        media_number?: number;
      };
      let trackInfo: QobuzTrackInfo | null = null;
      let downloadUrl: string | null = null;
      let dlFormatId: number | null = null;
      const loginFailures: string[] = [];
      // Try each configured account until one owns the track.
      for (const qobuzAccount of config.qobuzAccounts) {
        const __q_qobuzAccount = legacyCreds(qobuzAccount); if (!__q_qobuzAccount) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Qobuz auth no longer available to the MCP server — use the desktop app' }) }] }; const token = await loginQobuzStandalone(__q_qobuzAccount.email, __q_qobuzAccount.password);
        if (!token) { loginFailures.push(__q_qobuzAccount.email); continue; }

        if (!trackInfo) {
          try {
            const infoRes = await fetch(
              `https://www.qobuz.com/api.json/0.2/track/get?track_id=${trackId}&app_id=${QOBUZ_APP_ID}`,
              { headers: qobuzApiHeaders(token) }
            );
            if (infoRes.ok) trackInfo = await infoRes.json() as QobuzTrackInfo;
          } catch { /* metadata fetch failed, continue without */ }
        }

        for (const fid of ['27', '7', '6']) {
          const params = { format_id: fid, intent: 'stream', track_id: trackId };
          const sig = signQobuzRequest('trackgetFileUrl', params);
          const url = `https://www.qobuz.com/api.json/0.2/track/getFileUrl?track_id=${trackId}&format_id=${fid}&intent=stream&request_ts=${sig.request_ts}&request_sig=${sig.request_sig}&app_id=${QOBUZ_APP_ID}`;
          const res = await fetch(url, { headers: qobuzApiHeaders(token) });
          if (res.ok) {
            const data = await res.json() as { url?: string; format_id?: number; mime_type?: string };
            if (data.url) {
              downloadUrl = data.url;
              dlFormatId = data.format_id || parseInt(fid);
              break;
            }
          }
        }
        if (downloadUrl) break;
      }

      if (!downloadUrl) {
        const detail = loginFailures.length
          ? `Login failed for: ${loginFailures.join(', ')}`
          : 'Track not found in any configured account or no download URL available';
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Download failed — ${detail}` }) }] };
      }

      // Download the FLAC file
      const dlRes = await fetch(downloadUrl, { headers: { 'User-Agent': USER_AGENT } });
      if (!dlRes.ok) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Download HTTP error: ${dlRes.status}` }) }] };
      }

      const rawName = sanitizeFilename(`${artist} - ${title}.flac`);
      const rawPath = path.join(outputDir, rawName);
      const buffer = Buffer.from(await dlRes.arrayBuffer());
      await fs.writeFile(rawPath, buffer);

      // Download album art if available
      let artPath: string | null = null;
      const artUrl = trackInfo?.album?.image?.large || trackInfo?.album?.image?.small;
      if (artUrl) {
        try {
          const artRes = await fetch(artUrl, { headers: { 'User-Agent': USER_AGENT } });
          if (artRes.ok) {
            artPath = path.join(outputDir, `.cover_${trackId}.jpg`);
            await fs.writeFile(artPath, Buffer.from(await artRes.arrayBuffer()));
          }
        } catch { /* art download failed */ }
      }

      // Convert to AIFF with embedded metadata and art via ffmpeg
      const aiffName = sanitizeFilename(`${artist} - ${title}.aiff`);
      const aiffPath = path.join(outputDir, aiffName);
      const year = trackInfo?.album?.release_date_original?.split('-')[0] || '';

      const ffmpegArgs = ['-i', rawPath];
      if (artPath) ffmpegArgs.push('-i', artPath);
      ffmpegArgs.push(
        '-map', '0:a',
        ...(artPath ? ['-map', '1:0', '-c:v', 'copy', '-disposition:v', 'attached_pic'] : []),
        '-acodec', 'pcm_s24be', '-ar', '44100', '-ac', '2',
        '-write_id3v2', '1',
        '-metadata', `title=${trackInfo?.title || title}`,
        '-metadata', `artist=${trackInfo?.performer?.name || artist}`,
        '-metadata', `album=${trackInfo?.album?.title || ''}`,
        '-metadata', `album_artist=${trackInfo?.album?.artist?.name || trackInfo?.performer?.name || artist}`,
        '-metadata', `genre=${trackInfo?.album?.genre?.name || ''}`,
        '-metadata', `date=${year}`,
        '-metadata', `track=${trackInfo?.track_number || ''}`,
        '-metadata', `disc=${trackInfo?.media_number || ''}`,
        '-y', aiffPath
      );

      const { execFileSync } = await import('child_process');
      const ffmpegBin: string = require('ffmpeg-static');
      try {
        execFileSync(ffmpegBin, ffmpegArgs, { stdio: 'pipe' });
        // Clean up the intermediate FLAC (journaled) and temp art.
        await safeDelete(rawPath, { context: 'mcp-download-cleanup', detail: { convertedTo: aiffPath } }).catch(() => {});
        if (artPath) await fs.unlink(artPath).catch(() => {});
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, path: aiffPath, format: 'AIFF', qobuzFormatId: dlFormatId, hasMetadata: true, hasArt: !!artPath }) }] };
      } catch (convErr) {
        // Fallback: try without art
        try {
          const fallbackArgs = ['-i', rawPath, '-acodec', 'pcm_s24be', '-ar', '44100', '-ac', '2', '-write_id3v2', '1', '-y', aiffPath];
          execFileSync(ffmpegBin, fallbackArgs, { stdio: 'pipe' });
          await safeDelete(rawPath, { context: 'mcp-download-cleanup', detail: { convertedTo: aiffPath } }).catch(() => {});
          if (artPath) await fs.unlink(artPath).catch(() => {});
          return { content: [{ type: 'text', text: JSON.stringify({ success: true, path: aiffPath, format: 'AIFF', note: 'Converted without art embedding' }) }] };
        } catch {
          if (artPath) await fs.unlink(artPath).catch(() => {});
          return { content: [{ type: 'text', text: JSON.stringify({ success: true, path: rawPath, format: 'FLAC', note: 'AIFF conversion failed, FLAC kept' }) }] };
        }
      }
    }

    // Beatport — try each configured account until one owns the track.
    if (config.beatportAccounts.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Beatport credentials not configured' }) }] };
    }

    let beatportCookies: string | null = null;
    let dlUrl: string | null = null;
    const beatportLoginFailures: string[] = [];
    for (const beatportAccount of config.beatportAccounts) {
      const __b_beatportAccount = legacyCreds(beatportAccount); if (!__b_beatportAccount) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Beatport auth no longer available to the MCP server — use the desktop app' }) }] }; const cookies = await loginBeatportStandalone(__b_beatportAccount.email, __b_beatportAccount.password);
      if (!cookies) { beatportLoginFailures.push(__b_beatportAccount.email); continue; }
      beatportCookies = cookies;

      for (const endpoint of [
        `https://www.beatport.com/api/v4/catalog/tracks/${trackId}/download?audio_format_id=3`,
        `https://www.beatport.com/api/v4/my/downloads/${trackId}?audio_format_id=3`
      ]) {
        const res = await fetchBeatport(cookies, endpoint, { headers: { 'Accept': 'application/json' } });
        if (res.ok) {
          const data = await res.json() as { download_url?: string; url?: string };
          const u = data.download_url || data.url;
          if (u) { dlUrl = u; break; }
        }
      }
      if (dlUrl) break;
    }

    if (!dlUrl || !beatportCookies) {
      const detail = beatportLoginFailures.length
        ? `Login failed for: ${beatportLoginFailures.join(', ')}`
        : 'Track not found in any configured account';
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Download failed — ${detail}` }) }] };
    }

    const ext = dlUrl.match(/\.(wav|aiff|aif|mp3|flac)$/i)?.[1] || 'wav';
    const rawName = sanitizeFilename(`${artist} - ${title}.${ext}`);
    const rawPath = path.join(outputDir, rawName);

    const dlRes = await fetchBeatport(beatportCookies, dlUrl, { headers: { 'Accept': '*/*' } });
    if (!dlRes.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Beatport download HTTP error: ${dlRes.status}` }) }] };
    }
    const buffer = Buffer.from(await dlRes.arrayBuffer());
    await fs.writeFile(rawPath, buffer);

    // Convert to AIFF if needed
    const rawExt = path.extname(rawPath).toLowerCase();
    if (rawExt !== '.aiff' && rawExt !== '.aif') {
      const convResult = await convertToAiff(rawPath);
      if (convResult.success && convResult.outputPath) {
        await deleteOriginalAfterConversion(rawPath, convResult.outputPath);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, path: convResult.outputPath, format: 'AIFF' }) }] };
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, path: rawPath, format: ext.toUpperCase() }) }] };
  }
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server failed to start:', err);
  process.exit(1);
});
