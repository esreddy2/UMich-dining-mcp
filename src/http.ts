import { config } from './config.js';

export type HttpFailureKind = 'network' | 'timeout' | 'http' | 'blocked';

export interface UpstreamFailure { at: string; kind: HttpFailureKind; status: number | undefined }
let lastUpstreamFailure: UpstreamFailure | null = null;

/** Sanitized monitoring state; no URLs, HTML or user-provided data. */
export function getLastUpstreamFailure(): UpstreamFailure | null {
  return lastUpstreamFailure;
}

/**
 * A short name for the upstream page.
 *
 * The full URL is kept on the error for the logs, but it is not echoed to the
 * client: a public endpoint that repeats its own upstream URL tells a reader
 * more than it needs to know.
 */
export function upstreamName(url: string): string {
  try {
    const parsed = new URL(url);
    const match = /\/menus-locations\/(.+?)\/?$/.exec(parsed.pathname);
    return match ? match[1]! : parsed.hostname;
  } catch {
    return 'the dining site';
  }
}

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
    lastUpstreamFailure = { at: new Date().toISOString(), kind, status };
  }
}

/** Raised when the site answers with a Cloudflare challenge instead of a page. */
export class BlockedError extends HttpError {
  constructor(message: string, url: string) {
    super('blocked', message, url);
    this.name = 'BlockedError';
  }
}

const CLOUDFLARE_MARKERS = ['cf-browser-verification', 'cf_chl_opt', 'challenge-platform', '__cf_chl_'];

export function looksBlocked(html: string): boolean {
  const head = html.slice(0, 4000).toLowerCase();
  if (CLOUDFLARE_MARKERS.some((marker) => head.includes(marker))) return true;
  const title = /<title[^>]*>(.*?)<\/title>/i.exec(head)?.[1]?.toLowerCase() ?? '';
  return (
    title.includes('just a moment') ||
    title.includes('attention required') ||
    title.includes('access denied')
  );
}

let workingUserAgent: string | null = null;
/** Consecutive failures with the latched fallback User-Agent; resets it after N. */
let fallbackFailures = 0;
const FALLBACK_FAILURE_THRESHOLD = 5;

export function currentUserAgent(): string {
  return workingUserAgent ?? config.userAgent;
}

/** Forget the remembered User-Agent, e.g. after a configuration change. */
export function resetUserAgent(): void {
  workingUserAgent = null;
  fallbackFailures = 0;
}

/**
 * The circuit breaker.
 *
 * After a run of consecutive upstream failures the fetches pause for a
 * cooldown, so the warmer cannot hammer a site that is refusing the server.
 * A single success opens the circuit again.
 */
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 60_000;

/** Per-host failure counts and breaker open times, so one failing host does not take down a healthy one. */
const failuresByHost = new Map<string, number>();
const breakerOpenByHost = new Map<string, number>();

export function breakerState(host: string = 'global', now: number = Date.now()): { open: boolean; failures: number } {
  const failures = failuresByHost.get(host) ?? 0;
  const openUntil = breakerOpenByHost.get(host) ?? 0;
  return { open: now < openUntil, failures };
}

function recordSuccess(host: string): void {
  failuresByHost.set(host, 0);
  breakerOpenByHost.set(host, 0);
}

function recordFailure(host: string): void {
  const failures = (failuresByHost.get(host) ?? 0) + 1;
  failuresByHost.set(host, failures);
  if (failures >= BREAKER_THRESHOLD) {
    breakerOpenByHost.set(host, Date.now() + BREAKER_COOLDOWN_MS);
  }
}

/** Reset the breaker; used by the tests. */
export function resetBreaker(): void {
  failuresByHost.clear();
  breakerOpenByHost.clear();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * A global politeness limiter: at most `maxConcurrentRequests` requests in
 * flight and at least `minRequestGapMs` between the start of two requests.
 *
 * The gap is enforced at the start gate, which one request at a time passes:
 * a request takes its turn, waits out whatever is left of the gap and claims
 * the next start time. Scheduling the waits in parallel would let two
 * requests leave at the same moment, which is twice the rate the site was
 * promised.
 *
 * A background request (the cache warmer) never stands in front of a live
 * one: a waiting foreground request is always served first.
 */
class RateLimiter {
  private active = 0;
  private foreground: (() => void)[] = [];
  private background: (() => void)[] = [];
  private foregroundWaiting = 0;
  /** The earliest time the next request may start. */
  private nextStartAt = 0;
  /** The chain of the start gate: one request at a time passes it. */
  private gate: Promise<void> = Promise.resolve();

  async run<T>(task: () => Promise<T>, options: { background?: boolean } = {}): Promise<T> {
    await this.acquire(options.background === true);
    try {
      await this.passGate();
      return await task();
    } finally {
      this.active -= 1;
      this.pump();
    }
  }

  /**
   * Wait for the turn and for the gap, then claim the next start time.
   */
  private async passGate(): Promise<void> {
    const previous = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const wait = this.nextStartAt - Date.now();
      if (wait > 0) await delay(wait);
      this.nextStartAt = Date.now() + config.minRequestGapMs;
    } finally {
      release();
    }
  }

  private acquire(isBackground: boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      const grant = () => resolve();
      if (isBackground) this.background.push(grant);
      else {
        this.foregroundWaiting += 1;
        this.foreground.push(grant);
      }
      this.pump();
    });
  }

  private pump(): void {
    // Reserve one slot for foreground traffic when a foreground request is
    // waiting, so a hung background request cannot hold every slot.
    const backgroundLimit = this.foregroundWaiting > 0
      ? Math.max(0, config.maxConcurrentRequests - 1)
      : config.maxConcurrentRequests;

    while (this.active < backgroundLimit) {
      let grant: (() => void) | undefined;
      if (this.foregroundWaiting > 0) {
        grant = this.foreground.shift();
        if (grant) this.foregroundWaiting -= 1;
      } else {
        grant = this.background.shift();
      }
      if (!grant) break;
      this.active += 1;
      grant();
    }

    // Grant the reserved foreground slot when one is free.
    while (this.foregroundWaiting > 0 && this.active < config.maxConcurrentRequests) {
      const grant = this.foreground.shift();
      if (!grant) break;
      this.foregroundWaiting -= 1;
      this.active += 1;
      grant();
    }
  }
}

const limiter = new RateLimiter();

interface FetchOptions {
  /** Override the User-Agent for this request. */
  userAgent?: string;
  signal?: AbortSignal;
  /** Run the request in the background; a live request always goes first. */
  background?: boolean;
}

async function requestText(url: string, options: FetchOptions): Promise<{ status: number; html: string; retryAfterMs: number | null }> {
  // Honour an already-aborted signal: an event listener added after the fact
  // never fires, so abort immediately instead of running the request to its
  // own timeout.
  if (options.signal?.aborted) {
    throw new HttpError('timeout', `The request for ${upstreamName(url)} timed out after ${config.timeoutMs}ms`, url);
  }

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

    // Refuse an oversized body before reading it: Content-Length is the wire
    // size (possibly gzip-compressed), so anything already above the cap can
    // never decompress to something acceptable.
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null) {
      const length = Number.parseInt(contentLength, 10);
      if (!Number.isNaN(length) && length > config.maxBodyBytes) {
        throw new HttpError(
          'http',
          `The response from ${upstreamName(url)} is too large (${length} bytes, cap ${config.maxBodyBytes})`,
          url,
          response.status,
        );
      }
    }

    // Read the (decompressed) body as a stream and abort at the byte ceiling,
    // so a gzip bomb cannot allocate tens of megabytes in the heap.
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > config.maxBodyBytes) {
          reader.releaseLock();
          throw new HttpError(
            'http',
            `The response from ${upstreamName(url)} exceeds the body limit of ${config.maxBodyBytes} bytes`,
            url,
            response.status,
          );
        }
        chunks.push(value);
      }
    }
    const html = decoder.decode(Buffer.concat(chunks));
    return {
      status: response.status,
      html,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // An abort is always a timeout: either this request's own deadline ran out
    // or the caller aborted it (the call budget, a range cut-off, ...). A
    // non-aborted failure is a network problem.
    if (controller.signal.aborted || options.signal?.aborted) {
      throw new HttpError('timeout', `The request for ${upstreamName(url)} timed out after ${config.timeoutMs}ms`, url);
    }
    throw new HttpError('network', `The request for ${upstreamName(url)} failed: ${(error as Error).message}`, url);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Parse a `Retry-After` header into a delay in milliseconds, or null. */
function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number.parseInt(value, 10);
  if (!Number.isNaN(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
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
  const host = new URL(url).hostname;
  if (breakerState(host).open) {
    throw new HttpError(
      'blocked',
      `The dining site refused ${breakerState(host).failures} requests in a row; the fetches are paused for a minute.`,
      url,
    );
  }

  let attempt = 0;
  let lastError: HttpError | undefined;

  while (attempt <= config.maxRetries) {
    if (options.signal?.aborted) break;
    attempt += 1;
    try {
      const response = await limiter.run(() => requestText(url, options), {
        background: options.background === true,
      });
      const { status, html, retryAfterMs } = response;

      if (status === 403) {
        const fallback = config.fallbackUserAgent;

        // Try the fallback User-Agent. The configured primary was just refused;
        // retrying it within the same call is pointless.
        const retry = await limiter.run(() => requestText(url, { ...options, userAgent: fallback }), {
          background: options.background === true,
        });
        if (retry.status === 200) {
          workingUserAgent = fallback;
          fallbackFailures = 0;
          process.stderr.write(`User-Agent latched to fallback ${fallback} after 403 on ${upstreamName(url)}\n`);
          recordSuccess(host);
          return retry.html;
        }
        if (isRetryableStatus(retry.status)) {
          lastError = new HttpError('http', `The request for ${upstreamName(url)} failed with HTTP ${retry.status}`, url, retry.status);
          await delay(retry.retryAfterMs ?? config.retryBaseDelayMs * 2 ** (attempt - 1) + Math.random() * config.retryBaseDelayMs);
          continue;
        }

        // The fallback also failed: count it and reset the latch after N failures.
        fallbackFailures += 1;
        if (fallbackFailures >= FALLBACK_FAILURE_THRESHOLD) {
          workingUserAgent = null;
          fallbackFailures = 0;
          process.stderr.write(`User-Agent fallback latch reset after ${FALLBACK_FAILURE_THRESHOLD} failures\n`);
        }
        recordFailure(host);
        throw new HttpError(
          'http',
          `The request for ${upstreamName(url)} was refused with HTTP ${retry.status}. The site only answers the User-Agent it allows; ` +
            'set UMICH_DINING_USER_AGENT if the policy has changed.',
          url,
          retry.status,
        );
      }

      if (isRetryableStatus(status)) {
        lastError = new HttpError('http', `The request for ${upstreamName(url)} failed with HTTP ${status}`, url, status);
        await delay(retryAfterMs ?? config.retryBaseDelayMs * 2 ** (attempt - 1) + Math.random() * config.retryBaseDelayMs);
        continue;
      }

      if (status !== 200) {
        recordFailure(host);
        throw new HttpError('http', `The request for ${upstreamName(url)} failed with HTTP ${status}`, url, status);
      }

      if (looksBlocked(html)) {
        recordFailure(host);
        throw new BlockedError(
          `The request for ${upstreamName(url)} was answered with a Cloudflare challenge instead of the page.`,
          url,
        );
      }

      recordSuccess(host);
      return html;
    } catch (error) {
      if (error instanceof BlockedError) throw error;
      if (error instanceof HttpError && error.kind === 'http' && error.status !== 429 && (error.status ?? 0) < 500) {
        throw error;
      }
      lastError = error instanceof HttpError ? error : new HttpError('network', (error as Error).message, url);
      if (attempt > config.maxRetries) break;
      await delay(config.retryBaseDelayMs * 2 ** (attempt - 1) + Math.random() * config.retryBaseDelayMs);
    }
  }

  recordFailure(host);
  throw lastError ?? new HttpError('network', `The request for ${upstreamName(url)} failed`, url);
}
