import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../src/cache.js';
import { cache } from '../src/cache.js';
import { countItems, getMenu, listLocations } from '../src/service.js';
import { fixtureResponse, mockFixtureFetch, readFixture } from './helpers.js';

describe('cache', () => {
  beforeEach(() => {
    cache.clear();
    vi.unstubAllGlobals();
  });

  it('makes one upstream request for ten concurrent identical calls', async () => {
    const mock = mockFixtureFetch();
    const pages = await Promise.all(Array.from({ length: 10 }, () => getMenu('bursley', undefined, 'Lunch')));

    expect(mock.calls).toHaveLength(2);
    for (const page of pages) {
      expect(countItems(page.menu.meals), 'Lunch at Bursley').toBe(26);
    }
  });

  it('serves a stale entry when the reload fails', async () => {
    const ttl = 20;
    const store = new TtlCache();
    let calls = 0;

    const loader = async (): Promise<string> => {
      calls += 1;
      if (calls === 1) return 'first';
      throw new Error('upstream is down');
    };

    const first = await store.fetch('key', ttl, loader);
    expect(first).toEqual({
      value: 'first',
      stale: false,
      storedAt: expect.any(Number),
      cached: false,
    });

    await new Promise((resolve) => setTimeout(resolve, ttl + 5));

    const second = await store.fetch('key', ttl, loader);
    expect(second.value).toBe('first');
    expect(second.stale).toBe(true);
    expect(calls).toBe(2);
  });

  it('fails when there is nothing to fall back on', async () => {
    const store = new TtlCache();
    await expect(
      store.fetch('key', 1000, async () => {
        throw new Error('upstream is down');
      }),
    ).rejects.toThrow(/upstream is down/);
  });

  it('keeps a failed hall from breaking the other halls', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('markley')) throw new Error('upstream is down');
      if (url.includes('regularhours')) {
        return new Response(readFixture('regularhours.html'), { status: 200 });
      }
      const response = fixtureResponse(url);
      return response ?? new Response('not found', { status: 404 });
    });

    const { locations, failures } = await listLocations();
    expect(locations).toHaveLength(9);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.hall).toBe('markley');
    expect(locations.find((location) => location.id === 'markley')).toBeUndefined();
  });
});
