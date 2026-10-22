import { describe, expect, it } from 'vitest';
import {
  ALLERGEN_BY_CODE,
  ALLERGEN_CODES,
  HALL_BY_CODE,
  HALL_CODES,
  MEAL_BY_CODE,
  MEAL_CODES,
  TRAIT_BY_CODE,
  TRAIT_CODES,
  STATION_NAMES,
  buildKey,
  createKeyBuilder,
  mealCode,
  stationCode,
} from '../src/codes.js';
import { HALLS } from '../src/halls.js';
import { ALLERGEN_SLUGS, BOOLEAN_TRAIT_SLUGS } from '../src/taxonomy.js';

describe('the vocabulary codes', () => {
  it('numbers the halls from one, in the order of the registry', () => {
    expect(Object.keys(HALL_CODES)).toEqual(HALLS.map((hall) => hall.id));
    for (const [index, hall] of HALLS.entries()) {
      expect(HALL_CODES[hall.id]).toBe(index + 1);
      expect(HALL_BY_CODE[index + 1]).toBe(hall.id);
    }
  });

  it('numbers the meals from one, in the order of the day', () => {
    expect(MEAL_CODES).toEqual({ Breakfast: 1, Brunch: 2, Lunch: 3, Dinner: 4 });
    expect(MEAL_BY_CODE[1]).toBe('Breakfast');
    expect(MEAL_BY_CODE[2]).toBe('Brunch');
    expect(MEAL_BY_CODE[3]).toBe('Lunch');
    expect(MEAL_BY_CODE[4]).toBe('Dinner');
  });

  it('gives a meal label the site invents a code of its own', () => {
    const builder = createKeyBuilder();
    expect(mealCode(builder, 'Brunch')).toBe(2);
    expect(mealCode(builder, 'Supper')).toBe(5);
    expect(mealCode(builder, 'Supper')).toBe(5);
    expect(buildKey(builder).meals).toEqual({ '2': 'Brunch', '5': 'Supper' });
  });

  it('numbers the allergens from one, in the order of the taxonomy', () => {
    for (const [index, slug] of ALLERGEN_SLUGS.entries()) {
      expect(ALLERGEN_CODES[slug]).toBe(index + 1);
      expect(ALLERGEN_BY_CODE[index + 1]).toBe(slug);
    }
  });

  it('numbers the six boolean traits from one, in the order of the taxonomy', () => {
    expect(Object.keys(TRAIT_CODES)).toEqual(BOOLEAN_TRAIT_SLUGS);
    for (const [index, slug] of BOOLEAN_TRAIT_SLUGS.entries()) {
      expect(TRAIT_CODES[slug]).toBe(index + 1);
      expect(TRAIT_BY_CODE[index + 1]).toBe(slug);
    }
  });

  it('leaves the density and the carbon tiers out of the trait codes', () => {
    // The tiers have their own numeric fields; a code would hide the scale.
    expect(TRAIT_CODES['mhealthy1' as never]).toBeUndefined();
    expect(TRAIT_CODES['carbonlow' as never]).toBeUndefined();
  });
});

describe('the key block', () => {
  it('lists only what the response uses', () => {
    const builder = createKeyBuilder();
    builder.halls.add(HALL_CODES['bursley']!);
    builder.traits.add(TRAIT_CODES['vegan']!);

    const key = buildKey(builder);
    expect(key).toEqual({
      halls: { '1': 'bursley' },
      traits: { '5': 'vegan' },
    });
    expect(key.meals).toBeUndefined();
    expect(key.stations).toBeUndefined();
    expect(key.allergens).toBeUndefined();
  });

  it('is empty when the response uses nothing', () => {
    expect(buildKey(createKeyBuilder())).toEqual({});
  });

  it('gives a station the same number in every response', () => {
    // The number of a station does not depend on the rows of the response.
    const first = createKeyBuilder();
    const second = createKeyBuilder();
    const grill = stationCode('Grill');
    const soup = stationCode('Soup');

    first.stations.set(grill, 'Grill');
    first.stations.set(soup, 'Soup');
    second.stations.set(soup, 'Soup');
    second.stations.set(grill, 'Grill');

    expect(buildKey(first).stations).toEqual(buildKey(second).stations);
    expect(stationCode('Grill')).toBe(grill);
  });

  it('gives a station the site invents a number of its own', () => {
    const code = stationCode('A Station Nobody Has Seen');
    expect(code).toBeGreaterThan(STATION_NAMES.length);
    // The name keeps the number it took.
    expect(stationCode('A Station Nobody Has Seen')).toBe(code);
  });
});
