import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cache } from '../src/cache.js';
import { ServiceError, countItems, getMenu, todayIn, validateDate } from '../src/service.js';
import { readFixture } from './helpers.js';

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The datepicker markup the site builds in the browser. */
function datepickerMarkup(date: string): string {
  const [year, month, day] = date.split('-');
  return `<div class="ui-datepicker-inline ui-datepicker">
      <div class="ui-datepicker-title">
        <span class="ui-datepicker-month">${MONTH_NAMES[Number(month) - 1]}</span>&nbsp;<span class="ui-datepicker-year">${year}</span>
      </div>
      <table><tbody><tr><td><a class="ui-state-default ui-state-active" href="#">${Number(day)}</a></td></tr></tbody></table>
    </div>`;
}

function withDatepicker(date: string): string {
  return readFixture('bursley.html').replace('</body>', `${datepickerMarkup(date)}</body>`);
}

/**
 * The site serves a different day's menu when the requested date is outside
 * the range its datepicker allows, so the range is checked before anything is
 * fetched and the date the page rendered is compared with the requested one.
 */
describe('date handling', () => {
  beforeEach(() => {
    cache.clear();
    vi.unstubAllGlobals();
  });

  it('rejects a date outside today-3 days .. today+14 days', () => {
    const today = '2026-10-20';
    expect(() => validateDate('2026-10-17', today)).not.toThrow();
    expect(() => validateDate('2026-11-03', today)).not.toThrow();
    expect(() => validateDate('2026-10-16', today)).toThrow(/outside the range/);
    expect(() => validateDate('2026-11-04', today)).toThrow(/outside the range/);
    expect(() => validateDate('2026-10-20', today)).not.toThrow();
  });

  it('rejects a malformed date', () => {
    expect(() => validateDate('20-10-2026', '2026-10-20')).toThrow(/not a valid date/);
    expect(() => validateDate('2026-13-01', '2026-10-20')).toThrow(/not a valid date/);
    expect(() => validateDate('2026-02-30', '2026-10-20')).toThrow(/not a valid date/);
  });

  it('rejects an out-of-range date before any request is made', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      return new Response(readFixture('bursley.html'), { status: 200 });
    });

    const today = todayIn();
    const far = new Date(`${today}T00:00:00Z`);
    far.setUTCDate(far.getUTCDate() + 40);
    const outOfRange = far.toISOString().slice(0, 10);

    await expect(getMenu('bursley', outOfRange)).rejects.toThrow(ServiceError);
    expect(calls).toHaveLength(0);
  });

  it('fails when the page rendered another day', async () => {
    vi.stubGlobal('fetch', async (): Promise<Response> =>
      new Response(withDatepicker('2019-10-20'), { status: 200 }),
    );

    await expect(getMenu('bursley')).rejects.toThrow(/returned the menu for 2019-10-20/);
  });

  it('accepts a page that rendered the requested day', async () => {
    const today = todayIn();
    vi.stubGlobal('fetch', async (): Promise<Response> =>
      new Response(withDatepicker(today), { status: 200 }),
    );

    const page = await getMenu('bursley', today);
    expect(page.menu.renderedDate).toBe(today);
    expect(countItems(page.menu.meals)).toBe(66);
  });

  it('fails when no menu is published for the day', async () => {
    const empty = `<html><body><div id="mdining-items">
        <h3><a href="#"><i class="fa fa-minus"></i> Dinner</a></h3>
        <div class="courses"><ul class="courses_wrapper"><li><h4>Empty Station</h4><ul class="items"></ul></li></ul></div>
      </div></body></html>`;
    vi.stubGlobal('fetch', async (): Promise<Response> => new Response(empty, { status: 200 }));

    await expect(getMenu('bursley')).rejects.toThrow(/No menu is published/);
  });
});
