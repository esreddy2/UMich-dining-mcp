import { describe, expect, it } from 'vitest';
import { HttpRequestLimiter } from '../src/http-limits.js';
import { loadHttpSettings } from '../src/http-settings.js';

describe('HTTP configuration', () => {
  it('defaults to loopback and a single approved hostname', () => {
    const settings = loadHttpSettings({});
    expect(settings.host).toBe('127.0.0.1');
    expect(settings.allowedHosts).toEqual(['localhost']);
    expect(settings.trustProxy).toBe(false);
    expect(settings.bearerTokenSha256).toBeUndefined();
  });
  it('rejects malformed settings and token hashes', () => {
    expect(() => loadHttpSettings({ UMICH_MCP_HTTP_PORT: '-1' })).toThrow();
    expect(() => loadHttpSettings({ UMICH_MCP_BEARER_TOKEN_SHA256: 'plaintext' })).toThrow();
  });
});

describe('HTTP request limiter', () => {
  it('enforces a per-IP token bucket', () => {
    const limit = new HttpRequestLimiter(2, 2, 2);
    const a = limit.acquire('a', 1000);
    const b = limit.acquire('a', 1000);
    expect('release' in a).toBe(true);
    expect('release' in b).toBe(true);
    if ('release' in a) a.release();
    if ('release' in b) b.release();
    // The budget is spent: the client is told to wait for the refill.
    const refused = limit.acquire('a', 1000);
    expect(refused).toMatchObject({ status: 429 });
    expect('retryAfter' in refused && refused.retryAfter).toBeGreaterThan(0);
    expect('release' in limit.acquire('a', 32_000)).toBe(true);
  });

  it('answers a concurrency refusal with 503, not 429', () => {
    // A client that is refused because the server is full has to wait a
    // moment, not a minute: the two are different problems.
    const limit = new HttpRequestLimiter(60, 1, 2);
    const first = limit.acquire('a');
    expect(limit.acquire('a')).toMatchObject({ status: 503 });
    const second = limit.acquire('b');
    expect(limit.acquire('c')).toMatchObject({ status: 503 });
    if ('release' in first) { first.release(); first.release(); }
    if ('release' in second) second.release();
    expect('release' in limit.acquire('c')).toBe(true);
  });

  it('enforces global and per-IP concurrency and idempotent release', () => {
    const limit = new HttpRequestLimiter(60, 1, 2);
    const first = limit.acquire('a');
    expect('release' in first).toBe(true);
    if ('release' in first) { first.release(); first.release(); }
    expect('release' in limit.acquire('a')).toBe(true);
  });
});
