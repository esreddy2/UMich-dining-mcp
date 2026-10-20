import { afterEach, describe, expect, it, vi } from 'vitest';

interface FetchCall {
  url: string;
  agent: string;
}

function recorder(): { calls: FetchCall[]; respond: (handler: (call: FetchCall) => Response) => void } {
  const calls: FetchCall[] = [];
  const respond = (handler: (call: FetchCall) => Response): void => {
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const agent = String((init?.headers as Record<string, string> | undefined)?.['User-Agent'] ?? '');
      const call = { url, agent };
      calls.push(call);
      return handler(call);
    });
  };
  return { calls, respond };
}

const URL_UNDER_TEST = 'https://dining.umich.edu/menus-locations/dining-halls/bursley/';

describe('http layer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    delete process.env['UMICH_DINING_USER_AGENT'];
  });

  it('sends the User-Agent the site accepts', async () => {
    const { fetchText } = await import('../src/http.js');
    const mock = recorder();
    mock.respond(() => new Response('<html>ok</html>', { status: 200 }));

    const html = await fetchText(URL_UNDER_TEST);
    expect(html).toContain('ok');
    expect(mock.calls[0]?.agent).toBe('python-requests/2.32.3');
  });

  it('falls back to the working User-Agent when a request is refused', async () => {
    vi.resetModules();
    process.env['UMICH_DINING_USER_AGENT'] = 'some-other-agent/1.0';
    const { fetchText } = await import('../src/http.js');

    const mock = recorder();
    mock.respond((call) =>
      call.agent === 'python-requests/2.32.3'
        ? new Response('<html>ok</html>', { status: 200 })
        : new Response('forbidden', { status: 403 }),
    );

    const html = await fetchText(URL_UNDER_TEST);
    expect(html).toContain('ok');
    expect(mock.calls.map((call) => call.agent)).toEqual([
      'some-other-agent/1.0',
      'python-requests/2.32.3',
    ]);
  });

  it('names the User-Agent policy when the site refuses the request', async () => {
    const { fetchText } = await import('../src/http.js');
    const mock = recorder();
    mock.respond(() => new Response('forbidden', { status: 403 }));

    await expect(fetchText(URL_UNDER_TEST)).rejects.toThrow(/User-Agent/);
  });

  it('retries a server error and reports it when it keeps failing', async () => {
    const { fetchText } = await import('../src/http.js');
    const mock = recorder();
    mock.respond(() => new Response('boom', { status: 503 }));

    await expect(fetchText(URL_UNDER_TEST)).rejects.toThrow(/503/);
    expect(mock.calls.length).toBeGreaterThan(1);
  });

  it('treats a Cloudflare challenge as a block', async () => {
    const { fetchText } = await import('../src/http.js');
    const mock = recorder();
    mock.respond(
      () =>
        new Response(
          '<!doctype html><html><head><title>Just a moment...</title></head><body><div id="cf-browser-verification"></div></body></html>',
          { status: 200 },
        ),
    );

    await expect(fetchText(URL_UNDER_TEST)).rejects.toThrow(/Cloudflare challenge/);
  });

  it('does not mistake a normal page for a challenge', async () => {
    const { fetchText } = await import('../src/http.js');
    const mock = recorder();
    mock.respond(
      () =>
        new Response('<!doctype html><html><head><title>Bursley | M|Dining</title></head><body><noscript>enable javascript to see the calendar</noscript></body></html>', {
          status: 200,
        }),
    );

    await expect(fetchText(URL_UNDER_TEST)).resolves.toContain('Bursley');
  });
});
