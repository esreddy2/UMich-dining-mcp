import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The rate the site is asked at.
 *
 * The limiter promises the university that the server asks for at most one
 * page every `UMICH_DINING_MIN_GAP_MS`. The limit used to be scheduled in
 * parallel, so two requests could leave in the same millisecond: four per
 * second against a site that was promised two.
 */
describe('the upstream limiter', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('starts the requests the gap apart', async () => {
    vi.stubEnv('UMICH_DINING_MIN_GAP_MS', '120');
    vi.stubEnv('UMICH_DINING_MAX_CONCURRENCY', '4');

    const starts: number[] = [];
    vi.stubGlobal('fetch', async (): Promise<Response> => {
      starts.push(Date.now());
      return new Response('<html>ok</html>', { status: 200 });
    });

    const { fetchText } = await import('../src/http.js');
    const url = 'https://dining.umich.edu/menus-locations/dining-halls/bursley/';

    const before = Date.now();
    await Promise.all([
      fetchText(url),
      fetchText(url),
      fetchText(url),
      fetchText(url),
    ]);
    const elapsed = Date.now() - before;

    expect(starts).toHaveLength(4);
    // Four requests, each 120 ms apart, take at least three gaps.
    expect(elapsed).toBeGreaterThanOrEqual(120 * 3);

    // No two requests start in the same 50 ms window.
    for (let index = 1; index < starts.length; index += 1) {
      const gap = starts[index]! - starts[index - 1]!;
      expect(gap, `request ${index} started ${gap} ms after the previous one`).toBeGreaterThanOrEqual(100);
    }
  });

  it('lets a live request go before a waiting background one', async () => {
    vi.stubEnv('UMICH_DINING_MIN_GAP_MS', '0');
    vi.stubEnv('UMICH_DINING_MAX_CONCURRENCY', '1');

    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const kind = url.includes('held') ? 'held' : url.includes('background') ? 'background' : 'foreground';
      if (kind === 'held') await held;
      order.push(kind);
      return new Response('<html>ok</html>', { status: 200 });
    });

    const { fetchText } = await import('../src/http.js');

    // The only slot is taken by a background request that is still running.
    const first = fetchText('https://dining.umich.edu/held', { background: true });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // A second background request and a live one are both waiting.
    const second = fetchText('https://dining.umich.edu/background', { background: true });
    const foreground = fetchText('https://dining.umich.edu/foreground');

    release();
    await Promise.all([first, second, foreground]);

    expect(order).toEqual(['held', 'foreground', 'background']);
  });
});
