import { describe, expect, it } from 'vitest';
import { ALLERGEN_NOTE, encodeResponse, selectNutrients, type DomainDish } from '../src/encode.js';
import { stationCode } from '../src/codes.js';

function dish(overrides: Partial<DomainDish> = {}): DomainDish {
  return {
    hall: 'bursley',
    hallName: 'Bursley',
    date: '2026-10-21',
    meal: 'Lunch',
    station: 'Grill',
    name: 'Grilled Chicken',
    traits: ['vegan'],
    allergens: ['milk'],
    mhealthyTier: 3,
    carbonFootprint: 2,
    calories: 320,
    sodiumMg: 540,
    nutrition: {
      servingSize: '1 Each (113g)',
      calories: 320,
      totalFat: '8g',
      saturatedFat: '2g',
      transFat: '0g',
      cholesterol: '60mg',
      sodium: '540mg',
      totalCarbohydrate: '40g',
      dietaryFiber: '5g',
      sugars: '3g',
      protein: '32g',
      micronutrients: { Iron: '15%', Calcium: '3%' },
    },
    ...overrides,
  };
}

/** The value of a named position of a row. */
function at(row: unknown[], field: string, fields: string[]): unknown {
  return row[fields.indexOf(field)];
}

describe('the nutrient selection', () => {
  it('returns nothing beyond the calories and the sodium by default', () => {
    const selection = selectNutrients(undefined);
    expect(selection.keys).toEqual([]);
    expect(selection.micronutrients).toEqual([]);
  });

  it('takes the canonical keys', () => {
    const selection = selectNutrients(['protein']);
    expect(selection.keys).toEqual(['protein']);
    expect(selection.units.protein).toBe('g');
  });

  it('takes the published micronutrient names', () => {
    const selection = selectNutrients(['Iron']);
    expect(selection.micronutrients.map((spec) => spec.name)).toEqual(['Iron']);
    expect(selection.units.iron).toBe('mg');
  });

  it('takes every nutrient with "all"', () => {
    const selection = selectNutrients(['all']);
    expect(selection.keys).toContain('protein');
    expect(selection.keys).toContain('totalFat');
    expect(selection.micronutrients).toHaveLength(4);
  });

  it('rejects an unknown name and names the tool that lists the names', () => {
    expect(() => selectNutrients(['vitaminZ'])).toThrow(/list_nutrition_fields/);
  });
});

describe('the coded row', () => {
  it('is an array with the positions the response names', () => {
    const response = encodeResponse([dish()], selectNutrients(undefined));
    const row = response.matches[0]!;

    expect(Array.isArray(row)).toBe(true);
    expect(response.fields).toEqual([
      'hall',
      'meal',
      'station',
      'name',
      'traits',
      'allergens',
      'mhealthyTier',
      'calories',
      'servingSize',
      'servingSizeGrams',
    ]);
    expect(row).toHaveLength(response.fields.length);
  });

  it('carries the codes of the hall, the meal and the station', () => {
    const response = encodeResponse([dish()], selectNutrients(undefined));
    const row = response.matches[0]!;
    expect(at(row, 'hall', response.fields)).toBe(1);
    expect(at(row, 'meal', response.fields)).toBe(3);
    expect(at(row, 'station', response.fields)).toBe(stationCode('Grill'));
    expect(response.key.halls).toEqual({ '1': 'bursley' });
    expect(response.key.meals).toEqual({ '3': 'Lunch' });
    expect(response.key.stations).toEqual({ [String(stationCode('Grill'))]: 'Grill' });
  });

  it('carries the traits and the allergens as codes', () => {
    const response = encodeResponse([dish()], selectNutrients(undefined));
    const row = response.matches[0]!;
    expect(at(row, 'traits', response.fields)).toEqual([5]);
    expect(at(row, 'allergens', response.fields)).toEqual([7]);
    expect(response.key.traits).toEqual({ '5': 'vegan' });
    expect(response.key.allergens).toEqual({ '7': 'milk' });
  });

  it('keeps the density in its own numeric field', () => {
    const response = encodeResponse([dish()], selectNutrients(undefined));
    const row = response.matches[0]!;
    expect(at(row, 'mhealthyTier', response.fields)).toBe(3);
    expect(response.fields).not.toContain('carbonFootprint');
  });

  it('leaves the carbon tier out unless max carbon or a carbon sort asks for it', () => {
    const defaultResponse = encodeResponse([dish()], selectNutrients(undefined));
    expect(defaultResponse.fields).not.toContain('carbonFootprint');

    const carbonResponse = encodeResponse(
      [dish()],
      selectNutrients(undefined, [], true),
    );
    expect(carbonResponse.fields).toEqual([
      'hall',
      'meal',
      'station',
      'name',
      'traits',
      'allergens',
      'mhealthyTier',
      'carbonFootprint',
      'calories',
      'servingSize',
      'servingSizeGrams',
    ]);
    const row = carbonResponse.matches[0]!;
    expect(at(row, 'carbonFootprint', carbonResponse.fields)).toBe(2);
    expect(at(row, 'mhealthyTier', carbonResponse.fields)).toBe(3);
    expect(at(row, 'calories', carbonResponse.fields)).toBe(320);
  });

  it('carries the serving size and its weight in grams', () => {
    const response = encodeResponse([dish()], selectNutrients(undefined));
    const row = response.matches[0]!;
    expect(at(row, 'servingSize', response.fields)).toBe('1 Each (113g)');
    expect(at(row, 'servingSizeGrams', response.fields)).toBe(113);
  });

  it('carries the days of a range query', () => {
    const response = encodeResponse(
      [dish({ dates: ['2026-10-21', '2026-10-22'] })],
      selectNutrients(undefined),
    );
    expect(response.fields).toContain('dates');
    expect(at(response.matches[0]!, 'dates', response.fields)).toEqual([
      '2026-10-21',
      '2026-10-22',
    ]);
  });

  it('states the units of the nutrients it returns', () => {
    const response = encodeResponse([dish()], selectNutrients(['protein']));
    expect(response.units).toEqual({ calories: 'kcal', protein: 'g' });
  });

  it('returns a selected nutrient under its own name', () => {
    const response = encodeResponse([dish()], selectNutrients(['protein']));
    expect(response.fields).toContain('protein');
    expect(at(response.matches[0]!, 'protein', response.fields)).toBe(32);
  });

  it('returns a selected micronutrient as the amount the panel derives from the percent', () => {
    const response = encodeResponse([dish()], selectNutrients(['Iron']));
    expect(response.fields).toContain('iron');
    // The site publishes 15 %DV of an 18 mg Daily Value: 2.7 mg.
    expect(at(response.matches[0]!, 'iron', response.fields)).toBe(2.7);
    expect(response.units!.iron).toBe('mg');
  });

  it('leaves the sodium out unless it is asked for', () => {
    const without = encodeResponse([dish()], selectNutrients(undefined));
    expect(without.units).toBeUndefined();
    expect(without.fields).not.toContain('sodium');

    const with_ = encodeResponse([dish()], selectNutrients(['sodium']));
    expect(with_.units).toEqual({ calories: 'kcal', sodium: 'mg' });
    expect(at(with_.matches[0]!, 'sodium', with_.fields)).toBe(540);
  });

  it('keeps the nutrient a filter constrained even when another one is asked for', () => {
    const response = encodeResponse([dish()], selectNutrients(['protein'], ['sodium']));
    expect(response.units).toEqual({ calories: 'kcal', sodium: 'mg', protein: 'g' });
    expect(at(response.matches[0]!, 'sodium', response.fields)).toBe(540);
  });

  it('reminds the reader of the allergen codes only when there are allergens', () => {
    const withAllergens = encodeResponse([dish()], selectNutrients(undefined));
    expect(withAllergens.note).toBe(ALLERGEN_NOTE);

    const without = encodeResponse([dish({ allergens: [] })], selectNutrients(undefined));
    expect(without.note).toBeUndefined();
  });

  it('is much smaller than the row it replaces', () => {
    const row = dish();
    const encoded = JSON.stringify(encodeResponse([row], selectNutrients(undefined)).matches[0]);
    const domain = JSON.stringify(row);
    // The member names of a named row are two and a half times its data.
    expect(encoded.length).toBeLessThan(domain.length / 2);
  });
});
