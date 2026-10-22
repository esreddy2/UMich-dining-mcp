import { load, type CheerioAPI } from 'cheerio';
import { hallIdFromUrl } from '../halls.js';
import type { HallId, RegularHours, ServicePeriod, WeeklyHours } from '../types.js';
import { normalizeText } from './text.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export class HoursParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HoursParseError';
  }
}

/**
 * The service periods of the day a page was rendered for.
 *
 * The site labels the block "Today's Hours" and renders the periods of the
 * selected date, so the heading is the site's wording and not a claim about
 * the wall clock.
 */
export function parseTodaysHours($: CheerioAPI): ServicePeriod[] {
  const periods: ServicePeriod[] = [];
  $('div.hours ul.calhours > li').each((_, element) => {
    const item = $(element);
    const label = normalizeText(item.find('span.calhours-title').first().text());
    const times = normalizeText(item.find('span.calhours-times').first().text());
    if (!label && !times) {
      // The site states a closed day with a bare <li>Closed</li>, with no
      // spans in it. Dropping it would say "no periods" where the site says
      // "closed", and contradict the weekly block of the same response.
      const own = normalizeText(item.text());
      if (/^closed$/i.test(own)) {
        periods.push({ label: 'Closed', times: 'Closed', closed: true });
      }
      return;
    }
    periods.push({ label, times, closed: !times || /^closed$/i.test(times) });
  });
  return periods;
}

/** Split the `<br>` separated cell of the regular hours table into periods. */
function parsePeriods(cellHtml: string): ServicePeriod[] {
  const periods: ServicePeriod[] = [];
  const lines = cellHtml
    .split(/<br\s*\/?>/i)
    .map((line) => normalizeText(line.replace(/<[^>]+>/g, ' ')))
    .filter((line) => line.length > 0);

  for (const line of lines) {
    if (/^closed$/i.test(line)) {
      periods.push({ label: 'Closed', times: 'Closed', closed: true });
      continue;
    }
    const separator = line.indexOf(':');
    // A label is a word and a time is not: the site writes the periods of
    // the dining halls as "Breakfast: 7:00 am - 10:30 am" and the periods of
    // the other locations as a plain "10:00 am - 10:00 pm".  A line that
    // starts with a number is a time and is never cut at the colon of the
    // time itself.
    const label = separator < 0 ? '' : line.slice(0, separator).trim();
    if (!label || /\d/.test(label)) {
      periods.push({ label: '', times: line, closed: false });
      continue;
    }
    const times = line.slice(separator + 1).trim();
    periods.push({ label, times, closed: false });
  }
  return periods;
}

/**
 * Expand a day label into individual weekdays.
 *
 * "Monday - Thursday" becomes four days, "Saturday - Sunday" two days, and
 * "Sunday - Saturday" the whole week. A range that wraps around the end of
 * the week is handled as well.
 */
export function expandDays(label: string): string[] {
  const parts = label
    .split(/\s*[-–—]\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return [];
  if (parts.length === 1) {
    const single = parts[0] as string;
    return WEEKDAYS.includes(single as (typeof WEEKDAYS)[number]) ? [single] : [];
  }

  const start = WEEKDAYS.indexOf(parts[0] as (typeof WEEKDAYS)[number]);
  const end = WEEKDAYS.indexOf(parts[1] as (typeof WEEKDAYS)[number]);
  if (start < 0 || end < 0) return [];

  const days: string[] = [];
  let cursor = start;
  const limit = end >= start ? end : end + WEEKDAYS.length;
  while (cursor <= limit) {
    days.push(WEEKDAYS[cursor % WEEKDAYS.length] as string);
    cursor += 1;
  }
  return days;
}

function matchHallByName(name: string): HallId | null {
  const normalized = name.toLowerCase().replace(/[^a-z]/g, '');
  const map: Record<string, HallId> = {
    bursley: 'bursley',
    eastquad: 'east-quad',
    markley: 'markley',
    mosherjordan: 'mosher-jordan',
    northquad: 'north-quad',
    southquad: 'south-quad',
    twigsatoxford: 'twigs-at-oxford',
    wolverinevillage: 'wolverine-village',
    lawyersclub: 'lawyers-club',
    marthacook: 'martha-cook',
  };
  return map[normalized] ?? null;
}

/**
 * Parse the regular hours page.
 *
 * The page holds one table per group of locations. A location starts at the
 * row with a `<th>` that names it and links to its menu page, and the rows
 * below it carry the schedule. The tables are matched by that link rather
 * than by position, because the site groups the locations differently over
 * time (cafes, markets and the grill sit in tables of their own and come and
 * go), and a location may share a `<tbody>` with the one before it.
 */
export function parseRegularHours(html: string): Record<HallId, RegularHours> {
  const $ = load(html);
  const result: Partial<Record<HallId, RegularHours>> = {};

  $('table').each((_, table) => {
    let current: { id: HallId; name: string; url: string | null; weekly: WeeklyHours[] } | null = null;

    $(table).find('tr').each((__, row) => {
      const head = $(row).find('th').first();
      if (head.length > 0) {
        const name = normalizeText(head.text());
        const href = head.find('a').first().attr('href') ?? null;
        const id = (href ? hallIdFromUrl(href) : null) ?? matchHallByName(name);
        if (id) {
          current = { id, name, url: href, weekly: [] };
          result[id] = { hall: id, name, url: href, weekly: current.weekly };
        } else {
          current = null;
        }
        return;
      }

      if (!current) return;
      const cells = $(row).children('td');
      if (cells.length < 2) return;
      const dayLabel = normalizeText(cells.eq(0).text());
      const periods = parsePeriods(cells.eq(1).html() ?? '');
      const days = expandDays(dayLabel);
      if (days.length === 0) return;
      current.weekly.push({ days, periods, closed: periods.every((period) => period.closed) });
    });
  });

  if (Object.keys(result).length === 0) {
    throw new HoursParseError('The regular hours page contains no dining hall tables; the layout has probably changed.');
  }
  return result as Record<HallId, RegularHours>;
}

/** Parse a time range such as "9:00 am - 10:30 am" into minutes since midnight. */
export function parseTimeRange(times: string): { start: number; end: number } | null {
  const match = /(\d{1,2}):(\d{2})\s*(am|pm)?\s*-\s*(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(times);
  if (!match) return null;
  const toMinutes = (hour: string, minute: string, meridiem: string | undefined, fallbackMeridiem: string) => {
    let value = Number.parseInt(hour, 10) * 60 + Number.parseInt(minute, 10);
    const meridiemValue = (meridiem ?? fallbackMeridiem).toLowerCase();
    if (meridiemValue === 'pm' && value < 12 * 60) value += 12 * 60;
    if (meridiemValue === 'am' && value === 12 * 60) value = 0;
    return value;
  };
  const start = toMinutes(match[1] as string, match[2] as string, match[3], 'am');
  const end = toMinutes(match[4] as string, match[5] as string, match[6], 'am');
  return { start, end };
}
