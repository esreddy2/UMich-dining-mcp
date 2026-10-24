import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cache } from '../src/cache.js';
import { DiskCache, diskCache } from '../src/disk-cache.js';
import { warmerDays, warm } from '../src/warmer.js';
import { mockFixtureFetch } from './helpers.js';

describe('the warmer', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    cache.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cache.clear();
  });

  it('covers today and the published future window', () => {
    const days = warmerDays('2026-10-21');
    expect(days[0]).toBe('2026-10-18');
    expect(days).toHaveLength(18);
    expect(days[3]).toBe('2026-10-21');
  });

  it('warms a hall and a day without failing on the others', async () => {
    mockFixtureFetch();
    const result = await warm(['bursley'], ['2026-10-21'], '2026-10-21');
    expect(result.warmed).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('isolates a hall that fails', async () => {
    vi.stubGlobal('fetch', async (): Promise<Response> => new Response('not found', { status: 404 }));
    const result = await warm(['bursley'], ['2026-10-21'], '2026-10-21');
    expect(result.warmed).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('does not refetch a page that is still fresh', async () => {
    mockFixtureFetch();
    await diskCache.delete('hall:markley:2026-10-21');
    cache.clear();

    const mock = mockFixtureFetch();
    await warm(['markley'], ['2026-10-21'], '2026-10-21');
    expect(mock.calls).toHaveLength(2);

    // A live entry is served from the cache: no second request to the site.
    await warm(['markley'], ['2026-10-21'], '2026-10-21');
    expect(mock.calls).toHaveLength(2);
  });
});

describe('the cache behind the memory', () => {
  let dir: string;
  let disk: DiskCache;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'umich-dining-l2-'));
    disk = new DiskCache(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('serves a value that is only on disk', async () => {
    await disk.set('hall:bursley:2026-10-21', { meals: { Lunch: [] } }, 60_000);

    const { TtlCache } = await import('../src/cache.js');
    const memory = new TtlCache(disk);
    let loaded = false;
    const result = await memory.fetch('hall:bursley:2026-10-21', 60_000, async () => {
      loaded = true;
      return { meals: {} };
    });

    expect(loaded).toBe(false);
    expect(result.value).toEqual({ meals: { Lunch: [] } });
    expect(result.stale).toBe(false);
  });

  it('writes a loaded value to the disk', async () => {
    const { TtlCache } = await import('../src/cache.js');
    const memory = new TtlCache(disk);
    await memory.fetch('hall:bursley:2026-10-21', 60_000, async () => ({ meals: { Lunch: [] } }));
    await memory.flush();

    const entry = await disk.get('hall:bursley:2026-10-21');
    expect(entry?.value).toEqual({ meals: { Lunch: [] } });
  });

  it('falls back to an expired disk entry when the load fails', async () => {
    await disk.set('hall:bursley:2026-10-21', { meals: { Lunch: [] } }, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const { TtlCache } = await import('../src/cache.js');
    const memory = new TtlCache(disk);
    const result = await memory.fetch('hall:bursley:2026-10-21', 60_000, async () => {
      throw new Error('the site is down');
    });

    expect(result.stale).toBe(true);
    expect(result.value).toEqual({ meals: { Lunch: [] } });
  });

  it('keeps one file per key', async () => {
    const { TtlCache } = await import('../src/cache.js');
    const memory = new TtlCache(disk);
    await memory.fetch('hall:bursley:2026-10-21', 60_000, async () => ({ a: 1 }));
    await memory.fetch('hall:bursley:2026-10-22', 60_000, async () => ({ a: 2 }));
    await memory.flush();
    const names = await readdir(dir);
    expect(names.filter((name) => name.endsWith('.json'))).toHaveLength(2);
  });

  it('knows that a key is held on the disk', async () => {
    const { TtlCache } = await import('../src/cache.js');
    const memory = new TtlCache(disk);

    expect(await memory.isCached('hall:bursley:2026-10-21')).toBe(false);
    await memory.fetch('hall:bursley:2026-10-21', 60_000, async () => ({ a: 1 }));
    await memory.flush();
    expect(await memory.isCached('hall:bursley:2026-10-21')).toBe(true);
  });

  it('flushes while a disk write is in flight instead of looping', async () => {
    const { TtlCache } = await import('../src/cache.js');
    const memory = new TtlCache(disk);
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const realSet = disk.set.bind(disk);
    vi.spyOn(disk, 'set').mockImplementation(async (key: string, value: unknown, ttlMs: number, storedAt?: number) => {
      await held;
      return realSet(key, value, ttlMs, storedAt);
    });

    const loaded = memory.fetch('hall:bursley:2026-10-21', 60_000, async () => ({ a: 1 }));
    await loaded; // writeToDisk has been invoked and the write is held in flight
    const flushing = memory.flush();
    release!();
    await flushing;

    const entry = await disk.get('hall:bursley:2026-10-21');
    expect(entry?.value).toEqual({ a: 1 });
    vi.restoreAllMocks();
  });
});
