/**
 * Runtime configuration. Everything is environment driven so an operator can
 * adjust the request profile without a rebuild.
 */

import { CAMPUS_TIMEZONE } from './clock.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export interface Config {
  /** Origin of the dining site. Overridable for tests and mirrors. */
  baseUrl: string;
  /**
   * The only User-Agent measured to return HTTP 200 from dining.umich.edu
   * (a generic fetch UA and a headless-Chrome UA both get 403). It is not our
   * real identity, so it is configurable and documented in the README.
   */
  userAgent: string;
  /** The UA tried when the primary one is refused with a 403. */
  fallbackUserAgent: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Retries after the first attempt on network errors, 5xx and 429. */
  maxRetries: number;
  /** Base delay of the exponential backoff between retries. */
  retryBaseDelayMs: number;
  /** Maximum simultaneous requests to the dining site. */
  maxConcurrentRequests: number;
  /** Minimum gap between two requests to the dining site. */
  minRequestGapMs: number;
  /** Time zone the site publishes "today" in. */
  timezone: string;
  /** Accepted menu dates, relative to today. */
  dateWindow: { minDays: number; maxDays: number };
  /** Cache lifetimes, in milliseconds. */
  ttl: {
    todayMenu: number;
    futureMenu: number;
    pastMenu: number;
    regularHours: number;
  };
  /** How many upstream pages a single range query may fetch. */
  maxRangeFetches: number;
  /** The wall-clock budget of a single tool call, in milliseconds. */
  callBudgetMs: number;
  /** The largest upstream response body that will be read, in bytes. */
  maxBodyBytes: number;
  /** Where the persistent cache lives, or null when it is disabled. */
  cacheDir: string | null;
  /** How long a persistent cache entry is kept, in days. */
  cacheMaxAgeDays: number;
  /** The largest the persistent cache may grow, in megabytes. */
  cacheMaxSizeMb: number;
  /** How often the persistent cache is pruned, in milliseconds. */
  cachePruneIntervalMs: number;
  /** Fraction of TTL after which a fresh entry is revalidated in the background. */
  cacheRefreshThreshold: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    baseUrl: (env['UMICH_DINING_BASE_URL'] ?? 'https://dining.umich.edu').replace(/\/+$/, ''),
    userAgent: env['UMICH_DINING_USER_AGENT'] ?? 'python-requests/2.32.3',
    fallbackUserAgent: env['UMICH_DINING_FALLBACK_USER_AGENT'] ?? 'python-requests/2.32.3',
    timeoutMs: intFromEnv(env, 'UMICH_DINING_TIMEOUT_MS', 20_000),
    maxRetries: intFromEnv(env, 'UMICH_DINING_MAX_RETRIES', 3),
    retryBaseDelayMs: intFromEnv(env, 'UMICH_DINING_RETRY_BASE_MS', 500),
    maxConcurrentRequests: intFromEnv(env, 'UMICH_DINING_MAX_CONCURRENCY', 2),
    minRequestGapMs: intFromEnv(env, 'UMICH_DINING_MIN_GAP_MS', 500),
    /** Time zone the site publishes "today" in: the campus, EST/EDT. */
    timezone: env['UMICH_DINING_TIMEZONE'] ?? CAMPUS_TIMEZONE,
    dateWindow: { minDays: -3, maxDays: 14 },
    ttl: {
      todayMenu: intFromEnv(env, 'UMICH_DINING_TTL_TODAY_MS', 15 * MINUTE),
      futureMenu: intFromEnv(env, 'UMICH_DINING_TTL_FUTURE_MS', 6 * HOUR),
      pastMenu: intFromEnv(env, 'UMICH_DINING_TTL_PAST_MS', 24 * HOUR),
      regularHours: intFromEnv(env, 'UMICH_DINING_TTL_REGULAR_HOURS_MS', 24 * HOUR),
    },
    maxRangeFetches: intFromEnv(env, 'UMICH_DINING_MAX_RANGE_FETCHES', 12),
    callBudgetMs: intFromEnv(env, 'UMICH_DINING_CALL_BUDGET_MS', 25_000),
    maxBodyBytes: intFromEnv(env, 'UMICH_DINING_MAX_BODY_BYTES', 8 * 1024 * 1024),
    cacheDir: cacheDirFromEnv(env),
    cacheMaxAgeDays: intFromEnv(env, 'UMICH_DINING_CACHE_MAX_AGE_DAYS', 30),
    cacheMaxSizeMb: intFromEnv(env, 'UMICH_DINING_CACHE_MAX_SIZE_MB', 200),
    cachePruneIntervalMs: intFromEnv(env, 'UMICH_DINING_CACHE_PRUNE_INTERVAL_MS', 60 * MINUTE),
    cacheRefreshThreshold: (() => {
      const raw = env['UMICH_DINING_CACHE_REFRESH_THRESHOLD'];
      if (raw === undefined || raw.trim() === '') return 0.6;
      const value = Number.parseFloat(raw);
      return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.6;
    })(),
  };
}

function cacheDirFromEnv(env: NodeJS.ProcessEnv): string | null {
  const raw = env['UMICH_DINING_CACHE_DIR'];
  if (raw !== undefined && raw.trim().toLowerCase() === 'off') return null;
  if (raw !== undefined && raw.trim() !== '') return raw.trim();
  return `${process.env['HOME'] ?? '/tmp'}/.cache/umich-dining-mcp`;
}

export const config: Config = loadConfig();
