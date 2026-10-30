import fs from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';
import { app } from 'electron';
import type { BrowserContext } from 'playwright';
import { createScopedLogger } from './logger';

const log = createScopedLogger('SpliceRecovery');

// The .mjs modules live at <repo>/lib/*.mjs. Use Electron's `app.getAppPath()`
// rather than `__dirname` so this is robust to Vite's code-splitting (which
// can move this file between dist/main/main.js and dist/main/chunks/...).
function spliceLibUrl(file: string): string {
  return pathToFileURL(path.join(app.getAppPath(), 'lib', file)).href;
}

const TOKEN_CACHE = path.join(os.homedir(), '.cache', 'candybar-manager', 'splice-token.json');
const PROFILE_DIR = path.join(os.homedir(), '.cache', 'candybar-manager', 'playwright-profiles', 'splice');

export type SpliceLoginStatus = {
  connected: boolean;
  tokenExpiresAt: number | null;
  hasProfile: boolean;
};

export type SpliceMissingSample = {
  originalPath: string;
  basename: string;
  searchKey: string;
};

export type SpliceScanResult = {
  alsPath: string;
  totalRefs: number;
  spliceRefs: number;
  missing: SpliceMissingSample[];
};

export type SpliceAsset = {
  uuid: string;
  filename: string;
  name: string;
  coverUrl: string | null;
  packName: string | null;
  packSlug: string | null;
};

export type SpliceOwnedItem = SpliceMissingSample & { asset: SpliceAsset };
export type SpliceCreditsItem = SpliceMissingSample & { asset: SpliceAsset; spliceUrl: string };
export type SpliceNotFoundItem = SpliceMissingSample & { error?: string };

export type SpliceBuckets = {
  owned: SpliceOwnedItem[];
  credits: SpliceCreditsItem[];
  notFound: SpliceNotFoundItem[];
};

export type SpliceProgress =
  | { phase: 'parsing'; alsPath: string }
  | { phase: 'searching'; index: number; total: number; sample: SpliceMissingSample; result?: 'owned' | 'credits' | 'notFound' }
  | { phase: 'downloading'; index: number; total: number; sample: SpliceOwnedItem; status?: 'ok' | 'fail'; error?: string }
  | { phase: 'complete' };

export type SpliceDownloadReport = {
  attempted: number;
  succeeded: number;
  failed: Array<{ sample: SpliceOwnedItem; error: string }>;
};

// --- .mjs module bindings (lazy) ------------------------------------------

type AlsParserModule = {
  findMissingSpliceSamples: (alsPath: string) => SpliceScanResult;
};
type SpliceClientModule = {
  searchSamples: (opts: { filepath?: string | null; query?: string | null; licensed?: boolean | null; page?: number; limit?: number; verbose?: boolean }) => Promise<{ assets: Array<{ uuid: string; filename: string; name: string; coverUrl: string | null; packName: string | null; packSlug: string | null }> }>;
  downloadSample: (assetUuid: string, destPath: string, opts?: { verbose?: boolean }) => Promise<string>;
  getAuthToken: (opts?: { forceRefresh?: boolean; verbose?: boolean }) => Promise<string>;
  getCreditsBalance: (opts?: { verbose?: boolean }) => Promise<{ credits: number; state: string; planName: string | null; planTier: string | null }>;
  purchaseAsset: (assetUuid: string, opts?: { verbose?: boolean }) => Promise<{ uuid: string; licensed: boolean }>;
};
type LaunchBrowserModule = {
  launchSiteBrowser: (opts: { profile: string; headless?: boolean; extraArgs?: string[] }) => Promise<BrowserContext>;
};

let alsParserMod: AlsParserModule | null = null;
let spliceClientMod: SpliceClientModule | null = null;
let launchBrowserMod: LaunchBrowserModule | null = null;

async function getAlsParser(): Promise<AlsParserModule> {
  if (!alsParserMod) alsParserMod = await import(spliceLibUrl('alsParser.mjs')) as AlsParserModule;
  return alsParserMod;
}
async function getSpliceClient(): Promise<SpliceClientModule> {
  if (!spliceClientMod) spliceClientMod = await import(spliceLibUrl('spliceClient.mjs')) as SpliceClientModule;
  return spliceClientMod;
}
async function getLaunchBrowser(): Promise<LaunchBrowserModule> {
  if (!launchBrowserMod) launchBrowserMod = await import(spliceLibUrl('launchBrowser.mjs')) as LaunchBrowserModule;
  return launchBrowserMod;
}

// --- Public API -----------------------------------------------------------

export async function getLoginStatus(): Promise<SpliceLoginStatus> {
  // A profile *directory* gets created the moment Playwright launches Chrome,
  // even if the user never finishes signing in. The real signal of "we have
  // a session" is the Cookies SQLite file — Chrome only writes that once at
  // least one cookie has been stored. Modern Chrome stores cookies under
  // `Default/Network/Cookies`; older builds used `Default/Cookies`. Check
  // both to stay forward/backward compatible.
  const cookiePaths = [
    path.join(PROFILE_DIR, 'Default', 'Network', 'Cookies'),
    path.join(PROFILE_DIR, 'Default', 'Cookies'),
  ];
  const hasProfile = fs.existsSync(PROFILE_DIR) && cookiePaths.some(p => fs.existsSync(p));

  let tokenExpiresAt: number | null = null;
  try {
    const raw = fs.readFileSync(TOKEN_CACHE, 'utf8');
    const cached = JSON.parse(raw) as { expiresAt?: number };
    if (typeof cached.expiresAt === 'number') tokenExpiresAt = cached.expiresAt;
  } catch {
    // no cache yet
  }

  // "Connected" means we can mint a bearer when needed. A live token is
  // sufficient; a cookie-bearing profile is also sufficient because
  // mintFreshToken will refresh on demand. A profile with NO cookies means
  // Chrome was opened but auth never completed — not connected.
  const connected =
    (tokenExpiresAt !== null && tokenExpiresAt > Date.now() + 60_000) || hasProfile;
  return { connected, tokenExpiresAt, hasProfile };
}

/**
 * Open visible Chrome at splice.com, drive through the sign-in page to the
 * Google OAuth handoff, and let the user finish the Google sign-in
 * themselves. Resolves when the browser window is closed (the persistent
 * profile keeps the session).
 */
export async function startLogin(): Promise<{ ok: boolean; error?: string }> {
  const MAX_ATTEMPTS = 5;
  try {
    const { launchSiteBrowser } = await getLaunchBrowser();
    const ctx = await launchSiteBrowser({ profile: 'splice', headless: false });
    const page = await ctx.newPage();

    // Track whether the user closed the window mid-flow so we don't keep
    // retrying against a dead context.
    let closed = false;
    ctx.on('close', () => { closed = true; });

    let lastError: string | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !closed; attempt++) {
      try {
        log.info(`startLogin attempt ${attempt}/${MAX_ATTEMPTS}`);
        await page.goto('https://splice.com/sign-in', { waitUntil: 'domcontentloaded', timeout: 30_000 });

        // If we've already landed on Google (e.g. persistent profile already
        // had a partial OAuth state), we're done driving.
        if (page.url().startsWith('https://accounts.google.com/')) break;

        // Find the "Sign in with Google" button. Splice's button text has
        // varied ("Sign in with Google", "Continue with Google"), so match
        // either via a regex on the accessible name.
        const googleBtn = page.getByRole('button', { name: /(sign in|continue) with google/i }).first();
        await googleBtn.waitFor({ state: 'visible', timeout: 15_000 });
        await googleBtn.click();

        // Wait for the OAuth handoff. Splice opens Google in the same tab
        // via a redirect, so we can wait on the URL of the current page.
        await page.waitForURL(/^https:\/\/accounts\.google\.com\//, { timeout: 20_000 });
        log.info('Reached Google OAuth — handing off to user');
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        log.warn(`startLogin attempt ${attempt} failed: ${lastError}`);
        if (closed) break;
        if (attempt === MAX_ATTEMPTS) {
          // Don't tear down — let the user finish manually if they can.
          log.warn('Auto-navigation to Google OAuth failed; leaving window open for manual sign-in');
        }
      }
    }

    // Wait until the user closes the window. Playwright's context emits 'close' when that happens.
    if (!closed) {
      await new Promise<void>((resolve) => {
        ctx.on('close', () => resolve());
      });
    }
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error('startLogin failed:', error);
    return { ok: false, error };
  }
}

export async function scan(alsPath: string): Promise<SpliceScanResult> {
  if (!fs.existsSync(alsPath)) throw new Error(`File not found: ${alsPath}`);
  const { findMissingSpliceSamples } = await getAlsParser();
  return findMissingSpliceSamples(alsPath);
}

type SearchAsset = {
  uuid: string;
  name: string;
  filename: string;
  coverUrl: string | null;
  packName: string | null;
  packSlug: string | null;
};

// Splice's filepath/query search returns popularity-sorted partial matches —
// the actual exact hit is often buried in the list. Walk the results and
// return the one whose filename matches our basename. Prefer exact match,
// fall back to a substring match (some filenames have suffixes like
// "[2024-08-23 203418]" that won't appear in the Splice version).
function pickBestMatch(assets: SearchAsset[], basename: string): SearchAsset | null {
  if (!assets.length) return null;
  const targetLower = basename.toLowerCase();
  const targetStem = stripExt(targetLower);

  // 1. Exact filename or .name match (case-insensitive).
  for (const a of assets) {
    const fLower = (a.filename || '').toLowerCase();
    const nLower = (a.name || '').toLowerCase();
    if (fLower === targetLower || basenameOf(fLower) === targetLower) return a;
    if (basenameOf(nLower) === targetLower) return a;
  }
  // 2. Stem match — basename without extension matches what Splice returned.
  for (const a of assets) {
    if (stripExt(basenameOf((a.filename || '').toLowerCase())) === targetStem) return a;
    if (stripExt(basenameOf((a.name || '').toLowerCase())) === targetStem) return a;
  }
  // 3. Substring match. Last resort — gives us a hit when the .als basename
  // had extra suffixes Splice's master copy doesn't.
  for (const a of assets) {
    const f = basenameOf((a.filename || '').toLowerCase());
    if (f.includes(targetStem) || targetStem.includes(stripExt(f))) return a;
  }
  return null;
}

function basenameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}
function stripExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}
function toAsset(s: SearchAsset): SpliceAsset {
  return {
    uuid: s.uuid,
    name: s.name,
    filename: s.filename,
    coverUrl: s.coverUrl,
    packName: s.packName,
    packSlug: s.packSlug,
  };
}

// Splice's per-sample URLs returned 404 with both old and new UUID
// formats; we link to the pack page instead, which always works.
function publicSpliceUrl(asset: { packSlug: string | null }): string {
  return asset.packSlug
    ? `https://splice.com/sounds/packs/${asset.packSlug}`
    : 'https://splice.com/sounds';
}

export async function classify(
  missing: SpliceMissingSample[],
  onProgress: (p: SpliceProgress) => void,
): Promise<SpliceBuckets> {
  const { searchSamples } = await getSpliceClient();
  const owned: SpliceOwnedItem[] = [];
  const credits: SpliceCreditsItem[] = [];
  const notFound: SpliceNotFoundItem[] = [];

  // Splice's search no longer privileges exact filename matches — it
  // returns popularity-sorted partial matches first, then the actual hit
  // somewhere down the list. We pull a wider page and locally pick the
  // result whose filename matches our basename.
  for (let i = 0; i < missing.length; i++) {
    const m = missing[i];
    onProgress({ phase: 'searching', index: i, total: missing.length, sample: m });
    try {
      const ownedHit = await searchSamples({ filepath: m.searchKey, licensed: true, limit: 50 });
      const ownedMatch = pickBestMatch(ownedHit.assets ?? [], m.basename);
      if (ownedMatch) {
        owned.push({ ...m, asset: toAsset(ownedMatch) });
        onProgress({ phase: 'searching', index: i, total: missing.length, sample: m, result: 'owned' });
        continue;
      }
      const fullHit = await searchSamples({ filepath: m.searchKey, licensed: null, limit: 50 });
      const fullMatch = pickBestMatch(fullHit.assets ?? [], m.basename);
      if (fullMatch) {
        credits.push({
          ...m,
          asset: toAsset(fullMatch),
          spliceUrl: publicSpliceUrl(fullMatch),
        });
        onProgress({ phase: 'searching', index: i, total: missing.length, sample: m, result: 'credits' });
        continue;
      }
      notFound.push(m);
      onProgress({ phase: 'searching', index: i, total: missing.length, sample: m, result: 'notFound' });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      notFound.push({ ...m, error });
      onProgress({ phase: 'searching', index: i, total: missing.length, sample: m, result: 'notFound' });
    }
  }

  onProgress({ phase: 'complete' });
  return { owned, credits, notFound };
}

// Resolve the local Splice samples root (where the desktop client stores
// downloaded packs). On both Win and Mac the official Splice app uses
// `~/Documents/Splice/Samples`. We detect rather than hardcode so users
// who haven't installed the client yet see a clear error.
function localSpliceSamplesRoot(): string | null {
  const candidate = path.join(os.homedir(), 'Documents', 'Splice', 'Samples');
  return fs.existsSync(candidate) ? candidate : null;
}

// Translate an Ableton-recorded path into a writable local destination.
// Two cases:
//   1. Path explicitly contains a Splice samples folder
//      (e.g. `C:\Users\Sam\Documents\Splice\Samples\packs\Foo\bar.wav` or
//      `.../Splice - thetexaswave/Samples/packs/...`). We anchor on the
//      `/Splice<...>/Samples/` segment and reuse the tail.
//   2. No Splice segment (e.g. consolidated paths like
//      `H:/My Drive/.../Samples/Processed/Consolidate/foo.wav`). Fall
//      back to a synthesized Splice-shaped path using the pack name we
//      pulled from the API response.
function remapToLocalSpliceRoot(
  originalPath: string,
  localRoot: string,
  packName: string | null,
  basename: string,
): string {
  const m = originalPath.match(/[\\/]Splice[^\\/]*[\\/]Samples[\\/](.+)$/i);
  if (m) {
    const tail = m[1].replace(/[\\/]/g, path.sep);
    return path.join(localRoot, tail);
  }
  // Fall-back layout: ~/Documents/Splice/Samples/packs/<Pack>/<basename>.
  // If we don't know the pack, drop into a generic "recovered" bucket so
  // the file lands somewhere writable rather than ENOENT/EPERM-ing.
  const safePack = (packName ?? 'recovered').replace(/[\\/:*?"<>|]/g, '_');
  return path.join(localRoot, 'packs', safePack, basename);
}

export async function downloadOwned(
  items: SpliceOwnedItem[],
  onProgress: (p: SpliceProgress) => void,
): Promise<SpliceDownloadReport> {
  const { downloadSample } = await getSpliceClient();
  const failed: SpliceDownloadReport['failed'] = [];
  let succeeded = 0;

  const localRoot = localSpliceSamplesRoot();
  if (!localRoot) {
    // Fail every item up-front rather than spawning 15 EPERMs. The user
    // needs to install the Splice desktop client (or create the dir) before
    // we can recover anything.
    const error = `Local Splice samples folder not found at ${path.join(os.homedir(), 'Documents', 'Splice', 'Samples')}. Install the Splice desktop client or create that folder.`;
    log.error(error);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      failed.push({ sample: item, error });
      onProgress({ phase: 'downloading', index: i, total: items.length, sample: item, status: 'fail', error });
    }
    onProgress({ phase: 'complete' });
    return { attempted: items.length, succeeded: 0, failed };
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    onProgress({ phase: 'downloading', index: i, total: items.length, sample: item });
    try {
      const destPath = remapToLocalSpliceRoot(
        item.originalPath,
        localRoot,
        item.asset.packName,
        item.basename,
      );
      await downloadSample(item.asset.uuid, destPath);
      succeeded++;
      onProgress({ phase: 'downloading', index: i, total: items.length, sample: item, status: 'ok' });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failed.push({ sample: item, error });
      onProgress({ phase: 'downloading', index: i, total: items.length, sample: item, status: 'fail', error });
    }
  }

  onProgress({ phase: 'complete' });
  return { attempted: items.length, succeeded, failed };
}

/**
 * Read the user's Splice subscription credits + plan info. Backs the
 * credits balance display in the UI.
 */
export async function getCreditsBalance(): Promise<{ credits: number; state: string; planName: string | null; planTier: string | null }> {
  const { getCreditsBalance: fn } = await getSpliceClient();
  return fn();
}

/**
 * Spend a credit per item to license each sample, then download it. Same
 * path-remap logic as downloadOwned. Each licensed item moves into the
 * owned bucket conceptually; we report failures (insufficient credits,
 * network errors) per-item and continue rather than aborting the batch.
 */
export async function buyCreditsBucket(
  items: SpliceCreditsItem[],
  onProgress: (p: SpliceProgress) => void,
): Promise<SpliceDownloadReport> {
  const { purchaseAsset, downloadSample } = await getSpliceClient();
  const failed: SpliceDownloadReport['failed'] = [];
  let succeeded = 0;

  const localRoot = localSpliceSamplesRoot();
  if (!localRoot) {
    const error = `Local Splice samples folder not found at ${path.join(os.homedir(), 'Documents', 'Splice', 'Samples')}. Install the Splice desktop client or create that folder.`;
    log.error(error);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      // Adapt SpliceCreditsItem -> SpliceOwnedItem shape for the failed report.
      const ownedShape: SpliceOwnedItem = { ...item };
      failed.push({ sample: ownedShape, error });
      onProgress({ phase: 'downloading', index: i, total: items.length, sample: ownedShape, status: 'fail', error });
    }
    onProgress({ phase: 'complete' });
    return { attempted: items.length, succeeded: 0, failed };
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const asOwned: SpliceOwnedItem = { ...item };
    onProgress({ phase: 'downloading', index: i, total: items.length, sample: asOwned });
    try {
      // Spend the credit first. If this throws (out of credits, already
      // owned, network), the item is treated as failed and we move on
      // rather than charging credits for items whose downloads fail later.
      await purchaseAsset(item.asset.uuid);
      const destPath = remapToLocalSpliceRoot(
        item.originalPath,
        localRoot,
        item.asset.packName,
        item.basename,
      );
      await downloadSample(item.asset.uuid, destPath);
      succeeded++;
      onProgress({ phase: 'downloading', index: i, total: items.length, sample: asOwned, status: 'ok' });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failed.push({ sample: asOwned, error });
      onProgress({ phase: 'downloading', index: i, total: items.length, sample: asOwned, status: 'fail', error });
    }
  }

  onProgress({ phase: 'complete' });
  return { attempted: items.length, succeeded, failed };
}

/** Write a manifest matching the CLI's output, but to userData (cross-platform). */
export function writeManifest(scanResult: SpliceScanResult, buckets: SpliceBuckets): string {
  const dir = path.join(app.getPath('userData'), 'splice-recover');
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, `splice-recover-${path.basename(scanResult.alsPath, '.als')}.json`);
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        alsPath: scanResult.alsPath,
        scannedAt: new Date().toISOString(),
        summary: {
          owned: buckets.owned.length,
          credits: buckets.credits.length,
          notFound: buckets.notFound.length,
        },
        ...buckets,
      },
      null,
      2,
    ),
  );
  return manifestPath;
}
