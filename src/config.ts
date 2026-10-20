/**
 * Runtime configuration. Everything is environment driven so an operator can
 * adjust the request profile without a rebuild.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    baseUrl: (env['UMICH_DINING_BASE_URL'] ?? 'https://dining.umich.edu').replace(/\/+$/, ''),
    userAgent: env['UMICH_DINING_USER_AGENT'] ?? 'python-requests/2.32.3',
    fallbackUserAgent: 'python-requests/2.32.3',
    timeoutMs: intFromEnv(env, 'UMICH_DINING_TIMEOUT_MS', 20_000),
    maxRetries: intFromEnv(env, 'UMICH_DINING_MAX_RETRIES', 3),
    retryBaseDelayMs: intFromEnv(env, 'UMICH_DINING_RETRY_BASE_MS', 500),
    maxConcurrentRequests: intFromEnv(env, 'UMICH_DINING_MAX_CONCURRENCY', 2),
    minRequestGapMs: intFromEnv(env, 'UMICH_DINING_MIN_GAP_MS', 500),
    timezone: env['UMICH_DINING_TIMEZONE'] ?? 'America/Detroit',
    dateWindow: { minDays: -3, maxDays: 14 },
    ttl: {
      todayMenu: intFromEnv(env, 'UMICH_DINING_TTL_TODAY_MS', 15 * MINUTE),
      futureMenu: intFromEnv(env, 'UMICH_DINING_TTL_FUTURE_MS', 6 * HOUR),
      pastMenu: intFromEnv(env, 'UMICH_DINING_TTL_PAST_MS', 24 * HOUR),
      regularHours: intFromEnv(env, 'UMICH_DINING_TTL_REGULAR_HOURS_MS', 24 * HOUR),
    },
  };
}

export const config: Config = loadConfig();
