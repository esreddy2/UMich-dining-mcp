import { describe, expect, it } from 'vitest';
import { parseMenuPage } from '../src/parser/menu.js';
import {
  ALLERGENS,
  ALLERGEN_SLUGS,
  BOOLEAN_TRAIT_SLUGS,
  TRAITS,
  TRAIT_SLUGS,
  closeTraits,
  mhealthyTier,
  carbonFootprint,
} from '../src/taxonomy.js';
import { HALL_FIXTURES, readFixture } from './helpers.js';

const LIVE_TRAIT_LABELS: Record<string, string> = {
  carbonhigh: 'Carbon Footprint High',
  carbonlow: 'Carbon Footprint Low',
  carbonmedium: 'Carbon Footprint Medium',
  glutenfree: 'Gluten Free',
  halal: 'Halal',
  kosher: 'Kosher',
  mhealthy1: 'Nutrient Dense Low',
  mhealthy2: 'Nutrient Dense Low Medium',
  mhealthy3: 'Nutrient Dense Medium',
  mhealthy4: 'Nutrient Dense Medium High',
  mhealthy5: 'Nutrient Dense High',
  spicy: 'Spicy',
  vegan: 'Vegan',
  vegetarian: 'Vegetarian',
};

const LIVE_ALLERGEN_LABELS: Record<string, string> = {
  alcohol: 'Alcohol',
  beef: 'Beef',
  coconut: 'Coconut',
  eggs: 'Eggs',
  fish: 'Fish',
  'item-is-deep-fried': 'Item Is Deep Fried',
  milk: 'Milk',
  oats: 'Oats',
  peanuts: 'Peanuts',
  pork: 'Pork',
  'sesame-seed': 'Sesame Seed',
  shellfish: 'Shellfish',
  soy: 'Soy',
  'tree-nuts': 'Tree Nuts',
  wheat_barley_rye: 'Wheat/barley/rye',
};

function allItems() {
  const items: { traits: string[]; allergens: string[]; traitLabels: Record<string, string> }[] = [];
  for (const fixture of Object.values(HALL_FIXTURES)) {
    const menu = parseMenuPage(readFixture(fixture));
    for (const stations of Object.values(menu.meals)) {
      for (const station of stations) items.push(...station.items);
    }
  }
  return items;
}

describe('taxonomy', () => {
  it('holds the fifteen live allergens with their display labels', () => {
    expect(ALLERGEN_SLUGS).toHaveLength(15);
    expect({ ...ALLERGENS }).toEqual(LIVE_ALLERGEN_LABELS);
  });

  it('holds the fourteen live traits with their display labels', () => {
    expect(TRAIT_SLUGS).toHaveLength(14);
    expect({ ...TRAITS }).toEqual(LIVE_TRAIT_LABELS);
  });

  it('reads the trait labels the site publishes', () => {
    const labels = new Map<string, string>();
    for (const item of allItems()) {
      for (const [slug, label] of Object.entries(item.traitLabels)) {
        const known = labels.get(slug);
        if (known) expect(label).toBe(known);
        else labels.set(slug, label);
      }
    }
    for (const [slug, label] of Object.entries(LIVE_TRAIT_LABELS)) {
      expect(labels.get(slug)).toBe(label);
    }
  });

  it('closes vegan into vegetarian and nothing else', () => {
    expect(closeTraits(['vegan'])).toEqual(['vegan', 'vegetarian']);
    expect(closeTraits(['vegetarian'])).toEqual(['vegetarian']);
    expect(closeTraits(['halal'])).toEqual(['halal']);
    expect(closeTraits(['kosher'])).toEqual(['kosher']);
    expect(closeTraits(['glutenfree', 'spicy'])).toEqual(['glutenfree', 'spicy']);
    // The ordinal traits are never closed over.
    expect(closeTraits(['mhealthy5'])).toEqual(['mhealthy5']);
    expect(closeTraits(['carbonlow'])).toEqual(['carbonlow']);
  });

  it('does not let halal or kosher imply vegetarian', () => {
    const items = allItems();
    const halal = items.filter((item) => item.traits.includes('halal'));
    const kosher = items.filter((item) => item.traits.includes('kosher'));
    expect(halal.length).toBeGreaterThan(0);
    expect(kosher.length).toBeGreaterThan(0);

    // Not every halal or kosher dish is vegetarian, so neither trait may be
    // read as "vegetarian". (Of the 57 halal dishes none is vegetarian; of the
    // 15 kosher dishes 11 are vegan, 1 is vegetarian and 3 are neither.)
    expect(halal.some((item) => !item.traits.includes('vegetarian'))).toBe(true);
    expect(kosher.some((item) => !item.traits.includes('vegetarian'))).toBe(true);
    expect(halal.filter((item) => item.traits.includes('vegetarian'))).toHaveLength(0);
  });

  it('derives the ordinal tiers', () => {
    expect(mhealthyTier(['mhealthy1'])).toBe(1);
    expect(mhealthyTier(['mhealthy5'])).toBe(5);
    expect(mhealthyTier(['vegan'])).toBeNull();
    expect(carbonFootprint(['carbonlow'])).toBe(1);
    expect(carbonFootprint(['carbonmedium'])).toBe(2);
    expect(carbonFootprint(['carbonhigh'])).toBe(3);
    expect(carbonFootprint(['vegan'])).toBeNull();
  });

  it('does not inflate the allergen counts with the filter panel', () => {
    const menu = parseMenuPage(readFixture('bursley.html'));
    const items = Object.values(menu.meals).flat().flatMap((station) => station.items);
    const soy = items.filter((item) => item.allergens.includes('soy')).length;

    // The filter panel renders one <li class="allergen-soy"> per allergen, so a
    // parser that reads the whole page would count ten more.
    const html = readFixture('bursley.html');
    const panelSoy = (html.match(/allergen-soy/g) ?? []).length;
    expect(panelSoy).toBeGreaterThan(soy);
    expect(soy).toBe(30);
  });

  it('uses the canonical allergen slugs only', () => {
    for (const item of allItems()) {
      for (const allergen of item.allergens) {
        expect(ALLERGEN_SLUGS).toContain(allergen);
      }
      for (const trait of item.traits) {
        expect(TRAIT_SLUGS).toContain(trait);
      }
    }
  });

  it('keeps the boolean traits apart from the ordinal ones', () => {
    expect(BOOLEAN_TRAIT_SLUGS).toEqual(['glutenfree', 'halal', 'kosher', 'spicy', 'vegan', 'vegetarian']);
  });
});
