import {
  ALLERGEN_CODES,
  HALL_CODES,
  TRAIT_CODES,
  buildKey,
  createKeyBuilder,
  mealCode,
  stationCode,
  type KeyBuilder,
} from './codes.js';
import {
  MICRONUTRIENT_SPECS,
  NUTRIENT_SPECS,
  micronutrientAmount,
  micronutrientSpec,
  NUTRIENT_KEYS,
  parseNutritionNumber,
  parseServingSizeGrams,
  resolveNutrientName,
  resolveSortField,
  type MicronutrientSpec,
} from './nutrition.js';
import type { CarbonLevel, HallId, Nutrition } from './types.js';

/**
 * The encoding boundary.
 *
 * The service works in domain values: hall ids, meal names, trait slugs. The
 * published rows carry small integers instead, and a `key` block at the top of
 * each response maps every code back to its slug, listing only what that
 * response uses. The codes are frozen for the life of the contract.
 */

export const ALLERGEN_NOTE =
  'Allergen codes: check key.allergens before reporting; site data is advisory.';

/** A dish in domain values, as the service returns it. */
export interface DomainDish {
  hall: HallId;
  hallName: string;
  date: string;
  /** The meal, as the site labels it. */
  meal: string;
  station: string;
  name: string;
  traits: string[];
  allergens: string[];
  mhealthyTier: number | null;
  carbonFootprint: CarbonLevel | null;
  calories: number | null;
  sodiumMg: number | null;
  nutrition: Nutrition | null;
  /** The days the dish appeared on, in a range query. */
  dates?: string[];
}

/**
 * A row of a sweep answer.
 *
 * The row is an array and not an object: the member names of a row are two
 * and a half times the data of a row, repeated on every row of the response.
 * The `fields` list of the response names the positions, once.
 */
export type EncodedDish = unknown[];

export interface EncodedResponse {
  key: Record<string, Record<string, string>>;
  units?: Record<string, string>;
  note?: string;
  [field: string]: unknown;
}

/** The rows of a sweep answer. */
export interface EncodedSweepResponse extends EncodedResponse {
  matches: EncodedDish[];
}

/** The nutrient selections the caller asked for. */
export interface NutrientSelection {
  /** The canonical keys, e.g. "protein". */
  keys: string[];
  /** The micronutrients, e.g. "Iron". */
  micronutrients: MicronutrientSpec[];
  /** The units of every nutrient the response returns. */
  units: Record<string, string>;
  /** True when the carbon tier is part of every row (max_carbon or sort_by carbonFootprint). */
  includeCarbon: boolean;
}

export class SelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelectionError';
  }
}

/**
 * Resolve the nutrient selection.
 *
 * The names are the canonical nutrient keys, the published micronutrient
 * names, or "all". An unknown name is rejected with a message that names the
 * tool that lists the supported names.
 *
 * The nutrients a filter constrained are always part of the selection: asking
 * for a range of sodium and not getting the sodium back would make the
 * answer unusable.
 */
export function selectNutrients(
  requested: string[] | undefined,
  constrained: string[] = [],
  includeCarbon = false,
): NutrientSelection {
  const keys: string[] = [];
  const micronutrients: MicronutrientSpec[] = [];
  const units: Record<string, string> = { calories: 'kcal' };

  const addKey = (key: string): void => {
    // The calories are always in the row; they are the one number every
    // reader wants and the one number every dish publishes.
    if (key === 'calories') return;
    if (keys.includes(key)) return;
    keys.push(key);
    const spec = NUTRIENT_SPECS.find((candidate) => candidate.key === key);
    units[key] = spec?.unit ?? 'g';
  };

  const addMicronutrient = (spec: MicronutrientSpec): void => {
    if (micronutrients.some((existing) => existing.name === spec.name)) return;
    micronutrients.push(spec);
    units[spec.field] = spec.derivedUnit;
  };

  for (const raw of constrained) {
    const name = raw.trim();
    if (name.toLowerCase() === 'all') {
      for (const spec of NUTRIENT_SPECS) addKey(spec.key);
      for (const spec of MICRONUTRIENT_SPECS) addMicronutrient(spec);
      continue;
    }
    const resolved = resolveNutrientName(name);
    if (!resolved) {
      throw new SelectionError(
        `Unknown nutrient "${name}". Use list_nutrition_fields to see the supported nutrient names.`,
      );
    }
    if (resolved.micronutrient) addMicronutrient(resolved.micronutrient);
    else addKey(resolved.key);
  }

  for (const raw of requested ?? []) {
    const name = raw.trim();
    if (name.toLowerCase() === 'all') {
      for (const spec of NUTRIENT_SPECS) addKey(spec.key);
      for (const spec of MICRONUTRIENT_SPECS) addMicronutrient(spec);
      continue;
    }
    const resolved = resolveNutrientName(name);
    if (!resolved) {
      throw new SelectionError(
        `Unknown nutrient "${name}". Use list_nutrition_fields to see the supported nutrient names.`,
      );
    }
    if (resolved.micronutrient) addMicronutrient(resolved.micronutrient);
    else addKey(resolved.key);
  }

  return { keys, micronutrients, units, includeCarbon };
}

/** The units of the nutrients a selection returns. */
export function selectionUnits(selection: NutrientSelection): Record<string, string> {
  return { ...selection.units };
}

/**
 * Encode one dish. The key builder collects the codes the response uses.
 */
/**
 * The names of the row positions, in the order the rows carry them.
 *
 * The list is the same for every row of a response, and the response names
 * it once.
 */
function canonicalSortField(sortBy: string): string {
  try {
    return resolveSortField(sortBy);
  } catch {
    return sortBy;
  }
}

function sortFieldAlreadyInRow(canonical: string, selection: NutrientSelection): boolean {
  if (canonical === 'calories') return true;
  if (canonical === 'carbonFootprint') return selection.includeCarbon;
  if (canonical === 'proteinToCalorie' || canonical === 'protein_to_calorie') return false;
  if (canonical === 'fiberToCalorie' || canonical === 'fiber_to_calorie') return false;
  if (NUTRIENT_KEYS.includes(canonical)) return selection.keys.includes(canonical);
  // micronutrient: canonical is its published name (e.g. "Iron")
  if (selection.micronutrients.some((spec) => spec.name === canonical)) return true;
  return false;
}

export function rowFields(selection: NutrientSelection, withDates = false, hoist = false, sortBy?: string): string[] {
  const fields: string[] = [];
  if (!hoist) fields.push('hall', 'meal', 'station');
  fields.push('name', 'traits', 'allergens', 'mhealthyTier');
  if (selection.includeCarbon) fields.push('carbonFootprint');
  fields.push('calories', 'servingSize', 'servingSizeGrams');
  if (withDates) fields.push('dates');
  for (const key of selection.keys) fields.push(key);
  for (const spec of selection.micronutrients) fields.push(spec.field);
  if (sortBy) {
    const canonical = canonicalSortField(sortBy);
    if (!sortFieldAlreadyInRow(canonical, selection)) {
      fields.push(canonical);
    }
  }
  return fields;
}



function sortFieldValue(dish: DomainDish, sortBy: string): number | null {
  const canonical = sortBy;
  if (canonical === 'calories') return dish.calories;
  if (canonical === 'carbonFootprint') return dish.carbonFootprint;
  if (canonical === 'sodium') return dish.sodiumMg;
  if (canonical === 'proteinToCalorie' || canonical === 'protein_to_calorie') {
    const p = parseNutritionNumber(dish.nutrition?.protein ?? null, 'protein');
    if (p === null || !dish.calories) return null;
    return p / dish.calories;
  }
  if (canonical === 'fiberToCalorie' || canonical === 'fiber_to_calorie') {
    const f = parseNutritionNumber(dish.nutrition?.dietaryFiber ?? null, 'dietaryFiber');
    if (f === null || !dish.calories) return null;
    return f / dish.calories;
  }
  const micro = micronutrientSpec(canonical);
  if (micro) return micronutrientAmount(dish.nutrition, micro);
  const raw = dish.nutrition ? (dish.nutrition as unknown as Record<string, unknown>)[canonical] : null;
  const rawStr = typeof raw === 'string' ? raw : (raw == null ? null : (typeof raw === 'number' ? String(raw) : null));
  return parseNutritionNumber(rawStr, canonical);
}

export function encodeDish(
  dish: DomainDish,
  builder: KeyBuilder,
  selection: NutrientSelection,
  hoist = false,
  sortBy?: string,
): EncodedDish {
  const hall = HALL_CODES[dish.hall] ?? 0;
  const meal = mealCode(builder, dish.meal);
  const station = stationCode(dish.station);
  if (!hoist) {
    builder.halls.add(hall);
    builder.stations.set(station, dish.station);
  }

  const traits: number[] = [];
  for (const slug of dish.traits) {
    const code = TRAIT_CODES[slug];
    if (code === undefined) continue;
    traits.push(code);
    builder.traits.add(code);
  }

  const allergens: number[] = [];
  for (const slug of dish.allergens) {
    const code = ALLERGEN_CODES[slug];
    if (code === undefined) continue;
    allergens.push(code);
    builder.allergens.add(code);
  }

  const encoded: unknown[] = [];
  if (!hoist) encoded.push(hall, meal, station);
  encoded.push(dish.name, traits, allergens, dish.mhealthyTier);
  if (selection.includeCarbon) encoded.push(dish.carbonFootprint);
  encoded.push(dish.calories, dish.nutrition?.servingSize ?? null, parseServingSizeGrams(dish.nutrition?.servingSize ?? null));
  if (dish.dates) encoded.push(dish.dates);

  for (const key of selection.keys) {
    const raw = dish.nutrition ? (dish.nutrition as unknown as Record<string, unknown>)[key] : null;
    const value = key === 'calories' ? dish.calories : parseNutritionNumber(typeof raw === 'string' ? raw : null, key);
    encoded.push(value);
  }

  // A micronutrient carries its amount, in the unit of its Daily Value, like
  // every other nutrient of the row. The site publishes the percentage; the
  // amount is derived from it and carries the rounding of that figure.
  for (const spec of selection.micronutrients) {
    encoded.push(micronutrientAmount(dish.nutrition, spec));
  }

  if (sortBy) {
    const canonical = canonicalSortField(sortBy);
    if (!sortFieldAlreadyInRow(canonical, selection)) {
      encoded.push(sortFieldValue(dish, canonical));
    }
  }

  return encoded;
}

/**
 * Encode a response: the rows, the key block, the units and the note.
 *
 * The allergen reminder is only present when the response carries allergens.
 * A note that names an unparseable meal label is added whatever the rows
 * carry, so a service this server cannot read stays visible.
 */
export function encodeResponse(
  dishes: DomainDish[],
  selection: NutrientSelection,
  rest: Record<string, unknown> = {},
  extraNotes: string[] = [],
  sortBy?: string,
): EncodedSweepResponse {
  const { sortBy: restSortBy, ...cleanRest } = rest;
  const resolvedSortBy = sortBy ?? (typeof restSortBy === 'string' ? restSortBy : undefined);
  const builder = createKeyBuilder();
  const matches = dishes.map((dish) => encodeDish(dish, builder, selection, false, resolvedSortBy));

  const response: EncodedSweepResponse = {
    key: buildKey(builder),
    units: { ...selection.units },
    ...cleanRest,
    matches,
  };

  const notes: string[] = [];
  if (matches.some((dish) => (dish[5] as number[]).length > 0)) notes.push(ALLERGEN_NOTE);
  notes.push(...extraNotes);
  if (notes.length > 0) response.note = notes.join(' ');

  if (response.units && Object.keys(response.units).length <= 1) {
    delete response.units;
  }

  return response;
}

/**
 * Encode a menu: the same coded row as the sweep tools, grouped by meal and
 * station.
 *
 * The row means the same thing wherever it is read, and the key block resolves
 * every code the menu uses.
 */
export function encodeMenu(
  groups: { meal: string; stations: { name: string; items: DomainDish[] }[] }[],
  selection: NutrientSelection,
  rest: Record<string, unknown> = {},
  extraNotes: string[] = [],
): EncodedResponse {
  const builder = createKeyBuilder();

  const meals = groups.map((group) => {
    const meal = mealCode(builder, group.meal);
    const stations = group.stations.map((station) => {
      const code = stationCode(station.name);
      builder.stations.set(code, station.name);
      return {
        station: code,
        items: station.items.map((item) => encodeDish(item, builder, selection, true)),
      };
    });
    return { meal, stations };
  });

  const response: EncodedResponse = {
    key: buildKey(builder),
    units: { ...selection.units },
    ...rest,
    meals,
  };

  const notes = [...extraNotes];
  const hasAllergens = meals.some((meal) =>
    meal.stations.some((station) => station.items.some((item) => (item[2] as number[]).length > 0)),
  );
  if (hasAllergens) notes.unshift(ALLERGEN_NOTE);
  if (notes.length > 0) response.note = notes.join(' ');

  if (response.units && Object.keys(response.units).length <= 1) {
    delete response.units;
  }

  return response;
}

/** The micronutrient a field name belongs to, or null. */
export function micronutrientForField(field: string): MicronutrientSpec | null {
  return MICRONUTRIENT_SPECS.find((spec) => spec.field === field) ?? null;
}

export { micronutrientSpec };
