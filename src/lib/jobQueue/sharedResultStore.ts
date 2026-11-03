import { SharedResultKey, SharedResultMap } from './types';

type StoreEntry<K extends SharedResultKey> = {
  data: SharedResultMap[K];
  storedAt: number;
  generation: number;
};

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Bumped by every lib file operation (move, delete, convert) so a cached file
// list can't outlive the files it describes. Module-level so file ops can call
// it without reaching into the JobManager instance.
let libraryGeneration = 0;

/** Mark every cached library file list stale. Called from safeMove/safeDelete/convert. */
export function invalidateLibraryFileLists(): void {
  libraryGeneration++;
}

export class SharedResultStore {
  private store = new Map<string, StoreEntry<SharedResultKey>>();
  private ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  set<K extends SharedResultKey>(
    key: K,
    contextKey: string,
    data: SharedResultMap[K]
  ): void {
    const compositeKey = `${key}::${contextKey}`;
    this.store.set(compositeKey, { data, storedAt: Date.now(), generation: libraryGeneration });
  }

  get<K extends SharedResultKey>(
    key: K,
    contextKey: string
  ): SharedResultMap[K] | null {
    const compositeKey = `${key}::${contextKey}`;
    const entry = this.store.get(compositeKey);
    if (!entry) return null;

    if (Date.now() - entry.storedAt > this.ttlMs || entry.generation !== libraryGeneration) {
      this.store.delete(compositeKey);
      return null;
    }

    return entry.data as SharedResultMap[K];
  }

  has(key: SharedResultKey, contextKey: string): boolean {
    return this.get(key, contextKey) !== null;
  }

  invalidate(key: SharedResultKey, contextKey: string): void {
    this.store.delete(`${key}::${contextKey}`);
  }

  clear(): void {
    this.store.clear();
  }
}
