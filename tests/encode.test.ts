import { describe, expect, it } from 'vitest';
import { ALLERGEN_NOTE, encodeResponse, rowFields, selectNutrients, type DomainDish } from '../src/encode.js';
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
    const selection = selectNutrients(undefined);
    const response = encodeResponse([dish()], selection);
    const fields = rowFields(selection, false, false);
    const row = response.matches[0]!;

    expect(Array.isArray(row)).toBe(true);
    expect(fields).toEqual([
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
    expect(row).toHaveLength(fields.length);
  });

  it('carries the codes of the hall, the meal and the station', () => {
    const selection = selectNutrients(undefined);
    const response = encodeResponse([dish()], selection);
    const fields = rowFields(selection, false, false);
    const row = response.matches[0]!;
    expect(at(row, 'hall', fields)).toBe(1);
    expect(at(row, 'meal', fields)).toBe(3);
    expect(at(row, 'station', fields)).toBe(stationCode('Grill'));
    expect(response.key.halls).toEqual({ '1': 'bursley' });
    expect(response.key.meals).toEqual({ '3': 'Lunch' });
    expect(response.key.stations).toEqual({ [String(stationCode('Grill'))]: 'Grill' });
  });

  it('carries the traits and the allergens as codes', () => {
    const selection = selectNutrients(undefined);
    const response = encodeResponse([dish()], selection);
    const fields = rowFields(selection, false, false);
    const row = response.matches[0]!;
    expect(at(row, 'traits', fields)).toEqual([5]);
    expect(at(row, 'allergens', fields)).toEqual([7]);
    expect(response.key.traits).toEqual({ '5': 'vegan' });
    expect(response.key.allergens).toEqual({ '7': 'milk' });
  });

  it('keeps the density in its own numeric field', () => {
    const selection = selectNutrients(undefined);
    const response = encodeResponse([dish()], selection);
    const fields = rowFields(selection, false, false);
    const row = response.matches[0]!;
    expect(at(row, 'mhealthyTier', fields)).toBe(3);
    expect(fields).not.toContain('carbonFootprint');
  });

  it('leaves the carbon tier out unless max carbon or a carbon sort asks for it', () => {
    const defaultSelection = selectNutrients(undefined);
    const defaultFields = rowFields(defaultSelection, false, false);
    expect(defaultFields).not.toContain('carbonFootprint');

    const carbonSelection = selectNutrients(undefined, [], true);
    const carbonResponse = encodeResponse(
      [dish()],
      carbonSelection,
    );
    const carbonFields = rowFields(carbonSelection, false, false);
    expect(carbonFields).toEqual([
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
    expect(at(row, 'carbonFootprint', carbonFields)).toBe(2);
    expect(at(row, 'mhealthyTier', carbonFields)).toBe(3);
    expect(at(row, 'calories', carbonFields)).toBe(320);
  });

  it('carries the serving size and its weight in grams', () => {
    const selection = selectNutrients(undefined);
    const response = encodeResponse([dish()], selection);
    const fields = rowFields(selection, false, false);
    const row = response.matches[0]!;
    expect(at(row, 'servingSize', fields)).toBe('1 Each (113g)');
    expect(at(row, 'servingSizeGrams', fields)).toBe(113);
  });

  it('carries the days of a range query', () => {
    const selection = selectNutrients(undefined);
    const response = encodeResponse(
      [dish({ dates: ['2026-10-21', '2026-10-22'] })],
      selection,
    );
    const fields = rowFields(selection, true, false);
    expect(fields).toContain('dates');
    expect(at(response.matches[0]!, 'dates', fields)).toEqual([
      '2026-10-21',
      '2026-10-22',
    ]);
  });

  it('states the units of the nutrients it returns', () => {
    const selection = selectNutrients(['protein']);
    const response = encodeResponse([dish()], selection);
    expect(response.units).toEqual({ calories: 'kcal', protein: 'g' });
  });

  it('returns a selected nutrient under its own name', () => {
    const selection = selectNutrients(['protein']);
    const response = encodeResponse([dish()], selection);
    const fields = rowFields(selection, false, false);
    expect(fields).toContain('protein');
    expect(at(response.matches[0]!, 'protein', fields)).toBe(32);
  });

  it('returns a selected micronutrient as the amount the panel derives from the percent', () => {
    const selection = selectNutrients(['Iron']);
    const response = encodeResponse([dish()], selection);
    const fields = rowFields(selection, false, false);
    expect(fields).toContain('iron');
    // The site publishes 15 %DV of an 18 mg Daily Value: 2.7 mg.
    expect(at(response.matches[0]!, 'iron', fields)).toBe(2.7);
    expect(response.units!.iron).toBe('mg');
  });

  it('leaves the sodium out unless it is asked for', () => {
    const withoutSelection = selectNutrients(undefined);
    const without = encodeResponse([dish()], withoutSelection);
    const withoutFields = rowFields(withoutSelection, false, false);
    expect(without.units).toBeUndefined();
    expect(withoutFields).not.toContain('sodium');

    const selection3 = selectNutrients(['sodium']);
    const with_ = encodeResponse([dish()], selection3);
    const fields3 = rowFields(selection3, false, false);
    expect(with_.units).toEqual({ calories: 'kcal', sodium: 'mg' });
    expect(at(with_.matches[0]!, 'sodium', fields3)).toBe(540);
  });

  it('keeps the nutrient a filter constrained even when another one is asked for', () => {
    const selection = selectNutrients(['protein'], ['sodium']);
    const response = encodeResponse([dish()], selection);
    const fields = rowFields(selection, false, false);
    expect(response.units).toEqual({ calories: 'kcal', sodium: 'mg', protein: 'g' });
    expect(at(response.matches[0]!, 'sodium', fields)).toBe(540);
  });

  it('reminds the reader of the allergen codes only when there are allergens', () => {
    const selectionA = selectNutrients(undefined);
    const withAllergens = encodeResponse([dish()], selectionA);
    expect(withAllergens.note).toBe(ALLERGEN_NOTE);

    const selection2 = selectNutrients(undefined);
    const without = encodeResponse([dish({ allergens: [] })], selection2);
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
