#!/usr/bin/env node
/**
 * Optional stateless Streamable HTTP server. Bind loopback on a normal host and
 * publish through a trusted reverse proxy. The original stdio entry is untouched.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer as createNodeServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
} from '@modelcontextprotocol/server';
import { cache } from './cache.js';
import { getLastUpstreamFailure } from './http.js';
import { HttpRequestLimiter } from './http-limits.js';
import { loadHttpSettings, type HttpSettings } from './http-settings.js';
import { createServer } from './server.js';
import { warmer, pruneCache } from './warmer.js';
import { config } from './config.js';

const started = Date.now();
const MAX_BODY_BYTES = 64 * 1024;

function clientIp(req: IncomingMessage, settings: HttpSettings): string {
  if (settings.trustProxy) {
    // ONLY safe when a loopback/host-private reverse proxy overwrites X-Real-IP
    // rather than appending a user-supplied forwarding header.
    const ip = req.headers['x-real-ip'];
    if (typeof ip === 'string' && /^(?:[0-9a-fA-F:.]+)$/.test(ip) && ip.length <= 45) return ip;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function authorised(req: IncomingMessage, settings: HttpSettings): boolean {
  const expected = settings.bearerTokenSha256;
  if (!expected) return true; // public, read-only dining information
  const header = req.headers.authorization ?? '';
  const match = /^Bearer ([\x21-\x7e]{16,512})$/.exec(header);
  if (!match?.[1]) return false;
  const hash = createHash('sha256').update(match[1], 'utf8').digest();
  return timingSafeEqual(hash, Buffer.from(expected, 'hex'));
}

async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  response.headers.forEach((value, name) => { headers[name] = value; });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body), res);
}

export function createHttpApp(settings: HttpSettings = loadHttpSettings()) {
  const limiter = new HttpRequestLimiter(
    settings.requestsPerMinute, settings.maxConcurrentPerIp, settings.maxConcurrentTotal,
  );
  const mcp = createMcpHandler(() => createServer(), {
    // Serving both the modern protocol and older stateless HTTP clients is
    // intentional: existing public MCP clients may not implement the new era.
    legacy: 'stateless',
    responseMode: 'json',
    maxRequestBodySize: MAX_BODY_BYTES,
    maxSubscriptions: 32,
    keepAliveMs: 15_000,
    onerror: (error) => { process.stderr.write(`MCP request error: ${error.message}\n`); },
  });

  const server = createNodeServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';

      // The request target is used to build the internal URL, so it has to
      // be a path: an absolute-form target would carry a host of the
      // client's choosing into the URL and into the log. It is refused before
      // anything else looks at it.
      const target = req.url ?? '/mcp';
      if (!target.startsWith('/')) {
        sendJson(res, 400, { error: 'bad_request_target' });
        return;
      }

      const path = new URL(target, 'http://127.0.0.1').pathname;
      if (path !== '/healthz' && path !== '/mcp') {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      // Preserve the raw Host header for SDK validation, while constructing the
      // fetch URL from a constant local origin (never from untrusted Host).
      const webRequest = new Request(`http://127.0.0.1:${settings.port}${target}`, {
        method: 'GET', headers,
      });
      const rejected = hostHeaderValidationResponse(webRequest, settings.allowedHosts)
        ?? originValidationResponse(webRequest, settings.allowedOrigins);
      if (rejected) {
        await sendResponse(res, rejected);
        return;
      }
      // The token is checked before the health endpoint: a token that protects
      // the tools must protect the endpoint that says how the server is
      // doing. The health payload names the uptime, the cache size and the
      // kind of the last upstream failure, which is more than a public
      // endpoint should say.
      if (!authorised(req, settings)) {
        res.setHeader('www-authenticate', 'Bearer realm="umich-dining-mcp"');
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      if (path === '/healthz') {
        if (method !== 'GET' && method !== 'HEAD') {
          sendJson(res, 405, { error: 'method_not_allowed' });
          return;
        }
        // When no bearer token is configured the endpoint is public: it says
        // whether the server is up, and nothing about the cache or the
        // upstream. When a token protects the tools, it protects the health
        // endpoint too, and the payload names the cache size and the kind of
        // the last upstream failure.
        const health: Record<string, unknown> = {
          status: 'ok', uptimeSeconds: Math.floor((Date.now() - started) / 1000),
        };
        if (settings.bearerTokenSha256) {
          health.cacheSize = cache.size;
          health.lastUpstreamError = getLastUpstreamFailure();
        }
        if (method === 'HEAD') {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end();
        } else {
          sendJson(res, 200, health);
        }
        return;
      }
      if (!['POST', 'GET', 'DELETE'].includes(method)) {
        res.setHeader('allow', 'POST, GET, DELETE');
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      const len = req.headers['content-length'];
      if (len && (/^\d+$/.test(len) === false || Number(len) > MAX_BODY_BYTES)) {
        sendJson(res, 413, { error: 'request_too_large' });
        return;
      }
      const admission = limiter.acquire(clientIp(req, settings));
      if ('status' in admission) {
        res.setHeader('retry-after', String(admission.retryAfter));
        if (admission.status === 503) {
          // The server is at its capacity, not the client over its budget.
          sendJson(res, 503, { error: 'server_busy' });
          return;
        }
        sendJson(res, 429, { error: 'rate_limited' });
        return;
      }
      try {
        const controller = new AbortController();
        req.on('aborted', () => controller.abort());
        res.on('close', () => { if (!res.writableFinished) controller.abort(); });
        const init: RequestInit & { duplex?: 'half' } = {
          method, headers,
          signal: controller.signal,
        };
        if (method === 'POST') {
          init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
          init.duplex = 'half';
        }
        const response = await mcp.fetch(new Request(
          `http://127.0.0.1:${settings.port}${target}`, init,
        ));
        await sendResponse(res, response);
      } finally {
        admission.release();
      }
    })().catch((error: unknown) => {
      process.stderr.write(`HTTP server error: ${error instanceof Error ? error.message : 'unknown'}\n`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.destroy();
    });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return { server, close: async () => { await mcp.close(); await new Promise<void>((ok, fail) => server.close((err) => err ? fail(err) : ok())); } };
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const settings = loadHttpSettings();
  const { server, close } = createHttpApp(settings);
  server.listen(settings.port, settings.host, () => {
    process.stdout.write(`umich-dining-mcp HTTP listening on ${settings.host}:${settings.port}\n`);
  });

  // The long-lived mode keeps the persistent cache warm and prunes it.
  warmer.start();
  const pruneTimer = setInterval(() => {
    void pruneCache();
  }, config.cachePruneIntervalMs);
  pruneTimer.unref?.();
  void pruneCache();

  const shutdown = (): void => {
    warmer.stop();
    clearInterval(pruneTimer);
    void close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
