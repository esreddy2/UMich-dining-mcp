import { afterEach, describe, expect, it, vi } from 'vitest';
import { breakerState, fetchText, resetBreaker } from '../src/http.js';
import { parseTimeOfDay, isOpenAtMinutes } from '../src/service.js';
import { ServiceError } from '../src/service.js';

const URL_UNDER_TEST = 'https://dining.umich.edu/menus-locations/dining-halls/bursley/';

describe('the circuit breaker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetBreaker();
  });

  it('is closed at the start', () => {
    expect(breakerState().open).toBe(false);
    expect(breakerState().failures).toBe(0);
  });

  it('opens after a run of refusals and pauses the fetches', async () => {
    vi.stubGlobal('fetch', async (): Promise<Response> => new Response('forbidden', { status: 403 }));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(fetchText(URL_UNDER_TEST)).rejects.toThrow();
    }

    const host = new URL(URL_UNDER_TEST).hostname;
    expect(breakerState(host).open).toBe(true);
    expect(breakerState(host).failures).toBeGreaterThanOrEqual(5);
  });

  it('closes again after a success', async () => {
    vi.stubGlobal('fetch', async (): Promise<Response> => new Response('forbidden', { status: 403 }));
    await expect(fetchText(URL_UNDER_TEST)).rejects.toThrow();
    resetBreaker();

    vi.stubGlobal('fetch', async (): Promise<Response> => new Response('<html>ok</html>', { status: 200 }));
    await fetchText(URL_UNDER_TEST);
    const host = new URL(URL_UNDER_TEST).hostname;
    expect(breakerState(host).open).toBe(false);
    expect(breakerState(host).failures).toBe(0);
  });
});

describe('the time of day', () => {
  it('reads a 24-hour time', () => {
    expect(parseTimeOfDay('12:30')).toBe(12 * 60 + 30);
    expect(parseTimeOfDay('00:15')).toBe(15);
    expect(parseTimeOfDay('23:59')).toBe(23 * 60 + 59);
  });

  it('reads a time with a meridiem', () => {
    expect(parseTimeOfDay('7:05 pm')).toBe(19 * 60 + 5);
    expect(parseTimeOfDay('12:00 am')).toBe(0);
    expect(parseTimeOfDay('12:00 pm')).toBe(12 * 60);
  });

  it('rejects a time that is not one', () => {
    expect(() => parseTimeOfDay('half past twelve')).toThrow(ServiceError);
    expect(() => parseTimeOfDay('12:75')).toThrow(/minutes/);
  });
});

describe('the service periods of a day', () => {
  it('covers the minutes it publishes', () => {
    const periods = [{ label: 'Breakfast', times: '9:00 am - 10:30 am', closed: false }];
    expect(isOpenAtMinutes(periods, 9 * 60)).toBe(true);
    expect(isOpenAtMinutes(periods, 10 * 60)).toBe(true);
    expect(isOpenAtMinutes(periods, 11 * 60)).toBe(false);
  });

  it('never covers a closed period', () => {
    const periods = [{ label: 'Dinner', times: '5:00 pm - 8:00 pm', closed: true }];
    expect(isOpenAtMinutes(periods, 18 * 60)).toBe(false);
  });
});
