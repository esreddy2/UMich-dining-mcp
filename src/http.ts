import { config } from './config.js';

export type HttpFailureKind = 'network' | 'timeout' | 'http' | 'blocked';

export class HttpError extends Error {
  readonly kind: HttpFailureKind;
  readonly status: number | undefined;
  readonly url: string;

  constructor(kind: HttpFailureKind, message: string, url: string, status?: number) {
    super(message);
    this.name = 'HttpError';
    this.kind = kind;
    this.status = status;
    this.url = url;
  }
}

/** Raised when the site answers with a Cloudflare challenge instead of a page. */
export class BlockedError extends HttpError {
  constructor(message: string, url: string) {
    super('blocked', message, url);
    this.name = 'BlockedError';
  }
}

const CLOUDFLARE_MARKERS = ['just a moment', 'checking your browser', 'cf-browser-verification', 'enable javascript and cookies'];

export function looksBlocked(html: string): boolean {
  const head = html.slice(0, 4000).toLowerCase();
  if (head.includes('cf-browser-verification') || head.includes('cf_chl_opt')) return true;
  if (head.includes('just a moment') && !head.includes('mdining-items')) return true;
  return CLOUDFLARE_MARKERS.some((marker) => head.includes(marker));
}

let workingUserAgent: string | null = null;

export function currentUserAgent(): string {
  return workingUserAgent ?? config.userAgent;
}

/** Forget the remembered User-Agent, e.g. after a configuration change. */
export function resetUserAgent(): void {
  workingUserAgent = null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * A global politeness limiter: at most `maxConcurrentRequests` requests in
 * flight and at least `minRequestGapMs` between the start of two requests.
 */
class RateLimiter {
  private active = 0;
  private queue: (() => void)[] = [];
  private lastStartedAt = 0;

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      this.lastStartedAt = Date.now();
      return await task();
    } finally {
      this.active -= 1;
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < config.maxConcurrentRequests) {
      this.active += 1;
      return this.waitForGap();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
  }

  private async waitForGap(): Promise<void> {
    const elapsed = Date.now() - this.lastStartedAt;
    const wait = config.minRequestGapMs - elapsed;
    if (wait > 0) await delay(wait);
  }
}

const limiter = new RateLimiter();

interface FetchOptions {
  /** Override the User-Agent for this request. */
  userAgent?: string;
  signal?: AbortSignal;
}

async function requestText(url: string, options: FetchOptions): Promise<{ status: number; html: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': options.userAgent ?? currentUserAgent(),
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    const html = await response.text();
    return { status: response.status, html };
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new HttpError('timeout', `Request to ${url} timed out after ${config.timeoutMs}ms`, url);
    }
    throw new HttpError('network', `Request to ${url} failed: ${(error as Error).message}`, url);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Fetch a page from the dining site.
 *
 * - The User-Agent defaults to the only one measured to return HTTP 200.
 * - A 403 triggers one retry with the fallback User-Agent; if that works, the
 *   working User-Agent is remembered for the rest of the process.
 * - Network errors, 5xx and 429 are retried with an exponential backoff.
 * - A Cloudflare challenge page is reported as a block, never as content.
 */
export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  let attempt = 0;
  let lastError: HttpError | undefined;

  while (attempt <= config.maxRetries) {
    attempt += 1;
    try {
      const { status, html } = await limiter.run(() => requestText(url, options));

      if (status === 403) {
        const fallback = config.fallbackUserAgent;
        const primary = options.userAgent ?? currentUserAgent();
        if (primary !== fallback) {
          const retry = await limiter.run(() => requestText(url, { ...options, userAgent: fallback }));
          if (retry.status === 200) {
            workingUserAgent = fallback;
            return retry.html;
          }
          if (isRetryableStatus(retry.status)) {
            lastError = new HttpError('http', `Request to ${url} failed with HTTP ${retry.status}`, url, retry.status);
            await delay(config.retryBaseDelayMs * 2 ** (attempt - 1));
            continue;
          }
          throw new HttpError('http', `Request to ${url} was refused with HTTP ${retry.status}`, url, retry.status);
        }
        throw new HttpError(
          'http',
          `Request to ${url} was refused with HTTP 403. The site only answers the User-Agent it allows; ` +
            'set UMICH_DINING_USER_AGENT if the policy has changed.',
          url,
          403,
        );
      }

      if (isRetryableStatus(status)) {
        lastError = new HttpError('http', `Request to ${url} failed with HTTP ${status}`, url, status);
        await delay(config.retryBaseDelayMs * 2 ** (attempt - 1));
        continue;
      }

      if (status !== 200) {
        throw new HttpError('http', `Request to ${url} failed with HTTP ${status}`, url, status);
      }

      if (looksBlocked(html)) {
        throw new BlockedError(
          `Request to ${url} was answered with a Cloudflare challenge instead of the page.`,
          url,
        );
      }

      return html;
    } catch (error) {
      if (error instanceof BlockedError) throw error;
      if (error instanceof HttpError && error.kind === 'http' && error.status !== 429 && (error.status ?? 0) < 500) {
        throw error;
      }
      lastError = error instanceof HttpError ? error : new HttpError('network', (error as Error).message, url);
      if (attempt > config.maxRetries) break;
      await delay(config.retryBaseDelayMs * 2 ** (attempt - 1));
    }
  }

  throw lastError ?? new HttpError('network', `Request to ${url} failed`, url);
}
