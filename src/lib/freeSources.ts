/**
 * Free and cheap copies for Lossless Upgrades, in Ben's order: a SoundCloud
 * free download first, then Bandcamp (free, name your price, or a cheap
 * minimum), and only then Qobuz and Beatport (qobuzCart.ts).
 *
 * The search lives in lib/sourcing/freeSources.mjs, shared with the
 * playlist-sourcing CLI and skill, and is loaded at run time the way
 * soundcloudSets.ts loads the set reader. Its free hits become the rows
 * bin/source-soundcloud-likes.mjs --tracks downloads, gates and all, and
 * upgradeOutcomes() maps that run back to each `rb:<rbId>`.
 */

import { app } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { stopProcessTree } from './claude/claudeCode';

export type FreeSourceHit = {
  source: 'soundcloud' | 'bandcamp';
  /** native: SoundCloud's own download button. gate: a SoundCloud free link
   *  behind a gate (Hypeddit &c). free: Bandcamp gives it away ($0 name your
   *  price). paid: Bandcamp's minimum is above $0, for Ben to buy. */
  kind: 'native' | 'gate' | 'free' | 'paid';
  /** The track page. */
  url: string;
  artist: string;
  title: string;
  /** The title as the source lists it ("… [FREE DOWNLOAD]"). */
  listedAs: string;
  uploader: string;
  /** Seconds. */
  duration: number | null;
  confidence: number;
  /** Seconds between this copy and the playlist entry, when both are known. */
  durationGap: number | null;
  gate?: { host: string | null; url: string } | null;
  /** Bandcamp's minimum, on a paid hit only. */
  price?: { amount: number; currency: string; label: string } | null;
  /** Bandcamp mails a free link when signed out; the downloader needs an address. */
  needsEmail?: boolean;
  /** 'source': Bandcamp serves the lossless master. 'on-arrival': a SoundCloud
   *  file's format is only known once it lands; a lossy one is quarantined. */
  lossless: 'source' | 'on-arrival';
  /** One line for the UI: "SoundCloud download button", "£2.00 or more on Bandcamp",
   *  "Free WAV via Influence Planner (asks for your email, a SoundCloud connect and a comment)". */
  reason: string;
  /** What the download page gives and asks for, read signed out before
   *  anything is clicked (Influence Planner pages carry it). Null when the
   *  host can't be read that way. */
  gateInfo?: GateInfo | null;
  /** Why the page couldn't be read, when it couldn't. */
  gateNote?: string;
  /** Ben pasted this link himself ("Found a free download?"). */
  pasted?: boolean;
};

/** A download page's own account of itself. */
export type GateInfo = {
  /** "WAV", "MP3"… from the file the page serves; null when it doesn't say. */
  format: string | null;
  /** true for WAV/AIFF/FLAC, false for MP3 &c, null when unknown. */
  lossless: boolean | null;
  /** What it asks for, in order: 'email', 'soundcloud-connect', 'comment'. */
  needs: string[];
  active: boolean;
};

/** A SoundCloud upload close enough to be the track that the search passed
 *  over, and why: so a "not found" row can say "Shizz Lo's upload matches,
 *  but it offers no free download". */
export type FreeSourceMiss = {
  url: string;
  listedAs: string;
  uploader: string;
  /** How alike it is before the version and length checks, 0–1. */
  confidence: number;
  why: {
    code: 'no-download' | 'download-limit' | 'lossy-title' | 'gate-off' | 'gate-lossy' | 'other-length' | 'other-version' | 'low-match';
    /** A phrase that follows "…, but": "it offers no free download". */
    text: string;
  };
};

/** What the free search found for one track. A search that failed is in
 *  `errors`, never reported as "not there". */
export type FreeSources = {
  soundcloud: FreeSourceHit | null;
  bandcamp: FreeSourceHit | null;
  /** The closest SoundCloud uploads passed over, best explanation first. */
  soundcloudMisses?: FreeSourceMiss[];
  /** Set when `soundcloud` is a link Ben pasted: the link, and what the check
   *  against his copy found (another version, another length, unchecked). */
  pasted?: { url: string; warning: string | null } | null;
  errors: string[];
};

/** A row for bin/source-soundcloud-likes.mjs --tracks. */
export type FreeFetchRow = { upgradeKey: string; scId: number | string; source?: string } & Record<string, unknown>;

/** What a --tracks run did for one upgrade. */
export type FreeUpgradeOutcome = {
  /** The lossless file that landed, or null. */
  filePath: string | null;
  source: 'soundcloud' | 'bandcamp' | null;
  /** Fetched on an earlier run (the download ledger). */
  earlier?: boolean;
  attempts: Array<{ source: 'soundcloud' | 'bandcamp'; url: string; status: string; reason: string }>;
};

type FullHit = FreeSourceHit & { fetchRow: Record<string, unknown> | null };
type FullSources = { soundcloud: FullHit | null; bandcamp: FullHit | null; soundcloudMisses?: FreeSourceMiss[]; errors: string[] };
type Want = { artist: string; title: string; duration?: number };

type FreeSourcesModule = {
  findFreeSources: (want: Want) => Promise<FullSources>;
  freeHitFromLink: (want: Want, link: string) => Promise<{ hit: FullHit; warning: string | null }>;
  needsStoreSearch: (found: FullSources) => boolean;
  toFetchRows: (entries: Array<{ key: string; found: FullSources }>) => FreeFetchRow[];
  upgradeOutcomes: (session: unknown) => Record<string, FreeUpgradeOutcome>;
};

let mod: FreeSourcesModule | null = null;

async function getModule(): Promise<FreeSourcesModule> {
  if (!mod) {
    const url = pathToFileURL(path.join(app.getAppPath(), 'lib', 'sourcing', 'freeSources.mjs')).href;
    mod = await import(url) as FreeSourcesModule;
  }
  return mod;
}

/** Tracks searched at once: two hosts, a few requests each, all public. */
const CONCURRENCY = 3;

export type FreeSearchResult = {
  /** Per track key, without the downloader rows (they stay in main). */
  found: Map<string, FreeSources>;
  /** Keys still worth a store search: all but those with a free, no-email Bandcamp copy. */
  needStores: Set<string>;
  /** Downloader rows for every free hit, SoundCloud before Bandcamp per key. */
  fetchRows: FreeFetchRow[];
};

const slim = (h: FullHit | null): FreeSourceHit | null => {
  if (!h) return null;
  const { fetchRow: _fetchRow, ...rest } = h;
  return rest;
};

export async function searchFreeSources(
  tracks: Array<{ key: string; artist: string; title: string; duration?: number }>,
  onProgress?: (current: number, total: number, label: string) => void,
): Promise<FreeSearchResult> {
  const m = await getModule();
  const full = new Map<string, FullSources>();
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < tracks.length) {
      const t = tracks[next++];
      full.set(t.key, await m.findFreeSources({ artist: t.artist, title: t.title, duration: t.duration }));
      onProgress?.(++done, tracks.length, `${t.artist} - ${t.title}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tracks.length) }, worker));

  const result: FreeSearchResult = { found: new Map(), needStores: new Set(), fetchRows: [] };
  // In the playlist's order, so the downloader works down it top to bottom.
  const entries = tracks.map(t => ({ key: t.key, found: full.get(t.key)! }));
  for (const { key, found } of entries) {
    result.found.set(key, { soundcloud: slim(found.soundcloud), bandcamp: slim(found.bandcamp), soundcloudMisses: found.soundcloudMisses ?? [], errors: found.errors });
    if (m.needsStoreSearch(found)) result.needStores.add(key);
  }
  result.fetchRows = m.toFetchRows(entries);
  return result;
}

/**
 * A free copy from a link Ben found himself (a SoundCloud page or the
 * download page), checked against his copy where it can be. Throws, with a
 * sentence for the UI, when the link is no use (not a link, nothing free on
 * it, a switched-off page, an MP3). `fetchRow` is the downloader's row,
 * already tagged with `upgradeKey`.
 */
export async function freeFromLink(key: string, want: Want, link: string): Promise<{ hit: FreeSourceHit; fetchRow: FreeFetchRow; warning: string | null }> {
  const m = await getModule();
  const { hit, warning } = await m.freeHitFromLink(want, link);
  const fetchRow = { ...(hit.fetchRow as Record<string, unknown>), upgradeKey: key } as FreeFetchRow;
  return { hit: slim(hit)!, fetchRow, warning };
}

/** Write a --tracks list for the downloader. */
export function writeFetchList(file: string, name: string, rows: FreeFetchRow[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ name, tracks: rows }, null, 1));
}

/** Each upgradeKey's result from a finished --tracks session file. */
export async function readUpgradeOutcomes(sessionPath: string): Promise<Record<string, FreeUpgradeOutcome>> {
  const session = JSON.parse(await fs.promises.readFile(sessionPath, 'utf8'));
  return (await getModule()).upgradeOutcomes(session);
}

/**
 * Run the downloader on a --tracks list with Electron's bundled Node, the way
 * the SoundCloud job does. Compressed files are deleted on arrival (Ben's
 * standing preference), and gates only follow, like or comment with a yes.
 * Each progress line goes to `onLine`; resolves with the session path.
 */
export function runFreeFetch(opts: {
  appRoot: string;
  listPath: string;
  accountActions: boolean;
  signal: AbortSignal;
  onLine: (line: string) => void;
}): Promise<string> {
  const args = [
    path.join(opts.appRoot, 'bin', 'source-soundcloud-likes.mjs'),
    '--tracks', opts.listPath,
    '--drop-lossy',
    '--sc-actions', opts.accountActions ? 'follow,like,comment' : 'none',
  ];
  const child = spawn(process.execPath, args, {
    cwd: opts.appRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so stopping it also closes the Chrome it drives.
    detached: process.platform !== 'win32',
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let buf = '';
    let tail = '';
    const onAbort = () => {
      stopProcessTree(child);
      reject(new Error('Stopped'));
    };
    if (opts.signal.aborted) return onAbort();
    opts.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        tail = (tail + '\n' + line).slice(-2000);
        opts.onLine(line);
      }
    });
    child.on('error', (err) => reject(new Error(`Could not start the downloader: ${err.message}`)));
    child.on('close', (code) => {
      opts.signal.removeEventListener('abort', onAbort);
      if (opts.signal.aborted) return;
      const sessionPath = stdout.trim().split('\n').pop()?.trim() ?? '';
      if (code !== 0 || !sessionPath) {
        return reject(new Error(`The downloader stopped (exit ${code}). ${tail.trim().split('\n').slice(-2).join(' ')}`));
      }
      resolve(sessionPath);
    });
  });
}
