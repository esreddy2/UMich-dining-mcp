/** A bounded per-client token bucket, for public HTTP requests only. */
export class HttpRequestLimiter {
  private readonly clients = new Map<string, { tokens: number; updated: number; active: number }>();
  private activeTotal = 0;
  private readonly maxTrackedIps = 4096;

  constructor(
    private readonly perMinute: number,
    private readonly perIpConcurrent: number,
    private readonly globalConcurrent: number,
  ) {}

  /**
   * Take a slot for a client.
   *
   * A client that has spent its budget is refused with 429 and told how long
   * to wait. A client that is refused because the server is at its capacity
   * is refused with 503: the two are different problems and a client that
   * waits ten seconds for a capacity problem waits for nothing.
   */
  acquire(
    ip: string,
    now = Date.now(),
  ): { release: () => void } | { status: 429 | 503; retryAfter: number } {
    let bucket = this.clients.get(ip);
    if (!bucket) {
      if (this.clients.size >= this.maxTrackedIps) this.prune(now);
      if (this.clients.size >= this.maxTrackedIps) return { status: 503, retryAfter: 1 };
      bucket = { tokens: this.perMinute, updated: now, active: 0 };
      this.clients.set(ip, bucket);
    }
    bucket.tokens = Math.min(this.perMinute, bucket.tokens + ((now - bucket.updated) * this.perMinute) / 60_000);
    bucket.updated = now;
    if (bucket.tokens < 1) {
      // The time until one token is whole again.
      const refillMs = ((1 - bucket.tokens) * 60_000) / this.perMinute;
      return { status: 429, retryAfter: Math.max(1, Math.ceil(refillMs / 1000)) };
    }
    if (bucket.active >= this.perIpConcurrent || this.activeTotal >= this.globalConcurrent) {
      return { status: 503, retryAfter: 1 };
    }
    bucket.tokens -= 1;
    bucket.active += 1;
    this.activeTotal += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        bucket.active -= 1;
        this.activeTotal -= 1;
      },
    };
  }

  private prune(now: number): void {
    for (const [ip, bucket] of this.clients) {
      if (bucket.active === 0 && now - bucket.updated > 120_000) this.clients.delete(ip);
    }
  }
}
