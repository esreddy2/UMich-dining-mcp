/**
 * Campus time.
 *
 * The server may sit in any time zone: the host of a deployment, a laptop, a
 * container. The hall times, the day the site publishes and the mealtimes are
 * all in the time zone of the campus, America/Detroit: Eastern Standard Time,
 * and Eastern Daylight Time in the summer. Every time this server reports is
 * computed in that zone and never in the zone of the host, so a server in
 * Chicago and a server in UTC answer the same question the same way.
 *
 * The zone is configurable with `UMICH_DINING_TIMEZONE` for a mirror of the
 * site; the default is the campus.
 */

/** The time zone of the campus: America/Detroit, Eastern Standard/Daylight Time. */
export const CAMPUS_TIMEZONE = 'America/Detroit';

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
const timeFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The day of the calendar in the given time zone, as YYYY-MM-DD.
 *
 * The zone is named in the format, so the day is the campus day whatever the
 * clock of the host says.
 */
export function dayIn(timeZone: string, now: Date = new Date()): string {
  let fmt = dayFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatters.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(now);
  const get = (type: 'year' | 'month' | 'day'): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * The time of day in the given time zone, in minutes since midnight.
 *
 * The hour cycle is h23, so midnight is 0 minutes and not the 1440 some
 * runtimes report for the hour 24.
 */
export function minutesIn(timeZone: string, now: Date = new Date()): number {
  let fmt = timeFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
    timeFormatters.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(now);
  const get = (type: 'hour' | 'minute'): number =>
    Number.parseInt(parts.find((part) => part.type === type)?.value ?? '0', 10);
  return get('hour') * 60 + get('minute');
}
