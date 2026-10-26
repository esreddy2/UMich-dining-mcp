import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpApp } from '../src/http-server.js';
import { loadHttpSettings } from '../src/http-settings.js';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { cache } from '../src/cache.js';
import { createServer } from '../src/server.js';
import { todayIn } from '../src/service.js';
import { mockFixtureFetch, readFixture, withDeclaredDate } from './helpers.js';

/**
 * The test-coverage gaps of the extensive findings.
 *
 * Each of the twelve gaps in the findings sits next to a defect that shipped.
 * These are the assertions that would have caught them.
 */
describe('sorting', () => {
  let client: Client;

  beforeEach(async () => {
    vi.unstubAllGlobals();
    cache.clear();
    mockFixtureFetch();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);
    client = new Client({ name: 'c', version: '1' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    vi.unstubAllGlobals();
    cache.clear();
  });

  async function sorted(sort_by?: string, sort_order?: 'asc' | 'desc'): Promise<{
    values: number[];
    missing: number;
  }> {
    const result = (await client.callTool({
      name: 'filter_dishes',
      arguments: { hall: 'bursley', sort_by, sort_order },
    })) as { structuredContent?: { matches: unknown[][] } };
    const rows = result.structuredContent?.matches ?? [];
    const calories = 7;
    const values = rows
      .map((row) => row[calories] as number | null)
      .filter((value): value is number => value !== null);
    // The dishes without a value are at the end, in both directions.
    const missing = rows.length - values.length;
    const firstMissing = rows.findIndex((row) => row[calories] === null);
    if (missing > 0) expect(firstMissing).toBe(rows.length - missing);
    return { values, missing };
  }

  it('sorts descending by default', async () => {
    const { values } = await sorted('calories');
    expect(values.length).toBeGreaterThan(2);
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index]!).toBeLessThanOrEqual(values[index - 1]!);
    }
  });

  it('sorts ascending when it is asked to', async () => {
    const { values } = await sorted('calories', 'asc');
    expect(values.length).toBeGreaterThan(2);
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index]!).toBeGreaterThanOrEqual(values[index - 1]!);
    }
  });

  it('puts the dishes without a value last, in both directions', async () => {
    for (const order of ['asc', 'desc'] as const) {
      const { values, missing } = await sorted('calories', order);
      expect(values.length).toBeGreaterThan(2);
      for (let index = 1; index < values.length; index += 1) {
        if (order === 'asc') {
          expect(values[index]!).toBeGreaterThanOrEqual(values[index - 1]!);
        } else {
          expect(values[index]!).toBeLessThanOrEqual(values[index - 1]!);
        }
      }
      expect(missing).toBeGreaterThanOrEqual(0);
    }
  });

  it('refuses an unknown field', async () => {
    const result = (await client.callTool({
      name: 'filter_dishes',
      arguments: { hall: 'bursley', sort_by: 'protien' },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

describe('the notes of a sweep answer', () => {
  let client: Client;

  beforeEach(async () => {
    vi.unstubAllGlobals();
    cache.clear();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);
    client = new Client({ name: 'c', version: '1' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    vi.unstubAllGlobals();
    cache.clear();
  });

  it('says which days carried no menu', async () => {
    // The site's own "no menu" marker, on the page of one day.
    vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('regularhours')) {
        return new Response(readFixture('regularhours.html'), { status: 200 });
      }
      const body = readFixture('no-menu.html');
      return new Response(body.replace(
        /(<span class="date">)[^<]*(<\/span>)/,
        '$1Saturday, October 24, 2026$2',
      ), { status: 200 });
    });

    const result = (await client.callTool({
      name: 'filter_dishes',
      arguments: { hall: 'bursley', date: '2026-10-24' },
    })) as { structuredContent?: { noMenu?: { hall: string; date: string }[]; note?: string; totalMatches: number } };

    const payload = result.structuredContent!;
    expect(payload.noMenu).toEqual([{ hall: 'bursley', date: '2026-10-24' }]);
    expect(payload.totalMatches).toBe(0);
    expect(payload.note).toMatch(/No menu published at: 2026-10-24/);
  });

  it('does not say a day carried no menu when a filter matched nothing', async () => {
    mockFixtureFetch();
    const result = (await client.callTool({
      name: 'filter_dishes',
      arguments: { hall: 'bursley', station: 'No Such Station' },
    })) as { structuredContent?: { noMenu?: { hall: string; date: string }[]; note?: string } };

    const payload = result.structuredContent!;
    // The day had a menu; the station simply does not exist.
    expect(payload.noMenu).toEqual([]);
    expect(payload.note).toMatch(/No station called/);
    expect(payload.note).not.toMatch(/No menu published/);
  });

  it('says that the answer is a range', async () => {
    mockFixtureFetch();
    // The day of the campus, which is the day the service reads too.
    const today = todayIn();
    const result = (await client.callTool({
      name: 'filter_dishes',
      arguments: { hall: 'bursley', from: today, to: today },
    })) as { structuredContent?: { note?: string } };

    expect(result.structuredContent?.note).toMatch(/This is a range/);
  });

  it('names a meal label the site published that it cannot parse', async () => {
    const today = todayIn();
    vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('regularhours')) {
        return new Response(readFixture('regularhours.html'), { status: 200 });
      }
      const body = readFixture('supper.html');
      return new Response(withDeclaredDate(body, today), { status: 200 });
    });

    const result = (await client.callTool({
      name: 'filter_dishes',
      arguments: { hall: 'bursley', date: today },
    })) as { structuredContent?: { note?: string; totalMatches: number } };

    expect(result.structuredContent?.note).toMatch(/cannot parse/);
    expect(result.structuredContent?.note).toMatch(/Supper/);
    // The dishes of the unknown meal are still there.
    expect(result.structuredContent?.totalMatches).toBeGreaterThan(0);
  });
});

describe('the published contract', () => {
  let client: Client;

  beforeEach(async () => {
    vi.unstubAllGlobals();
    cache.clear();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);
    client = new Client({ name: 'c', version: '1' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    vi.unstubAllGlobals();
    cache.clear();
  });

  it('describes every parameter of every tool', async () => {
    const tools = await client.listTools();
    for (const tool of tools.tools) {
      const schema = tool.inputSchema as {
        properties?: Record<string, { description?: string }>;
      };
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        expect(property.description, `${tool.name}.${name}`).toBeTruthy();
      }
    }
  });

  it('publishes the same schemas twice', async () => {
    // A client that holds an old tool list must be able to see that nothing
    // moved under it.
    const first = await client.listTools();
    const second = await client.listTools();
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
  });

  it('says that the data is unofficial', async () => {
    const tools = await client.listTools();
    const menu = tools.tools.find((tool) => tool.name === 'get_menu');
    expect(menu?.description).toMatch(/allergen/i);
    expect(client.getInstructions()).toMatch(/not affiliated/);
  });

  it('publishes a strict input schema for every tool', async () => {
    const tools = await client.listTools();
    for (const tool of tools.tools) {
      const schema = tool.inputSchema as { additionalProperties?: boolean };
      expect(schema.additionalProperties, tool.name).toBe(false);
    }
  });
});

describe('the request target', () => {
  it('is refused when it is not a path', async () => {
    const app = createHttpApp(loadHttpSettings({ UMICH_MCP_ALLOWED_HOSTS: '127.0.0.1' }));
    await new Promise<void>((ok) => app.server.listen(0, '127.0.0.1', ok));
    const port = (app.server.address() as AddressInfo).port;

    try {
      const response = await new Promise<number>((ok) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: 'http://evil.example.com/mcp',
            headers: { Host: '127.0.0.1' },
          },
          (res) => {
            res.resume();
            res.on('end', () => ok(res.statusCode ?? 0));
          },
        );
        req.on('error', () => ok(0));
        req.end('{}');
      });
      // An absolute-form target is refused, not interpolated into the log.
      expect(response).toBe(400);
    } finally {
      await app.close();
    }
  });
});
