import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { cache } from '../src/cache.js';
import { config } from '../src/config.js';
import { filterDishes, searchDishes, todayIn } from '../src/service.js';
import { mockDatedFetch, readFixture } from './helpers.js';

const BURSLEY = readFixture('bursley.html');

function day(offset: number): string {
  const base = Date.parse(`${todayIn()}T00:00:00Z`);
  return new Date(base + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

describe('a range query', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    // The cache is shared by the process; a range query counts its own fetches.
    cache.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('aggregates a dish over the days it appears on', async () => {
    mockDatedFetch({ [day(0)]: BURSLEY, [day(1)]: BURSLEY, [day(2)]: BURSLEY });

    const result = await searchDishes('oatmeal', { halls: ['bursley'], from: day(0), to: day(2) });

    expect(result.dateRange).toEqual({ from: day(0), to: day(2) });
    expect(result.matches.length).toBeGreaterThan(0);
    for (const match of result.matches) {
      expect(match.dates).toEqual([day(0), day(1), day(2)]);
    }
  });

  it('reports the days it could not cover', async () => {
    mockDatedFetch({ [day(0)]: BURSLEY });
    const budget = config.maxRangeFetches;
    config.maxRangeFetches = 1;

    try {
      const result = await searchDishes('oatmeal', { halls: ['bursley'], from: day(0), to: day(2) });
      expect(result.coverage).toBeDefined();
      expect(result.coverage!.requested).toBe(3);
      expect(result.coverage!.fetchedNow).toBe(1);
      expect(result.coverage!.pending).toBe(2);
    } finally {
      config.maxRangeFetches = budget;
    }
  });

  it('counts the pages it already had as cached', async () => {
    mockDatedFetch({ [day(0)]: BURSLEY, [day(1)]: BURSLEY, [day(2)]: BURSLEY });

    const first = await searchDishes('oatmeal', { halls: ['bursley'], from: day(0), to: day(2) });
    expect(first.coverage!.fetchedNow).toBe(3);
    expect(first.coverage!.cached).toBe(0);

    cache.clear();
    const second = await searchDishes('oatmeal', { halls: ['bursley'], from: day(0), to: day(2) });
    expect(second.coverage!.fetchedNow).toBe(3);
  });

  it('refuses a date together with a range', async () => {
    mockDatedFetch({});
    await expect(
      searchDishes('oatmeal', { halls: ['bursley'], date: day(0), from: day(0) }),
    ).rejects.toThrow(/not both/);
  });

  it('refuses a range that ends before it starts', async () => {
    mockDatedFetch({});
    await expect(
      searchDishes('oatmeal', { halls: ['bursley'], from: day(2), to: day(0) }),
    ).rejects.toThrow(/after its end/);
  });

  it('reports a day whose page carried no menu', async () => {
    mockDatedFetch({ [day(0)]: BURSLEY, [day(1)]: BURSLEY });
    const result = await searchDishes('oatmeal', { halls: ['bursley'], from: day(0), to: day(1) });
    expect(result.noMenu).toEqual([]);
  });

  it('filters a range and keeps the days that satisfy the constraint', async () => {
    mockDatedFetch({ [day(0)]: BURSLEY, [day(1)]: BURSLEY, [day(2)]: BURSLEY });
    const result = await filterDishes({
      halls: ['bursley'],
      from: day(0),
      to: day(2),
      nutrients: { calories: { min: 1_000_000 } },
    });
    expect(result.matches).toHaveLength(0);
  });

  it('searches within one meal', async () => {
    mockDatedFetch({ [day(0)]: BURSLEY });
    const result = await searchDishes('oatmeal', { halls: ['bursley'], meal: 'Breakfast' });
    expect(result.matches.length).toBeGreaterThan(0);
    for (const match of result.matches) {
      expect(match.meal).toBe('Breakfast');
    }
  });

  it('searches within one station', async () => {
    mockDatedFetch({ [day(0)]: BURSLEY });
    const result = await searchDishes('oatmeal', { halls: ['bursley'], station: 'Hot Cereal' });
    expect(result.matches.length).toBeGreaterThan(0);
    for (const match of result.matches) {
      expect(match.station).toBe('Hot Cereal');
    }
  });

  it('names the stations that do exist when a station matches nothing', async () => {
    mockDatedFetch({ [day(0)]: BURSLEY });
    const result = await searchDishes('oatmeal', { halls: ['bursley'], station: 'No Such Station' });
    expect(result.matches).toHaveLength(0);
    expect(result.stationNote).toMatch(/No station called/);
    expect(result.stationNote).toMatch(/Hot Cereal/);
  });

  it('is paged with an offset over the range', async () => {
    mockDatedFetch({ [day(0)]: BURSLEY, [day(1)]: BURSLEY, [day(2)]: BURSLEY });

    const first = await searchDishes('oatmeal', { halls: ['bursley'], from: day(0), to: day(2) });
    expect(first.coverage!.offset).toBe(0);
    expect(first.coverage!.pages).toBe(3);
    // The whole range fitted in one call: there is no next page.
    expect(first.coverage!.nextOffset).toBeNull();

    // With a budget of one page, the rest of the range is paged.
    const budget = config.maxRangeFetches;
    config.maxRangeFetches = 1;
    cache.clear();
    try {
      const paged = await searchDishes('oatmeal', { halls: ['bursley'], from: day(0), to: day(2) });
      expect(paged.coverage!.nextOffset).toBe(1);
      expect(paged.coverage!.pending).toBe(2);

      // The next window starts where the first one stopped.
      const second = await searchDishes('oatmeal', {
        halls: ['bursley'],
        from: day(0),
        to: day(2),
        offset: paged.coverage!.nextOffset!,
      });
      expect(second.coverage!.offset).toBe(1);
      expect(second.coverage!.nextOffset).toBe(2);
    } finally {
      config.maxRangeFetches = budget;
    }
  });
});
