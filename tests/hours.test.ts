import { describe, expect, it } from 'vitest';
import { load } from 'cheerio';
import { expandDays, parseRegularHours, parseTodaysHours, parseTimeRange } from '../src/parser/hours.js';
import { readFixture } from './helpers.js';

describe('regular hours', () => {
  const regular = parseRegularHours(readFixture('regularhours.html'));

  it('finds the ten dining halls and ignores the other locations', () => {
    expect([...regular.keys()].sort()).toEqual([
      'bursley',
      'east-quad',
      'lawyers-club',
      'markley',
      'martha-cook',
      'mosher-jordan',
      'north-quad',
      'south-quad',
      'twigs-at-oxford',
      'wolverine-village',
    ]);
  });

  it('reads the weekly schedule of Bursley', () => {
    const bursley = regular.get('bursley');
    expect(bursley).toBeDefined();
    expect(bursley?.url).toBe('https://dining.umich.edu/menus-locations/dining-halls/bursley/');
    expect(bursley?.weekly).toHaveLength(4);

    const monday = bursley?.weekly.find((entry) => entry.days.includes('Monday'));
    expect(monday?.days).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday']);
    expect(monday?.periods).toEqual([
      { label: 'Breakfast', times: '7:00 am - 10:30 am', closed: false },
      { label: 'Lunch', times: '10:30 am - 4:30 pm', closed: false },
      { label: 'Dinner', times: '4:30 pm - 9:00 pm', closed: false },
    ]);

    const sunday = bursley?.weekly.find((entry) => entry.days.includes('Sunday'));
    expect(sunday?.periods.map((period) => period.label)).toEqual(['Breakfast', 'Brunch', 'Dinner']);
  });

  it('reads a closed week for Lawyers Club on Saturday', () => {
    const lawyers = regular.get('lawyers-club');
    const saturday = lawyers?.weekly.find((entry) => entry.days.includes('Saturday'));
    expect(saturday?.closed).toBe(true);
    expect(saturday?.periods[0]?.closed).toBe(true);
  });

  it('expands day ranges', () => {
    expect(expandDays('Monday – Thursday')).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday']);
    expect(expandDays('Monday - Friday')).toHaveLength(5);
    expect(expandDays('Saturday – Sunday')).toEqual(['Saturday', 'Sunday']);
    expect(expandDays('Sunday – Saturday')).toHaveLength(7);
    expect(expandDays('Friday')).toEqual(['Friday']);
  });
});

describe('hours of a hall page', () => {
  it('reads the service periods of the day', () => {
    const periods = parseTodaysHours(load(readFixture('bursley.html')));
    expect(periods).toEqual([
      { label: 'Breakfast', times: '7:00 am - 10:30 am', closed: false },
      { label: 'Lunch', times: '10:30 am - 4:30 pm', closed: false },
      { label: 'Dinner', times: '4:30 pm - 9:00 pm', closed: false },
    ]);
  });

  it('reads the periods of a hall that does not serve breakfast', () => {
    // Lawyers Club serves lunch and dinner; the site publishes no breakfast
    // for it, and the page has no breakfast block at all.
    const periods = parseTodaysHours(load(readFixture('lawyers-club.html')));
    expect(periods).toEqual([
      { label: 'Lunch', times: '11:30 am - 1:00 pm', closed: false },
      { label: 'Dinner', times: '5:30 pm - 7:00 pm', closed: false },
    ]);
  });

  it('normalises the non-breaking hyphen of the site', () => {
    for (const period of parseTodaysHours(load(readFixture('bursley.html')))) {
      expect(period.times).not.toMatch(/[\u00a0\u2011]/);
      expect(period.times).toMatch(/^\d{1,2}:\d{2} (am|pm) - \d{1,2}:\d{2} (am|pm)$/);
    }
  });
});

describe('time ranges', () => {
  it('reads a range into minutes', () => {
    expect(parseTimeRange('9:00 am - 10:30 am')).toEqual({ start: 540, end: 630 });
    expect(parseTimeRange('4:30 pm - 9:00 pm')).toEqual({ start: 990, end: 1260 });
    expect(parseTimeRange('12:00 pm - 1:00 pm')).toEqual({ start: 720, end: 780 });
    expect(parseTimeRange('Closed')).toBeNull();
  });
});
