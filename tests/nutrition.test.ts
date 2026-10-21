import { describe, expect, it } from 'vitest';
import { parseMenuPage } from '../src/parser/menu.js';
import { readFixture } from './helpers.js';

function bursleyItems() {
  const menu = parseMenuPage(readFixture('bursley.html'));
  return Object.values(menu.meals).flat().flatMap((station) => station.items);
}

describe('nutrition parser', () => {
  it('reads the full panel of Oatmeal', () => {
    const oatmeal = bursleyItems().find((item) => item.name === 'Oatmeal');
    expect(oatmeal).toBeDefined();
    expect(oatmeal?.nutrition).not.toBeNull();

    const nutrition = oatmeal?.nutrition;
    expect(nutrition?.servingSize).toBe('Cups (253g)');
    expect(nutrition?.calories).toBe(183);
    expect(nutrition?.totalFat).toBe('3g');
    expect(nutrition?.saturatedFat).toBe('1g');
    expect(nutrition?.transFat).toBe('0g');
    expect(nutrition?.cholesterol).toBe('0mg');
    expect(nutrition?.sodium).toBe('3mg');
    expect(nutrition?.totalCarbohydrate).toBe('33g');
    expect(nutrition?.dietaryFiber).toBe('5g');
    expect(nutrition?.sugars).toBe('1g');
    expect(nutrition?.protein).toBe('6g');
    expect(nutrition?.micronutrients).toEqual({
      'Vitamin A': '0%',
      'Vitamin C': '0%',
      Calcium: '3%',
      Iron: '11%',
    });
  });

  it('keeps the units of the values', () => {
    for (const item of bursleyItems()) {
      if (!item.nutrition) continue;
      expect(item.nutrition.totalFat).toMatch(/^\d+(\.\d+)?(mg|g)$/);
      expect(item.nutrition.sodium).toMatch(/^\d+(\.\d+)?mg$/);
      expect(item.nutrition.protein).toMatch(/^\d+(\.\d+)?g$/);
      expect(item.nutrition.cholesterol).toMatch(/^\d+(\.\d+)?mg$/);
    }
  });

  it('publishes a panel for every dish but two', () => {
    const items = bursleyItems();
    const without = items.filter((item) => item.nutrition === null).map((item) => item.name);
    expect(without).toEqual(['Sandwiches Made to Order', 'Sandwiches Made to Order']);
  });

  it('does not take the panel of the next dish', () => {
    const items = bursleyItems();
    const withNutrition = items.filter((item) => item.nutrition !== null);
    const without = items.filter((item) => item.nutrition === null);
    expect(withNutrition.length).toBe(67);
    expect(without.length).toBe(2);
  });

  it('reads a panel for every hall', () => {
    for (const fixture of [
      'east-quad.html',
      'markley.html',
      'mosher-jordan.html',
      'north-quad.html',
      'south-quad.html',
      'twigs-at-oxford.html',
      'wolverine-village-dining-hall.html',
      'lawyers-club.html',
      'martha-cook.html',
    ]) {
      const menu = parseMenuPage(readFixture(fixture));
      const items = Object.values(menu.meals).flat().flatMap((station) => station.items);
      const withNutrition = items.filter((item) => item.nutrition !== null);
      expect(withNutrition.length).toBeGreaterThan(0);
      for (const item of withNutrition) {
        expect(item.nutrition?.servingSize).not.toBeNull();
      }
    }
  });
});
