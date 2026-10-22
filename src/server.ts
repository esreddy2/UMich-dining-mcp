import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { HALLS } from './halls.js';
import {
  ALLERGENS,
  ALLERGEN_CAVEAT,
  ALLERGEN_REMINDER,
  ALLERGEN_SLUGS,
  BOOLEAN_TRAIT_SLUGS,
  CARBON_TIERS,
  MHEALTHY_TIERS,
  TRAITS,
  TRAIT_IMPLICATIONS,
  TRAIT_SLUGS,
} from './taxonomy.js';
import {
  ServiceError,
  filterDishes,
  findOpenNow,
  getHours,
  getItemNutrition,
  getMenu,
  listLocations,
  menuGroups,
  searchDishes,
} from './service.js';
import { BlockedError, HttpError } from './http.js';
import {
  MICRONUTRIENT_ROUNDING_CAVEAT,
  MICRONUTRIENT_SPECS,
  NUTRIENT_SPECS,
  NutrientError,
  SORT_FIELDS,
  acceptedUnits,
} from './nutrition.js';
import { encodeMenu, encodeResponse, selectNutrients, SelectionError } from './encode.js';
import { STATION_NAMES, TRAIT_CODES } from './codes.js';
import { HALL_IDS, MEAL_NAMES, type HallId } from './types.js';

const SERVER_NAME = 'umich-dining-mcp';
const SERVER_VERSION = '0.2.0';

/**
 * The annotations of a tool that only reads.
 *
 * Every tool of this server reads: none of them writes, deletes or changes
 * anything, and running one twice has the same effect as running it once.
 */
const READ_ONLY_WORLD = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** The annotations of a tool that reads a table of this server, not the world. */
const READ_ONLY_LOCAL = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const hallIdSchema = z.enum(HALL_IDS);

/** The halls of a sweep: one hall, a list of them, or none at all. */
function hallList(hall: string | string[] | undefined): HallId[] | undefined {
  if (hall === undefined) return undefined;
  const list = Array.isArray(hall) ? hall : [hall];
  return list.length > 0 ? (list as HallId[]) : undefined;
}

/**
 * The halls to sweep: one hall, or several, or none at all.
 *
 * A single hall may still be named on its own; a list names as many as the
 * caller wants, and an empty list means every hall.
 */
const hallsSchema = z
  .union([hallIdSchema, z.array(hallIdSchema).max(HALL_IDS.length)])
  .optional()
  .describe('The halls to search: one hall, or a list of them. Leave it out, or pass an empty list, for every hall.');
const mealNameSchema = z.enum(MEAL_NAMES);
/**
 * The meals to keep: one name, or a list of them.
 *
 * The list is empty when the request is refused, so the tool never answers
 * with a meal that was not asked for.
 */
const mealsSchema = z.union([mealNameSchema, z.array(mealNameSchema).min(1)]);
const allergenSchema = z.enum(ALLERGEN_SLUGS as [string, ...string[]]);
const traitSchema = z.enum(TRAIT_SLUGS as [string, ...string[]]);
const carbonSchema = z.number().int().min(1).max(3);

const nutritionSchema = z.object({
  servingSize: z.string().nullable(),
  calories: z.number().nullable(),
  totalFat: z.string().nullable(),
  saturatedFat: z.string().nullable(),
  transFat: z.string().nullable(),
  cholesterol: z.string().nullable(),
  sodium: z.string().nullable(),
  totalCarbohydrate: z.string().nullable(),
  dietaryFiber: z.string().nullable(),
  sugars: z.string().nullable(),
  protein: z.string().nullable(),
  micronutrients: z.record(z.string(), z.string()),
});

const servicePeriodSchema = z.object({
  label: z.string(),
  times: z.string(),
  closed: z.boolean(),
});

const weeklyHoursSchema = z.object({
  days: z.array(z.string()),
  periods: z.array(servicePeriodSchema),
  closed: z.boolean(),
});

const regularHoursSchema = z.object({
  hall: hallIdSchema,
  name: z.string(),
  url: z.string().nullable(),
  weekly: z.array(weeklyHoursSchema),
});

const locationSchema = z.object({
  id: hallIdSchema,
  name: z.string(),
  path: z.string(),
  url: z.string(),
  residentsOnly: z.boolean(),
  glutenFreePantry: z.boolean(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  mapUrl: z.string().nullable(),
  meals: z.array(mealNameSchema),
  date: z.string(),
  today: z.array(servicePeriodSchema),
  openNow: z.boolean(),
  stale: z.boolean(),
});

const hallHoursSchema = z.object({
  hall: hallIdSchema,
  name: z.string(),
  date: z.string(),
  today: z.array(servicePeriodSchema),
  regular: regularHoursSchema.nullable(),
  stale: z.boolean(),
});

/**
 * A row of a sweep answer.
 *
 * The row is an array: the member names of a named row are two and a half
 * times the data of the row, repeated on every row of the response. The
 * `fields` list of the response names the positions, once.
 */
const encodedDishSchema = z.array(
  z.union([
    z.number(),
    z.string(),
    z.boolean(),
    z.null(),
    z.array(z.number()),
    z.array(z.string()),
    z.record(z.string(), z.number()),
  ]),
);

const keySchema = z.record(z.string(), z.record(z.string(), z.string()));

/** The names of the row positions, in the order the rows carry them. */
const fieldsSchema = z.array(z.string());

const failureSchema = z.object({
  hall: hallIdSchema,
  hallName: z.string(),
  error: z.string(),
});

const listLocationsOutput = z.object({
  date: z.string(),
  locations: z.array(locationSchema),
  failures: z.array(failureSchema),
  warning: z.string(),
});

const encodedStationSchema = z.object({
  station: z.number().int().min(1),
  items: z.array(encodedDishSchema),
});

const encodedMealSchema = z.object({
  meal: z.number().int().min(1),
  stations: z.array(encodedStationSchema),
});

const getMenuOutput = z.object({
  hall: hallIdSchema,
  hallName: z.string(),
  date: z.string(),
  key: keySchema,
  units: z.record(z.string(), z.string()),
  /** The names of the row positions, in the order the rows carry them. */
  fields: fieldsSchema,
  note: z.string().optional(),
  /** The meals of the day, with the stations and the dishes of each. */
  meals: z.array(encodedMealSchema),
  /** Meals the site published under a label this server has no slot for. */
  otherMeals: z.array(
    z.object({ label: z.string(), stations: z.array(encodedStationSchema) }),
  ),
  /** Meal labels the site used that this server does not know. */
  unknownMealLabels: z.array(z.string()),
  renderedDate: z.string().nullable(),
  totalStations: z.number(),
  totalItems: z.number(),
  /** True when the site published its "no menu" marker for this day. */
  noMenu: z.boolean(),
  stale: z.boolean(),
});

const searchDishesOutput = z.object({
  key: keySchema,
  units: z.record(z.string(), z.string()),
  /** The names of the row positions, in the order the rows carry them. */
  fields: fieldsSchema,
  note: z.string().optional(),
  query: z.string(),
  date: z.string().optional(),
  dateRange: z.object({ from: z.string(), to: z.string() }).optional(),
  totalMatches: z.number(),
  /** True when the rows were cut short by the limit. */
  truncated: z.boolean(),
  /** True when a day of the answer was served from an expired cache entry. */
  stale: z.boolean(),
  /** The days of the range whose page carried no menu. */
  emptyDates: z.array(z.string()),
  matches: z.array(encodedDishSchema),
  failures: z.array(failureSchema),
  coverage: z
    .object({
      requested: z.number(),
      cached: z.number(),
      fetchedNow: z.number(),
      pending: z.number(),
      failed: z.number(),
      stale: z.number(),
      offset: z.number(),
      pages: z.number(),
      nextOffset: z.number().nullable(),
    })
    .optional(),
});

const filterDishesOutput = z.object({
  key: keySchema,
  units: z.record(z.string(), z.string()),
  /** The names of the row positions, in the order the rows carry them. */
  fields: fieldsSchema,
  note: z.string().optional(),
  date: z.string().optional(),
  dateRange: z.object({ from: z.string(), to: z.string() }).optional(),
  totalMatches: z.number(),
  /** True when the rows were cut short by the limit. */
  truncated: z.boolean(),
  /** True when a day of the answer was served from an expired cache entry. */
  stale: z.boolean(),
  /** The days of the range whose page carried no menu. */
  emptyDates: z.array(z.string()),
  matches: z.array(encodedDishSchema),
  failures: z.array(failureSchema),
  coverage: z
    .object({
      requested: z.number(),
      cached: z.number(),
      fetchedNow: z.number(),
      pending: z.number(),
      failed: z.number(),
      stale: z.number(),
      offset: z.number(),
      pages: z.number(),
      nextOffset: z.number().nullable(),
    })
    .optional(),
});

const getHoursOutput = z.object({
  date: z.string(),
  halls: z.array(hallHoursSchema),
  failures: z.array(failureSchema),
});

const findOpenNowOutput = z.object({
  date: z.string(),
  at: z.string().nullable(),
  open: z.array(locationSchema),
  closed: z.array(locationSchema),
  failures: z.array(failureSchema),
});

const itemNutritionOutput = z.object({
  hall: hallIdSchema,
  hallName: z.string(),
  date: z.string(),
  /** The meal, as the site labels it. */
  meal: z.string(),
  station: z.string(),
  name: z.string(),
  traits: z.array(z.string()),
  traitLabels: z.record(z.string(), z.string()),
  allergens: z.array(z.string()),
  mhealthyTier: z.number().nullable(),
  carbonFootprint: carbonSchema.nullable(),
  nutrition: nutritionSchema,
  /** The weight of a serving, derived from the published serving size. */
  servingSizeGrams: z.number().nullable(),
  /** The micronutrients: the amount they stand for (mg, or mcg RAE for the vitamin A). */
  micronutrients: z.record(z.string(), z.number().nullable()),
  warning: z.string(),
});

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates use the YYYY-MM-DD format.')
  .describe('Calendar date in YYYY-MM-DD. The site publishes menus for today-3 days to today+14 days.');

function ok(payload: unknown): {
  content: { type: 'text'; text: string }[];
  structuredContent: unknown;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/**
 * The one shape every tool error takes.
 *
 * `{"error": {"kind": ..., "message": ...}}`, with the kind telling the
 * caller what to do about it: an argument to fix, an upstream problem to
 * wait out, or a fault of this server.
 */
export type ErrorKind =
  | 'invalid_request'
  | 'not_found'
  | 'upstream'
  | 'upstream_blocked'
  | 'internal';

function classifyError(error: unknown): ErrorKind {
  if (error instanceof ServiceError) {
    return /no dish|does not publish|not served/i.test(error.message) ? 'not_found' : 'invalid_request';
  }
  if (error instanceof NutrientError || error instanceof SelectionError) return 'invalid_request';
  if (error instanceof BlockedError) return 'upstream_blocked';
  if (error instanceof HttpError) return 'upstream';
  return 'internal';
}

function fail(error: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  const payload = { error: { kind: classifyError(error), message } };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

/**
 * The notes a sweep response carries besides the rows: the days whose page
 * held no menu and the meal labels this server cannot parse.
 */
function extraNotes(result: {
  emptyDates?: string[];
  unknownMealLabels?: string[];
  stationNote?: string;
  dateRange?: { from: string; to: string };
  truncated?: boolean;
  truncationNote?: string;
  totalMatches?: number;
}): string[] {
  const notes: string[] = [];
  if (result.truncated) {
    notes.push(
      result.truncationNote ??
        `The rows are cut short: ${result.totalMatches} dishes matched and only the first ones are ` +
          'shown. Narrow the query, or raise the limit.',
    );
  }
  if (result.dateRange) {
    notes.push(
      'This is a range: the values of a dish are the ones of the first day it appeared on, and ' +
        'the "dates" of a row are the days it appeared on.',
    );
  }
  if (result.emptyDates && result.emptyDates.length > 0) {
    notes.push(`No menu published on: ${result.emptyDates.join(', ')}.`);
  }
  if (result.unknownMealLabels && result.unknownMealLabels.length > 0) {
    notes.push(
      `The site published meal labels this server cannot parse, so those meals are missing: ` +
        `${result.unknownMealLabels.join(', ')}.`,
    );
  }
  if (result.stationNote) notes.push(result.stationNote);
  return notes;
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        'Menus, hours, traits and nutrition for the dining halls of the University of Michigan, ' +
        'read from the public site at dining.umich.edu. This server is not affiliated with or ' +
        'endorsed by the university, and the data is unofficial: the site is the only authority, ' +
        'and its allergen flags are advisory. The rows of the sweep tools carry codes; read the ' +
        '"key" block of the response to resolve them.',
    },
  );

  server.registerTool(
    'list_locations',
    {
      title: 'List dining halls',
      description:
        'List the ten University of Michigan dining halls with their address, phone, e-mail, map link, ' +
        'the service periods published for the requested day, whether they are serving right now, and ' +
        'whether they have a gluten-free pantry. Cafes, markets, bakeries, grills, prices and meal ' +
        'plans are out of scope.',
      inputSchema: z.strictObject({
        date: dateSchema.optional().describe('The day to read. Defaults to today.'),
      }),
      outputSchema: listLocationsOutput,
      annotations: READ_ONLY_WORLD,
    },
    async (args) => {
      try {
        const { date, locations, failures } = await listLocations(args.date);
        return ok({ date, locations, failures, warning: ALLERGEN_REMINDER });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'get_menu',
    {
      title: 'Get a dining hall menu',
      description:
        'Get the menu of one dining hall: meals, stations and dishes, with each dish\'s traits ' +
        '(the six boolean ones as codes), its allergens as codes, its nutrient-density tier, its ' +
        'carbon footprint tier, its calories and its serving size. Read the "key" block to resolve ' +
        'the codes and the "fields" list to read a row, which is an array. The full nutrition panel ' +
        'of a single dish comes from get_item_nutrition. The ' +
        'date defaults to today; the site publishes menus for today-3 days to today+14 days. ' +
        ALLERGEN_CAVEAT,
      inputSchema: z.strictObject({
        hall: hallIdSchema.describe('The dining hall to read.'),
        date: dateSchema.optional().describe('The day to read. Defaults to today.'),
        meal: mealsSchema
          .optional()
          .describe('Keeps only those meals: one name, or a list of them. When it is left out, the meal the hall is serving right now is used.'),
        station: z.string().optional().describe('Keeps only that station.'),
        include_nutrients: z
          .array(z.string())
          .optional()
          .describe('The nutrients to return, by canonical key or by published name, or ["all"].'),
      }),
      outputSchema: getMenuOutput,
      annotations: READ_ONLY_WORLD,
    },
    async (args) => {
      try {
        const page = await getMenu(args.hall, args.date, args.meal);
        let groups = menuGroups(page);

        if (args.station) {
          const wanted = args.station.toLowerCase();
          groups = groups.map((group) => ({
            meal: group.meal,
            stations: group.stations.filter((station) => station.name.toLowerCase() === wanted),
          }));
        }

        const totalStations = groups.reduce((sum, group) => sum + group.stations.length, 0);
        const totalItems = groups.reduce(
          (sum, group) => sum + group.stations.reduce((inner, station) => inner + station.items.length, 0),
          0,
        );

        const selection = selectNutrients(args.include_nutrients);
        const notes: string[] = [];
        if (page.mealNote) notes.push(page.mealNote);
        if (page.menu.unknownMealLabels.length > 0) {
          notes.push(
            `The site published meal labels this server cannot parse, so those meals are missing: ` +
              `${page.menu.unknownMealLabels.join(', ')}.`,
          );
        }

        return ok(encodeMenu(groups, selection, {
          hall: page.hall.id,
          hallName: page.hall.name,
          date: page.date,
          otherMeals: [],
          unknownMealLabels: page.menu.unknownMealLabels,
          renderedDate: page.menu.renderedDate,
          totalStations,
          totalItems,
          noMenu: page.menu.noMenu,
          stale: page.stale,
        }, notes));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'search_dishes',
    {
      title: 'Search dishes',
      description:
        'Search dish names across the dining halls, or within the halls that are named. The match is a ' +
        'case-insensitive substring match on the dish name. A single day is searched by default; ' +
        '"from" and "to" search a range of days, and each row then lists the days the dish ' +
        'appeared on. The rows carry codes: read key.halls, key.meals, key.stations, key.traits ' +
        'and key.allergens to resolve them. The rows are arrays: the "fields" list names the ' +
        'positions, in order. The row always carries the calories and the serving ' +
        'size; every other nutrient, the sodium included, is asked for with include_nutrients. ' +
        'mhealthyTier is 1 (Nutrient Dense Low) to 5 (Nutrient ' +
        'Dense High). The rows are returned in the order asked for, and "limit" takes the first of them: the default is 50.',
      inputSchema: z.strictObject({
        query: z.string().min(1).describe('Text to look for in the dish names.'),
        hall: hallsSchema,
        date: dateSchema.optional().describe('A single day to search. Cannot be combined with from/to.'),
        from: dateSchema.optional().describe('The first day of a range to search.'),
        to: dateSchema.optional().describe('The last day of a range to search. Defaults to the last published day.'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('How many pages of the range to skip. The response names the offset of the next page.'),
        meal: mealNameSchema.optional().describe('Keeps only that meal.'),
        station: z.string().optional().describe('Keeps only that station.'),
        include_nutrients: z
          .array(z.string())
          .optional()
          .describe('The nutrients to return, by canonical key or by published name, or ["all"].'),
        sort_by: z
          .string()
          .optional()
          .describe('The field to sort on, e.g. "calories" or "protein". The default order is by hall, meal and name.'),
        sort_order: z.enum(['asc', 'desc']).optional().describe('The direction of the sort. The default is descending.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('How many rows to return, the first of them in the order asked for. Defaults to 50; ask again with a larger limit for more.'),
      }),
      outputSchema: searchDishesOutput,
      annotations: READ_ONLY_WORLD,
    },
    async (args) => {
      try {
        const result = await searchDishes(args.query, {
          halls: hallList(args.hall),
          date: args.date,
          from: args.from,
          to: args.to,
          offset: args.offset,
          meal: args.meal,
          station: args.station,
          sort_by: args.sort_by,
          sort_order: args.sort_order,
          limit: args.limit,
        });
        const selection = selectNutrients(args.include_nutrients, [], args.sort_by === 'carbonFootprint');
        return ok(encodeResponse(result.matches, selection, {
          query: result.query,
          date: result.dateRange ? undefined : result.date,
          dateRange: result.dateRange,
          totalMatches: result.totalMatches,
          truncated: result.truncated,
          stale: result.stale,
          emptyDates: result.emptyDates ?? [],
          failures: result.failures,
          coverage: result.coverage,
        }, extraNotes(result)));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'filter_dishes',
    {
      title: 'Filter dishes',
      description:
        'Filter the dining hall menus by allergen, trait, nutrient density, carbon footprint and ' +
        'nutrients. exclude_allergens removes dishes that carry any of the listed allergens; ' +
        'require_traits keeps only dishes that carry every listed trait; min_mhealthy is the lowest ' +
        'acceptable nutrient-density tier (3 = Nutrient Dense Medium or better); max_carbon is the ' +
        'highest acceptable carbon footprint (1 = low, 2 = medium, 3 = high). Both of them drop the ' +
        'dishes the site did not tag: a dish with no nutrient density is not "dense", and a dish ' +
        'with no carbon footprint does not pass a carbon cap. max_calories and ' +
        'min_calories and the sodium bounds are numeric caps that exclude dishes without published ' +
        'values. nutrients takes a range per nutrient, e.g. {"protein": {"min": 20, "unit": "g"}}; ' +
        'the unit defaults to the nutrient\'s own and is checked. A micronutrient threshold without ' +
        'a unit is read in the amount the row carries: {"Iron": {"min": 2}} means 2 mg of iron, ' +
        'while {"Iron": {"min": 2, "unit": "%DV"}} means 2 percent of the Daily Value. include_nutrients names the ' +
        'nutrients to return; it defaults to the ones the filter used, and a nutrient the filter ' +
        'constrained is always returned. The row always carries the calories and the serving ' +
        'size; every other nutrient, the sodium included, is asked for by name. A single day is filtered by ' +
        'default; "from" and "to" filter a range and each row then lists the days the dish appeared ' +
        'on. The rows carry codes: read key.halls, key.meals, key.stations, key.traits and ' +
        'key.allergens to resolve them, and the "fields" list to read a row. ' +
        ALLERGEN_CAVEAT,
      inputSchema: z.strictObject({
        exclude_allergens: z
          .array(allergenSchema)
          .optional()
          .describe('Keeps only the dishes that carry none of these allergens.'),
        require_traits: z
          .array(traitSchema)
          .optional()
          .describe('Keeps only the dishes that carry every one of these traits.'),
        min_mhealthy: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe('The lowest acceptable nutrient-density tier. The dishes the site did not tag are dropped.'),
        max_carbon: carbonSchema
          .optional()
          .describe('The highest acceptable carbon footprint: 1 (low), 2 (medium) or 3 (high). The dishes the site did not tag are dropped.'),
        max_calories: z.number().nonnegative().optional().describe('The highest acceptable number of calories.'),
        min_calories: z.number().nonnegative().optional().describe('The lowest acceptable number of calories.'),
        max_sodium_mg: z.number().nonnegative().optional().describe('The highest acceptable amount of sodium, in mg.'),
        min_sodium_mg: z.number().nonnegative().optional().describe('The lowest acceptable amount of sodium, in mg.'),
        nutrients: z
          .record(
            z.string(),
            z.object({
              min: z.number().optional().describe('The lowest acceptable value, in the unit below.'),
              max: z.number().optional().describe('The highest acceptable value, in the unit below.'),
              unit: z
                .string()
                .optional()
                .describe('The unit of the bounds. It defaults to the nutrient\'s own; a micronutrient defaults to the published percent.'),
            }),
          )
          .optional()
          .describe(
            'A range per nutrient, e.g. {"protein": {"min": 20, "unit": "g"}}. A constraint on a nutrient ' +
              'excludes the dishes that publish no value for it.',
          ),
        include_nutrients: z
          .array(z.string())
          .optional()
          .describe('The nutrients to return, by canonical key or by published name, or ["all"].'),
        query: z.string().optional().describe('A case-insensitive substring of the dish name.'),
        meal: mealNameSchema.optional().describe('Keeps only that meal.'),
        station: z.string().optional().describe('Keeps only that station.'),
        sort_by: z
          .string()
          .optional()
          .describe(
            'The field to sort on: a nutrient key (calories, sodium, protein, totalFat, …), ' +
              'carbonFootprint, a micronutrient name (Iron, Calcium, …), or one of ' +
              'proteinToCalorie and fiberToCalorie. An unknown field is refused.',
          ),
        sort_order: z
          .enum(['asc', 'desc'])
          .optional()
          .describe('The direction of the sort. It defaults to desc, so the biggest value comes first.'),
        hall: hallsSchema,
        date: dateSchema.optional().describe('A single day to filter. Cannot be combined with from/to.'),
        from: dateSchema.optional().describe('The first day of a range to filter.'),
        to: dateSchema.optional().describe('The last day of a range to filter. Defaults to the last published day.'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('How many pages of the range to skip. The response names the offset of the next page.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('How many rows to return, the first of them in the order asked for. Defaults to 50; ask again with a larger limit for more.'),
      }),
      outputSchema: filterDishesOutput,
      annotations: READ_ONLY_WORLD,
    },
    async (args) => {
      try {
        const result = await filterDishes({
          exclude_allergens: args.exclude_allergens,
          require_traits: args.require_traits,
          min_mhealthy: args.min_mhealthy,
          max_carbon: args.max_carbon,
          max_calories: args.max_calories,
          min_calories: args.min_calories,
          max_sodium_mg: args.max_sodium_mg,
          min_sodium_mg: args.min_sodium_mg,
          nutrients: args.nutrients,
          query: args.query,
          meal: args.meal,
          station: args.station,
          sort_by: args.sort_by,
          sort_order: args.sort_order,
          halls: hallList(args.hall),
          date: args.date,
          from: args.from,
          to: args.to,
          offset: args.offset,
          limit: args.limit,
        });
        const fallback = Object.keys(args.nutrients ?? {});
        if (args.max_sodium_mg !== undefined || args.min_sodium_mg !== undefined) {
          if (!fallback.includes('sodium')) fallback.push('sodium');
        }
        const selection = selectNutrients(
          args.include_nutrients,
          fallback,
          args.max_carbon !== undefined || args.sort_by === 'carbonFootprint',
        );
        return ok(encodeResponse(result.matches, selection, {
          date: result.dateRange ? undefined : result.date,
          dateRange: result.dateRange,
          totalMatches: result.totalMatches,
          truncated: result.truncated,
          stale: result.stale,
          emptyDates: result.emptyDates ?? [],
          failures: result.failures,
          coverage: result.coverage,
        }, extraNotes(result)));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'list_nutrition_fields',
    {
      title: 'List nutrition fields',
      description:
        'List the canonical nutrient identifiers, their units, the alternative units a threshold ' +
        'may be written in, and the Daily Value basis of the published micronutrients. A ' +
        'constraint on a nutrient excludes the dishes that publish no value for it, and a value ' +
        'the site writes as "trace" or "< 1%" is missing rather than zero.',
      inputSchema: z.strictObject({}),
      outputSchema: z.object({
        fields: z.array(
          z.object({
            key: z.string(),
            label: z.string(),
            unit: z.string(),
            sortable: z.boolean(),
          }),
        ),
        acceptedUnits: z.record(z.string(), z.array(z.string())),
        sortFields: z.array(z.string()),
        micronutrients: z.array(
          z.object({
            name: z.string(),
            field: z.string(),
            publishedUnit: z.string(),
            defaultUnit: z.string(),
            dailyValue: z.number(),
            dailyValueUnit: z.string(),
            derivedUnit: z.string(),
          }),
        ),
        notes: z.array(z.string()),
      }),
      annotations: READ_ONLY_LOCAL,
    },
    () => {
      const accepted: Record<string, string[]> = {};
      for (const spec of NUTRIENT_SPECS) accepted[spec.key] = acceptedUnits(spec.key);
      for (const spec of MICRONUTRIENT_SPECS) accepted[spec.name] = acceptedUnits(spec.name);

        return ok({
          fields: NUTRIENT_SPECS.map((spec) => ({
            key: spec.key,
            label: spec.label,
            unit: spec.unit,
            sortable: spec.sortable,
          })),
          acceptedUnits: accepted,
          sortFields: [...SORT_FIELDS],
          micronutrients: MICRONUTRIENT_SPECS.map((spec) => ({
            name: spec.name,
            field: spec.field,
            publishedUnit: spec.publishedUnit,
            defaultUnit: spec.derivedUnit,
            dailyValue: spec.dailyValue,
            dailyValueUnit: spec.dailyValueUnit,
            derivedUnit: spec.derivedUnit,
          })),
          notes: [
            MICRONUTRIENT_ROUNDING_CAVEAT,
            'A constraint on a nutrient excludes the dishes that publish no value for it.',
            'A value the site writes as "trace" or "< 1%" is missing, not zero.',
            'A micronutrient is returned as the amount the panel derives from the published percent: 15 %DV of an 18 mg Daily Value of iron is 2.7 mg.',
            'A micronutrient threshold without a unit is read in that amount: {"Iron": {"min": 2}} means 2 mg of iron, while {"Iron": {"min": 2, "unit": "%DV"}} means 2 percent of the Daily Value.',
          ],
        });
    },
  );

  server.registerTool(
    'get_hours',
    {
      title: 'Get dining hall hours',
      description:
        "Get the service periods published for a dining hall on the requested day, together with the " +
        "hall's regular weekly schedule. Without a hall argument every hall is returned. A hall that " +
        "cannot be read is reported in the failures and the other halls are still returned.",
      inputSchema: z.strictObject({
        hall: hallIdSchema.optional().describe('One hall, or every hall.'),
        date: dateSchema.optional().describe('The day to read. Defaults to today.'),
      }),
      outputSchema: getHoursOutput,
      annotations: READ_ONLY_WORLD,
    },
    async (args) => {
      try {
        const { date, hours, failures } = await getHours(args.hall, args.date);
        return ok({ date, halls: hours, failures });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'find_open_now',
    {
      title: 'Find halls that are open now',
      description:
        'Return the dining halls that are serving at the given time of day, and the ones that are not, ' +
        'with the service periods of the day. Without arguments the current campus-local time is used.',
      inputSchema: z.strictObject({
        date: dateSchema.optional().describe('The day to look at. Defaults to today.'),
        at: z
          .string()
          .regex(/^\d{1,2}:\d{2}(\s*(am|pm))?$/i, 'Times use the HH:MM format, e.g. "12:30" or "7:05 pm".')
          .optional()
          .describe('The campus-local time of day to look at. Defaults to the current time.'),
      }),
      outputSchema: findOpenNowOutput,
      annotations: READ_ONLY_WORLD,
    },
    async (args) => {
      try {
        const { date, at, open, closed, failures } = await findOpenNow(args.date, args.at);
        return ok({ date, at, open, closed, failures });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'get_item_nutrition',
    {
      title: 'Get a dish nutrition panel',
      description:
        "Get the full nutrition panel of one dish, including the serving size, calories, the fat, " +
        "cholesterol, sodium, carbohydrate and protein values and the micronutrients. The dish name " +
        'is matched case-insensitively; an exact match wins, otherwise a unique substring match is ' +
        'used and an ambiguous name is reported rather than guessed. ' +
        ALLERGEN_CAVEAT,
      inputSchema: z.strictObject({
        hall: hallIdSchema.describe('The dining hall to read.'),
        item: z.string().min(1).describe('The dish name.'),
        date: dateSchema.optional(),
        meal: mealNameSchema.optional().describe('Narrow the search to one meal.'),
        station: z.string().optional().describe('Narrow the search to one station.'),
      }),
      outputSchema: itemNutritionOutput,
      annotations: READ_ONLY_WORLD,
    },
    async (args) => {
      try {
        const result = await getItemNutrition(args.hall, args.item, args.date, args.meal, args.station);
        return ok(result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerResource(
    'dining-halls',
    'umich://dining-halls',
    {
      title: 'Dining hall registry',
      description: 'The ten supported University of Michigan dining halls, with their code.',
      mimeType: 'application/json',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            HALLS.map((hall, index) => ({
              code: index + 1,
              id: hall.id,
              name: hall.name,
              path: hall.path,
              url: hall.url,
              residentsOnly: hall.residentsOnly,
              glutenFreePantry: hall.glutenFreePantry,
            })),
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    'taxonomy',
    'umich://taxonomy',
    {
      title: 'Allergen and trait taxonomy',
      description:
        'The allergen, trait and station vocabularies of the dining site with their codes, the trait ' +
        'implication closure and the caveat that applies to all allergen data.',
      mimeType: 'application/json',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              allergens: ALLERGEN_SLUGS.map((slug, index) => ({
                code: index + 1,
                slug,
                label: ALLERGENS[slug],
              })),
              traits: TRAIT_SLUGS.map((slug) => ({
                code: TRAIT_CODES[slug] ?? null,
                slug,
                label: TRAITS[slug],
                boolean: BOOLEAN_TRAIT_SLUGS.includes(slug),
              })),
              booleanTraits: BOOLEAN_TRAIT_SLUGS,
              mhealthyTiers: MHEALTHY_TIERS.map((slug, index) => ({
                code: index + 1,
                slug,
                label: TRAITS[slug],
              })),
              carbonTiers: CARBON_TIERS.map((slug, index) => ({
                code: index + 1,
                slug,
                label: TRAITS[slug],
              })),
              stations: STATION_NAMES.map((name, index) => ({ code: index + 1, name })),
              sortFields: [...SORT_FIELDS],
              implications: TRAIT_IMPLICATIONS,
              caveat: ALLERGEN_CAVEAT,
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  return server;
}
