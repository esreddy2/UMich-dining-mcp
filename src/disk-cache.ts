import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

/**
 * The persistent cache, one JSON file per key under the cache directory.
 *
 * It sits behind the in-memory TTL cache: the memory decides whether a value
 * is live, the disk keeps the value across restarts and serves the pages a
 * range query needs without spending a request on the site.
 *
 * Only public menu data is stored. The directory is created with mode 0700
 * and the files with mode 0600.
 */

export interface DiskEntry {
  key: string;
  value: unknown;
  /** When the value was produced, in epoch milliseconds. */
  storedAt: number;
  /** When the value goes stale, in epoch milliseconds. */
  expiresAt: number;
}

const FILE_SUFFIX = '.json';

/**
 * Whether a value is made only of things JSON can hold.
 *
 * A `Map` or a `Set` is not: it serialises to `{}` and comes back empty. A
 * function, a symbol and a bigint are not either, and a circular structure
 * cannot be written at all. The cache refuses to store such a value, so a
 * poisoned entry can never be written in the first place.
 */
export function isJsonSafe(value: unknown, seen: Set<object> = new Set()): boolean {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (value instanceof Map || value instanceof Set) return false;
  if (value instanceof Date) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isJsonSafe(entry, seen)) return false;
    }
    return true;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    // A property whose value is undefined is dropped by JSON, which is
    // harmless: the key is simply absent afterwards.
    if (entry === undefined) continue;
    if (!isJsonSafe(entry, seen)) return false;
  }
  return true;
}

/** A file name that is unique per key and safe to write anywhere. */
function fileNameFor(key: string): string {
  const readable = key.replace(/[^A-Za-z0-9.-]+/g, '_').slice(0, 80);
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 12);
  return `${readable}-${digest}${FILE_SUFFIX}`;
}

export interface PruneOptions {
  /** The oldest day the site still publishes; earlier days are dropped. */
  earliestDate?: string;
  /** The newest day the site still publishes; later days are dropped. */
  latestDate?: string;
  /** Entries older than this many days are dropped. */
  maxAgeDays?: number;
  /** The largest the cache may grow, in bytes. */
  maxSizeBytes?: number;
}

export class DiskCache {
  readonly dir: string | null;

  constructor(dir: string | null) {
    this.dir = dir;
  }

  get enabled(): boolean {
    return this.dir !== null;
  }

  private pathFor(key: string): string | null {
    return this.dir === null ? null : join(this.dir, fileNameFor(key));
  }

  /** Read an entry, or null when there is none or it cannot be read. */
  async get(key: string): Promise<DiskEntry | null> {
    const path = this.pathFor(key);
    if (path === null) return null;
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as DiskEntry;
      if (typeof parsed?.storedAt !== 'number' || typeof parsed?.expiresAt !== 'number') return null;
      return parsed;
    } catch {
      // A missing or damaged file is a cache miss, never a failure.
      return null;
    }
  }

  /** Write an entry. The write is atomic: a temp file, then a rename. */
  async set(key: string, value: unknown, ttlMs: number, storedAt = Date.now()): Promise<void> {
    const path = this.pathFor(key);
    if (path === null) return;
    const entry: DiskEntry = { key, value, storedAt, expiresAt: storedAt + ttlMs };
    if (!isJsonSafe(entry)) {
      // The value does not survive the round trip. Storing it would poison
      // the next process that reads it.
      return;
    }
    let serialised: string;
    try {
      serialised = JSON.stringify(entry);
    } catch {
      return;
    }
    try {
      await mkdir(this.dir!, { recursive: true, mode: 0o700 });
      const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(temp, serialised, { mode: 0o600 });
      await rename(temp, path);
    } catch {
      // The cache is an optimisation; a failed write must not fail the call.
    }
  }

  /** Remove one entry. */
  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    if (path === null) return;
    try {
      await rm(path, { force: true });
    } catch {
      // Nothing to do: the entry is gone either way.
    }
  }

  /** The files of the cache with their size and the key they hold. */
  private async files(): Promise<{ path: string; key: string; size: number; storedAt: number }[]> {
    if (this.dir === null) return [];
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const files: { path: string; key: string; size: number; storedAt: number }[] = [];
    for (const name of names) {
      if (!name.endsWith(FILE_SUFFIX)) continue;
      const path = join(this.dir, name);
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        const raw = await readFile(path, 'utf8');
        const parsed = JSON.parse(raw) as Partial<DiskEntry>;
        if (typeof parsed?.key !== 'string') continue;
        files.push({ path, key: parsed.key, size: info.size, storedAt: parsed.storedAt ?? 0 });
      } catch {
        // A file that cannot be read is dropped by the prune below.
      }
    }
    return files;
  }

  /**
   * Drop what is no longer worth keeping.
   *
   * An entry is dropped when its day left the published window, when it is
   * older than the maximum age, and, once the size cap is reached, the
   * oldest entries go first.
   */
  async prune(options: PruneOptions = {}): Promise<number> {
    if (this.dir === null) return 0;
    const files = await this.files();
    const maxAgeDays = options.maxAgeDays ?? config.cacheMaxAgeDays;
    const maxSizeBytes = options.maxSizeBytes ?? config.cacheMaxSizeMb * 1024 * 1024;
    const now = Date.now();

    const dropped = new Set<string>();
    let size = 0;
    const kept: { path: string; key: string; size: number; storedAt: number }[] = [];

    for (const file of files) {
      const date = /:(\d{4}-\d{2}-\d{2})$/.exec(file.key)?.[1];
      if (date) {
        if (options.earliestDate && date < options.earliestDate) {
          dropped.add(file.path);
          continue;
        }
        if (options.latestDate && date > options.latestDate) {
          dropped.add(file.path);
          continue;
        }
      }
      if (maxAgeDays > 0 && now - file.storedAt > maxAgeDays * 24 * 60 * 60 * 1000) {
        dropped.add(file.path);
        continue;
      }
      kept.push(file);
      size += file.size;
    }

    // Over the cap, the oldest entries go first.
    kept.sort((a, b) => a.storedAt - b.storedAt);
    for (const file of kept) {
      if (size <= maxSizeBytes) break;
      dropped.add(file.path);
      size -= file.size;
    }

    for (const path of dropped) {
      try {
        await rm(path, { force: true });
      } catch {
        // Nothing to do.
      }
    }

    return dropped.size;
  }
}

export const diskCache = new DiskCache(config.cacheDir);
