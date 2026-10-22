import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { cache } from '../src/cache.js';
import { config } from '../src/config.js';
import { createServer } from '../src/server.js';
import { mockFixtureFetch, readFixture } from './helpers.js';

describe('the server instructions', () => {
  it('say that the data is unofficial', async () => {
    mockFixtureFetch();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);
    const client = new Client({ name: 'c', version: '1' });
    try {
      await client.connect(clientTransport);
      const info = client.getInstructions();
      expect(info).toBeTruthy();
      expect(info).toMatch(/not affiliated with or endorsed by the university/);
      expect(info).toMatch(/unofficial/);
    } finally {
      await client.close();
    }
  });
});

describe('a truncated answer', () => {
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

  it('says so when the rows were cut short', async () => {
    const result = (await client.callTool({
      name: 'filter_dishes',
      arguments: { query: 'a', limit: 2 },
    })) as { structuredContent?: { totalMatches: number; truncated: boolean; matches: unknown[]; note?: string } };

    const payload = result.structuredContent!;
    expect(payload.totalMatches).toBeGreaterThan(2);
    expect(payload.matches).toHaveLength(2);
    expect(payload.truncated).toBe(true);
    expect(payload.note).toMatch(/cut short/);
    expect(payload.note).toMatch(/larger limit/);
  });

  it('does not say so when the rows are all there', async () => {
    const result = (await client.callTool({
      name: 'filter_dishes',
      arguments: { query: 'oatmeal', limit: 50 },
    })) as { structuredContent?: { totalMatches: number; truncated: boolean; matches: unknown[] } };

    const payload = result.structuredContent!;
    expect(payload.truncated).toBe(false);
    expect(payload.matches).toHaveLength(payload.totalMatches);
  });
});

describe('the upstream URL', () => {
  it('is not echoed to the client', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('regularhours')) {
        return new Response(readFixture('regularhours.html'), { status: 200 });
      }
      return new Response('boom', { status: 500 });
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);
    const client = new Client({ name: 'c', version: '1' });
    try {
      await client.connect(clientTransport);
      const result = (await client.callTool({
        name: 'filter_dishes',
        arguments: { hall: 'bursley' },
      })) as { structuredContent?: { failures: { error: string }[] } };

      const text = JSON.stringify(result.structuredContent);
      expect(text).not.toContain('dining.umich.edu');
      // The hall is still named, so the reader knows what failed.
      expect(result.structuredContent?.failures[0]?.error).toBeTruthy();
    } finally {
      await client.close();
    }
  });
});

describe('an unknown argument', () => {
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

  it('is refused rather than ignored', async () => {
    const result = (await client.callTool({
      name: 'filter_dishes',
      arguments: { hall: 'bursley', extra_unknown_arg: 1 },
    })) as { isError?: boolean; content?: { text?: string }[] };

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/extra_unknown_arg|unrecognized/i);
  });

  it('is refused on a tool that takes nothing at all', async () => {
    const result = (await client.callTool({
      name: 'list_nutrition_fields',
      arguments: { anything: true },
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
  });
});

describe('a tool error', () => {
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

  it('has one shape', async () => {
    const result = (await client.callTool({
      name: 'get_item_nutrition',
      arguments: { hall: 'bursley', item: 'A Dish Nobody Serves' },
    })) as { isError?: boolean; content?: { text?: string }[] };

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content?.[0]?.text ?? '{}') as {
      error?: { kind?: string; message?: string };
    };
    expect(payload.error?.kind).toBe('not_found');
    expect(payload.error?.message).toMatch(/A Dish Nobody Serves/);
  });

  it('says what kind of fault it is', async () => {
    const result = (await client.callTool({
      name: 'filter_dishes',
      arguments: { hall: 'bursley', nutrients: { protein: { min: 1, unit: 'kg' } } },
    })) as { isError?: boolean; content?: { text?: string }[] };

    const payload = JSON.parse(result.content?.[0]?.text ?? '{}') as {
      error?: { kind?: string };
    };
    expect(payload.error?.kind).toBe('invalid_request');
  });
});

describe('the budget of a call', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    cache.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cache.clear();
  });

  it('is a setting', () => {
    expect(config.callBudgetMs).toBeGreaterThan(0);
  });
});
