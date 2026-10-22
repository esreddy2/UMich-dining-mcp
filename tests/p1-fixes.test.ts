import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cache } from '../src/cache.js';
import { parseTodaysHours } from '../src/parser/hours.js';
import { load } from 'cheerio';
import {
  filterDishes,
  getHours,
  isOpenAtMinutes,
  listLocations,
  parseTimeOfDay,
} from '../src/service.js';
import { fixtureResponse, readFixture } from './helpers.js';

/**
 * The P1 fixes of the extensive findings.
 *
 * Every case here is a defect that was reproduced against the site and is
 * now closed.
 */
describe('a day the hall is closed', () => {
  it('reads the closed marker the site publishes', () => {
    const $ = load(
      '<div class="hours"><ul class="calhours"><li>Closed</li></ul></div>',
    );
    const periods = parseTodaysHours($);
    expect(periods).toEqual([{ label: 'Closed', times: 'Closed', closed: true }]);
  });

  it('still reads the periods of an open day', () => {
    const $ = load(readFixture('bursley.html'));
    const periods = parseTodaysHours($);
    expect(periods.length).toBeGreaterThan(0);
    expect(periods.every((period) => period.closed === false)).toBe(true);
  });
});

describe('the end of a service period', () => {
  it('is exclusive', () => {
    const periods = [{ label: 'Breakfast', times: '9:00 am - 10:30 am', closed: false }];
    expect(isOpenAtMinutes(periods, 9 * 60)).toBe(true);
    expect(isOpenAtMinutes(periods, 10 * 60 + 29)).toBe(true);
    // The hall closes at 10:30, so it is closed at 10:30.
    expect(isOpenAtMinutes(periods, 10 * 60 + 30)).toBe(false);
  });

  it('does not overlap the periods that touch', () => {
    const periods = [
      { label: 'Lunch', times: '11:00 am - 4:30 pm', closed: false },
      { label: 'Dinner', times: '4:30 pm - 7:30 pm', closed: false },
    ];
    // The end of a period is exclusive and the start of the next one is
    // inclusive, so the two never overlap and 4:30 pm is served by Dinner.
    expect(isOpenAtMinutes(periods, 16 * 60 + 30)).toBe(true);
    expect(isOpenAtMinutes(periods, 16 * 60 + 29)).toBe(true);
    // The end of the last period is exclusive too.
    expect(isOpenAtMinutes(periods, 19 * 60 + 30)).toBe(false);
    expect(isOpenAtMinutes(periods, 19 * 60 + 29)).toBe(true);
  });
});

describe('a hall that cannot be read', () => {
  beforeEach(() => {
    cache.clear();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cache.clear();
  });

  it('does not lose the other halls of get_hours', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('markley')) throw new Error('the hall is down');
      if (url.includes('regularhours')) {
        return new Response(readFixture('regularhours.html'), { status: 200 });
      }
      const response = fixtureResponse(url);
      return response ?? new Response('not found', { status: 404 });
    });

    const { hours, failures } = await getHours();
    expect(hours).toHaveLength(9);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.hall).toBe('markley');
  });
});

describe('a sort field', () => {
  beforeEach(() => {
    cache.clear();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cache.clear();
  });

  it('refuses an unknown one', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return fixtureResponse(url) ?? new Response('not found', { status: 404 });
    });

    await expect(filterDishes({ halls: ['bursley'], sort_by: 'protien' })).rejects.toThrow(
      /Unknown sort field/,
    );
  });

  it('names the fields it knows', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return fixtureResponse(url) ?? new Response('not found', { status: 404 });
    });

    await expect(filterDishes({ halls: ['bursley'], sort_by: 'protien' })).rejects.toThrow(
      /proteinToCalorie/,
    );
  });
});

describe('a nutrient name', () => {
  it('is matched without regard to case', async () => {
    cache.clear();
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return fixtureResponse(url) ?? new Response('not found', { status: 404 });
    });

    const result = await filterDishes({ halls: ['bursley'], nutrients: { Protein: { min: 1 } } });
    expect(result.failures).toHaveLength(0);
    expect(result.totalMatches).toBeGreaterThan(0);
  });
});

describe('the meals of a hall', () => {
  beforeEach(() => {
    cache.clear();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cache.clear();
  });

  it('come from the published periods', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('regularhours')) {
        return new Response(readFixture('regularhours.html'), { status: 200 });
      }
      const response = fixtureResponse(url);
      return response ?? new Response('not found', { status: 404 });
    });

    const { locations } = await listLocations();
    const bursley = locations.find((location) => location.id === 'bursley');
    expect(bursley).toBeDefined();
    // The meals and the periods of the same hall never disagree.
    const periodLabels = bursley!.today
      .filter((period) => !period.closed)
      .map((period) => period.label);
    for (const meal of bursley!.meals) {
      expect(periodLabels.map((label) => label.toLowerCase())).toContain(meal.toLowerCase());
    }
  });
});

describe('a time of day', () => {
  it('is read in the campus time zone', () => {
    expect(parseTimeOfDay('7:05 pm')).toBe(19 * 60 + 5);
  });
});
