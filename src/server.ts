import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { HALLS } from './halls.js';
import {
  ALLERGENS,
  ALLERGEN_CAVEAT,
  ALLERGEN_SLUGS,
  BOOLEAN_TRAIT_SLUGS,
  CARBON_TIERS,
  MHEALTHY_TIERS,
  TRAITS,
  TRAIT_IMPLICATIONS,
  TRAIT_SLUGS,
} from './taxonomy.js';
import {
  filterDishes,
  findOpenNow,
  getHours,
  getItemNutrition,
  getMenu,
  listLocations,
  searchDishes,
  todayIn,
} from './service.js';
import { HALL_IDS, MEAL_NAMES, type MealName } from './types.js';

const SERVER_NAME = 'umich-dining-mcp';
const SERVER_VERSION = '0.1.0';

const hallIdSchema = z.enum(HALL_IDS);
const mealNameSchema = z.enum(MEAL_NAMES);
const allergenSchema = z.enum(ALLERGEN_SLUGS as [string, ...string[]]);
const traitSchema = z.enum(TRAIT_SLUGS as [string, ...string[]]);
const carbonSchema = z.enum(['low', 'medium', 'high']);

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

const menuItemSchema = z.object({
  name: z.string(),
  traits: z.array(z.string()),
  traitLabels: z.record(z.string(), z.string()),
  allergens: z.array(z.string()),
  mhealthyTier: z.number().nullable(),
  carbonFootprint: carbonSchema.nullable(),
  nutrition: nutritionSchema.nullable(),
});

const stationSchema = z.object({
  name: z.string(),
  items: z.array(menuItemSchema),
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

const dishMatchSchema = z.object({
  hall: hallIdSchema,
  hallName: z.string(),
  date: z.string(),
  meal: mealNameSchema,
  station: z.string(),
  name: z.string(),
  traits: z.array(z.string()),
  traitLabels: z.record(z.string(), z.string()),
  allergens: z.array(z.string()),
  mhealthyTier: z.number().nullable(),
  carbonFootprint: carbonSchema.nullable(),
  calories: z.number().nullable(),
  sodiumMg: z.number().nullable(),
});

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

const getMenuOutput = z.object({
  hall: hallIdSchema,
  hallName: z.string(),
  date: z.string(),
  mealLabels: z.record(z.string(), z.string()),
  meals: z.object({
    Breakfast: z.array(stationSchema),
    Lunch: z.array(stationSchema),
    Dinner: z.array(stationSchema),
  }),
  renderedDate: z.string().nullable(),
  totalStations: z.number(),
  totalItems: z.number(),
  stale: z.boolean(),
});

const searchDishesOutput = z.object({
  query: z.string(),
  date: z.string(),
  totalMatches: z.number(),
  matches: z.array(dishMatchSchema),
  failures: z.array(failureSchema),
  warning: z.string(),
});

const filterDishesOutput = z.object({
  date: z.string(),
  totalMatches: z.number(),
  matches: z.array(dishMatchSchema),
  failures: z.array(failureSchema),
  warning: z.string(),
});

const getHoursOutput = z.object({
  date: z.string(),
  halls: z.array(hallHoursSchema),
});

const findOpenNowOutput = z.object({
  date: z.string(),
  open: z.array(locationSchema),
  closed: z.array(locationSchema),
  failures: z.array(failureSchema),
});

const itemNutritionOutput = z.object({
  hall: hallIdSchema,
  hallName: z.string(),
  date: z.string(),
  meal: mealNameSchema,
  station: z.string(),
  name: z.string(),
  traits: z.array(z.string()),
  traitLabels: z.record(z.string(), z.string()),
  allergens: z.array(z.string()),
  mhealthyTier: z.number().nullable(),
  carbonFootprint: carbonSchema.nullable(),
  nutrition: nutritionSchema,
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
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function fail(error: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
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
      inputSchema: z.object({
        date: dateSchema.optional(),
      }),
      outputSchema: listLocationsOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { date, locations, failures } = await listLocations(args.date);
        return ok({ date, locations, failures, warning: ALLERGEN_CAVEAT });
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
        '(Vegan, Halal, Gluten Free, Nutrient Dense tier, Carbon Footprint tier), allergens and ' +
        'nutrition panel. The date defaults to today; the site publishes menus for today-3 days to ' +
        'today+14 days.',
      inputSchema: z.object({
        hall: hallIdSchema.describe('The dining hall to read.'),
        date: dateSchema.optional(),
        meal: mealNameSchema.optional(),
      }),
      outputSchema: getMenuOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const page = await getMenu(args.hall, args.date);
        const meals = { ...page.menu.meals } as Record<MealName, z.infer<typeof stationSchema>[]>;
        if (args.meal) {
          for (const meal of MEAL_NAMES) {
            if (meal !== args.meal) meals[meal] = [];
          }
        }
        const totalStations = Object.values(meals).reduce((sum, stations) => sum + stations.length, 0);
        const totalItems = Object.values(meals).reduce(
          (sum, stations) => sum + stations.reduce((inner, station) => inner + station.items.length, 0),
          0,
        );
        return ok({
          hall: page.hall.id,
          hallName: page.hall.name,
          date: page.date,
          mealLabels: page.menu.mealLabels,
          meals,
          renderedDate: page.renderedDate,
          totalStations,
          totalItems,
          stale: page.stale,
        });
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
        'Search dish names across the dining halls, or within one hall. The match is a ' +
        'case-insensitive substring match on the dish name.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Text to look for in the dish names.'),
        hall: hallIdSchema.optional().describe('Restrict the search to one hall.'),
        date: dateSchema.optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      outputSchema: searchDishesOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await searchDishes(args.query, {
          hall: args.hall,
          date: args.date,
          limit: args.limit,
        });
        return ok(result);
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
        'calories. exclude_allergens removes dishes that carry any of the listed allergens; ' +
        'require_traits keeps only dishes that carry every listed trait; min_mhealthy is the lowest ' +
        'acceptable nutrient-density tier (3 = Nutrient Dense Medium or better); max_carbon is the ' +
        'highest acceptable carbon footprint; max_calories and max_sodium_mg are numeric caps that ' +
        'exclude dishes without published values. ' +
        ALLERGEN_CAVEAT,
      inputSchema: z.object({
        exclude_allergens: z.array(allergenSchema).optional(),
        require_traits: z.array(traitSchema).optional(),
        min_mhealthy: z.number().int().min(1).max(5).optional(),
        max_carbon: carbonSchema.optional(),
        max_calories: z.number().nonnegative().optional(),
        max_sodium_mg: z.number().nonnegative().optional(),
        hall: hallIdSchema.optional(),
        date: dateSchema.optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      outputSchema: filterDishesOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await filterDishes({
          exclude_allergens: args.exclude_allergens,
          require_traits: args.require_traits,
          min_mhealthy: args.min_mhealthy,
          max_carbon: args.max_carbon,
          max_calories: args.max_calories,
          max_sodium_mg: args.max_sodium_mg,
          hall: args.hall,
          date: args.date,
          limit: args.limit,
        });
        return ok(result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'get_hours',
    {
      title: 'Get dining hall hours',
      description:
        "Get the service periods published for a dining hall on the requested day, together with the " +
        "hall's regular weekly schedule. Without a hall argument every hall is returned.",
      inputSchema: z.object({
        hall: hallIdSchema.optional(),
        date: dateSchema.optional(),
      }),
      outputSchema: getHoursOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const halls = await getHours(args.hall, args.date);
        return ok({ date: halls[0]?.date ?? todayIn(), halls });
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
        'Return the dining halls that are serving at the current time, and the ones that are not, ' +
        'with the service periods of today.',
      inputSchema: z.object({}),
      outputSchema: findOpenNowOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const { date, open, closed, failures } = await findOpenNow();
        return ok({ date, open, closed, failures });
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
        'used and an ambiguous name is reported rather than guessed.',
      inputSchema: z.object({
        hall: hallIdSchema.describe('The dining hall to read.'),
        item: z.string().min(1).describe('The dish name.'),
        date: dateSchema.optional(),
      }),
      outputSchema: itemNutritionOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await getItemNutrition(args.hall, args.item, args.date);
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
      description: 'The ten supported University of Michigan dining halls.',
      mimeType: 'application/json',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            HALLS.map((hall) => ({
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
        'The allergen and trait vocabularies of the dining site, the trait implication closure and the ' +
        'caveat that applies to all allergen data.',
      mimeType: 'application/json',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              allergens: ALLERGENS,
              traits: TRAITS,
              booleanTraits: BOOLEAN_TRAIT_SLUGS,
              mhealthyTiers: MHEALTHY_TIERS,
              carbonTiers: CARBON_TIERS,
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
