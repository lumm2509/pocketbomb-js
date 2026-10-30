/**
 * A caching strategy (durations in seconds).
 */
export interface CachingStrategy {
  /**
   * "no-store" skips the cache.
   */
  mode?: "public" | "no-store";

  /**
   * How long an entry stays fresh.
   */
  maxAge?: number;

  /**
   * How long after the fresh window a stale entry is served while it is refreshed in the background.
   */
  staleWhileRevalidate?: number;
}

/**
 * The caching strategies of the storefront queries ({@link withCache}).
 */
export const Cache = {
  /** Skip the cache. */
  none: (): CachingStrategy => ({ mode: "no-store" }),
  /** 1 second fresh + 9 seconds stale-while-revalidate. */
  short: (): CachingStrategy => ({ mode: "public", maxAge: 1, staleWhileRevalidate: 9 }),
  /** 1 hour fresh + 23 hours stale-while-revalidate. */
  long: (): CachingStrategy => ({ mode: "public", maxAge: 3600, staleWhileRevalidate: 82800 }),
  /** A custom strategy. */
  custom: (options: Omit<CachingStrategy, "mode">): CachingStrategy => ({
    mode: "public",
    maxAge: options.maxAge ?? 0,
    staleWhileRevalidate: options.staleWhileRevalidate ?? 0,
  }),
};

/**
 * A cached entry.
 */
export interface CacheEntry<T = unknown> {
  value: T;

  /**
   * The unix ms timestamp until the entry is fresh.
   */
  freshUntil: number;

  /**
   * The unix ms timestamp until the entry could be served stale.
   */
  staleUntil: number;
}

/**
 * A pluggable async key-value cache store (in-memory, KV, Redis, ...).
 */
export interface CacheStore {
  get(key: string): Promise<CacheEntry | undefined> | CacheEntry | undefined;
  set(key: string, entry: CacheEntry): Promise<void> | void;
  delete(key: string): Promise<void> | void;
}

/**
 * An in-memory {@link CacheStore} with an optional max number of entries (LRU eviction).
 */
export class MemoryCache implements CacheStore {
  private entries = new Map<string, CacheEntry>();

  constructor(readonly maxEntries = 1000) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): CacheEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.staleUntil <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }

    // move to the end (most recently used)
    this.entries.delete(key);
    this.entries.set(key, entry);

    return entry;
  }

  set(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

/**
 * Schedules background work (e.g. the `ctx.waitUntil` of the edge runtimes).
 */
export type WaitUntil = (promise: Promise<unknown>) => void;

export interface WithCacheOptions {
  cache?: CacheStore | null;
  key: string;
  strategy?: CachingStrategy | null;
  waitUntil?: WaitUntil;

  /**
   * Whether the result should be cached (default to always).
   */
  shouldCache?: (value: any) => boolean;
}

const revalidating = new Set<string>();

/**
 * Runs `fn` with the provided caching strategy: a fresh entry is returned as it is,
 * a stale entry is returned and refreshed in the background (stale-while-revalidate)
 * and a missing entry is loaded and stored.
 *
 * Without a cache store or with the "no-store" strategy `fn` is called directly.
 */
export async function withCache<T>(options: WithCacheOptions, fn: () => Promise<T>): Promise<T> {
  const { cache, key, strategy } = options;
  if (!cache || !strategy || strategy.mode === "no-store") {
    return fn();
  }

  const store = async (value: T): Promise<void> => {
    if (options.shouldCache && !options.shouldCache(value)) {
      return;
    }

    const now = Date.now();
    const freshUntil = now + (strategy.maxAge || 0) * 1000;
    await cache.set(key, {
      value,
      freshUntil,
      staleUntil: freshUntil + (strategy.staleWhileRevalidate || 0) * 1000,
    });
  };

  const entry = (await cache.get(key)) as CacheEntry<T> | undefined;
  const now = Date.now();

  if (entry && entry.freshUntil > now) {
    return entry.value;
  }

  if (entry && entry.staleUntil > now) {
    if (!revalidating.has(key)) {
      revalidating.add(key);

      const refresh = fn()
        .then(store)
        .catch(() => {}) // keep serving the stale entry
        .finally(() => revalidating.delete(key));

      options.waitUntil?.(refresh);
    }

    return entry.value;
  }

  const value = await fn();
  await store(value);

  return value;
}

/**
 * Returns a SHA-256 hex digest (e.g. to build cache keys without leaking secrets).
 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
