/**
 * A TTL cache with in-flight de-duplication and stale-on-error.
 *
 * - Concurrent requests for the same key share one upstream call.
 * - An entry that is past its TTL is kept as a fallback: if the reload fails,
 *   the stale value is returned and flagged instead of the call failing.
 * - A persistent cache sits behind the memory: a value that is not in memory
 *   is looked up on disk, and every value that is loaded is written to disk.
 */

import { diskCache, type DiskCache } from './disk-cache.js';
import { config } from './config.js';

export interface Cached<T> {
  value: T;
  stale: boolean;
  /** When the value was originally produced, in epoch milliseconds. */
  storedAt: number;
  /** True when the value came from the memory or the disk, not from the network. */
  cached: boolean;
}

interface Entry<T> {
  value: T;
  storedAt: number;
  expiresAt: number;
}

export class TtlCache {
  private readonly entries = new Map<string, Entry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly diskWrites = new Set<Promise<void>>();

  constructor(private readonly disk: DiskCache | null = null) {}

  /** Wait for the pending persistent writes to finish. */
  async flush(): Promise<void> {
    // Drain a snapshot once: writeToDisk keeps appending to diskWrites while
    // the writes are in flight, so re-reading the set can loop forever.
    await Promise.all([...this.diskWrites]);
  }

  private writeToDisk(key: string, value: unknown, ttlMs: number, storedAt: number): void {
    if (!this.disk) return;
    const write = this.disk.set(key, value, ttlMs, storedAt).then(() => {});
    this.diskWrites.add(write);
    void write.finally(() => this.diskWrites.delete(write));
  }

  /** Number of entries currently held, live and stale alike. */
  get size(): number {
    return this.entries.size;
  }

  get<T>(key: string): Entry<T> | undefined {
    return this.entries.get(key) as Entry<T> | undefined;
  }

  /**
   * Whether the key is held live, in the memory or on the disk.
   *
   * The range budget asks this before it fetches a page: a page that is on
   * the disk needs no request, so it does not count against the budget.
   */
  async isCached(key: string): Promise<boolean> {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > now) return true;
    if (!this.disk) return false;
    const diskEntry = await this.disk.get(key);
    return diskEntry !== null && diskEntry.expiresAt > now;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    const now = Date.now();
    this.entries.set(key, { value, storedAt: now, expiresAt: now + ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
    void this.disk?.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  /**
   * Return the cached value for `key`, loading it with `loader` when needed.
   *
   * A live entry is returned as is. A missing or expired entry is loaded; when
   * the load fails and an expired entry is still available, the expired value
   * is returned with `stale: true`.
   */
  async fetch<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    options: { force?: boolean } = {},
  ): Promise<Cached<T>> {
    const now = Date.now();

    // Cold-start hydration: if no memory entry, check disk first so an expired
    // disk entry is available as a fallback during an upstream outage.
    let existing = this.entries.get(key) as Entry<T> | undefined;
    if (!existing && this.disk && !options.force) {
      const diskEntry = await this.disk.get(key);
      if (diskEntry) {
        existing = { value: diskEntry.value as T, storedAt: diskEntry.storedAt, expiresAt: diskEntry.expiresAt };
        this.entries.set(key, existing);
      }
    }
    if (options.force) {
      existing = this.entries.get(key) as Entry<T> | undefined;
    }

    // Fresh entry: serve it, and trigger a background revalidation once past
    // the refresh threshold so the value is already fresh by the time TTL ends.
    if (existing && existing.expiresAt > now && !options.force) {
      const refreshAt = existing.storedAt + (existing.expiresAt - existing.storedAt) * config.cacheRefreshThreshold;
      if (now > refreshAt) {
        this.revalidate(key, ttlMs, loader);
      }
      return { value: existing.value, stale: false, storedAt: existing.storedAt, cached: true };
    }

    // Expired entry (or hydrated expired disk entry): try a synchronous fetch.
    if (existing && !options.force) {
      const pending = this.inFlight.get(key) as Promise<T> | undefined;
      if (pending) {
        try {
          await pending;
          const entry = this.entries.get(key) as Entry<T> | undefined;
          if (entry) {
            return { value: entry.value, stale: false, storedAt: entry.storedAt, cached: true };
          }
        } catch {
          // Fetch failed - fall through to stale fallback.
        }
        return { value: existing.value, stale: true, storedAt: existing.storedAt, cached: true };
      }

      const load = (async (): Promise<T> => {
        try {
          const value = await loader();
          const storedAt = Date.now();
          this.entries.set(key, { value, storedAt, expiresAt: storedAt + ttlMs });
          this.writeToDisk(key, value, ttlMs, storedAt);
          return value;
        } finally {
          this.inFlight.delete(key);
        }
      })();
      this.inFlight.set(key, load);

      try {
        const value = await load;
        return { value, stale: false, storedAt: Date.now(), cached: false };
      } catch {
        existing.expiresAt = Date.now() + 60_000;
        this.entries.set(key, existing);
        return { value: existing.value, stale: true, storedAt: existing.storedAt, cached: true };
      }
    }

    // No entry (or force): load from disk or network (existing behavior).
    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) {
      const value = await pending;
      const entry = this.entries.get(key) as Entry<T> | undefined;
      return { value, stale: false, storedAt: entry?.storedAt ?? now, cached: true };
    }

    let diskEntry: { value: unknown; storedAt: number; expiresAt: number } | null = null;
    const load = (async (): Promise<T> => {
      try {
        if (this.disk) {
          diskEntry = await this.disk.get(key);
          if (diskEntry && diskEntry.expiresAt > now && !options.force) {
            this.entries.set(key, {
              value: diskEntry.value,
              storedAt: diskEntry.storedAt,
              expiresAt: diskEntry.expiresAt,
            });
            return diskEntry.value as T;
          }
        }
        const value = await loader();
        const storedAt = Date.now();
        this.entries.set(key, { value, storedAt, expiresAt: storedAt + ttlMs });
        this.writeToDisk(key, value, ttlMs, storedAt);
        return value;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, load);

    try {
      const value = await load;
      return { value, stale: false, storedAt: Date.now(), cached: false };
    } catch (error) {
      const entry = diskEntry as { value: unknown; storedAt: number; expiresAt: number } | null;
      if (entry) {
        this.entries.set(key, {
          value: entry.value,
          storedAt: entry.storedAt,
          expiresAt: entry.expiresAt,
        });
        return { value: entry.value as T, stale: true, storedAt: entry.storedAt, cached: true };
      }
      throw error;
    }
  }

  /** Reload a stale entry in the background, keeping the stale value meanwhile. */
  private revalidate<T>(key: string, ttlMs: number, loader: () => Promise<T>): void {
    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) return;
    const load = loader().then(
      (value) => {
        const storedAt = Date.now();
        this.entries.set(key, { value, storedAt, expiresAt: storedAt + ttlMs });
        this.inFlight.delete(key);
        this.writeToDisk(key, value, ttlMs, storedAt);
        return value;
      },
      () => {
        this.inFlight.delete(key);
      },
    );
    this.inFlight.set(key, load);
    void load.catch(() => {});
  }
}

export const cache = new TtlCache(diskCache.enabled ? diskCache : null);
