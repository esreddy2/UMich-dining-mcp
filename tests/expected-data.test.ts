import { describe, expect, it } from 'vitest';
import { load } from 'cheerio';
import { parseMenuPage } from '../src/parser/menu.js';
import { parseTodaysHours } from '../src/parser/hours.js';
import { parseLocationDetails } from '../src/parser/location.js';
import { MEAL_NAMES, type MealName } from '../src/types.js';
import {
  HALL_FIXTURES,
  readExpected,
  readFixture,
  type ExpectedHall,
  type ExpectedItem,
} from './helpers.js';

/**
 * These tests compare the parser with the expected data in
 * `tests/fixtures/expected/`, which is written by `tests/oracle/build_expected.py`.
 *
 * The oracle is a second implementation of the site reader, written in a
 * different language with a different parser, and it never imports anything
 * from `src/`.  The expectations therefore describe what the markup of the
 * site says, not what the parser happens to print: a parser bug shows up as
 * a difference against the expected data instead of being copied into it.
 *
 * The oracle and the parser were also both checked against the live rendered
 * pages of all ten halls, so the expected data is a statement about the site
 * and not about one of the two readers.
 */

/**
 * The only implication the site's data supports: a vegan dish is vegetarian
 * as well.  On the live data none of the vegan dishes carries the vegetarian
 * trait, so the site treats the two as exclusive and the closure is explicit.
 */
function closeTraits(traits: Iterable<string>): string[] {
  const result = new Set(traits);
  if (result.has('vegan')) result.add('vegetarian');
  return [...result].sort();
}

const MHEALTHY_TIERS = ['mhealthy1', 'mhealthy2', 'mhealthy3', 'mhealthy4', 'mhealthy5'];
const CARBON_TIERS: Record<string, 'low' | 'medium' | 'high'> = {
  carbonlow: 'low',
  carbonmedium: 'medium',
  carbonhigh: 'high',
};

function expectedTraits(item: ExpectedItem): string[] {
  const slugs = [...item.traitClasses, ...item.publishedTraits.map((trait) => trait.slug)];
  return closeTraits(slugs);
}

function expectedMhealthy(item: ExpectedItem): number | null {
  for (const trait of item.traitClasses) {
    const index = MHEALTHY_TIERS.indexOf(trait);
    if (index >= 0) return index + 1;
  }
  return null;
}

function expectedCarbon(item: ExpectedItem): 'low' | 'medium' | 'high' | null {
  for (const trait of item.traitClasses) {
    const tier = CARBON_TIERS[trait];
    if (tier) return tier;
  }
  return null;
}

const HALLS = Object.keys(HALL_FIXTURES);

describe('the parser against the independently expected data', () => {
  it('covers the ten halls', () => {
    expect(HALLS).toHaveLength(10);
  });

  for (const hall of HALLS) {
    describe(hall, () => {
      const expected: ExpectedHall = readExpected(hall);
      const html = readFixture(HALL_FIXTURES[hall] as string);
      const menu = parseMenuPage(html);
      const $ = load(html);

      it('publishes the meals the site publishes', () => {
        const published = expected.meals.map((meal) => meal.label);
        expect(published.every((label) => (MEAL_NAMES as readonly string[]).includes(label))).toBe(true);
        expect(menu.unknownMealLabels).toEqual([]);

        const parsed = MEAL_NAMES.filter((meal) => menu.meals[meal].length > 0);
        expect(parsed).toHaveLength(expected.counts.meals);
        for (const meal of parsed) {
          expect(menu.mealLabels[meal]).toBe(meal);
        }
      });

      it('reads the stations of every meal', () => {
        for (const expectedMeal of expected.meals) {
          const meal = expectedMeal.label as MealName;
          const stations = menu.meals[meal];
          expect(stations.map((station) => station.name)).toEqual(
            expectedMeal.stations.map((station) => station.name),
          );
        }
      });

      it('reads the dishes of every station', () => {
        for (const expectedMeal of expected.meals) {
          const meal = expectedMeal.label as MealName;
          expectedMeal.stations.forEach((expectedStation, index) => {
            const station = menu.meals[meal][index];
            expect(station?.items.map((item) => item.name)).toEqual(
              expectedStation.items.map((item) => item.name),
            );
          });
        }
      });

      it('reads the traits of every dish', () => {
        for (const expectedMeal of expected.meals) {
          const meal = expectedMeal.label as MealName;
          for (const expectedStation of expectedMeal.stations) {
            const station = menu.meals[meal].find((entry) => entry.name === expectedStation.name);
            for (const expectedItem of expectedStation.items) {
              const item = station?.items.find((entry) => entry.name === expectedItem.name);
              expect(item?.traits, `${meal} / ${expectedStation.name} / ${expectedItem.name}`).toEqual(
                expectedTraits(expectedItem),
              );
              for (const published of expectedItem.publishedTraits) {
                expect(item?.traitLabels[published.slug], published.slug).toBe(published.label);
              }
            }
          }
        }
      });

      it('reads the allergens of every dish', () => {
        for (const expectedMeal of expected.meals) {
          const meal = expectedMeal.label as MealName;
          for (const expectedStation of expectedMeal.stations) {
            const station = menu.meals[meal].find((entry) => entry.name === expectedStation.name);
            for (const expectedItem of expectedStation.items) {
              const item = station?.items.find((entry) => entry.name === expectedItem.name);
              expect(
                item?.allergens,
                `${meal} / ${expectedStation.name} / ${expectedItem.name}`,
              ).toEqual([...expectedItem.allergenClasses].sort());
            }
          }
        }
      });

      it('reads the nutrient density and the carbon footprint of every dish', () => {
        for (const expectedMeal of expected.meals) {
          const meal = expectedMeal.label as MealName;
          for (const expectedStation of expectedMeal.stations) {
            const station = menu.meals[meal].find((entry) => entry.name === expectedStation.name);
            for (const expectedItem of expectedStation.items) {
              const item = station?.items.find((entry) => entry.name === expectedItem.name);
              const where = `${meal} / ${expectedStation.name} / ${expectedItem.name}`;
              expect(item?.mhealthyTier, where).toBe(expectedMhealthy(expectedItem));
              expect(item?.carbonFootprint, where).toBe(expectedCarbon(expectedItem));
            }
          }
        }
      });

      it('reads the nutrition panel of every dish', () => {
        for (const expectedMeal of expected.meals) {
          const meal = expectedMeal.label as MealName;
          for (const expectedStation of expectedMeal.stations) {
            const station = menu.meals[meal].find((entry) => entry.name === expectedStation.name);
            for (const expectedItem of expectedStation.items) {
              const item = station?.items.find((entry) => entry.name === expectedItem.name);
              const where = `${meal} / ${expectedStation.name} / ${expectedItem.name}`;
              if (!expectedItem.panel) {
                expect(item?.nutrition, where).toBeNull();
                continue;
              }
              expect(item?.nutrition, where).toEqual(expectedItem.panel.values);
            }
          }
        }
      });

      it('reads the service periods of the day', () => {
        const periods = parseTodaysHours($);
        expect(periods.map((period) => ({ label: period.label, times: period.times }))).toEqual(
          expected.todayHours,
        );
        for (const period of periods) {
          expect(period.closed).toBe(!period.times || /^closed$/i.test(period.times));
        }
      });

      it('reads the contact details of the hall', () => {
        expect(parseLocationDetails($)).toEqual(expected.location);
      });

      it('has the item and panel counts the markup holds', () => {
        expect(menu.itemCount).toBe(expected.counts.items);
        expect(menu.stationCount).toBe(expected.counts.stations);
        const panels = Object.values(menu.meals)
          .flat()
          .flatMap((station) => station.items)
          .filter((item) => item.nutrition !== null);
        expect(panels).toHaveLength(expected.counts.panels);
        // The site writes one item name and one nutrition element per dish.
        expect(expected.counts.items).toBe(expected.source.itemNameSpans);
        expect(expected.counts.panels).toBe(expected.source.nutritionTables);
      });
    });
  }

  it('reads every dish of the ten halls', () => {
    let items = 0;
    let panels = 0;
    let stations = 0;
    for (const hall of HALLS) {
      const menu = parseMenuPage(readFixture(HALL_FIXTURES[hall] as string));
      for (const meals of Object.values(menu.meals)) {
        stations += meals.length;
        for (const station of meals) {
          items += station.items.length;
          panels += station.items.filter((item) => item.nutrition !== null).length;
        }
      }
    }
    expect(items).toBe(448);
    expect(stations).toBe(149);
    expect(panels).toBe(438);
  });
});
