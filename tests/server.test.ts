import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { cache } from '../src/cache.js';
import { createServer } from '../src/server.js';
import { mockFixtureFetch } from './helpers.js';

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

  it('registers exactly seven tools and two resources', async () => {
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

  it('calls get_menu and returns the meals of a hall', async () => {
    mockFixtureFetch();
    const result = await client.callTool({ name: 'get_menu', arguments: { hall: 'bursley' } });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as {
      hall: string;
      totalStations: number;
      totalItems: number;
      meals: Record<string, unknown[]>;
    };
    expect(payload.hall).toBe('bursley');
    expect(payload.totalStations).toBe(22);
    expect(payload.totalItems).toBe(69);
    expect(Object.keys(payload.meals).sort()).toEqual(['Breakfast', 'Dinner', 'Lunch']);
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
    const searchPayload = search.structuredContent as { totalMatches: number; matches: { name: string }[] };
    expect(searchPayload.totalMatches).toBeGreaterThan(0);
    expect(searchPayload.matches[0]?.name.toLowerCase()).toContain('oatmeal');

    const filter = await client.callTool({
      name: 'filter_dishes',
      arguments: { exclude_allergens: ['milk'], require_traits: ['vegetarian'] },
    });
    expect(filter.isError).toBeFalsy();
    const filterPayload = filter.structuredContent as {
      matches: { allergens: string[]; traits: string[] }[];
      warning: string;
    };
    expect(filterPayload.matches.length).toBeGreaterThan(0);
    for (const match of filterPayload.matches) {
      expect(match.allergens).not.toContain('milk');
      expect(match.traits).toContain('vegetarian');
    }
    expect(filterPayload.warning).toMatch(/allergen/i);
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
