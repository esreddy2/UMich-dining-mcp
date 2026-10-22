import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiskCache } from '../src/disk-cache.js';
import { parseRegularHours } from '../src/parser/hours.js';
import { HALL_IDS } from '../src/types.js';
import { readFixture } from './helpers.js';

describe('the persistent cache', () => {
  let dir: string;
  let cache: DiskCache;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'umich-dining-cache-'));
    cache = new DiskCache(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('does nothing when it is switched off', async () => {
    const off = new DiskCache(null);
    expect(off.enabled).toBe(false);
    await off.set('hall:bursley:2026-10-21', { meals: {} }, 1000);
    expect(await off.get('hall:bursley:2026-10-21')).toBeNull();
  });

  it('writes a value and reads it back', async () => {
    await cache.set('hall:bursley:2026-10-21', { meals: { Lunch: [] } }, 60_000);
    const entry = await cache.get('hall:bursley:2026-10-21');
    expect(entry?.value).toEqual({ meals: { Lunch: [] } });
    expect(entry?.expiresAt).toBeGreaterThan(entry!.storedAt);
  });

  it('writes one file per key', async () => {
    await cache.set('hall:bursley:2026-10-21', { a: 1 }, 60_000);
    await cache.set('hall:bursley:2026-10-22', { a: 2 }, 60_000);
    const names = await readdir(dir);
    expect(names.filter((name) => name.endsWith('.json'))).toHaveLength(2);
  });

  it('keeps the directory and the files private', async () => {
    await cache.set('hall:bursley:2026-10-21', { a: 1 }, 60_000);
    const directoryMode = (await stat(dir)).mode & 0o777;
    expect(directoryMode & 0o077).toBe(0);
    const name = (await readdir(dir)).find((entry) => entry.endsWith('.json'))!;
    const fileMode = (await stat(join(dir, name))).mode & 0o777;
    expect(fileMode & 0o077).toBe(0);
  });

  it('leaves no temporary file behind', async () => {
    await cache.set('hall:bursley:2026-10-21', { a: 1 }, 60_000);
    const names = await readdir(dir);
    expect(names.filter((name) => name.endsWith('.tmp'))).toHaveLength(0);
  });

  it('treats a damaged file as a miss', async () => {
    await cache.set('hall:bursley:2026-10-21', { a: 1 }, 60_000);
    const name = (await readdir(dir)).find((entry) => entry.endsWith('.json'))!;
    await writeFile(join(dir, name), 'not json at all');
    expect(await cache.get('hall:bursley:2026-10-21')).toBeNull();
  });

  it('refuses to store a value that does not survive the round trip', async () => {
    // A Map serialises to {}: storing it would poison the next process.
    await cache.set('regular-hours', new Map([['bursley', { hall: 'bursley' }]]), 60_000);
    expect(await cache.get('regular-hours')).toBeNull();
    expect((await readdir(dir)).filter((name) => name.endsWith('.json'))).toHaveLength(0);
  });

  it('stores the regular hours the server actually caches', async () => {
    const regular = parseRegularHours(readFixture('regularhours.html'));
    await cache.set('regular-hours', regular, 60_000);

    const entry = await cache.get('regular-hours');
    expect(entry).not.toBeNull();
    const value = entry!.value as Record<string, { name: string; weekly: unknown[] }>;
    expect(Object.keys(value).sort()).toEqual([...HALL_IDS].sort());
    expect(value['bursley']?.name).toBe('Bursley');
    expect(value['bursley']?.weekly.length).toBeGreaterThan(0);
  });

  it('prunes the days that left the published window', async () => {
    await cache.set('hall:bursley:2026-10-01', { a: 1 }, 60_000);
    await cache.set('hall:bursley:2026-10-21', { a: 2 }, 60_000);
    await cache.set('hall:bursley:2026-12-01', { a: 3 }, 60_000);

    const dropped = await cache.prune({ earliestDate: '2026-10-20', latestDate: '2026-11-04' });

    expect(dropped).toBe(2);
    expect(await cache.get('hall:bursley:2026-10-21')).not.toBeNull();
    expect(await cache.get('hall:bursley:2026-10-01')).toBeNull();
    expect(await cache.get('hall:bursley:2026-12-01')).toBeNull();
  });

  it('prunes the entries that are older than the maximum age', async () => {
    const old = new DiskCache(dir);
    await old.set('hall:bursley:2026-10-21', { a: 1 }, 60_000, Date.now() - 40 * 24 * 60 * 60 * 1000);
    await old.set('hall:bursley:2026-10-22', { a: 2 }, 60_000, Date.now());

    const dropped = await old.prune({ maxAgeDays: 30 });

    expect(dropped).toBe(1);
    expect(await old.get('hall:bursley:2026-10-22')).not.toBeNull();
  });

  it('drops the oldest entries first when the cache is over the cap', async () => {
    const base = Date.now() - 10 * 60 * 1000;
    await cache.set('old', { a: 1 }, 60_000, base);
    await cache.set('new', { a: 2 }, 60_000, base + 60_000);

    const dropped = await cache.prune({ maxSizeBytes: 1 });

    expect(dropped).toBe(2);
  });
});
