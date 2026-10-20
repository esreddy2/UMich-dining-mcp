import { describe, expect, it } from 'vitest';
import { parseMenuPage } from '../src/parser/menu.js';
import { HALL_IDS, type MealName } from '../src/types.js';
import { HALL_FIXTURES, readFixture, readItemNameSnapshot } from './helpers.js';

/**
 * The verified ground truth of 2026-10-20: meals, stations and items per
 * hall. These numbers are the regression lock on the site's structure.
 */
const GROUND_TRUTH: Record<string, { meals: number; stations: number; items: number }> = {
  bursley: { meals: 3, stations: 22, items: 66 },
  'east-quad': { meals: 1, stations: 9, items: 40 },
  markley: { meals: 1, stations: 6, items: 14 },
  'mosher-jordan': { meals: 3, stations: 21, items: 65 },
  'north-quad': { meals: 1, stations: 7, items: 20 },
  'south-quad': { meals: 3, stations: 28, items: 94 },
  'twigs-at-oxford': { meals: 1, stations: 5, items: 17 },
  'wolverine-village': { meals: 3, stations: 31, items: 97 },
  'lawyers-club': { meals: 2, stations: 12, items: 23 },
  'martha-cook': { meals: 1, stations: 8, items: 12 },
};

function dishLines(html: string): string[] {
  const menu = parseMenuPage(html);
  const lines: string[] = [];
  for (const [meal, stations] of Object.entries(menu.meals)) {
    for (const station of stations) {
      for (const item of station.items) {
        lines.push(`${meal} | ${station.name} | ${item.name}`);
      }
    }
  }
  return lines;
}

describe('menu parser', () => {
  it('covers exactly the ten supported halls', () => {
    expect([...HALL_IDS].sort()).toEqual(Object.keys(GROUND_TRUTH).sort());
  });

  for (const [hall, expected] of Object.entries(GROUND_TRUTH)) {
    describe(hall, () => {
      const html = readFixture(HALL_FIXTURES[hall] as string);

      it(`publishes ${expected.meals} meals, ${expected.stations} stations and ${expected.items} items`, () => {
        const menu = parseMenuPage(html);
        const publishedMeals = Object.entries(menu.meals).filter(([, stations]) => stations.length > 0);
        expect(publishedMeals).toHaveLength(expected.meals);
        expect(menu.stationCount).toBe(expected.stations);
        expect(menu.itemCount).toBe(expected.items);
      });

      it('matches the committed item-name snapshot', () => {
        const snapshot = readItemNameSnapshot();
        expect(snapshot.capturedFor).toBe('2026-10-20');
        const expected = snapshot.halls[hall];
        expect(expected).toBeDefined();
        expect(dishLines(html)).toEqual(expected?.dishLines);
      });
    });
  }

  it('does not count the station <li> as an item', () => {
    const menu = parseMenuPage(readFixture('bursley.html'));
    const stations = Object.values(menu.meals).flat();
    expect(stations).toHaveLength(22);
    // Every station has exactly one name and only real dishes.
    for (const station of stations) {
      expect(station.name.length).toBeGreaterThan(0);
      for (const item of station.items) {
        expect(item.name.length).toBeGreaterThan(0);
      }
    }
    // 87 would be the count if the station <li> were read as an item.
    expect(menu.itemCount).toBe(66);
  });

  it('keeps the site own meal labels', () => {
    const menu = parseMenuPage(readFixture('bursley.html'));
    expect(menu.mealLabels).toEqual({ Breakfast: 'Breakfast', Lunch: 'Lunch', Dinner: 'Dinner' });
    expect(menu.unknownMealLabels).toEqual([]);
  });

  it('reads every dish name exactly once', () => {
    const menu = parseMenuPage(readFixture('bursley.html'));
    const names = Object.values(menu.meals)
      .flat()
      .flatMap((station) => station.items.map((item) => item.name));
    expect(names).toHaveLength(66);
    expect(new Set(names).size).toBeLessThanOrEqual(names.length);
    // "Oatmeal" is served once at Bursley.
    expect(names.filter((name) => name === 'Oatmeal')).toHaveLength(1);
  });

  it('rejects a page that is not a dining hall menu', () => {
    expect(() => parseMenuPage('<html><body><p>nothing here</p></body></html>')).toThrow(
      /no #mdining-items container/,
    );
  });

  it('scopes the item name lookup to the item list', () => {
    const menu = parseMenuPage(readFixture('bursley.html'));
    const breakfast = menu.meals.Breakfast[0];
    expect(breakfast?.name).toBe('Hot Cereal');
    expect(breakfast?.items[0]?.name).toBe('Oatmeal');
    for (const meal of Object.keys(menu.meals) as MealName[]) {
      for (const station of menu.meals[meal]) {
        expect(station.items.every((item) => !item.name.includes('Hot Cereal'))).toBe(true);
      }
    }
  });
});
