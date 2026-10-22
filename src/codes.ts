import { HALLS } from './halls.js';
import { ALLERGEN_SLUGS, BOOLEAN_TRAIT_SLUGS } from './taxonomy.js';

/**
 * Frozen vocabulary codes. These numbers are part of the published response
 * contract and never change between releases.
 */

export const HALL_CODES: Readonly<Record<string, number>> = Object.fromEntries(
  HALLS.map((hall, index) => [hall.id, index + 1]),
);

export const HALL_BY_CODE: Readonly<Record<number, string>> = Object.fromEntries(
  HALLS.map((hall, index) => [index + 1, hall.id]),
);

/**
 * The meals, in the order the day runs. Brunch is the fourth label the site
 * uses: it is published on the weekend days.
 */
export const MEAL_CODES: Readonly<Record<string, number>> = {
  Breakfast: 1,
  Brunch: 2,
  Lunch: 3,
  Dinner: 4,
};

export const MEAL_BY_CODE: Readonly<Record<number, string>> = {
  1: 'Breakfast',
  2: 'Brunch',
  3: 'Lunch',
  4: 'Dinner',
};

/** The first code a meal label the site invents may take. */
export const FIRST_EXTRA_MEAL_CODE = 5;

export const ALLERGEN_CODES: Readonly<Record<string, number>> = Object.fromEntries(
  ALLERGEN_SLUGS.map((slug, index) => [slug, index + 1]),
);

export const ALLERGEN_BY_CODE: Readonly<Record<number, string>> = Object.fromEntries(
  ALLERGEN_SLUGS.map((slug, index) => [index + 1, slug]),
);

// Six boolean traits in taxonomy order.
export const TRAIT_CODES: Readonly<Record<string, number>> = Object.fromEntries(
  BOOLEAN_TRAIT_SLUGS.map((slug, index) => [slug, index + 1]),
);

export const TRAIT_BY_CODE: Readonly<Record<number, string>> = Object.fromEntries(
  BOOLEAN_TRAIT_SLUGS.map((slug, index) => [index + 1, slug]),
);

/**
 * The station names the site publishes, in a frozen order.
 *
 * The code of a station is the same in every response, so an agent that
 * remembers "station 12 is Hot Cereal" reads it right the next time. A name
 * the site invents takes the next free code and keeps it for the life of the
 * process.
 */
export const STATION_NAMES: readonly string[] = [
  '24 Carrots',
  'Beverages',
  'Breads and Rolls',
  'Classics',
  'Deli',
  'Dessert',
  'Grill',
  'Halal',
  'Homestyles',
  'Hot Cereal',
  'Kings Hawaiian Grill',
  'Kosher',
  'Make It Your Own',
  'MBakery',
  'Noodles',
  'Olive Branch',
  'Pizziti',
  'Rotisserie',
  'Sabroso',
  'Salad Bar',
  'Salads',
  'Signature',
  'Signature Blue',
  'Signature Maize',
  'Soup',
  'Toast',
  'Two Oceans',
  'Vita',
  'Wild Fire Maize',
  'World Palate Maize',
];

export const STATION_CODES: Readonly<Record<string, number>> = Object.fromEntries(
  STATION_NAMES.map((name, index) => [name, index + 1]),
);

/** The stations the site invents, and the code each one took. */
const extraStations = new Map<string, number>();

/** The code of a station name, stable for the life of the process. */
export function stationCode(name: string): number {
  const known = STATION_CODES[name];
  if (known !== undefined) return known;
  const existing = extraStations.get(name);
  if (existing !== undefined) return existing;
  const next = STATION_NAMES.length + extraStations.size + 1;
  extraStations.set(name, next);
  return next;
}

export interface KeyBuilder {
  halls: Set<number>;
  /** The meal codes the response uses, and the label behind each of them. */
  meals: Map<number, string>;
  /** The station codes the response uses, and the name behind each of them. */
  stations: Map<number, string>;
  traits: Set<number>;
  allergens: Set<number>;
}

export function createKeyBuilder(): KeyBuilder {
  return {
    halls: new Set(),
    meals: new Map(),
    stations: new Map(),
    traits: new Set(),
    allergens: new Set(),
  };
}

/**
 * The code of a meal label.
 *
 * The four meals the site is known to publish have a fixed code. A label the
 * site invents takes the next free code, so it is still readable through
 * `key.meals` rather than dropped.
 */
export function mealCode(builder: KeyBuilder, label: string): number {
  const known = MEAL_CODES[label];
  if (known !== undefined) {
    builder.meals.set(known, label);
    return known;
  }
  for (const [code, existing] of builder.meals) {
    if (existing === label) return code;
  }
  let next = FIRST_EXTRA_MEAL_CODE;
  for (const code of builder.meals.keys()) {
    if (code >= next) next = code + 1;
  }
  builder.meals.set(next, label);
  return next;
}

export function buildKey(builder: KeyBuilder): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  if (builder.halls.size > 0) {
    const halls: Record<string, string> = {};
    for (const code of builder.halls) {
      const slug = HALL_BY_CODE[code];
      if (slug !== undefined) halls[String(code)] = slug;
    }
    result.halls = halls;
  }
  if (builder.meals.size > 0) {
    const meals: Record<string, string> = {};
    for (const [code, name] of builder.meals) {
      meals[String(code)] = name;
    }
    result.meals = meals;
  }
  if (builder.stations.size > 0) {
    const stations: Record<string, string> = {};
    for (const [code, name] of builder.stations) {
      stations[String(code)] = name;
    }
    result.stations = stations;
  }
  if (builder.traits.size > 0) {
    const traits: Record<string, string> = {};
    for (const code of builder.traits) {
      const slug = TRAIT_BY_CODE[code];
      if (slug !== undefined) traits[String(code)] = slug;
    }
    result.traits = traits;
  }
  if (builder.allergens.size > 0) {
    const allergens: Record<string, string> = {};
    for (const code of builder.allergens) {
      const slug = ALLERGEN_BY_CODE[code];
      if (slug !== undefined) allergens[String(code)] = slug;
    }
    result.allergens = allergens;
  }
  return result;
}