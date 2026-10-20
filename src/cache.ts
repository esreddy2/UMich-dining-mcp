/**
 * A TTL cache with in-flight de-duplication and stale-on-error.
 *
 * - Concurrent requests for the same key share one upstream call.
 * - An entry that is past its TTL is kept as a fallback: if the reload fails,
 *   the stale value is returned and flagged instead of the call failing.
 */

export interface Cached<T> {
  value: T;
  stale: boolean;
  /** When the value was originally produced, in epoch milliseconds. */
  storedAt: number;
}

interface Entry<T> {
  value: T;
  storedAt: number;
  expiresAt: number;
}

export class TtlCache {
  private readonly entries = new Map<string, Entry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  /** Number of entries currently held, live and stale alike. */
  get size(): number {
    return this.entries.size;
  }

  get<T>(key: string): Entry<T> | undefined {
    return this.entries.get(key) as Entry<T> | undefined;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    const now = Date.now();
    this.entries.set(key, { value, storedAt: now, expiresAt: now + ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
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
  async fetch<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<Cached<T>> {
    const now = Date.now();
    const existing = this.entries.get(key) as Entry<T> | undefined;
    if (existing && existing.expiresAt > now) {
      return { value: existing.value, stale: false, storedAt: existing.storedAt };
    }

    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) {
      const value = await pending;
      const entry = this.entries.get(key) as Entry<T> | undefined;
      return { value, stale: false, storedAt: entry?.storedAt ?? now };
    }

    const load = loader().then(
      (value) => {
        this.entries.set(key, { value, storedAt: Date.now(), expiresAt: Date.now() + ttlMs });
        this.inFlight.delete(key);
        return value;
      },
      (error: unknown) => {
        this.inFlight.delete(key);
        throw error;
      },
    );
    this.inFlight.set(key, load);

    try {
      const value = await load;
      return { value, stale: false, storedAt: Date.now() };
    } catch (error) {
      if (existing) {
        return { value: existing.value, stale: true, storedAt: existing.storedAt };
      }
      throw error;
    }
  }
}

export const cache = new TtlCache();
