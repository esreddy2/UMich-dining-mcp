/** Configuration for the optional public HTTP entry. The stdio entry is unaffected. */
export interface HttpSettings {
  host: string;
  port: number;
  allowedHosts: string[];
  allowedOrigins: string[];
  trustProxy: boolean;
  requestsPerMinute: number;
  maxConcurrentPerIp: number;
  maxConcurrentTotal: number;
  bearerTokenSha256: string | undefined;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

/**
 * The hostname allowlist.
 *
 * The entries are hostnames, without a scheme and without a port: the port of
 * the `Host` header is not part of the comparison, so a server that listens on
 * a port of its own is reached with the plain hostname of its host.
 */
function hostList(raw: string): string[] {
  const hosts = raw.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!hosts.length) {
    throw new Error('Invalid HTTP hostname allowlist: the list is empty.');
  }
  for (const host of hosts) {
    if (host.includes(':')) {
      throw new Error(
        `Invalid HTTP hostname allowlist: "${host}" carries a port. ` +
          'List the hostname alone; the port of the Host header is not compared.',
      );
    }
    if (!/^[a-z0-9.-]+$/.test(host) && !/^\[?[0-9a-f:.]+\]?$/.test(host)) {
      throw new Error(
        `Invalid HTTP hostname allowlist: "${host}" is not a hostname. ` +
          'Use a bare hostname, without a scheme and without a port.',
      );
    }
  }
  return [...new Set(hosts)];
}

export function loadHttpSettings(env: NodeJS.ProcessEnv = process.env): HttpSettings {
  const bearerTokenSha256 = env['UMICH_MCP_BEARER_TOKEN_SHA256']?.toLowerCase();
  if (bearerTokenSha256 && !/^[a-f0-9]{64}$/.test(bearerTokenSha256)) {
    throw new Error('UMICH_MCP_BEARER_TOKEN_SHA256 must be a SHA-256 hex digest');
  }
  return {
    host: env['UMICH_MCP_HTTP_HOST'] ?? '127.0.0.1',
    port: positiveInt(env, 'UMICH_MCP_HTTP_PORT', 8080, 65535),
    allowedHosts: hostList(env['UMICH_MCP_ALLOWED_HOSTS'] ?? 'umich-dining-mcp.duckdns.org'),
    allowedOrigins: hostList(env['UMICH_MCP_ALLOWED_ORIGINS'] ?? 'umich-dining-mcp.duckdns.org'),
    trustProxy: env['UMICH_MCP_TRUST_PROXY'] === '1',
    // The budget of one client. It sits above the one of the reverse proxy in
    // front of it, so that the proxy's limit is the one a client meets and
    // the application is the last line rather than the first.
    requestsPerMinute: positiveInt(env, 'UMICH_MCP_RATE_PER_MINUTE', 120, 600),
    maxConcurrentPerIp: positiveInt(env, 'UMICH_MCP_MAX_CONCURRENT_PER_IP', 4, 32),
    maxConcurrentTotal: positiveInt(env, 'UMICH_MCP_MAX_CONCURRENT_TOTAL', 16, 128),
    bearerTokenSha256,
  };
}
