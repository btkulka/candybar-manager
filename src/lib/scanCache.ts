import { createScopedLogger } from './logger';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

function getFileMtimeMs(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return undefined;
  }
}

const log = createScopedLogger('ScanCache');
import { CheckResult } from './musicLibraryCheck';

export type CacheEntry<T> = {
  data: T;
  timestamp: number;
  libraryRoot: string;
  csvPath?: string; // Only for check results
  csvMtimeMs?: number; // CSV file modification time
};

export type ScanCache = {
  libraryCheck?: CacheEntry<CheckResult>;
};

// In-memory store for libraryCheck (CSV/Spotify matching results).
// Library health and organize state now live in SQLite (see libraryStore.ts).
let store: ScanCache = {};
let cacheFilePath: string | null = null;

export function initCachePath(userDataDir: string): void {
  cacheFilePath = path.join(userDataDir, 'scan-cache.json');
}

// Serialize writes so rapid successive calls can't race and swap their
// on-disk order (which would leave older state persisted).
let persistChain: Promise<void> = Promise.resolve();
function persistToDisk(): void {
  if (!cacheFilePath) return;
  const snapshot = JSON.stringify(store);
  persistChain = persistChain
    .then(() => fsPromises.writeFile(cacheFilePath!, snapshot))
    .catch((err) => {
      log.warn('Failed to persist cache to disk:', err);
    });
}

export async function loadCache(): Promise<ScanCache> {
  if (cacheFilePath && fs.existsSync(cacheFilePath)) {
    try {
      const raw = fs.readFileSync(cacheFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as ScanCache & { libraryHealth?: unknown; organizeState?: unknown };
      // Drop any legacy keys that have already been migrated to SQLite
      store = { libraryCheck: parsed.libraryCheck };
      if (parsed.libraryHealth || parsed.organizeState) {
        persistToDisk(); // rewrite without the legacy keys
      }
      log.info('Cache restored from disk');
    } catch (err) {
      log.warn('Failed to read cache from disk, starting fresh:', err);
      store = {};
    }
  }
  return store;
}

export function isCacheValid<T>(
  entry: CacheEntry<T> | undefined,
  libraryRoot: string,
  csvPath?: string
): boolean {
  if (!entry) return false;
  if (entry.libraryRoot !== libraryRoot) return false;
  if (csvPath !== undefined && entry.csvPath !== csvPath) return false;
  if (csvPath !== undefined && entry.csvMtimeMs !== undefined) {
    const currentMtime = getFileMtimeMs(csvPath);
    if (currentMtime !== undefined && currentMtime !== entry.csvMtimeMs) return false;
  }
  return true;
}

export function getCachedLibraryCheck(
  libraryRoot: string,
  csvPath: string
): CheckResult | null {
  const entry = store.libraryCheck;
  if (isCacheValid(entry, libraryRoot, csvPath)) {
    return entry!.data;
  }
  return null;
}

/** Return the most-recent cached library-track list regardless of which CSV
 *  drove the scan, as long as the libraryRoot matches. Used by the Sources
 *  tab to tag already-in-library matches without requiring a full rescan. */
export function getLatestCachedLibraryTracks(libraryRoot: string): CheckResult['libraryTracks'] | null {
  const entry = store.libraryCheck;
  if (!entry || entry.libraryRoot !== libraryRoot) return null;
  return entry.data.libraryTracks;
}

export async function cacheLibraryCheck(
  libraryRoot: string,
  csvPath: string,
  result: CheckResult
): Promise<void> {
  store.libraryCheck = {
    data: result,
    timestamp: Date.now(),
    libraryRoot,
    csvPath,
    csvMtimeMs: getFileMtimeMs(csvPath)
  };
  persistToDisk();
}

export function updateCachedCheckResult(result: CheckResult): void {
  if (store.libraryCheck) {
    store.libraryCheck.data = result;
    store.libraryCheck.timestamp = Date.now();
    persistToDisk();
  }
}

export function getCacheStatus(): {
  libraryCheck: { valid: boolean; age: number | null; libraryRoot: string | null } | null;
  libraryHealth: { valid: boolean; age: number | null; libraryRoot: string | null } | null;
} {
  const now = Date.now();
  const checkEntry = store.libraryCheck;
  return {
    libraryCheck: checkEntry ? {
      valid: true,
      age: now - checkEntry.timestamp,
      libraryRoot: checkEntry.libraryRoot
    } : null,
    // libraryHealth moved to SQLite; this field is returned as null for
    // backwards compatibility with existing IPC consumers.
    libraryHealth: null
  };
}

export async function clearCache(): Promise<void> {
  store = {};
  persistToDisk();
}

export async function clearCacheEntry(type: 'libraryCheck'): Promise<void> {
  delete store[type];
  persistToDisk();
}
