import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { cache } from '../src/cache.js';
import { createServer } from '../src/server.js';
import { HALL_FIXTURES, fixtureResponse, mockFixtureFetch } from './helpers.js';

/**
 * The contract of the server: the tools it offers, the values it accepts,
 * the shape of what it returns and the way it reports a failure.
 *
 * The checks are made against the contract of the MCP protocol and the data
 * of the site, not against the internals of the implementation.
 */

interface ToolResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
}

const TOOL_NAMES = [
  'list_locations',
  'get_menu',
  'filter_dishes',
  'get_hours',
  'find_open_now',
  'get_item_nutrition',
  'list_nutrition_fields',
];

describe('the contract of the server', () => {
  let client: Client;

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);
    client = new Client({ name: 'umich-dining-mcp-contract', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  beforeEach(() => {
    vi.unstubAllGlobals();
    mockFixtureFetch();
  });

  /**
   * Read the ten pages once and keep them in the cache, so that the tests
   * below do not read and parse the same pages over and over.
   */
  async function warmUp(): Promise<void> {
    cache.clear();
    mockFixtureFetch();
    await client.callTool({ name: 'list_locations', arguments: {} });
  }

  it('offers the eight tools and the two resources', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());

    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri).sort()).toEqual([
      'umich://dining-halls',
      'umich://taxonomy',
    ]);
  });

  it('describes every tool and marks it as read only', async () => {
    const tools = await client.listTools();
    for (const tool of tools.tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.inputSchema, tool.name).toBeTruthy();
      expect(tool.outputSchema, tool.name).toBeTruthy();
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      // The annotations are declared, not left to the defaults.
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      expect(tool.annotations?.idempotentHint, tool.name).toBe(true);
    }
    // The one tool that reads a table of this server, not the world.
    const nutrition = tools.tools.find((tool) => tool.name === 'list_nutrition_fields');
    expect(nutrition?.annotations?.openWorldHint).toBe(false);
    for (const tool of tools.tools.filter((entry) => entry.name !== 'list_nutrition_fields')) {
      expect(tool.annotations?.openWorldHint, tool.name).toBe(true);
    }
  });

  it('answers a call with the payload in the text and in the structured content', async () => {
    const result = (await client.callTool({ name: 'get_menu', arguments: { hall: 'bursley' } })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeDefined();
    const text = result.content?.[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual(result.structuredContent);
  });

  it('reports the dishes of the hall it was asked for', async () => {
    const result = (await client.callTool({ name: 'get_menu', arguments: { hall: 'bursley', meal: 'Lunch' } })) as ToolResult;
    const payload = result.structuredContent as { totalItems: number; totalStations: number; key: { meals: Record<string, string> }; meals: { meal: number }[] };
    expect(payload.totalItems).toBe(26);
    expect(payload.totalStations).toBeGreaterThan(0);
    expect(payload.meals).toHaveLength(1);
    expect(payload.key.meals[String(payload.meals[0]!.meal)]).toBe('Lunch');
  });

  it('returns only the meal it was asked for', async () => {
    const result = (await client.callTool({
      name: 'get_menu',
      arguments: { hall: 'bursley', meal: 'Breakfast' },
    })) as ToolResult;
    const payload = result.structuredContent as {
      key: { meals: Record<string, string> };
      meals: { meal: number; stations: { station: number; items: unknown[] }[] }[];
      totalItems: number;
    };
    expect(payload.meals).toHaveLength(1);
    expect(payload.key.meals[String(payload.meals[0]!.meal)]).toBe('Breakfast');
    const breakfast = payload.meals[0]!.stations;
    expect(breakfast.length).toBeGreaterThan(0);
    expect(payload.totalItems).toBe(
      breakfast.reduce((sum, station) => sum + station.items.length, 0),
    );
  });

  it('rejects a hall the site does not have', async () => {
    for (const hall of ['refectory', 'Bursley', 'bursley ', 'north quad']) {
      const result = (await client.callTool({ name: 'get_menu', arguments: { hall } })) as ToolResult;
      expect(result.isError, hall).toBe(true);
      expect(result.structuredContent, hall).toBeUndefined();
      expect(result.content?.[0]?.text, hall).toBeTruthy();
    }
  });

  it('rejects a date that is not a date', async () => {
    for (const date of ['20-10-2026', '2026-13-01', 'yesterday', '2026-1-1']) {
      const result = (await client.callTool({
        name: 'get_menu',
        arguments: { hall: 'bursley', date },
      })) as ToolResult;
      expect(result.isError, date).toBe(true);
    }
  });

  it('rejects a date the site does not publish', async () => {
    const result = (await client.callTool({
      name: 'get_menu',
      arguments: { hall: 'bursley', date: '2019-01-01' },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/range/i);
  });

  it('rejects an empty query', async () => {
    const result = (await client.callTool({ name: 'filter_dishes', arguments: { query: '' } })) as ToolResult;
    expect(result.isError).toBe(true);
  });

  it('rejects a limit outside the range the server allows', async () => {
    for (const limit of [0, -1, 501]) {
      const result = (await client.callTool({
        name: 'filter_dishes',
        arguments: { query: 'oatmeal', limit },
      })) as ToolResult;
      expect(result.isError, String(limit)).toBe(true);
    }
  });

  it('rejects an allergen and a trait the site does not know', async () => {
    const allergen = (await client.callTool({
      name: 'filter_dishes',
      arguments: { exclude_allergens: ['unicorn'] },
    })) as ToolResult;
    expect(allergen.isError).toBe(true);

    const trait = (await client.callTool({
      name: 'filter_dishes',
      arguments: { require_traits: ['gluten-free'] },
    })) as ToolResult;
    expect(trait.isError).toBe(true);
  });

  it('rejects a nutrient density and a carbon footprint outside the range', async () => {
    for (const min_mhealthy of [0, 6]) {
      const result = (await client.callTool({
        name: 'filter_dishes',
        arguments: { min_mhealthy },
      })) as ToolResult;
      expect(result.isError, String(min_mhealthy)).toBe(true);
    }

    const carbon = (await client.callTool({
      name: 'filter_dishes',
      arguments: { max_carbon: 'extreme' },
    })) as ToolResult;
    expect(carbon.isError).toBe(true);
  });

  it('rejects an empty dish name', async () => {
    const result = (await client.callTool({
      name: 'get_item_nutrition',
      arguments: { hall: 'bursley', item: '' },
    })) as ToolResult;
    expect(result.isError).toBe(true);
  });

  it('reports a site that is down as a failure of the tool', async () => {
    cache.clear();
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', async (): Promise<Response> => new Response('down', { status: 503 }));
    const result = (await client.callTool({ name: 'get_menu', arguments: { hall: 'bursley' } })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/503|failed/i);
    await warmUp();
  });

  it('reports the halls it could not read and keeps the others', async () => {
    cache.clear();
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('markley')) return new Response('down', { status: 503 });
      const response = fixtureResponse(url);
      return response ?? new Response('not found', { status: 404 });
    });

    const result = (await client.callTool({ name: 'list_locations', arguments: {} })) as ToolResult;
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as {
      locations: { id: string }[];
      failures: { hall: string }[];
    };
    expect(payload.locations).toHaveLength(9);
    expect(payload.failures).toHaveLength(1);
    expect(payload.failures[0]?.hall).toBe('markley');
    await warmUp();
  });

  it('lists the ten halls with their address and their map link', async () => {
    const result = (await client.callTool({ name: 'list_locations', arguments: {} })) as ToolResult;
    const payload = result.structuredContent as {
      locations: { id: string; url: string; address: string | null }[];
    };
    expect(payload.locations).toHaveLength(10);
    for (const location of payload.locations) {
      expect(location.url, location.id).toMatch(/^https:\/\/dining\.umich\.edu\/menus-locations\//);
    }
    const bursley = payload.locations.find((location) => location.id === 'bursley');
    expect(bursley?.address).toBe('1931 Duffield Street, Ann Arbor, MI, 48109');
  });

  it('reports the hours of every hall', async () => {
    const result = (await client.callTool({ name: 'get_hours', arguments: {} })) as ToolResult;
    const payload = result.structuredContent as {
      date: string;
      halls: { hall: string; today: unknown[]; regular: { weekly: unknown[] } | null }[];
    };
    expect(payload.halls).toHaveLength(10);
    expect(payload.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const hall of payload.halls) {
      expect(hall.today.length, hall.hall).toBeGreaterThan(0);
      expect(hall.regular?.weekly.length, hall.hall).toBeGreaterThan(0);
    }
  });

  it('puts every hall into the open or the closed list', async () => {
    const result = (await client.callTool({ name: 'find_open_now', arguments: {} })) as ToolResult;
    const payload = result.structuredContent as { open: unknown[]; closed: unknown[] };
    expect(payload.open.length + payload.closed.length).toBe(10);
  });

  it('searches and filters the dishes of the site', async () => {
    const search = (await client.callTool({
      name: 'filter_dishes',
      arguments: { query: 'oatmeal' },
    })) as ToolResult;
    const searchPayload = search.structuredContent as {
      totalMatches: number;
      fields: string[];
      key: { halls: Record<string, string>; meals: Record<string, string>; traits: Record<string, string> };
      note?: string;
      matches: unknown[][];
    };
    const name = searchPayload.fields.indexOf('name');
    const hall = searchPayload.fields.indexOf('hall');
    expect(searchPayload.totalMatches).toBeGreaterThan(0);
    for (const match of searchPayload.matches) {
      expect(String(match[name]).toLowerCase()).toContain('oatmeal');
      expect(Object.keys(searchPayload.key.halls)).toContain(String(match[hall]));
    }
    expect(searchPayload.note).toMatch(/allergen/i);

    const filter = (await client.callTool({
      name: 'filter_dishes',
      arguments: { exclude_allergens: ['milk'], require_traits: ['vegetarian'] },
    })) as ToolResult;
    const filterPayload = filter.structuredContent as {
      totalMatches: number;
      fields: string[];
      key: { allergens: Record<string, string>; traits: Record<string, string> };
      matches: unknown[][];
    };
    const milk = Object.entries(filterPayload.key.allergens).find(([, slug]) => slug === 'milk')?.[0];
    const vegetarian = Object.entries(filterPayload.key.traits).find(([, slug]) => slug === 'vegetarian')?.[0];
    const allergens = filterPayload.fields.indexOf('allergens');
    const traits = filterPayload.fields.indexOf('traits');
    for (const match of filterPayload.matches) {
      if (milk) expect((match[allergens] as number[]).map(String)).not.toContain(milk);
      if (vegetarian) expect((match[traits] as number[]).map(String)).toContain(vegetarian);
    }
  });

  it('returns the panel of a dish with its meal and its station', async () => {
    const result = (await client.callTool({
      name: 'get_item_nutrition',
      arguments: { hall: 'bursley', item: 'Oatmeal' },
    })) as ToolResult;
    const payload = result.structuredContent as {
      name: string;
      nutrition: { calories: number | null; servingSize: string | null };
      warning: string;
      key: { meals: Record<string, string>; stations: Record<string, string> };
    };
    expect(payload.name).toBe('Oatmeal');
    expect(payload.nutrition.calories).toBe(183);
    expect(payload.nutrition.servingSize).toBe('Cups (253g)');
    expect(payload.key.meals[String(payload.meal)]).toBe('Breakfast');
    expect(payload.key.stations[String(payload.station)]).toBe('Hot Cereal');
    expect(payload.warning).toMatch(/allergen/i);
  });

  it('returns the coded rows with a key that lists only what is used', async () => {
    const result = (await client.callTool({
      name: 'filter_dishes',
      arguments: { query: 'oatmeal', hall: 'bursley' },
    })) as ToolResult;
    const payload = result.structuredContent as {
      key: Record<string, Record<string, string>>;
      units: Record<string, string>;
      fields: string[];
      date: string;
      matches: unknown[][];
    };

    const at = (row: unknown[], field: string): unknown => row[payload.fields.indexOf(field)];
    const hall = payload.fields.indexOf('hall');
    const meal = payload.fields.indexOf('meal');
    const station = payload.fields.indexOf('station');
    const traits = payload.fields.indexOf('traits');
    const allergens = payload.fields.indexOf('allergens');

    expect(payload.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(payload.matches.length).toBeGreaterThan(0);
    for (const row of payload.matches) {
      expect(row).toHaveLength(payload.fields.length);
      expect(row[hall]).toBe(1);
      expect(row[meal]).toBeGreaterThanOrEqual(1);
      expect(row[meal]).toBeLessThanOrEqual(4);
      expect(row[station]).toBeGreaterThan(0);
      const density = at(row, 'mhealthyTier') as number | null;
      expect(density === null || (density >= 1 && density <= 5)).toBe(true);
      const grams = at(row, 'servingSizeGrams') as number | null;
      expect(grams === null || grams > 0).toBe(true);
      // The codes resolve through the key.
      expect(payload.key.halls?.[String(row[hall])]).toBe('bursley');
      expect(payload.key.meals?.[String(row[meal])]).toBeTruthy();
      expect(payload.key.stations?.[String(row[station])]).toBeTruthy();
    }
    // The key lists only the vocabularies the rows use.
    for (const row of payload.matches) {
      for (const trait of row[traits] as number[]) {
        expect(payload.key.traits?.[String(trait)]).toBeTruthy();
      }
      for (const allergen of row[allergens] as number[]) {
        expect(payload.key.allergens?.[String(allergen)]).toBeTruthy();
      }
    }
    expect(payload.units.calories).toBe('kcal');
    // The sodium is not in the default row: it is asked for like any other.
    expect(payload.units.sodium).toBeUndefined();
    for (const row of payload.matches) {
      expect(row).not.toHaveProperty('sodium');
    }
  });

  it('returns the nutrients it was asked for and their units', async () => {
    const result = (await client.callTool({
      name: 'filter_dishes',
      arguments: { hall: 'bursley', include_nutrients: ['protein', 'Iron'] },
    })) as ToolResult;
    const payload = result.structuredContent as {
      units: Record<string, string>;
      fields: string[];
      matches: unknown[][];
    };
    expect(payload.units.protein).toBe('g');
    expect(payload.units.iron).toBe('mg');
    expect(payload.fields).toContain('protein');
    expect(payload.fields).toContain('iron');
    expect(payload.matches.length).toBeGreaterThan(0);
    for (const row of payload.matches) {
      expect(row).toHaveLength(payload.fields.length);
    }
  });

  it('returns the nutrients the filter used when none are asked for', async () => {
    const result = (await client.callTool({
      name: 'filter_dishes',
      arguments: { hall: 'bursley', nutrients: { protein: { min: 1 } } },
    })) as ToolResult;
    const payload = result.structuredContent as {
      units: Record<string, string>;
      fields: string[];
      matches: unknown[][];
    };
    expect(payload.units.protein).toBe('g');
    expect(payload.fields).toContain('protein');
    expect(payload.matches.length).toBeGreaterThan(0);
    for (const row of payload.matches) {
      expect(row).toHaveLength(payload.fields.length);
    }
  });

  it('returns the micronutrient the filter used when none are asked for', async () => {
    const result = (await client.callTool({
      name: 'filter_dishes',
      arguments: { hall: 'bursley', nutrients: { Iron: { min: 1, unit: 'mg' } } },
    })) as ToolResult;
    const payload = result.structuredContent as {
      units: Record<string, string>;
      fields: string[];
      matches: unknown[][];
    };
    expect(payload.units.iron).toBe('mg');
    expect(payload.fields).toContain('iron');
    expect(payload.matches.length).toBeGreaterThan(0);
    for (const row of payload.matches) {
      expect(row).toHaveLength(payload.fields.length);
    }
  });

  it('returns nothing beyond the calories and the sodium without a filter', async () => {
    const result = (await client.callTool({
      name: 'filter_dishes',
      arguments: { hall: 'bursley' },
    })) as ToolResult;
    const payload = result.structuredContent as {
      units: Record<string, string>;
      fields: string[];
      matches: unknown[][];
    };
    expect(Object.keys(payload.units).sort()).toEqual(['calories']);
    expect(payload.fields).not.toContain('protein');
    expect(payload.fields).not.toContain('iron');
    expect(payload.matches.length).toBeGreaterThan(0);
  });

  it('rejects a nutrient it does not know and names the tool that lists them', async () => {
    const result = (await client.callTool({
      name: 'filter_dishes',
      arguments: { hall: 'bursley', include_nutrients: ['vitaminZ'] },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/list_nutrition_fields/);
  });

  it('rejects a threshold in a unit the nutrient cannot be expressed in', async () => {
    const result = (await client.callTool({
      name: 'filter_dishes',
      arguments: { hall: 'bursley', nutrients: { protein: { min: 1, unit: 'kg' } } },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/protein/);
  });

  it('reports the halls it could not read and keeps the others', async () => {
    const result = (await client.callTool({
      name: 'filter_dishes',
      arguments: { hall: 'bursley' },
    })) as ToolResult;
    const payload = result.structuredContent as { failures: unknown[]; matches: unknown[] };
    expect(Array.isArray(payload.failures)).toBe(true);
    expect(Array.isArray(payload.matches)).toBe(true);
  });

  it('finds the halls that are open at a given time of day', async () => {
    const result = (await client.callTool({
      name: 'find_open_now',
      arguments: { at: '12:00' },
    })) as ToolResult;
    const payload = result.structuredContent as { date: string; at: string; open: unknown[]; closed: unknown[] };
    expect(payload.at).toBe('12:00 pm');
    expect(payload.open.length + payload.closed.length).toBe(10);
  });

  it('refuses a time of day it cannot read', async () => {
    const result = (await client.callTool({
      name: 'find_open_now',
      arguments: { at: 'half past twelve' },
    })) as ToolResult;
    expect(result.isError).toBe(true);
  });
});

describe('the resources of the server', () => {
  let client: Client;

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);
    client = new Client({ name: 'umich-dining-mcp-resources', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  it('lists the ten halls with the path of their page and their code', async () => {
    const resource = await client.readResource({ uri: 'umich://dining-halls' });
    const first = resource.contents[0] as { text?: string; mimeType?: string };
    expect(first.mimeType).toBe('application/json');
    const registry = JSON.parse(first.text ?? '[]') as {
      code: number;
      id: string;
      name: string;
      path: string;
      url: string;
    }[];
    expect(registry).toHaveLength(10);
    expect(registry.map((hall) => hall.id).sort()).toEqual([...Object.keys(HALL_FIXTURES)].sort());
    for (const hall of registry) {
      expect(hall.path, hall.id).toMatch(/^dining-halls\//);
      expect(hall.url, hall.id).toBe(`https://dining.umich.edu/menus-locations/${hall.path}/`);
    }
    expect(registry.map((hall) => hall.code)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('lists the allergens and the traits of the site with their codes', async () => {
    const resource = await client.readResource({ uri: 'umich://taxonomy' });
    const first = resource.contents[0] as { text?: string };
    const taxonomy = JSON.parse(first.text ?? '{}') as {
      allergens: { code: number; slug: string; label: string }[];
      traits: { code: number | null; slug: string; label: string; boolean: boolean }[];
      booleanTraits: string[];
      mhealthyTiers: { code: number; slug: string; label: string }[];
      carbonTiers: { code: number; slug: string; label: string }[];
      implications: Record<string, string[]>;
      caveat: string;
    };
    expect(taxonomy.allergens).toHaveLength(15);
    expect(taxonomy.traits).toHaveLength(14);
    expect(taxonomy.booleanTraits).toEqual([
      'glutenfree',
      'halal',
      'kosher',
      'spicy',
      'vegan',
      'vegetarian',
    ]);
    expect(taxonomy.mhealthyTiers).toHaveLength(5);
    expect(taxonomy.carbonTiers).toHaveLength(3);
    expect(taxonomy.implications).toEqual({ vegan: ['vegetarian'] });
    expect(taxonomy.caveat).toMatch(/allergen/i);

    // The codes are frozen: the allergens are 1..15 in the order of the list.
    expect(taxonomy.allergens.map((allergen) => allergen.code)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    // The six boolean traits are 1..6; the tiers have no trait code.
    const booleanCodes = taxonomy.traits
      .filter((trait) => trait.boolean)
      .map((trait) => trait.code);
    expect(booleanCodes).toEqual([1, 2, 3, 4, 5, 6]);
    for (const trait of taxonomy.traits.filter((entry) => !entry.boolean)) {
      expect(trait.code, trait.slug).toBeNull();
    }
    // The tiers carry their own fixed scale.
    expect(taxonomy.mhealthyTiers.map((tier) => tier.code)).toEqual([1, 2, 3, 4, 5]);
    expect(taxonomy.carbonTiers.map((tier) => tier.code)).toEqual([1, 2, 3]);
  });
});
