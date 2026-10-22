import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../src/server.js';
import { mockFixtureFetch } from './helpers.js';

/**
 * The size of the answer, measured rather than assumed.
 *
 * The compact row was adopted to cut the payload an agent has to read. This
 * test keeps the saving honest: a regression that puts a name back into a row
 * has to fail here.
 */
describe('the size of a sweep answer', () => {
  let client: Client;

  beforeEach(async () => {
    vi.unstubAllGlobals();
    mockFixtureFetch();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);
    client = new Client({ name: 'umich-dining-mcp-size', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  it('keeps a row far below the size of the data it replaces', async () => {
    const result = (await client.callTool({
      name: 'filter_dishes',
      arguments: { query: 'a', hall: 'bursley', limit: 50 },
    })) as { structuredContent?: { matches?: unknown[] } };

    const rows = result.structuredContent?.matches ?? [];
    expect(rows.length).toBeGreaterThan(0);

    const size = JSON.stringify(rows).length;
    const perRow = size / rows.length;

    // A row that carried the hall name, the trait labels, the per-row date
    // and the raw nutrition panel was several hundred bytes. The row is now
    // an array: the member names of a named row are two and a half times the
    // data of the row.
    expect(perRow).toBeLessThan(100);
  });

  it('keeps the key block small', async () => {
    const result = (await client.callTool({
      name: 'filter_dishes',
      arguments: { query: 'a', hall: 'bursley', limit: 50 },
    })) as { structuredContent?: { key?: unknown } };

    const key = JSON.stringify(result.structuredContent?.key ?? {}).length;
    expect(key).toBeLessThan(600);
  });

  it('keeps a whole menu small', async () => {
    // A menu of 97 dishes was 60,266 B with the per-item trait dictionary and
    // the raw nutrition panel. The compact coded row brings it to about
    // 9,000 B.
    const result = (await client.callTool({
      name: 'get_menu',
      arguments: { hall: 'south-quad', meal: 'Lunch' },
    })) as { structuredContent?: { totalItems?: number } };

    const items = result.structuredContent?.totalItems ?? 0;
    expect(items).toBe(47);

    const size = JSON.stringify(result.structuredContent).length;
    expect(size).toBeLessThan(12_000);
    expect(size / items).toBeLessThan(150);
  });

  it('cuts nothing: a whole menu comes back without truncation', async () => {
    const result = (await client.callTool({
      name: 'get_menu',
      arguments: { hall: 'south-quad', meal: 'Lunch' },
    })) as {
      structuredContent?: {
        totalItems: number;
        meals: { stations: { items: unknown[] }[] }[];
        omittedItems?: number;
      };
    };

    const payload = result.structuredContent!;
    const shown = payload.meals.reduce(
      (sum, meal) => sum + meal.stations.reduce((inner, station) => inner + station.items.length, 0),
      0,
    );
    expect(shown).toBe(payload.totalItems);
    expect(payload.totalItems).toBe(47);
    // The limit is gone, so nothing is left out and the field is gone too.
    expect(payload.omittedItems).toBeUndefined();
  });
});
