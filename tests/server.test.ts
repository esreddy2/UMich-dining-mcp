import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { cache } from '../src/cache.js';
import { createServer } from '../src/server.js';
import { mockFixtureFetch, readFixture, withDeclaredDate } from './helpers.js';

function resourceText(result: { contents: unknown[] }): string {
  const first = result.contents[0] as { text?: string } | undefined;
  if (!first || typeof first.text !== 'string') throw new Error('the resource has no text content');
  return first.text;
}

const TOOL_NAMES = [
  'list_locations',
  'get_menu',
  'search_dishes',
  'filter_dishes',
  'get_hours',
  'find_open_now',
  'get_item_nutrition',
  'list_nutrition_fields',
];

describe('server', () => {
  let client: Client;

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);
    client = new Client({ name: 'umich-dining-mcp-test', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  beforeEach(() => {
    cache.clear();
    vi.unstubAllGlobals();
  });

  it('registers exactly eight tools and two resources', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());

    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri).sort()).toEqual([
      'umich://dining-halls',
      'umich://taxonomy',
    ]);
  });

  it('gives every tool a description and a schema', async () => {
    const tools = await client.listTools();
    for (const tool of tools.tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema, tool.name).toBeTruthy();
      expect(tool.outputSchema, tool.name).toBeTruthy();
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
    }
  });

  it('reads both resources', async () => {
    const halls = await client.readResource({ uri: 'umich://dining-halls' });
    const registry = JSON.parse(resourceText(halls)) as { id: string }[];
    expect(registry).toHaveLength(10);
    expect(registry.map((hall) => hall.id)).toContain('bursley');

    const taxonomy = await client.readResource({ uri: 'umich://taxonomy' });
    const parsed = JSON.parse(resourceText(taxonomy)) as {
      allergens: Record<string, string>;
      traits: Record<string, string>;
      implications: Record<string, string[]>;
      caveat: string;
    };
    expect(Object.keys(parsed.allergens)).toHaveLength(15);
    expect(Object.keys(parsed.traits)).toHaveLength(14);
    expect(parsed.implications['vegan']).toEqual(['vegetarian']);
    expect(parsed.caveat).toMatch(/allergen/i);
  });

  it('calls list_locations and validates the structured content', async () => {
    mockFixtureFetch();
    const result = await client.callTool({ name: 'list_locations', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeDefined();
    const payload = result.structuredContent as { locations: { id: string }[]; failures: unknown[] };
    expect(payload.locations).toHaveLength(10);
    expect(payload.failures).toEqual([]);
  });

  it('calls get_menu and serves the meal it was asked for', async () => {
    mockFixtureFetch();
    const result = await client.callTool({ name: 'get_menu', arguments: { hall: 'bursley', meal: 'Lunch' } });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as {
      hall: string;
      totalStations: number;
      totalItems: number;
      key: { meals: Record<string, string> };
      meals: { meal: number; stations: { station: number; items: unknown[] }[] }[];
      otherMeals: unknown[];
      unknownMealLabels: string[];
      noMenu: boolean;
    };
    expect(payload.hall).toBe('bursley');
    expect(payload.meals).toHaveLength(1);
    expect(payload.key.meals[String(payload.meals[0]!.meal)]).toBe('Lunch');
    const lunch = payload.meals[0]!.stations;
    expect(lunch.length).toBeGreaterThan(0);
    expect(payload.totalItems).toBe(26);
    expect(payload.totalStations).toBe(lunch.length);
    expect(payload.otherMeals).toEqual([]);
    expect(payload.unknownMealLabels).toEqual([]);
    expect(payload.noMenu).toBe(false);
  });

  it('calls get_menu and serves several meals at once', async () => {
    mockFixtureFetch();
    const result = await client.callTool({
      name: 'get_menu',
      arguments: { hall: 'bursley', meal: ['Breakfast', 'Dinner'] },
    });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as {
      totalStations: number;
      totalItems: number;
      key: { meals: Record<string, string> };
      meals: { meal: number; stations: { station: number; items: unknown[] }[] }[];
    };
    expect(payload.meals).toHaveLength(2);
    const names = payload.meals.map((meal) => payload.key.meals[String(meal.meal)]);
    expect(names).toEqual(['Breakfast', 'Dinner']);
    const items = payload.meals.reduce(
      (sum, meal) => sum + meal.stations.reduce((inner, station) => inner + station.items.length, 0),
      0,
    );
    expect(items).toBe(13 + 30);
    expect(payload.totalItems).toBe(items);
    expect(payload.totalStations).toBe(
      payload.meals.reduce((sum, meal) => sum + meal.stations.length, 0),
    );
  });

  it('narrows to a known meal on a dated page', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('regularhours')) {
        return new Response(readFixture('regularhours.html'), { status: 200 });
      }
      const body = readFixture('brunch-only.html');
      return new Response(withDeclaredDate(body, '2026-10-25'), { status: 200 });
    });
    const result = await client.callTool({ name: 'get_menu', arguments: { hall: 'bursley', meal: 'Brunch', date: '2026-10-25' } });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as {
      meals: { meal: number; stations: { items: unknown[] }[] }[];
      totalItems: number;
      key: { meals: Record<string, string> };
    };
    expect(payload.meals).toHaveLength(1);
    expect(payload.key.meals[String(payload.meals[0]!.meal)]).toBe('Brunch');
    expect(payload.totalItems).toBe(2);
  });

  it('filters the asked meal down to one station', async () => {
    mockFixtureFetch();
    const result = await client.callTool({
      name: 'get_menu',
      arguments: { hall: 'bursley', meal: 'Lunch', station: 'Deli' },
    });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as {
      key: { meals: Record<string, string>; stations: Record<string, string> };
      meals: { meal: number; stations: { station: number; items: unknown[] }[] }[];
      totalItems: number;
    };
    expect(payload.meals).toHaveLength(1);
    expect(payload.key.meals[String(payload.meals[0]!.meal)]).toBe('Lunch');
    const stations = payload.meals[0]!.stations;
    expect(stations).toHaveLength(1);
    expect(payload.key.stations[String(stations[0]!.station)]).toBe('Deli');
    expect(stations[0]!.items.length).toBeGreaterThan(0);
    expect(payload.totalItems).toBe(stations[0]!.items.length);
  });

  it('rejects a hall the model made up', async () => {
    mockFixtureFetch();
    const result = await client.callTool({ name: 'get_menu', arguments: { hall: 'refectory' } });
    expect(result.isError).toBe(true);
  });

  it('reports an upstream failure as a tool error', async () => {
    vi.stubGlobal('fetch', async (): Promise<Response> => new Response('down', { status: 503 }));
    const result = await client.callTool({ name: 'get_menu', arguments: { hall: 'bursley' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/503|failed/i);
  });

  it('calls search_dishes and filter_dishes', async () => {
    mockFixtureFetch();
    const search = await client.callTool({ name: 'search_dishes', arguments: { query: 'oatmeal' } });
    expect(search.isError).toBeFalsy();
    const searchPayload = search.structuredContent as {
      totalMatches: number;
      fields: string[];
      matches: unknown[][];
    };
    expect(searchPayload.totalMatches).toBeGreaterThan(0);
    const name = searchPayload.fields.indexOf('name');
    expect(String(searchPayload.matches[0]?.[name]).toLowerCase()).toContain('oatmeal');

    const filter = await client.callTool({
      name: 'filter_dishes',
      arguments: { exclude_allergens: ['milk'], require_traits: ['vegetarian'] },
    });
    expect(filter.isError).toBeFalsy();
    const filterPayload = filter.structuredContent as {
      key: { allergens: Record<string, string>; traits: Record<string, string> };
      fields: string[];
      note?: string;
      matches: unknown[][];
    };
    expect(filterPayload.matches.length).toBeGreaterThan(0);
    const milk = Object.entries(filterPayload.key.allergens).find(([, slug]) => slug === 'milk')?.[0];
    const vegetarian = Object.entries(filterPayload.key.traits).find(([, slug]) => slug === 'vegetarian')?.[0];
    const allergens = filterPayload.fields.indexOf('allergens');
    const traits = filterPayload.fields.indexOf('traits');
    for (const match of filterPayload.matches) {
      if (milk) expect((match[allergens] as number[]).map(String)).not.toContain(milk);
      if (vegetarian) expect((match[traits] as number[]).map(String)).toContain(vegetarian);
    }
    expect(filterPayload.note).toMatch(/allergen/i);
  });

  it('reports the carbon tier only when max_carbon or a carbon sort asks for it', async () => {
    mockFixtureFetch();

    // No constraint: no carbon in the row.
    const plain = await client.callTool({
      name: 'search_dishes',
      arguments: { query: 'oatmeal' },
    });
    const plainPayload = plain.structuredContent as {
      fields: string[];
      matches: unknown[][];
    };
    expect(plainPayload.fields).not.toContain('carbonFootprint');

    // max_carbon brings the carbon tier into every row.
    const capped = await client.callTool({
      name: 'filter_dishes',
      arguments: { hall: 'bursley', max_carbon: 2 },
    });
    expect(capped.isError).toBeFalsy();
    const cappedPayload = capped.structuredContent as {
      fields: string[];
      matches: unknown[][];
    };
    const carbon = cappedPayload.fields.indexOf('carbonFootprint');
    expect(carbon).toBeGreaterThanOrEqual(0);
    const mhealthy = cappedPayload.fields.indexOf('mhealthyTier');
    expect(carbon).toBe(mhealthy + 1);
    for (const row of cappedPayload.matches) {
      const value = row[carbon] as number | null;
      expect(value === null || value <= 2).toBe(true);
    }

    // sort_by carbonFootprint brings the carbon tier into every row, sorted.
    const sorted = await client.callTool({
      name: 'search_dishes',
      arguments: { query: 'oatmeal', hall: 'bursley', sort_by: 'carbonFootprint', sort_order: 'asc' },
    });
    expect(sorted.isError).toBeFalsy();
    const sortedPayload = sorted.structuredContent as {
      fields: string[];
      matches: unknown[][];
    };
    const sortedCarbon = sortedPayload.fields.indexOf('carbonFootprint');
    expect(sortedCarbon).toBeGreaterThanOrEqual(0);
    const values = sortedPayload.matches.map(
      (row) => (row[sortedCarbon] as number | null) ?? Number.MAX_SAFE_INTEGER,
    );
    const ordered = [...values].sort((a, b) => a - b);
    expect(values).toEqual(ordered);
  });

  it('takes a list of halls and an empty list of them', async () => {
    mockFixtureFetch();

    const one = (await client.callTool({
      name: 'search_dishes',
      arguments: { query: 'oatmeal', hall: ['bursley'] },
    })) as {
      isError?: boolean;
      structuredContent?: { key: { halls: Record<string, string> }; matches: unknown[][]; fields: string[] };
    };
    expect(one.isError).toBeFalsy();
    expect(Object.keys(one.structuredContent!.key.halls)).toEqual(['1']);

    const two = (await client.callTool({
      name: 'search_dishes',
      arguments: { query: 'oatmeal', hall: ['bursley', 'markley'] },
    })) as { structuredContent?: { key: { halls: Record<string, string> } } };
    expect(Object.keys(two.structuredContent!.key.halls).sort()).toEqual(['1', '3']);

    // An empty list is every hall, and a single hall may still be named on
    // its own.
    const all = (await client.callTool({
      name: 'search_dishes',
      arguments: { query: 'oatmeal', hall: [] },
    })) as { structuredContent?: { key: { halls: Record<string, string> } } };
    expect(Object.keys(all.structuredContent!.key.halls).length).toBeGreaterThan(2);

    const single = (await client.callTool({
      name: 'search_dishes',
      arguments: { query: 'oatmeal', hall: 'bursley' },
    })) as { structuredContent?: { key: { halls: Record<string, string> } } };
    expect(Object.keys(single.structuredContent!.key.halls)).toEqual(['1']);
  });

  it('returns fifty rows by default and says how to see the rest', async () => {
    mockFixtureFetch();
    const result = (await client.callTool({
      name: 'filter_dishes',
      arguments: { hall: 'bursley' },
    })) as { structuredContent?: { matches: unknown[][]; totalMatches: number; truncated: boolean; note?: string } };

    expect(result.structuredContent!.totalMatches).toBeGreaterThan(50);
    expect(result.structuredContent!.matches).toHaveLength(50);
    expect(result.structuredContent!.truncated).toBe(true);
    expect(result.structuredContent!.note).toMatch(/larger limit/);
  });

  it('calls get_hours, find_open_now and get_item_nutrition', async () => {
    mockFixtureFetch();
    const hours = await client.callTool({ name: 'get_hours', arguments: { hall: 'bursley' } });
    expect(hours.isError).toBeFalsy();
    const hoursPayload = hours.structuredContent as {
      halls: { today: { label: string }[]; regular: { weekly: unknown[] } | null }[];
    };
    expect(hoursPayload.halls[0]?.today[0]?.label).toBe('Breakfast');
    expect(hoursPayload.halls[0]?.regular?.weekly.length).toBeGreaterThan(0);

    const open = await client.callTool({ name: 'find_open_now', arguments: {} });
    expect(open.isError).toBeFalsy();
    const openPayload = open.structuredContent as { open: unknown[]; closed: unknown[] };
    expect(openPayload.open.length + openPayload.closed.length).toBe(10);

    const nutrition = await client.callTool({
      name: 'get_item_nutrition',
      arguments: { hall: 'bursley', item: 'Oatmeal' },
    });
    expect(nutrition.isError).toBeFalsy();
    const nutritionPayload = nutrition.structuredContent as {
      name: string;
      nutrition: { calories: number; servingSize: string; micronutrients: Record<string, string> };
    };
    expect(nutritionPayload.name).toBe('Oatmeal');
    expect(nutritionPayload.nutrition.calories).toBe(183);
    expect(nutritionPayload.nutrition.servingSize).toBe('Cups (253g)');
    expect(nutritionPayload.nutrition.micronutrients['Vitamin A']).toBe('0%');
  });
});
