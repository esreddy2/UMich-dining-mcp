import { describe, expect, it } from 'vitest';
import {
  GRAMS_PER_OUNCE,
  MICRONUTRIENT_SPECS,
  NutrientError,
  deriveMicronutrient,
  nutrientValueInUnit,
  parsePublishedPercent,
  parseServingSizeGrams,
  resolveNutrientRange,
} from '../src/nutrition.js';

describe('the serving size weight', () => {
  it('reads the gram figure the site publishes', () => {
    expect(parseServingSizeGrams('Cups (253g)')).toBe(253);
    expect(parseServingSizeGrams('1/2 Cup (113g)')).toBe(113);
    expect(parseServingSizeGrams('Hamburger (120g)')).toBe(120);
  });

  it('prefers the gram figure over the ounce amount', () => {
    expect(parseServingSizeGrams('4 oz (113g)')).toBe(113);
  });

  it('converts an ounce amount when there is no gram figure', () => {
    expect(parseServingSizeGrams('.5 oz Serving (14g)')).toBe(14);
    expect(parseServingSizeGrams('4 oz')).toBe(Math.round(4 * GRAMS_PER_OUNCE * 1000) / 1000);
  });

  it('never guesses a weight that is not published', () => {
    expect(parseServingSizeGrams('1 Each')).toBeNull();
    expect(parseServingSizeGrams('')).toBeNull();
    expect(parseServingSizeGrams(null)).toBeNull();
  });
});

describe('the published percentage of a micronutrient', () => {
  it('reads the number the site prints', () => {
    expect(parsePublishedPercent('15%')).toBe(15);
    expect(parsePublishedPercent('3 %')).toBe(3);
  });

  it('has no value for a trace', () => {
    expect(parsePublishedPercent('Trace')).toBeNull();
    expect(parsePublishedPercent('<1%')).toBeNull();
    expect(parsePublishedPercent(null)).toBeNull();
  });
});

describe('the derived micronutrient amount', () => {
  it('derives the amount from the Daily Value the panel refers to', () => {
    const iron = deriveMicronutrient('Iron', '15%');
    expect(iron?.pct).toBe(15);
    expect(iron?.amount).toBeCloseTo(2.7, 5);
    expect(iron?.unit).toBe('mg');
  });

  it('knows the four micronutrients the site publishes', () => {
    expect(MICRONUTRIENT_SPECS.map((spec) => spec.name)).toEqual([
      'Vitamin A',
      'Vitamin C',
      'Calcium',
      'Iron',
    ]);
  });

  it('has no amount for a nutrient the site does not publish', () => {
    expect(deriveMicronutrient('Zinc', '15%')).toBeNull();
  });
});

describe('a nutrient threshold', () => {
  it('takes the canonical unit when none is given', () => {
    const range = resolveNutrientRange('protein', { min: 20 });
    expect(range.unit).toBe('g');
    expect(range.min).toBe(20);
  });

  it('accepts a milligram bound on a gram nutrient', () => {
    const range = resolveNutrientRange('protein', { min: 30_000, unit: 'mg' });
    expect(range.unit).toBe('mg');
    expect(range.min).toBe(30_000);
  });

  it('accepts a milligram bound on a micronutrient', () => {
    const range = resolveNutrientRange('Iron', { min: 2, unit: 'mg' });
    expect(range.unit).toBe('mg');
    expect(range.min).toBe(2);
  });

  it('accepts a percent bound on a micronutrient', () => {
    const range = resolveNutrientRange('Iron', { min: 10, unit: '%DV' });
    expect(range.unit).toBe('%DV');
  });

  it('rejects a unit the nutrient cannot be expressed in, by name', () => {
    expect(() => resolveNutrientRange('protein', { min: 1, unit: 'kg' })).toThrow(NutrientError);
    expect(() => resolveNutrientRange('protein', { min: 1, unit: 'kg' })).toThrow(/protein/);
  });

  it('rejects an unknown nutrient', () => {
    expect(() => resolveNutrientRange('vitaminZ', { min: 1 })).toThrow(/list_nutrition_fields/);
  });

  it('rejects a minimum above the maximum', () => {
    expect(() => resolveNutrientRange('protein', { min: 30, max: 10 })).toThrow(/greater than/);
  });

  it('rejects a negative bound', () => {
    expect(() => resolveNutrientRange('protein', { min: -1 })).toThrow(/zero or more/);
  });
});

describe('the value of a nutrient in the unit of a threshold', () => {
  const nutrition = {
    servingSize: '1 Each (113g)',
    calories: 320,
    totalFat: '8g',
    saturatedFat: null,
    transFat: null,
    cholesterol: '60mg',
    sodium: '540mg',
    totalCarbohydrate: '40g',
    dietaryFiber: '5g',
    sugars: '3g',
    protein: '32g',
    micronutrients: { Iron: '15%' },
  };

  it('reads a canonical nutrient in its own unit', () => {
    expect(nutrientValueInUnit('protein', 'g', nutrition)).toBe(32);
    expect(nutrientValueInUnit('sodium', 'mg', nutrition)).toBe(540);
  });

  it('converts a canonical nutrient into another unit', () => {
    expect(nutrientValueInUnit('protein', 'mg', nutrition)).toBe(32_000);
    expect(nutrientValueInUnit('sodium', 'g', nutrition)).toBe(0.54);
  });

  it('reads a micronutrient as the published percent', () => {
    expect(nutrientValueInUnit('Iron', '%DV', nutrition)).toBe(15);
  });

  it('reads a micronutrient as the derived amount', () => {
    expect(nutrientValueInUnit('Iron', 'mg', nutrition)).toBeCloseTo(2.7, 5);
  });

  it('has no value where the site publishes none', () => {
    expect(nutrientValueInUnit('transFat', 'g', nutrition)).toBeNull();
    expect(nutrientValueInUnit('Calcium', 'mg', nutrition)).toBeNull();
    expect(nutrientValueInUnit('protein', 'g', null)).toBeNull();
  });
});
