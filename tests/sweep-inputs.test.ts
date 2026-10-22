import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cache } from '../src/cache.js';
import { filterDishes, searchDishes } from '../src/service.js';
import { mockFixtureFetch } from './helpers.js';

/**
 * The inputs a sweep takes: the halls it covers, the limit that cuts it
 * short and the order the rows come back in.
 */

beforeEach(() => {
  vi.unstubAllGlobals();
  cache.clear();
  mockFixtureFetch();
});

describe('the halls a sweep covers', () => {
  it('searches every hall when no hall is named, and an empty list means the same', async () => {
    const all = await searchDishes('oatmeal', {});
    const halls = new Set(all.matches.map((match) => match.hall));
    expect(halls.size).toBeGreaterThan(1);

    const empty = await searchDishes('oatmeal', { halls: [] });
    expect(new Set(empty.matches.map((match) => match.hall))).toEqual(halls);
  });

  it('searches the halls that are named', async () => {
    const result = await searchDishes('oatmeal', { halls: ['bursley', 'markley'] });
    expect(result.matches.length).toBeGreaterThan(0);
    for (const match of result.matches) {
      expect(['bursley', 'markley']).toContain(match.hall);
    }
  });

  it('filters the halls that are named', async () => {
    const result = await filterDishes({ halls: ['bursley'] });
    expect(result.matches.length).toBeGreaterThan(0);
    for (const match of result.matches) {
      expect(match.hall).toBe('bursley');
    }
  });
});

describe('the limit', () => {
  it('returns fifty rows by default and says how to see the rest', async () => {
    const result = await searchDishes('a', { halls: ['bursley'] });
    expect(result.totalMatches).toBeGreaterThan(50);
    expect(result.matches).toHaveLength(50);
    expect(result.truncated).toBe(true);
    expect(result.truncationNote).toMatch(/larger limit/);
    expect(result.truncationNote).toMatch(/50 of/);
  });

  it('returns fifty rows of a filter too', async () => {
    const result = await filterDishes({ halls: ['bursley'] });
    expect(result.totalMatches).toBeGreaterThan(50);
    expect(result.matches).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });

  it('takes the rows that were asked for', async () => {
    const result = await searchDishes('a', { halls: ['bursley'], limit: 7 });
    expect(result.matches).toHaveLength(7);
    expect(result.truncated).toBe(true);
  });

  it('is not truncated when everything fits', async () => {
    const result = await searchDishes('oatmeal', { halls: ['markley'] });
    expect(result.truncated).toBe(false);
    expect(result.truncationNote).toBeUndefined();
  });
});

describe('the order of the rows', () => {
  it('sorts a search and takes the first of them', async () => {
    const result = await searchDishes('a', { halls: ['bursley'], sort_by: 'calories', sort_order: 'desc', limit: 10 });
    const calories = result.matches.map((match) => match.calories ?? -1);
    const sorted = [...calories].sort((a, b) => b - a);
    expect(calories).toEqual(sorted);

    // The limit takes the first of the order, not the first that was found.
    const all = await searchDishes('a', { halls: ['bursley'], sort_by: 'calories', sort_order: 'desc' });
    expect(result.matches.map((match) => match.name)).toEqual(all.matches.slice(0, 10).map((match) => match.name));
  });

  it('sorts a filter in the same way', async () => {
    const result = await filterDishes({ halls: ['bursley'], sort_by: 'calories', sort_order: 'asc', limit: 5 });
    const calories = result.matches.map((match) => match.calories ?? Number.MAX_SAFE_INTEGER);
    const sorted = [...calories].sort((a, b) => a - b);
    expect(calories).toEqual(sorted);
  });

  it('refuses a sort field that does not exist', async () => {
    await expect(searchDishes('a', { halls: ['bursley'], sort_by: 'protien' })).rejects.toThrow(
      /Unknown sort field/,
    );
  });
});

describe('the micronutrient thresholds', () => {
  it('reads a threshold without a unit in the amount the row carries', async () => {
    // The oatmeal of the fixture publishes 11 %DV of an 18 mg Daily Value:
    // 1.98 mg of iron.
    const inMg = await filterDishes({ halls: ['bursley'], nutrients: { Iron: { min: 1.9 } } });
    const inMgNames = inMg.matches.map((match) => match.name);
    expect(inMgNames).toContain('Oatmeal');

    const tooMuch = await filterDishes({ halls: ['bursley'], nutrients: { Iron: { min: 1.99 } } });
    expect(tooMuch.matches.map((match) => match.name)).not.toContain('Oatmeal');
  });

  it('reads a threshold in the published percent when the unit says so', async () => {
    const inPercent = await filterDishes({ halls: ['bursley'], nutrients: { Iron: { min: 2, unit: '%DV' } } });
    const inMg = await filterDishes({ halls: ['bursley'], nutrients: { Iron: { min: 2 } } });
    expect(inPercent.matches.length).toBeGreaterThan(0);
    // 2 %DV of iron is 0.36 mg: the percent lets through more dishes.
    expect(inPercent.matches.length).toBeGreaterThan(inMg.matches.length);
  });

  it('takes a gram amount of a nutrient the panel publishes in milligrams', async () => {
    const result = await filterDishes({ halls: ['bursley'], nutrients: { Calcium: { min: 0.03, unit: 'g' } } });
    expect(result.matches.length).toBeGreaterThan(0);
  });
});
