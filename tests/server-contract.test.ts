import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { cache } from '../src/cache.js';
import { createServer } from '../src/server.js';
import { HALL_FIXTURES, mockFixtureFetch, readFixture } from './helpers.js';

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
  'search_dishes',
  'filter_dishes',
  'get_hours',
  'find_open_now',
  'get_item_nutrition',
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

  it('offers the seven tools and the two resources', async () => {
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
    const result = (await client.callTool({ name: 'get_menu', arguments: { hall: 'bursley' } })) as ToolResult;
    const payload = result.structuredContent as { totalItems: number; totalStations: number };
    const html = readFixture(HALL_FIXTURES['bursley'] as string);
    const items = (html.match(/<span class="item-name">/g) ?? []).length;
    expect(payload.totalItems).toBe(items);
    expect(payload.totalStations).toBe(22);
  });

  it('returns only the meal it was asked for', async () => {
    const result = (await client.callTool({
      name: 'get_menu',
      arguments: { hall: 'bursley', meal: 'Breakfast' },
    })) as ToolResult;
    const payload = result.structuredContent as {
      meals: Record<string, unknown[]>;
      totalItems: number;
    };
    expect(payload.meals['Breakfast']?.length).toBeGreaterThan(0);
    expect(payload.meals['Lunch']).toEqual([]);
    expect(payload.meals['Dinner']).toEqual([]);
    const breakfast = payload.meals['Breakfast'] as { items: unknown[] }[];
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
    const result = (await client.callTool({ name: 'search_dishes', arguments: { query: '' } })) as ToolResult;
    expect(result.isError).toBe(true);
  });

  it('rejects a limit outside the range the server allows', async () => {
    for (const limit of [0, -1, 501]) {
      const result = (await client.callTool({
        name: 'search_dishes',
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
      const name = `${new URL(url).pathname.replace(/\/+$/, '').split('/').pop()}.html`;
      return new Response(readFixture(name), { status: 200 });
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
      locations: { id: string; url: string; address: string | null; meals: string[] }[];
      warning: string;
    };
    expect(payload.locations).toHaveLength(10);
    for (const location of payload.locations) {
      expect(location.url, location.id).toMatch(/^https:\/\/dining\.umich\.edu\/menus-locations\//);
      expect(location.meals.length, location.id).toBeGreaterThan(0);
    }
    const bursley = payload.locations.find((location) => location.id === 'bursley');
    expect(bursley?.address).toBe('1931 Duffield Street, Ann Arbor, MI, 48109');
    expect(payload.warning).toMatch(/allergen/i);
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
      name: 'search_dishes',
      arguments: { query: 'oatmeal' },
    })) as ToolResult;
    const searchPayload = search.structuredContent as {
      totalMatches: number;
      matches: { name: string; hall: string; traits: string[]; allergens: string[] }[];
      warning: string;
    };
    expect(searchPayload.totalMatches).toBeGreaterThan(0);
    for (const match of searchPayload.matches) {
      expect(match.name.toLowerCase()).toContain('oatmeal');
    }
    expect(searchPayload.warning).toMatch(/allergen/i);

    const filter = (await client.callTool({
      name: 'filter_dishes',
      arguments: { exclude_allergens: ['milk'], require_traits: ['vegetarian'] },
    })) as ToolResult;
    const filterPayload = filter.structuredContent as {
      totalMatches: number;
      matches: { allergens: string[]; traits: string[] }[];
    };
    for (const match of filterPayload.matches) {
      expect(match.allergens).not.toContain('milk');
      expect(match.traits).toContain('vegetarian');
    }
  });

  it('returns the panel of a dish with its meal and its station', async () => {
    const result = (await client.callTool({
      name: 'get_item_nutrition',
      arguments: { hall: 'bursley', item: 'Oatmeal' },
    })) as ToolResult;
    const payload = result.structuredContent as {
      hall: string;
      meal: string;
      station: string;
      name: string;
      nutrition: { calories: number; servingSize: string; micronutrients: Record<string, string> };
      warning: string;
    };
    expect(payload.hall).toBe('bursley');
    expect(payload.meal).toBe('Breakfast');
    expect(payload.station).toBe('Hot Cereal');
    expect(payload.name).toBe('Oatmeal');
    expect(payload.nutrition.calories).toBe(183);
    expect(payload.nutrition.servingSize).toBe('Cups (253g)');
    expect(payload.warning).toMatch(/allergen/i);
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

  it('lists the ten halls with the path of their page', async () => {
    const resource = await client.readResource({ uri: 'umich://dining-halls' });
    const first = resource.contents[0] as { text?: string; mimeType?: string };
    expect(first.mimeType).toBe('application/json');
    const registry = JSON.parse(first.text ?? '[]') as {
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
  });

  it('lists the allergens and the traits of the site', async () => {
    const resource = await client.readResource({ uri: 'umich://taxonomy' });
    const first = resource.contents[0] as { text?: string };
    const taxonomy = JSON.parse(first.text ?? '{}') as {
      allergens: Record<string, string>;
      traits: Record<string, string>;
      booleanTraits: string[];
      mhealthyTiers: string[];
      carbonTiers: string[];
      implications: Record<string, string[]>;
      caveat: string;
    };
    expect(Object.keys(taxonomy.allergens)).toHaveLength(15);
    expect(Object.keys(taxonomy.traits)).toHaveLength(14);
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
  });
});
