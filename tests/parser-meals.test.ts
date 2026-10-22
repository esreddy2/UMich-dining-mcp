import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { parseMenuPage, extractDeclaredDate } from '../src/parser/menu.js';
import { load } from 'cheerio';
import { cache } from '../src/cache.js';
import { filterDishes, getMenu } from '../src/service.js';
import { readFixture, withDeclaredDate } from './helpers.js';

/**
 * The meals the parser must keep.
 *
 * The site publishes a fourth meal, Brunch, and on the weekend days it is
 * often the only meal of the afternoon. The captured fixtures hold no Brunch
 * page, so these pages were built from the site's own markup.
 */
describe('the meals of a menu page', () => {
  it('keeps a Brunch meal beside another meal', () => {
    const parsed = parseMenuPage(readFixture('brunch.html'));

    expect(Object.keys(parsed.meals).sort()).toEqual(['Breakfast', 'Brunch', 'Dinner', 'Lunch']);
    expect(parsed.meals.Brunch.length).toBe(3);
    expect(parsed.meals.Brunch.map((station) => station.name)).toEqual([
      'Hot Cereal',
      'Toast',
      'Signature Maize',
    ]);
    expect(parsed.meals.Dinner.length).toBe(2);
    expect(parsed.unknownMealLabels).toEqual([]);
    expect(parsed.stationCount).toBe(5);
    expect(parsed.itemCount).toBe(5);
  });

  it('keeps a Brunch-only page', () => {
    const parsed = parseMenuPage(readFixture('brunch-only.html'));

    expect(parsed.meals.Brunch.length).toBe(2);
    expect(parsed.stationCount).toBe(2);
    expect(parsed.itemCount).toBe(2);
  });

  it('keeps a meal label it has no slot for as its own bucket', () => {
    const parsed = parseMenuPage(readFixture('supper.html'));

    expect(parsed.unknownMealLabels).toEqual(['Supper']);
    expect(parsed.otherMeals).toHaveLength(1);
    expect(parsed.otherMeals[0]?.label).toBe('Supper');
    expect(parsed.otherMeals[0]?.stations[0]?.items[0]?.name).toBe('Night Soup');
    // The station is counted: the page is not empty.
    expect(parsed.stationCount).toBe(1);
    expect(parsed.itemCount).toBe(1);
  });

  it('accepts the site’s own "no menu" marker', () => {
    const parsed = parseMenuPage(readFixture('no-menu.html'));

    expect(parsed.noMenu).toBe(true);
    expect(parsed.stationCount).toBe(0);
    expect(parsed.itemCount).toBe(0);
  });

  it('reads the date the page declares', () => {
    const $ = load(readFixture('brunch.html'));
    expect(extractDeclaredDate($)).toBe('2026-10-24');
  });

  it('finds no date on a page that states none', () => {
    const $ = load('<html><body><h2 class="menuTitle">Menu</h2></body></html>');
    expect(extractDeclaredDate($)).toBeNull();
  });

  it('still reads the captured pages the way it always did', () => {
    const parsed = parseMenuPage(readFixture('bursley.html'));
    expect(parsed.stationCount).toBe(22);
    expect(parsed.itemCount).toBe(69);
    expect(parsed.noMenu).toBe(false);
  });
});

/** The same meals, seen through the service. */
describe('a meal the sweep has to reach', () => {
  beforeEach(() => {
    cache.clear();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cache.clear();
  });

  function serveBrunch(): void {
    vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('regularhours')) {
        return new Response(readFixture('regularhours.html'), { status: 200 });
      }
      const body = readFixture('brunch.html');
      return new Response(withDeclaredDate(body, '2026-10-24'), { status: 200 });
    });
  }

  it('finds the Brunch dishes in a sweep', async () => {
    serveBrunch();

    const result = await filterDishes({ halls: ['bursley'], date: '2026-10-24' });

    expect(result.failures).toHaveLength(0);
    expect(result.totalMatches).toBe(5);
    expect(result.matches.map((match) => match.meal)).toContain('Brunch');
  });

  it('narrows a sweep to one meal, Brunch included', async () => {
    serveBrunch();

    const result = await filterDishes({ halls: ['bursley'], date: '2026-10-24', meal: 'Brunch' });

    expect(result.totalMatches).toBe(3);
    for (const match of result.matches) {
      expect(match.meal).toBe('Brunch');
    }
  });

  it('serves a Brunch-only page instead of failing the hall', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('regularhours')) {
        return new Response(readFixture('regularhours.html'), { status: 200 });
      }
      const body = readFixture('brunch-only.html');
      return new Response(withDeclaredDate(body, '2026-10-25'), { status: 200 });
    });

    const page = await getMenu('bursley', '2026-10-25', 'Brunch');
    expect(page.menu.meals.Brunch).toHaveLength(2);
  });

  it('says that no menu is published when the site says so', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('regularhours')) {
        return new Response(readFixture('regularhours.html'), { status: 200 });
      }
      const body = readFixture('no-menu.html');
      return new Response(withDeclaredDate(body, '2026-10-25'), { status: 200 });
    });

    const result = await filterDishes({ halls: ['bursley'], date: '2026-10-25' });
    expect(result.failures).toHaveLength(0);
    expect(result.totalMatches).toBe(0);
    expect(result.noMenu).toEqual([{ hall: 'bursley', date: '2026-10-25' }]);
  });
});
