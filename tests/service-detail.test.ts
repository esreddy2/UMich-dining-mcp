import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cache } from '../src/cache.js';
import {
  ServiceError,
  countItems,
  filterDishes,
  findOpenNow,
  getHours,
  getItemNutrition,
  getMenu,
  listLocations,
  searchDishes,
  todayIn,
  validateDate,
} from '../src/service.js';
import { HALL_FIXTURES, readExpected, readFixture, mockFixtureFetch } from './helpers.js';

/**
 * The service layer, checked against the data of the site.
 *
 * The counts of the searches and of the filters are recomputed here from the
 * expected data of `tests/fixtures/expected/`, which is written by the
 * independent oracle, so the service is compared with the markup of the site
 * and not with itself.
 */

interface ExpectedDish {
  hall: string;
  meal: string;
  station: string;
  name: string;
  traits: string[];
  allergens: string[];
  mhealthyTier: number | null;
  carbon: 'low' | 'medium' | 'high' | null;
  calories: number | null;
  sodiumMg: number | null;
}

const MHEALTHY_TIERS = ['mhealthy1', 'mhealthy2', 'mhealthy3', 'mhealthy4', 'mhealthy5'];
const CARBON_TIERS: Record<string, 'low' | 'medium' | 'high'> = {
  carbonlow: 'low',
  carbonmedium: 'medium',
  carbonhigh: 'high',
};

/** Every dish of the site, rebuilt from the expected data. */
function expectedDishes(): ExpectedDish[] {
  const dishes: ExpectedDish[] = [];
  for (const hall of Object.keys(HALL_FIXTURES)) {
    const expected = readExpected(hall);
    for (const meal of expected.meals) {
      for (const station of meal.stations) {
        for (const item of station.items) {
          const slugs = new Set([
            ...item.traitClasses,
            ...item.publishedTraits.map((trait) => trait.slug),
          ]);
          if (slugs.has('vegan')) slugs.add('vegetarian');
          const traits = [...slugs].sort();
          const mhealthy = MHEALTHY_TIERS.findIndex((tier) => slugs.has(tier));
          const carbon = Object.keys(CARBON_TIERS).find((tier) => slugs.has(tier));
          const sodium = item.panel?.values.sodium ?? null;
          const sodiumMg = sodium ? Number.parseInt(sodium.replace(/[^0-9]/g, ''), 10) : null;
          dishes.push({
            hall,
            meal: meal.label,
            station: station.name,
            name: item.name,
            traits,
            allergens: [...item.allergenClasses].sort(),
            mhealthyTier: mhealthy >= 0 ? mhealthy + 1 : null,
            carbon: carbon ? CARBON_TIERS[carbon] ?? null : null,
            calories: item.panel?.values.calories ?? null,
            sodiumMg: Number.isFinite(sodiumMg) ? sodiumMg : null,
          });
        }
      }
    }
  }
  return dishes;
}

/** The order the service reports its matches in. */
function byHallMealName(a: ExpectedDish, b: ExpectedDish): number {
  return a.hall.localeCompare(b.hall) || a.meal.localeCompare(b.meal) || a.name.localeCompare(b.name);
}

const ALL_DISHES = expectedDishes();

/**
 * The ten hall pages are read once and kept in the cache, so that the tests
 * below compare many sweeps with the same pages instead of fetching and
 * parsing them over and over.
 */
beforeAll(async () => {
  cache.clear();
  vi.unstubAllGlobals();
  mockFixtureFetch();
  await listLocations();
});

describe('the dates the site publishes', () => {
  it('accepts the range of the datepicker of the site', () => {
    const today = '2026-10-20';
    expect(() => validateDate('2026-10-17', today)).not.toThrow();
    expect(() => validateDate('2026-11-03', today)).not.toThrow();
    expect(() => validateDate('2026-10-20', today)).not.toThrow();
  });

  it('rejects a day outside the range of the datepicker of the site', () => {
    const today = '2026-10-20';
    expect(() => validateDate('2026-10-16', today)).toThrow(/outside the range/);
    expect(() => validateDate('2026-11-04', today)).toThrow(/outside the range/);
  });

  it('names the range in the error', () => {
    expect(() => validateDate('2026-11-04', '2026-10-20')).toThrow(/2026-10-17 to 2026-11-03/);
  });

  it('rejects a date that is not a date', () => {
    expect(() => validateDate('20-10-2026', '2026-10-20')).toThrow(/not a valid date/);
    expect(() => validateDate('2026-02-30', '2026-10-20')).toThrow(/not a valid date/);
    expect(() => validateDate('2026-13-01', '2026-10-20')).toThrow(/not a valid date/);
  });

  it('reads today in the time zone of the site', () => {
    const today = todayIn();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(todayIn('America/Detroit', new Date('2026-10-21T03:00:00Z'))).toBe('2026-10-20');
    expect(todayIn('America/Detroit', new Date('2026-10-21T05:00:00Z'))).toBe('2026-10-21');
  });
});

describe('the menus of the halls', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockFixtureFetch();
  });

  it('reads the dishes of every hall', async () => {
    for (const hall of Object.keys(HALL_FIXTURES)) {
      const page = await getMenu(hall as never);
      const expected = readExpected(hall);
      expect(countItems(page.menu.meals), hall).toBe(expected.counts.items);
      expect(page.date, hall).toBe(todayIn());
    }
  });

  it('reads 562 dishes over the ten halls', async () => {
    let total = 0;
    for (const hall of Object.keys(HALL_FIXTURES)) {
      const page = await getMenu(hall as never);
      total += countItems(page.menu.meals);
    }
    expect(total).toBe(562);
  });

  it('reports the contact details of every hall', async () => {
    const { locations, failures } = await listLocations();
    expect(failures).toEqual([]);
    expect(locations).toHaveLength(10);
    for (const location of locations) {
      const expected = readExpected(location.id);
      expect(location.address, location.id).toBe(expected.location.address);
      expect(location.phone, location.id).toBe(expected.location.phone);
      expect(location.email, location.id).toBe(expected.location.email);
      expect(location.mapUrl, location.id).toBe(expected.location.mapUrl);
    }
  });

  it('reports the meals a hall serves on the day', async () => {
    const { locations } = await listLocations();
    for (const location of locations) {
      const expected = readExpected(location.id);
      const published = expected.meals.filter((meal) => meal.stations.length > 0).map((meal) => meal.label);
      expect(location.meals, location.id).toEqual(published);
    }
  });

  it('keeps a hall that fails out of the way of the others', async () => {
    cache.clear();
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('markley')) throw new Error('the hall is down');
      const name = `${new URL(url).pathname.replace(/\/+$/, '').split('/').pop()}.html`;
      return new Response(readFixture(name), { status: 200 });
    });

    const { locations, failures } = await listLocations();
    expect(locations).toHaveLength(9);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.hall).toBe('markley');
    expect(locations.find((location) => location.id === 'markley')).toBeUndefined();

    // The pages of the other halls are read again for the tests below.
    cache.clear();
    mockFixtureFetch();
    await listLocations();
  });

  it('reports the service periods of every hall', async () => {
    const halls = await getHours();
    expect(halls).toHaveLength(10);
    for (const hall of halls) {
      const expected = readExpected(hall.hall);
      expect(hall.today.map((period) => period.label), hall.hall).toEqual(
        expected.todayHours.map((period) => period.label),
      );
      expect(hall.regular, hall.hall).not.toBeNull();
      expect(hall.regular?.weekly.length, hall.hall).toBeGreaterThan(0);
    }
  });

  it('puts every hall in exactly one of the open and the closed list', async () => {
    const { open, closed, failures } = await findOpenNow();
    expect(failures).toEqual([]);
    expect(open.length + closed.length).toBe(10);
    const ids = [...open, ...closed].map((location) => location.id);
    expect(new Set(ids).size).toBe(10);
  });
});

describe('the search for dishes', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockFixtureFetch();
  });

  it('finds the dishes whose name holds the query', async () => {
    const result = await searchDishes('oatmeal');
    const expected = ALL_DISHES.filter((dish) => dish.name.toLowerCase().includes('oatmeal')).sort(
      byHallMealName,
    );
    expect(result.totalMatches).toBe(expected.length);
    expect(result.matches.map((match) => `${match.hall}|${match.meal}|${match.name}`)).toEqual(
      expected.map((dish) => `${dish.hall}|${dish.meal}|${dish.name}`),
    );
  });

  it('ignores the case of the query', async () => {
    const lower = await searchDishes('oatmeal');
    const upper = await searchDishes('OATMEAL');
    expect(upper.totalMatches).toBe(lower.totalMatches);
  });

  it('finds a dish in one hall only', async () => {
    const all = await searchDishes('oatmeal');
    const one = await searchDishes('oatmeal', { hall: 'bursley' });
    expect(one.totalMatches).toBeLessThan(all.totalMatches);
    for (const match of one.matches) expect(match.hall).toBe('bursley');
  });

  it('reports a query that matches nothing without failing', async () => {
    const result = await searchDishes('a dish the site does not serve');
    expect(result.totalMatches).toBe(0);
    expect(result.matches).toEqual([]);
  });

  it('rejects an empty query', async () => {
    await expect(searchDishes('   ')).rejects.toThrow(ServiceError);
  });

  it('cuts the matches at the limit but counts them all', async () => {
    const all = await searchDishes('a');
    const limited = await searchDishes('a', { limit: 5 });
    expect(limited.matches).toHaveLength(5);
    expect(limited.totalMatches).toBe(all.totalMatches);
  });
});

describe('the filters of the dishes', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockFixtureFetch();
  });

  it('excludes the dishes that carry a listed allergen', async () => {
    const result = await filterDishes({ exclude_allergens: ['milk'] });
    const expected = ALL_DISHES.filter((dish) => !dish.allergens.includes('milk')).sort(
      byHallMealName,
    );
    expect(result.totalMatches).toBe(expected.length);
    for (const match of result.matches) expect(match.allergens).not.toContain('milk');
  });

  it('keeps the dishes that carry every listed trait', async () => {
    const result = await filterDishes({ require_traits: ['vegan', 'halal'] });
    const expected = ALL_DISHES.filter(
      (dish) => dish.traits.includes('vegan') && dish.traits.includes('halal'),
    ).sort(byHallMealName);
    expect(result.totalMatches).toBe(expected.length);
    for (const match of result.matches) {
      expect(match.traits).toContain('vegan');
      expect(match.traits).toContain('halal');
    }
  });

  it('reads the nutrient density as a minimum', async () => {
    const result = await filterDishes({ min_mhealthy: 3 });
    const expected = ALL_DISHES.filter(
      (dish) => dish.mhealthyTier !== null && dish.mhealthyTier >= 3,
    ).sort(byHallMealName);
    expect(result.totalMatches).toBe(expected.length);
    for (const match of result.matches) {
      expect(match.mhealthyTier).not.toBeNull();
      expect(match.mhealthyTier as number).toBeGreaterThanOrEqual(3);
    }
  });

  it('reads the carbon footprint as a maximum and leaves out the dishes without one', async () => {
    const result = await filterDishes({ max_carbon: 'medium' });
    const rank = { low: 1, medium: 2, high: 3 };
    const expected = ALL_DISHES.filter(
      (dish) => dish.carbon !== null && rank[dish.carbon] <= rank.medium,
    ).sort(byHallMealName);
    expect(result.totalMatches).toBe(expected.length);
    for (const match of result.matches) {
      expect(['low', 'medium']).toContain(match.carbonFootprint);
    }
  });

  it('reads the calories and the sodium as caps', async () => {
    const result = await filterDishes({ max_calories: 300, max_sodium_mg: 500 });
    const expected = ALL_DISHES.filter(
      (dish) =>
        dish.calories !== null &&
        dish.calories <= 300 &&
        dish.sodiumMg !== null &&
        dish.sodiumMg <= 500,
    ).sort(byHallMealName);
    expect(result.totalMatches).toBe(expected.length);
    for (const match of result.matches) {
      expect(match.calories).not.toBeNull();
      expect(match.sodiumMg).not.toBeNull();
    }
  });

  it('counts every dish of the site and returns the first 500', async () => {
    // The service caps a list of matches at 500 dishes; the total is the
    // number of dishes that match, not the number that are returned.
    const all = await filterDishes({ limit: 500 });
    expect(all.totalMatches).toBe(ALL_DISHES.length);
    expect(all.matches).toHaveLength(500);
  });

  it('cuts the matches at the limit but counts them all', async () => {
    const all = await filterDishes({ limit: 500 });
    const limited = await filterDishes({ limit: 5 });
    expect(limited.matches).toHaveLength(5);
    expect(limited.totalMatches).toBe(all.totalMatches);
  });

  it('carries the allergen warning with every result', async () => {
    const result = await filterDishes({});
    expect(result.warning).toMatch(/allergen/i);
    expect(result.warning).toMatch(/coeliac/i);
  });
});

describe('the nutrition panel of a dish', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockFixtureFetch();
  });

  it('returns the panel of the dish that was asked for', async () => {
    const result = await getItemNutrition('bursley', 'Oatmeal');
    const expected = readExpected('bursley');
    const dish = expected.meals
      .flatMap((meal) => meal.stations)
      .flatMap((station) => station.items)
      .find((item) => item.name === 'Oatmeal');
    expect(result.name).toBe('Oatmeal');
    expect(result.nutrition).toEqual(dish?.panel?.values);
  });

  it('matches the name of the dish without regard to its case', async () => {
    const result = await getItemNutrition('bursley', 'oatmeal');
    expect(result.name).toBe('Oatmeal');
  });

  it('reports a dish the hall does not serve', async () => {
    await expect(getItemNutrition('bursley', 'a dish the site does not serve')).rejects.toThrow(
      /No dish called/,
    );
  });

  it('reports a dish that is served more than once instead of guessing', async () => {
    // "Burger" holds two dishes of Bursley - the blended burger and the
    // blend burger with American cheese - and both are served in two meals.
    await expect(getItemNutrition('bursley', 'Burger')).rejects.toThrow(/matches \d+ dishes/);
    await expect(getItemNutrition('bursley', 'Burger')).rejects.toThrow(/Be more specific/);
    await expect(getItemNutrition('bursley', 'Burger')).rejects.toThrow(
      /Beef and Mushroom Blended Burger/,
    );
  });

  it('reports the dish of a name the hall serves twice', async () => {
    // "Cheese Pizza" is served in two meals of Bursley under the same name.
    const result = await getItemNutrition('bursley', 'Cheese Pizza');
    expect(result.name).toBe('Cheese Pizza');
    expect(result.meal).toMatch(/^(Breakfast|Lunch|Dinner)$/);
  });

  it('reports a dish the site publishes without a panel', async () => {
    await expect(getItemNutrition('bursley', 'Sandwiches Made to Order')).rejects.toThrow(
      /does not publish a nutrition panel/,
    );
  });

  it('rejects an empty name', async () => {
    await expect(getItemNutrition('bursley', '  ')).rejects.toThrow(ServiceError);
  });
});
