/**
 * Allergen and trait vocabularies, live-verified on 2026-10-22 against all ten
 * dining hall pages.
 *
 * The labels are the site's own: the allergen labels come from the menu page's
 * filter panel (`<li class="allergen-milk">...<input value="milk"/>Milk</label>`),
 * the trait labels from the `title` attribute of each `ul.traits > li`.
 *
 * The trait classes come in three flavours:
 *   - boolean traits   : glutenfree, halal, kosher, spicy, vegan, vegetarian
 *   - ordinal nutrient : mhealthy1..mhealthy5  (Low .. High)
 *   - ordinal carbon   : carbonlow, carbonmedium, carbonhigh
 *
 * The ordinal ones are modelled as fields, never as a set of traits that can be
 * closed over: a "Carbon Footprint Low" item must never be reported as
 * "Carbon Footprint High".
 */

export const ALLERGENS = {
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
} as const;

export type AllergenSlug = keyof typeof ALLERGENS;

export const ALLERGEN_SLUGS = Object.keys(ALLERGENS) as AllergenSlug[];

export const TRAITS = {
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
} as const;

export type TraitSlug = keyof typeof TRAITS;

export const TRAIT_SLUGS = Object.keys(TRAITS) as TraitSlug[];

/** Traits that are true or false, and may therefore be required in a filter. */
export const BOOLEAN_TRAIT_SLUGS: TraitSlug[] = [
  'glutenfree',
  'halal',
  'kosher',
  'spicy',
  'vegan',
  'vegetarian',
];

/** Nutrient density, low to high. Exactly one tier per item, never two. */
export const MHEALTHY_TIERS = ['mhealthy1', 'mhealthy2', 'mhealthy3', 'mhealthy4', 'mhealthy5'] as const;

/** Carbon footprint, low to high. Exactly one tier per item, never two. */
export const CARBON_TIERS = ['carbonlow', 'carbonmedium', 'carbonhigh'] as const;

export type MHealthyTier = 1 | 2 | 3 | 4 | 5;
export type CarbonTier = 'low' | 'medium' | 'high';

/**
 * The only boolean implication the site's data supports. Verified across all
 * 448 items: 0 of the 229 vegan items carry `trait-vegetarian`, so the site
 * treats vegan and vegetarian as mutually exclusive and a vegan item has to be
 * closed into "vegetarian" explicitly.
 *
 * `halal` never implies vegetarian (0 of 57) and `kosher` does not either
 * (11 vegan, 1 vegetarian, 3 neither).
 */
export const TRAIT_IMPLICATIONS: Record<string, string[]> = {
  vegan: ['vegetarian'],
};

export const ALLERGEN_CAVEAT = [
  'Allergen data is only as good as the site. The menu page flags the allergens',
  'the kitchen reported for a dish, but the data does not distinguish "contains"',
  'from "may contain", there are no ingredient lists, and it is not safe to treat',
  'a missing flag as an absence of the allergen.',
  'The site\'s own guidance is: "Look for the signs posted near each food serving',
  'area for a list of menu options with allergens highlighted in red."',
  'The "Gluten Free" trait means the dish is made without gluten, not that it is',
  'safe for someone with coeliac disease. Dedicated gluten-free pantries exist',
  'only at South Quad, East Quad, Mosher-Jordan and Bursley.',
].join(' ');

export function allergenLabel(slug: string): string {
  return ALLERGENS[slug as AllergenSlug] ?? slug;
}

export function traitLabel(slug: string): string {
  return TRAITS[slug as TraitSlug] ?? slug;
}

export function isAllergenSlug(value: string): value is AllergenSlug {
  return Object.prototype.hasOwnProperty.call(ALLERGENS, value);
}

export function isTraitSlug(value: string): value is TraitSlug {
  return Object.prototype.hasOwnProperty.call(TRAITS, value);
}

/**
 * Apply the implication closure to a set of trait slugs. Ordinal traits
 * (mhealthy*, carbon*) are never closed over: only `vegan` implies anything.
 */
export function closeTraits(traits: Iterable<string>): string[] {
  const result = new Set<string>(traits);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [trait, implies] of Object.entries(TRAIT_IMPLICATIONS)) {
      if (!result.has(trait)) continue;
      for (const implied of implies) {
        if (!result.has(implied)) {
          result.add(implied);
          changed = true;
        }
      }
    }
  }
  return [...result].sort();
}

/** The nutrient-density tier of an item, 1..5, or null when it has none. */
export function mhealthyTier(traits: Iterable<string>): MHealthyTier | null {
  for (const trait of traits) {
    const index = (MHEALTHY_TIERS as readonly string[]).indexOf(trait);
    if (index >= 0) return (index + 1) as MHealthyTier;
  }
  return null;
}

/** The carbon footprint tier of an item, or null when it has none. */
export function carbonFootprint(traits: Iterable<string>): CarbonTier | null {
  for (const trait of traits) {
    const index = (CARBON_TIERS as readonly string[]).indexOf(trait);
    if (index >= 0) return (['low', 'medium', 'high'] as const)[index] ?? null;
  }
  return null;
}
