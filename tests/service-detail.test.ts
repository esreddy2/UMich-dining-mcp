import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cache } from '../src/cache.js';
import { MEAL_NAMES } from '../src/types.js';
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
import { HALL_FIXTURES, fixtureResponse, readExpected, mockFixtureFetch, withDeclaredDate } from './helpers.js';

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
  carbon: 1 | 2 | 3 | null;
  calories: number | null;
  sodiumMg: number | null;
}

const MHEALTHY_TIERS = ['mhealthy1', 'mhealthy2', 'mhealthy3', 'mhealthy4', 'mhealthy5'];
const CARBON_TIERS: Record<string, 1 | 2 | 3> = {
  carbonlow: 1,
  carbonmedium: 2,
  carbonhigh: 3,
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

  it('reads the dishes of every hall, meal by meal', async () => {
    for (const hall of Object.keys(HALL_FIXTURES)) {
      const expected = readExpected(hall);
      const perMeal = Object.fromEntries(
        expected.meals.map((meal) => [meal.label, meal.stations.reduce((sum, station) => sum + station.items.length, 0)]),
      );
      for (const meal of MEAL_NAMES) {
        const page = await getMenu(hall as never, undefined, meal);
        expect(countItems(page.menu.meals), `${hall} ${meal}`).toBe(perMeal[meal] ?? 0);
        expect(page.date, `${hall} ${meal}`).toBe(todayIn());
      }
    }
  });

  it('reads 562 dishes over the ten halls, meal by meal', async () => {
    let total = 0;
    for (const hall of Object.keys(HALL_FIXTURES)) {
      const expected = readExpected(hall);
      total += expected.counts.items;
    }
    expect(total).toBe(562);
    // Each meal of each hall yields its own slice of the expected total.
    let served = 0;
    for (const hall of Object.keys(HALL_FIXTURES)) {
      for (const meal of MEAL_NAMES) {
        const page = await getMenu(hall as never, undefined, meal);
        served += countItems(page.menu.meals);
      }
    }
    expect(served).toBe(562);
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

  describe('getMenu meal selection', () => {
    beforeEach(() => {
      cache.clear();
      vi.unstubAllGlobals();
      mockFixtureFetch();
    });

    it('selects the meal being served right now', async () => {
      // 17:00 UTC on 2026-10-22 is 13:00 in the hall's time zone: Lunch.
      const page = await getMenu('bursley', '2026-10-22', undefined, new Date('2026-10-22T17:00:00Z'));
      expect(page.selectedMeals).toEqual(['Lunch']);
      expect(countItems(page.menu.meals)).toBe(26);
    });

    it('does not depend on the time zone of the host', async () => {
      // The server may run in Chicago or in UTC. The campus day and the
      // mealtimes are the campus ones either way.
      const original = process.env['TZ'];
      try {
        for (const zone of ['America/Chicago', 'UTC', 'Pacific/Kiritimati', 'Asia/Tokyo']) {
          process.env['TZ'] = zone;
          expect(todayIn('America/Detroit', new Date('2026-10-22T17:00:00Z')), zone).toBe('2026-10-22');
          expect(todayIn('America/Detroit', new Date('2026-10-22T03:00:00Z')), zone).toBe('2026-10-21');
          const page = await getMenu('bursley', '2026-10-22', undefined, new Date('2026-10-22T17:00:00Z'));
          expect(page.selectedMeals, zone).toEqual(['Lunch']);
        }
      } finally {
        if (original === undefined) delete process.env['TZ'];
        else process.env['TZ'] = original;
      }
    });

    it('serves the next meal after midnight in the campus, not in the host', async () => {
      // 05:00 UTC is 01:00 in Ann Arbor and 00:00 in Chicago: both are after
      // dinner, so the next meal is Breakfast in either zone.
      const original = process.env['TZ'];
      try {
        for (const zone of ['America/Chicago', 'UTC']) {
          process.env['TZ'] = zone;
          const page = await getMenu('bursley', '2026-10-22', undefined, new Date('2026-10-22T05:00:00Z'));
          expect(page.selectedMeals, zone).toEqual(['Breakfast']);
        }
      } finally {
        if (original === undefined) delete process.env['TZ'];
        else process.env['TZ'] = original;
      }
    });

    it('reports nothing when the hall is closed after hours', async () => {
      // 02:00 UTC on 2026-10-23 is 22:00 on the 22nd in Detroit: after dinner.
      const page = await getMenu('bursley', '2026-10-22', undefined, new Date('2026-10-23T02:00:00Z'));
      expect(page.selectedMeals).toEqual([]);
      expect(page.mealNote).toMatch(/not serving|closed/i);
      expect(countItems(page.menu.meals)).toBe(0);
    });

    it('picks the next meal after hours', async () => {
      // 07:00 UTC on 2026-10-22 is 02:00 in Detroit: the next meal is Breakfast.
      const page = await getMenu('bursley', '2026-10-22', undefined, new Date('2026-10-22T07:00:00Z'));
      expect(page.selectedMeals).toEqual(['Breakfast']);
      expect(countItems(page.menu.meals)).toBe(13);
    });

    it('skips a meal label it does not know', async () => {
      const html = `<html><body><div id="mdining-items">
        <h2 class="menuTitle"><span class="date">Thursday, October 23, 2026</span></h2>
        <h3>Supper</h3>
        <div class="courses"><ul class="courses_wrapper"><li><h4>Station</h4><ul class="items"><li><span class="item-name">Supper Dish</span></li></ul></li></ul></div>
      </div></body></html>`;
      vi.stubGlobal('fetch', async (): Promise<Response> => new Response(html, { status: 200 }));
      // Supper is not in the known meal vocabulary, so the hall has no known
      // meal and the call reports nothing published rather than serving it.
      await expect(getMenu('bursley', '2026-10-23', undefined, new Date('2026-10-23T12:00:00Z'))).rejects.toThrow(
        /No menu is published/,
      );
    });

    it('returns an empty meal with a note instead of an error', async () => {
      const html = `<div id="mdining-items">
        <h3>Breakfast</h3>
        <div class="courses"><ul class="courses_wrapper"><li><h4>Station</h4><ul class="items"><li><span class="item-name">Oatmeal</span></li></ul></li></ul></div>
        <h3>Lunch</h3>
        <div class="courses"><ul class="courses_wrapper"><li><h4>Empty Station</h4><ul class="items"></ul></li></ul></div>
      </div>`;
      vi.stubGlobal('fetch', async (): Promise<Response> => new Response(withDeclaredDate(html, '2026-10-24'), { status: 200 }));
      const page = await getMenu('bursley', '2026-10-24', 'Lunch', new Date('2026-10-24T12:00:00Z'));
      expect(page.selectedMeals).toEqual(['Lunch']);
      expect(countItems(page.menu.meals)).toBe(0);
      expect(page.mealNote).toMatch(/Nothing is published for Lunch/i);
    });

    it('serves several meals at once', async () => {
      const page = await getMenu('bursley', '2026-10-22', ['Breakfast', 'Dinner'], new Date('2026-10-22T17:00:00Z'));
      expect(page.selectedMeals).toEqual(['Breakfast', 'Dinner']);
      expect(countItems(page.menu.meals)).toBe(13 + 30);
      expect(page.menu.meals.Brunch).toEqual([]);
      expect(page.menu.meals.Lunch).toEqual([]);
    });

    it('serves the meals in the order of the day, whatever the order of the request', async () => {
      const page = await getMenu('bursley', '2026-10-22', ['Dinner', 'Breakfast'], new Date('2026-10-22T17:00:00Z'));
      expect(page.selectedMeals).toEqual(['Breakfast', 'Dinner']);
    });

    it('serves a meal that is asked for twice only once', async () => {
      const page = await getMenu('bursley', '2026-10-22', ['Lunch', 'Lunch'], new Date('2026-10-22T17:00:00Z'));
      expect(page.selectedMeals).toEqual(['Lunch']);
      expect(countItems(page.menu.meals)).toBe(26);
    });

    it('names the empty meals of a request for several', async () => {
      // Bursley publishes no Brunch on a weekday, and the request for Brunch
      // and Lunch still returns Lunch.
      const page = await getMenu('bursley', '2026-10-22', ['Brunch', 'Lunch'], new Date('2026-10-22T17:00:00Z'));
      expect(page.selectedMeals).toEqual(['Brunch', 'Lunch']);
      expect(countItems(page.menu.meals)).toBe(26);
      expect(page.mealNote).toMatch(/Nothing is published for Brunch/i);
    });
  });

  it('keeps a hall that fails out of the way of the others', async () => {
    cache.clear();
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('markley')) throw new Error('the hall is down');
      const response = fixtureResponse(url);
      return response ?? new Response('not found', { status: 404 });
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
    const { halls, weekly, failures } = await getHours();
    expect(failures).toEqual([]);
    expect(halls).toHaveLength(10);
    for (const hall of halls) {
      const expected = readExpected(hall.hall);
      expect(hall.today.map((period) => period.label), hall.hall).toEqual(
        expected.todayHours.map((period) => period.label),
      );
      expect(hall.weekly, hall.hall).not.toBeNull();
      expect(weekly[hall.weekly!]?.length, hall.hall).toBeGreaterThan(0);
    }
  });

  it('puts every hall in exactly one of the open and the closed list', async () => {
    const { open, closed, failures } = await findOpenNow();
    expect(failures).toEqual([]);
    expect(open.length + closed.length).toBe(10);
    const ids = [...open.map((location) => location.id), ...closed];
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
    const one = await searchDishes('oatmeal', { halls: ['bursley'] });
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
    const result = await filterDishes({ max_carbon: 2 });
    const rank = { 1: 1, 2: 2, 3: 3 };
    const expected = ALL_DISHES.filter(
      (dish) => dish.carbon !== null && rank[dish.carbon] <= 2,
    ).sort(byHallMealName);
    expect(result.totalMatches).toBe(expected.length);
    for (const match of result.matches) {
      expect([1, 2]).toContain(match.carbonFootprint);
    }
  });

  it('reads the calories and the sodium as caps', async () => {
    const result = await filterDishes({ nutrients: { calories: { max: 300 }, sodium: { max: 500 } } });
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

  it('does not repeat the long allergen caveat in the body', async () => {
    const result = await filterDishes({});
    expect(result).not.toHaveProperty('warning');
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
    expect(result.nutrition.servingSize).toBe(dish?.panel?.values?.servingSize);
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
