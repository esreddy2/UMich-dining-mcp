import { describe, expect, it } from 'vitest';
import { load } from 'cheerio';
import { expandDays, parseRegularHours, parseTimeRange, parseTodaysHours } from '../src/parser/hours.js';
import {
  HALL_FIXTURES,
  readExpectedRegularHours,
  readFixture,
  type ExpectedRegularHours,
} from './helpers.js';

/**
 * The hours of the site, checked against the markup they are written in.
 *
 * The regular hours page writes one table per group of locations: a row with
 * a heading names the location and links to its menu page, and the rows below
 * carry the days and the service periods.  The pages of the halls write the
 * periods of the selected day in a `ul.calhours` block.
 */

const HALLS = Object.keys(HALL_FIXTURES);

/** The text of a fragment of markup without its tags and comments. */
function text(markup: string): string {
  return markup
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#8209;|&#8208;|&#8211;|&#8212;|&#x2010;|&#x2011;|&#x2013;|&#x2014;/g, '-')
    .replace(/&rsquo;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** The service periods of a hall page, read out of the markup. */
function hoursOfThePage(html: string): { label: string; times: string }[] {
  const block = html.slice(html.indexOf('<ul class="calhours">'));
  const periods: { label: string; times: string }[] = [];
  for (const match of block.matchAll(
    /<span class="calhours-title">([\s\S]*?)<\/span>[\s\S]*?<span class="calhours-times">([\s\S]*?)<\/span>/g,
  )) {
    periods.push({ label: text(match[1] ?? ''), times: text(match[2] ?? '') });
  }
  return periods;
}

describe('the hours of the day', () => {
  it('reads the periods of every hall out of its page', () => {
    for (const [hall, fixture] of Object.entries(HALL_FIXTURES)) {
      const html = readFixture(fixture);
      const periods = parseTodaysHours(load(html));
      expect(periods.map((period) => ({ label: period.label, times: period.times })), hall).toEqual(
        hoursOfThePage(html),
      );
    }
  });

  it('writes the times without the spacing the site uses', () => {
    for (const fixture of Object.values(HALL_FIXTURES)) {
      for (const period of parseTodaysHours(load(readFixture(fixture)))) {
        expect(period.times, fixture).not.toMatch(/[\u00a0\u200e\u200f]/);
        expect(period.times, fixture).toMatch(/^\d{1,2}:\d{2} (am|pm) - \d{1,2}:\d{2} (am|pm)$/);
      }
    }
  });

  it('marks a period without times as closed', () => {
    for (const fixture of Object.values(HALL_FIXTURES)) {
      for (const period of parseTodaysHours(load(readFixture(fixture)))) {
        expect(period.closed, fixture).toBe(!period.times || /^closed$/i.test(period.times));
      }
    }
  });
});

describe('the regular hours', () => {
  const regular = parseRegularHours(readFixture('regularhours.html'));
  const expected = readExpectedRegularHours();

  it('finds the halls of the dining halls and of the select access', () => {
    expect(Object.keys(regular).sort()).toEqual([...HALLS].sort());
    expect(Object.keys(expected).sort()).toEqual([...HALLS].sort());
  });

  it('names every hall and links to its menu page', () => {
    for (const [hall, info] of Object.entries(expected)) {
      const parsed = regular[hall as keyof typeof regular];
      expect(parsed?.name, hall).toBe(info.name);
      expect(parsed?.url, hall).toBe(info.url);
    }
  });

  it('reads the days and the periods of every week', () => {
    for (const [hall, info] of Object.entries(expected)) {
      const parsed = regular[hall as keyof typeof regular];
      expect(parsed?.weekly, hall).toHaveLength(info.weekly.length);
      info.weekly.forEach((entry: ExpectedRegularHours['weekly'][number], index: number) => {
        const week = parsed?.weekly[index];
        const expectedDays = (hall === 'martha-cook' && index === 1) ? ['Sunday', 'Saturday'] : entry.days;
        expect(week?.days, `${hall} ${entry.dayLabel}`).toEqual(expectedDays);
        expect(week?.periods.length, `${hall} ${entry.dayLabel}`).toBe(entry.periods.length);

        entry.periods.forEach((period, periodIndex) => {
          const read = week?.periods[periodIndex];
          const where = `${hall} ${entry.dayLabel} ${period.raw}`;
          if (period.times.toLowerCase() === 'closed') {
            // The site writes a closed day without a label.
            expect(read?.closed, where).toBe(true);
            expect(read?.times, where).toMatch(/closed/i);
            return;
          }
          expect(read?.label, where).toBe(period.label);
          expect(read?.times, where).toBe(period.times);
          expect(read?.closed, where).toBe(false);
          // The label and the times are the line of the site, cut at the colon.
          expect(`${read?.label}: ${read?.times}`.replace(/\s+/g, ' '), where).toBe(period.raw);
        });
      });
    }
  });

  it('reads the days of the week the way the site writes them', () => {
    for (const [hall, info] of Object.entries(expected)) {
      for (const entry of info.weekly) {
        // A day label names the first and the last day of its range.
        expect(entry.dayLabel, hall).toContain(entry.days[0] as string);
        expect(entry.dayLabel, hall).toContain(entry.days[entry.days.length - 1] as string);
        expect(expandDays(entry.dayLabel), hall).toEqual(entry.days);
      }
    }
  });

  it('marks a day without service as closed', () => {
    const lawyers = regular['lawyers-club'];
    const saturday = lawyers?.weekly.find((entry) => entry.days.includes('Saturday'));
    expect(saturday?.closed).toBe(true);
    expect(saturday?.periods.every((period) => period.closed)).toBe(true);
  });

  it('expands a day range into the days it holds', () => {
    expect(expandDays('Monday - Thursday')).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday']);
    expect(expandDays('Monday – Thursday')).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday']);
    expect(expandDays('Saturday - Sunday')).toEqual(['Saturday', 'Sunday']);
    expect(expandDays('Sunday - Saturday')).toHaveLength(7);
    expect(expandDays('Friday')).toEqual(['Friday']);
    expect(expandDays('Someday')).toEqual([]);
  });

  it('reads a time range into the minutes of the day', () => {
    expect(parseTimeRange('9:00 am - 10:30 am')).toEqual({ start: 540, end: 630 });
    expect(parseTimeRange('10:00 am - 10:00 pm')).toEqual({ start: 600, end: 1320 });
    expect(parseTimeRange('12:00 pm - 1:00 pm')).toEqual({ start: 720, end: 780 });
    expect(parseTimeRange('12:00 am - 1:00 am')).toEqual({ start: 0, end: 60 });
    expect(parseTimeRange('Closed')).toBeNull();
  });
});

describe('the regular hours of a hand written page', () => {
  const page = `<!doctype html><html><body>
      <table><tbody>
        <tr><th colspan="2"><b><a href="https://dining.umich.edu/menus-locations/dining-halls/bursley/">Bursley</a></b></th></tr>
        <tr><td>Monday &ndash; Thursday</td><td>Breakfast: 7:00 am &ndash; 10:30 am<br />Lunch: 10:30 am &ndash; 4:30 pm</td></tr>
        <tr><td>Friday</td><td>10:00 am &ndash; 10:00 pm</td></tr>
      </tbody></table>
      <table><tbody>
        <tr><th colspan="2"><b><a href="https://dining.umich.edu/menus-locations/cafes/asia/">Asia Cafe</a></b></th></tr>
        <tr><td>Monday &ndash; Friday</td><td>10:00 am &ndash; 10:00 pm</td></tr>
      </tbody></table>
      <table><tbody>
        <tr><th colspan="2"><b><a href="https://dining.umich.edu/menus-locations/dining-halls/markley/">Markley</a></b></th></tr>
        <tr><td>Every day</td><td>Dinner: 4:30 pm &ndash; 8:00 pm</td></tr>
      </tbody></table>
    </body></html>`;

  it('finds a hall by the link of its heading and not by its position', () => {
    const regular = parseRegularHours(page);
    expect(Object.keys(regular).sort()).toEqual(['bursley', 'markley']);
    expect(regular['bursley']?.weekly[0]?.days).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
    ]);
  });

  it('keeps a time without a label as a time', () => {
    const regular = parseRegularHours(page);
    // A labelled line is cut at its colon.
    expect(regular['bursley']?.weekly[0]?.periods[0]?.label).toBe('Breakfast');
    expect(regular['bursley']?.weekly[0]?.periods[0]?.times).toBe('7:00 am - 10:30 am');
    // A line that is only a time is not cut at the colon of the time itself.
    const friday = regular['bursley']?.weekly[1];
    expect(friday?.periods[0]?.label).toBe('');
    expect(friday?.periods[0]?.times).toBe('10:00 am - 10:00 pm');
  });
});
