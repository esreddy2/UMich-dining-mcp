import type { Nutrition } from './types.js';

export type NutrientUnit = 'kcal' | 'g' | 'mg' | '%DV' | 'serving';

/** A threshold on one nutrient, as the caller wrote it. */
export interface NutrientRangeInput {
  min?: number;
  max?: number;
  unit?: string;
}

/** A threshold with its unit checked and its bounds in the nutrient's own unit. */
export interface ResolvedNutrientRange {
  /** The canonical key, or the micronutrient name. */
  key: string;
  /** The unit the bounds are expressed in. */
  unit: string;
  min: number | null;
  max: number | null;
}

export class NutrientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NutrientError';
  }
}


export interface NutrientSpec {
  key: string;
  label: string;
  unit: NutrientUnit;
  sortable: boolean;
}

export const NUTRIENT_SPECS: NutrientSpec[] = [
  { key: 'calories', label: 'Calories', unit: 'kcal', sortable: true },
  { key: 'totalFat', label: 'Total Fat', unit: 'g', sortable: true },
  { key: 'saturatedFat', label: 'Saturated Fat', unit: 'g', sortable: true },
  { key: 'transFat', label: 'Trans Fat', unit: 'g', sortable: true },
  { key: 'cholesterol', label: 'Cholesterol', unit: 'mg', sortable: true },
  { key: 'sodium', label: 'Sodium', unit: 'mg', sortable: true },
  { key: 'totalCarbohydrate', label: 'Total Carbohydrate', unit: 'g', sortable: true },
  { key: 'dietaryFiber', label: 'Dietary Fiber', unit: 'g', sortable: true },
  { key: 'sugars', label: 'Sugars', unit: 'g', sortable: true },
  { key: 'protein', label: 'Protein', unit: 'g', sortable: true },
];

export const NUTRIENT_KEYS = NUTRIENT_SPECS.map((s) => s.key);

/**
 * The four micronutrients the site publishes, with the FDA Daily Value their
 * percentage refers to. The site prints only the percentage; the physical
 * amount is derived from the Daily Value and labelled as derived.
 */
export interface MicronutrientSpec {
  /** The name as the site publishes it, matched case-insensitively. */
  name: string;
  /** The field name the derived amount is returned under. */
  field: string;
  /** The unit the site publishes the value in. */
  publishedUnit: '%DV';
  /** The FDA Daily Value the published percentage refers to. */
  dailyValue: number;
  /** The unit of the Daily Value. */
  dailyValueUnit: 'mg' | 'mcg RAE';
  /** The unit the derived amount is expressed in. */
  derivedUnit: 'mg' | 'mcg RAE';
}

export const MICRONUTRIENT_SPECS: MicronutrientSpec[] = [
  { name: 'Vitamin A', field: 'vitaminA', publishedUnit: '%DV', dailyValue: 900, dailyValueUnit: 'mcg RAE', derivedUnit: 'mcg RAE' },
  { name: 'Vitamin C', field: 'vitaminC', publishedUnit: '%DV', dailyValue: 90, dailyValueUnit: 'mg', derivedUnit: 'mg' },
  { name: 'Calcium', field: 'calcium', publishedUnit: '%DV', dailyValue: 1300, dailyValueUnit: 'mg', derivedUnit: 'mg' },
  { name: 'Iron', field: 'iron', publishedUnit: '%DV', dailyValue: 18, dailyValueUnit: 'mg', derivedUnit: 'mg' },
];

const normalizeNutrientName = (name: string): string => name.trim().toLowerCase().replace(/[\s\-_]/g, '');

const MICRONUTRIENT_BY_LOWER_NAME = new Map(MICRONUTRIENT_SPECS.map((spec) => [normalizeNutrientName(spec.name), spec]));
const MICRONUTRIENT_BY_FIELD = new Map(MICRONUTRIENT_SPECS.map((spec) => [normalizeNutrientName(spec.field), spec]));

export function micronutrientSpec(name: string): MicronutrientSpec | null {
  const wanted = normalizeNutrientName(name);
  return MICRONUTRIENT_BY_LOWER_NAME.get(wanted) ?? MICRONUTRIENT_BY_FIELD.get(wanted) ?? null;
}

/** The rounding caveat that applies to every derived micronutrient amount. */
export const MICRONUTRIENT_ROUNDING_CAVEAT =
  'The site publishes whole percentages, so the derived amount carries the +/-1 percentage point ' +
  'rounding of the published figure: a 15% value is 13% to 17% of the Daily Value, not exactly 15%.';

export function nutrientUnit(key: string): NutrientUnit | null {
  return NUTRIENT_SPECS.find((s) => s.key === key)?.unit ?? null;
}

const GRAM_NUTRIENTS = new Set(['totalFat', 'saturatedFat', 'transFat', 'totalCarbohydrate', 'dietaryFiber', 'sugars', 'protein']);

export function canonicalUnit(key: string): NutrientUnit | null {
  if (key === 'calories') return 'kcal';
  if (GRAM_NUTRIENTS.has(key)) return 'g';
  if (key === 'cholesterol' || key === 'sodium') return 'mg';
  return null;
}

/**
 * The units a nutrient threshold may be written in, with the factor that
 * converts them to the canonical unit. A unit outside this map is rejected.
 */
const ACCEPTED_UNITS: Record<string, Record<string, number>> = {
  calories: { kcal: 1 },
  totalFat: { g: 1, mg: 0.001 },
  saturatedFat: { g: 1, mg: 0.001 },
  transFat: { g: 1, mg: 0.001 },
  cholesterol: { mg: 1, g: 1000 },
  sodium: { mg: 1, g: 1000 },
  totalCarbohydrate: { g: 1, mg: 0.001 },
  dietaryFiber: { g: 1, mg: 0.001 },
  sugars: { g: 1, mg: 0.001 },
  protein: { g: 1, mg: 0.001 },
};

/**
 * The units a micronutrient threshold may be written in.
 *
 * The amount comes first: the unit the row carries is the default one, so a
 * threshold without a unit is read in the amount and not in the published
 * percentage. The percentage stays available under its own name, "%DV".
 */
const MICRONUTRIENT_UNITS: Record<string, string[]> = {
  vitaminA: ['mcg RAE', '%DV'],
  vitaminC: ['mg', 'g', '%DV'],
  calcium: ['mg', 'g', '%DV'],
  iron: ['mg', 'g', '%DV'],
};

export function acceptedUnits(key: string): string[] {
  const units = ACCEPTED_UNITS[key];
  if (units) return Object.keys(units);
  const micro = micronutrientSpec(key);
  if (micro) return MICRONUTRIENT_UNITS[micro.field] ?? [micro.derivedUnit, micro.publishedUnit];
  return [];
}


export function parseNutritionNumber(raw: string | null | undefined, key: string): number | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (/^(trace|tr|less than|<)/i.test(text)) return null;
  const match = text.match(/^([\d,]+(?:\.\d+)?)\s*(kcal|cal|mg|g|%)?/i);
  if (!match || !match[1]) return null;
  if (!match) return null;
  const num = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(num)) return null;
  const unit = (match[2] ?? '').toLowerCase();
  const target = canonicalUnit(key);
  if (target === 'g') {
    if (unit === 'mg') return num / 1000;
    if (unit === 'g' || unit === '') return num;
    return null;
  }
  if (target === 'mg') {
    if (unit === 'g') return num * 1000;
    if (unit === 'mg' || unit === '') return num;
    return null;
  }
  if (target === 'kcal') {
    if (unit === 'kcal' || unit === 'cal' || unit === '') return num;
    return null;
  }
  return null;
}

/** The standard conversion, used only when the site states an ounce amount. */
export const GRAMS_PER_OUNCE = 28.349523125;

/**
 * The gram weight of a serving, read from the published serving size.
 *
 * Every published serving size carries a gram figure in parentheses
 * ("Cups (253g)"); where it does not, an ounce amount is converted with the
 * standard factor. Where neither is published the weight is unknown: nothing
 * is ever guessed.
 */
export function parseServingSizeGrams(servingSize: string | null | undefined): number | null {
  if (!servingSize) return null;
  const text = String(servingSize);

  const parenthesised = /\(([^)]*)\)/.exec(text);
  if (parenthesised) {
    const grams = /([\d]+(?:\.\d+)?)\s*g\b/i.exec(parenthesised[1]!);
    if (grams) {
      const value = Number(grams[1]);
      if (Number.isFinite(value)) return value;
    }
  }

  const ounces = /([\d]+(?:\.\d+)?)\s*oz\b/i.exec(text);
  if (ounces) {
    const value = Number(ounces[1]);
    if (Number.isFinite(value)) return Math.round(value * GRAMS_PER_OUNCE * 1000) / 1000;
  }

  return null;
}

/**
 * The published percentage of a micronutrient, as the number the site prints.
 * A value the site does not publish, or a "trace" value, has no percentage.
 */
export function parsePublishedPercent(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (/^(trace|tr|less than|<)/i.test(text)) return null;
  const match = /([\d]+(?:\.\d+)?)/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * The physical amount of a micronutrient, derived from the published percentage
 * and the FDA Daily Value the panel refers to.
 */
export function deriveMicronutrient(
  name: string,
  raw: string | null | undefined,
): { pct: number; amount: number; unit: string; spec: MicronutrientSpec } | null {
  const spec = micronutrientSpec(name);
  if (!spec) return null;
  const pct = parsePublishedPercent(raw);
  if (pct === null) return null;
  return {
    pct,
    amount: Math.round((pct / 100) * spec.dailyValue * 1000) / 1000,
    unit: spec.derivedUnit,
    spec,
  };
}

/**
 * The amount of a micronutrient, in the unit of its Daily Value.
 *
 * The site publishes the percentage only; the amount is derived from it and
 * carries the rounding of the published figure.
 */
export function micronutrientAmount(
  nutrition: Nutrition | null | undefined,
  spec: MicronutrientSpec,
): number | null {
  if (!nutrition) return null;
  const raw = findMicronutrientValue(nutrition.micronutrients, spec.name);
  return deriveMicronutrient(spec.name, raw)?.amount ?? null;
}

/**
 * Resolve the name of a nutrient the caller used.
 *
 * A canonical key wins, matched without regard to case; the published
 * micronutrient names are accepted case-insensitively too.
 */
export function resolveNutrientName(name: string): { key: string; micronutrient: MicronutrientSpec | null } | null {
  const trimmed = name.trim();
  const wanted = normalizeNutrientName(trimmed);
  const canonical = NUTRIENT_KEYS.find((key) => normalizeNutrientName(key) === wanted);
  if (canonical) return { key: canonical, micronutrient: null };
  // Accept the published label (e.g. "Total Fat") and field name (e.g. "totalFat").
  const byLabel = NUTRIENT_SPECS.find((spec) => normalizeNutrientName(spec.label) === wanted);
  if (byLabel) return { key: byLabel.key, micronutrient: null };
  const micro = micronutrientSpec(trimmed);
  if (micro) return { key: micro.name, micronutrient: micro };
  return null;
}

/**
 * The fields a sweep can sort on.
 *
 * The canonical nutrient keys, the two ratios the server computes, and the
 * published micronutrient names.
 */
export const SORT_FIELDS: readonly string[] = [
  ...NUTRIENT_KEYS,
  'carbonFootprint',
  'proteinToCalorie',
  'protein_to_calorie',
  'fiberToCalorie',
  'fiber_to_calorie',
  ...MICRONUTRIENT_SPECS.map((spec) => spec.name),
];

/** The default direction of a sort. */
export const DEFAULT_SORT_ORDER = 'desc';

/**
 * Check a sort field.
 *
 * An unknown field is refused: a typo would otherwise return a list that
 * looks sorted and is not.
 */
export function resolveSortField(name: string): string {
  const wanted = normalizeNutrientName(name);
  const found = SORT_FIELDS.find((field) => normalizeNutrientName(field) === wanted);
  if (!found) {
    throw new NutrientError(
      `Unknown sort field "${name}". Use one of: ${SORT_FIELDS.join(', ')}.`,
    );
  }
  return found;
}

/**
 * Check a nutrient threshold and express it in the unit the caller wrote.
 *
 * The unit defaults to the nutrient's canonical one: the gram, the milligram
 * or, for a micronutrient, the unit of its derived amount. A unit the
 * nutrient cannot be expressed in is rejected by name, as is a negative
 * bound, a non-finite bound and a range whose minimum exceeds its maximum.
 */
export function resolveNutrientRange(name: string, range: NutrientRangeInput): ResolvedNutrientRange {
  const resolved = resolveNutrientName(name);
  if (!resolved) {
    throw new NutrientError(
      `Unknown nutrient "${name}". Use list_nutrition_fields to see the supported nutrient names.`,
    );
  }

  const { key, micronutrient } = resolved;
  const units = acceptedUnits(key);
  const requested = range.unit?.trim();
  const requestedLower = requested ? requested.toLowerCase() : '';
  const matched = requested && requested.length > 0 ? units.find((candidate) => candidate.toLowerCase() === requestedLower) : undefined;
  const unit = matched ?? (requested && requested.length > 0 ? requested : units[0]!);

  if (!units.includes(unit)) {
    throw new NutrientError(
      `The unit "${unit}" cannot be used for "${key}". Use one of: ${units.join(', ')}.`,
    );
  }

  const min = range.min ?? null;
  const max = range.max ?? null;

  if (min !== null && (!Number.isFinite(min) || min < 0)) {
    throw new NutrientError(`The minimum for "${key}" must be a finite number of zero or more.`);
  }
  if (max !== null && (!Number.isFinite(max) || max < 0)) {
    throw new NutrientError(`The maximum for "${key}" must be a finite number of zero or more.`);
  }
  if (min !== null && max !== null && min > max) {
    throw new NutrientError(
      `The minimum for "${key}" (${min}) is greater than its maximum (${max}).`,
    );
  }

  void micronutrient;
  return { key, unit, min, max };
}

/**
 * The value of a nutrient in the unit of a resolved range, or null when the
 * site publishes no value for it. A constraint on an unknown value excludes
 * the dish, so this never reports a zero it did not find.
 */
export function nutrientValueInUnit(
  key: string,
  unit: string,
  nutrition: Nutrition | null | undefined,
): number | null {
  if (!nutrition) return null;

  const micro = micronutrientSpec(key);
  if (micro) {
    const raw = findMicronutrientValue(nutrition.micronutrients, micro.name);
    const derived = deriveMicronutrient(micro.name, raw);
    if (!derived) return null;
    // The published percentage, the derived amount, and a gram amount of a
    // nutrient the panel publishes in milligrams.
    if (unit === micro.publishedUnit) return derived.pct;
    if (unit === micro.derivedUnit) return derived.amount;
    if (unit === 'g' && micro.derivedUnit === 'mg') return Math.round((derived.amount / 1000) * 1000) / 1000;
    return null;
  }

  const canonical = canonicalUnit(key);
  if (!canonical) return null;
  const value =
    key === 'calories'
      ? nutrition.calories
      : parseNutritionNumber(asString((nutrition as unknown as Record<string, unknown>)[key]), key);
  if (value === null) return null;

  const factors = ACCEPTED_UNITS[key];
  const factor = factors?.[unit];
  if (factor === undefined) return null;
  return Math.round((value / factor) * 1000) / 1000;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

/** The published micronutrient value, matched case-insensitively. */
export function findMicronutrientValue(
  micronutrients: Record<string, string>,
  name: string,
): string | null {
  const wanted = name.trim().toLowerCase();
  for (const [key, value] of Object.entries(micronutrients)) {
    if (key.trim().toLowerCase() === wanted) return value;
  }
  return null;
}

