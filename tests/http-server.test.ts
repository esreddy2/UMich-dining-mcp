import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHash } from 'node:crypto';
import { type AddressInfo } from 'node:net';
import { request as nodeRequest } from 'node:http';
import { createHttpApp } from '../src/http-server.js';
import { loadHttpSettings } from '../src/http-settings.js';

const HOST = 'localhost';

describe('public HTTP transport', () => {
  const app = createHttpApp(loadHttpSettings({
    UMICH_MCP_ALLOWED_HOSTS: `${HOST},127.0.0.1`,
    UMICH_MCP_ALLOWED_ORIGINS: HOST,
    UMICH_MCP_RATE_PER_MINUTE: '30',
  }));
  let url: string;
  beforeAll(async () => {
    await new Promise<void>((ok) => app.server.listen(0, '127.0.0.1', ok));
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await app.close(); });

  function request(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${url}${path}`, {
      ...init,
      headers: { Host: HOST, ...init.headers },
    });
  }

  it('serves health without contacting the upstream', async () => {
    const response = await request('/healthz');
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; uptimeSeconds: number; cacheSize?: unknown; lastUpstreamError?: unknown };
    expect(body.status).toBe('ok');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    // Public: no cache size and no upstream failure leak out.
    expect(body.cacheSize).toBeUndefined();
    expect(body.lastUpstreamError).toBeUndefined();
  });
  it('serves a server that listens on a port of its own', async () => {
    // The allowlist holds hostnames: the port of the Host header is not part
    // of the comparison, so a server on any port is reachable.
    const port = (app.server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(response.status).toBe(200);
  });

  it('rejects unapproved Host and Origin headers', async () => {
    // A raw Node HTTP request actually sends the attacker-controlled Host.
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const req = nodeRequest(`${url}/healthz`, {
        headers: { Host: 'attacker.invalid' },
      }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(hostStatus).toBe(403);
    const origin = await request('/mcp', { headers: { Origin: 'https://attacker.invalid' } });
    expect(origin.status).toBe(403);
  });
  it('returns 404 on unrelated paths and 413 on oversized requests', async () => {
    expect((await request('/secret')).status).toBe(404);
    const big = await request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'x'.repeat(65537),
    });
    expect(big.status).toBe(413);
  });
  it('allows an actual MCP client to list the seven tools', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { Host: HOST } },
    });
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(8);
      expect(tools.tools.map((tool) => tool.name)).toContain('get_menu');
      const r = await client.readResource({ uri: 'umich://taxonomy' });
      expect(JSON.stringify(r.contents)).toContain('allergen');
    } finally {
      await client.close();
    }
  });
});

describe('optional bearer authentication', () => {
  const token = 'test-secret-token-for-http-tests';
  const hash = createHash('sha256').update(token).digest('hex');
  const app = createHttpApp(loadHttpSettings({
    UMICH_MCP_ALLOWED_HOSTS: `${HOST},127.0.0.1`,
    UMICH_MCP_BEARER_TOKEN_SHA256: hash,
  }));
  let url: string;
  beforeAll(async () => {
    await new Promise<void>((ok) => app.server.listen(0, '127.0.0.1', ok));
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await app.close(); });
  it('requires the configured bearer token', async () => {
    const options = { method: 'POST', body: '{}', headers: { Host: HOST, 'Content-Type': 'application/json' } };
    expect((await fetch(`${url}/mcp`, options)).status).toBe(401);
    const bad = await fetch(`${url}/mcp`, { ...options, headers: { ...options.headers, Authorization: 'Bearer incorrect-token-value-123456' } });
    expect(bad.status).toBe(401);
    const good = await fetch(`${url}/mcp`, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
    expect(good.status).not.toBe(401);
  });

  it('protects the health endpoint with the same token', async () => {
    // The health payload names the uptime, the cache size and the kind of
    // the last upstream failure: a token that protects the tools protects it.
    const anonymous = await fetch(`${url}/healthz`, { headers: { Host: HOST } });
    expect(anonymous.status).toBe(401);

    const withToken = await fetch(`${url}/healthz`, {
      headers: { Host: HOST, Authorization: `Bearer ${token}` },
    });
    expect(withToken.status).toBe(200);
    const body = await withToken.json() as { status: string; cacheSize: number; uptimeSeconds: number; lastUpstreamError: unknown };
    expect(body.status).toBe('ok');
    expect(body.cacheSize).toBeGreaterThanOrEqual(0);
    expect(body.lastUpstreamError).toBeDefined();
  });
});


describe('HTTP admission limit', () => {
  const app = createHttpApp(loadHttpSettings({ UMICH_MCP_ALLOWED_HOSTS: `${HOST},127.0.0.1`, UMICH_MCP_RATE_PER_MINUTE: '1' }));
  let url: string;
  beforeAll(async () => {
    await new Promise<void>((ok) => app.server.listen(0, '127.0.0.1', ok));
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`;
  });
  afterAll(async () => { await app.close(); });
  it('returns 429 after exhausting the per-IP budget', async () => {
    const opts = { method: 'POST', headers: { Host: HOST, 'Content-Type': 'application/json' }, body: '{}' };
    expect((await fetch(url, opts)).status).not.toBe(429);
    expect((await fetch(url, opts)).status).toBe(429);
  });
});
