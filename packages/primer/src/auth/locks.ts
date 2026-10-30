// Cross-tab exclusive locks (navigator.locks with a localStorage lease fallback).

export interface LeaseLockOptions {
  /**
   * The lease expiration in ms (in case the holder tab was closed).
   */
  ttl?: number;

  /**
   * The max wait for the lease in ms before running the callback without it.
   */
  wait?: number;
}

const defaultLeaseTTL = 15000;
const defaultLeaseWait = 20000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch (_) {
    return null; // e.g. blocked by the browser privacy settings
  }
}

function readLease(storage: Storage, name: string): { owner: string; expires: number } | null {
  try {
    return JSON.parse(storage.getItem(name) || "null");
  } catch (_) {
    return null;
  }
}

function randomOwner(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

/**
 * Runs `fn` while holding an exclusive cross-tab lock based on a localStorage lease
 * (fallback for the browsers without navigator.locks support).
 *
 * The lease expires after `ttl` in case the holder tab was closed.
 * If the lease couldn't be acquired within `wait`, `fn` is called anyway.
 */
export async function withLeaseLock<T>(
  name: string,
  fn: () => Promise<T>,
  options: LeaseLockOptions = {},
): Promise<T> {
  const storage = getLocalStorage();
  if (!storage) {
    return fn();
  }

  const ttl = options.ttl || defaultLeaseTTL;
  const deadline = Date.now() + (options.wait || defaultLeaseWait);
  const owner = randomOwner();

  let acquired = false;

  while (!acquired && Date.now() < deadline) {
    const lease = readLease(storage, name);

    if (!lease || !(lease.expires > Date.now())) {
      try {
        storage.setItem(name, JSON.stringify({ owner, expires: Date.now() + ttl }));
      } catch (_) {
        break; // storage is not available
      }

      // give a concurrent writer the chance to overwrite the lease (last write wins)
      await sleep(30);

      acquired = readLease(storage, name)?.owner === owner;
      if (acquired) {
        break;
      }
    }

    await sleep(50 + Math.floor(Math.random() * 100));
  }

  try {
    return await fn();
  } finally {
    if (acquired && readLease(storage, name)?.owner === owner) {
      try {
        storage.removeItem(name);
      } catch (_) {}
    }
  }
}

/**
 * Runs `fn` while holding an exclusive cross-tab lock with the specified name.
 *
 * It uses `navigator.locks` if available, otherwise a localStorage lease
 * (see {@link withLeaseLock}). Outside of a browser `fn` is called directly.
 */
export function withCrossTabLock<T>(
  name: string,
  fn: () => Promise<T>,
  options: LeaseLockOptions = {},
): Promise<T> {
  const locks = typeof navigator !== "undefined" ? (navigator as any).locks : undefined;
  if (locks?.request) {
    return locks.request(name, { mode: "exclusive" }, fn);
  }

  return withLeaseLock(name, fn, options);
}
