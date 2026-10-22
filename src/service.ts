import { config } from './config.js';
import { cache } from './cache.js';
import { fetchText, HttpError } from './http.js';
import { HALLS, REGULAR_HOURS_PATH, getHallDefinition } from './halls.js';
import { parseLocationDetails, type LocationDetails } from './parser/location.js';
import { parseMenuPage, ParseError, type ParsedMenu } from './parser/menu.js';
import { parseRegularHours, parseTimeRange, parseTodaysHours } from './parser/hours.js';
import { load } from 'cheerio';
import type {
  DiningHall,
  HallId,
  HallHours,
  LocationSummary,
  MealName,
  Menu,
  RegularHours,
  ServicePeriod,
  Station,
  Nutrition,
  CarbonLevel,
} from './types.js';
import { ALLERGEN_REMINDER } from './taxonomy.js';
import {
  MICRONUTRIENT_SPECS,
  deriveMicronutrient,
  findMicronutrientValue,
  micronutrientAmount,
  micronutrientSpec,
  nutrientValueInUnit,
  parseNutritionNumber,
  parseServingSizeGrams,
  resolveNutrientRange,
  resolveSortField,
  type ResolvedNutrientRange,
} from './nutrition.js';

export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceError';
  }
}

export interface DishMatch {
  hall: HallId;
  hallName: string;
  date: string;
  /** The meal, as the site labels it. */
  meal: string;
  station: string;
  name: string;
  traits: string[];
  traitLabels: Record<string, string>;
  allergens: string[];
  mhealthyTier: number | null;
  carbonFootprint: CarbonLevel | null;
  calories: number | null;
  sodiumMg: number | null;
  nutrition: Nutrition | null;
  /** The days the dish appeared on; only in a range query. */
  dates?: string[];
}

export interface DishSearchResult {
  query: string;
  date: string;
  dateRange?: { from: string; to: string };
  matches: DishMatch[];
  /** Halls that could not be read; the other halls are still reported. */
  failures: { hall: HallId; hallName: string; error: string }[];
  totalMatches: number;
  /** True when the rows were cut short by the limit. */
  truncated: boolean;
  /** How to see the rows the limit cut off. */
  truncationNote?: string;
  /** True when a day of the answer was served from an expired cache entry. */
  stale: boolean;
  coverage?: Coverage;
  /** The days whose page carried no menu. */
  emptyDates?: string[];
  /** The meal labels the site used that this server cannot parse. */
  unknownMealLabels?: string[];
  /** A station that matched nothing, with the names that do exist. */
  stationNote?: string;
}

export interface DishFilterResult {
  date: string;
  dateRange?: { from: string; to: string };
  matches: DishMatch[];
  failures: { hall: HallId; hallName: string; error: string }[];
  totalMatches: number;
  /** True when the rows were cut short by the limit. */
  truncated: boolean;
  /** How to see the rows the limit cut off. */
  truncationNote?: string;
  /** True when a day of the answer was served from an expired cache entry. */
  stale: boolean;
  coverage?: Coverage;
  /** The days whose page carried no menu. */
  emptyDates?: string[];
  /** The meal labels the site used that this server cannot parse. */
  unknownMealLabels?: string[];
  /** A station that matched nothing, with the names that do exist. */
  stationNote?: string;
}

interface HallPage {
  hall: DiningHall;
  date: string;
  menu: Menu;
  location: LocationDetails;
  periods: ServicePeriod[];
  stale: boolean;
  /** True when the page came from the cache rather than from the site. */
  cached: boolean;
  /** Why the menu could not be parsed, when it could not be. */
  menuError: string | null;
}

/** The location of a hall whose location block could not be read. */
const EMPTY_LOCATION: LocationDetails = {
  address: null,
  mapUrl: null,
  phone: null,
  email: null,
};

/** The number of dishes of a menu. */
export function countItems(meals: Record<MealName, Station[]>): number {
  let total = 0;
  for (const stations of Object.values(meals)) {
    for (const station of stations) total += station.items.length;
  }
  return total;
}

/** The number of stations of a menu. */
export function countStations(meals: Record<MealName, Station[]>): number {
  let total = 0;
  for (const stations of Object.values(meals)) total += stations.length;
  return total;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The current date in the time zone the site publishes "today" in. */
const dateFmtCache = new Map<string, Intl.DateTimeFormat>();
export function todayIn(timeZone: string = config.timezone, now: Date = new Date()): string {
  let fmt = dateFmtCache.get(timeZone);
  if (!fmt) { fmt = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); dateFmtCache.set(timeZone, fmt); }
  const parts = fmt.formatToParts(now);
  const get = (type: 'year' | 'month' | 'day'): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Parse a YYYY-MM-DD string into a UTC timestamp, or null when invalid. */
export function parseIsoDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return timestamp;
}

/** Whole days between two YYYY-MM-DD dates. */
export function dayOffset(date: string, today: string): number {
  const target = parseIsoDate(date);
  const base = parseIsoDate(today);
  if (target === null || base === null) return Number.NaN;
  return Math.round((target - base) / DAY_MS);
}

export function formatIsoDate(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Check a requested date against the range the site publishes.
 *
 * The site's own datepicker is bounded at -3 days and +2 weeks; outside that
 * range the site answers with a different day's menu instead of an error, so
 * the range is enforced here, before anything is fetched.
 */
export function validateDate(date: string, today: string = todayIn()): void {
  if (parseIsoDate(date) === null) {
    throw new ServiceError(`"${date}" is not a valid date. Use the YYYY-MM-DD format.`);
  }
  const offset = dayOffset(date, today);
  const { minDays, maxDays } = config.dateWindow;
  if (offset < minDays || offset > maxDays) {
    const earliest = formatIsoDate((parseIsoDate(today) as number) + minDays * DAY_MS);
    const latest = formatIsoDate((parseIsoDate(today) as number) + maxDays * DAY_MS);
    throw new ServiceError(
      `${date} is outside the range the site publishes menus for. ` +
        `The site serves menus from ${earliest} to ${latest} (today ${today}, ` +
        `${minDays} to +${maxDays} days).`,
    );
  }
}

function ttlForDate(date: string, today: string): number {
  const offset = dayOffset(date, today);
  if (offset === 0) return config.ttl.todayMenu;
  if (offset > 0) return config.ttl.futureMenu;
  return config.ttl.pastMenu;
}

function menuUrl(hall: DiningHall, date: string): string {
  return `${config.baseUrl}/menus-locations/${hall.path}/?menuDate=${date}`;
}

/**
 * Fetch and parse one hall page for one date.
 *
 * The page carries the menu, the service periods of that date and the
 * location details, so one request serves all of them. The warmer reads the
 * same entry: a page parsed for the menu alone would either cost a second
 * fetch later or split the cache in two, and the parse of the two small
 * blocks is a rounding error next to the request itself.
 *
 * The three blocks are parsed on their own. A menu that cannot be parsed
 * must not take the hours with it: the hours are still the hours, and a
 * layout change in one block is not a failure of the others.
 */
/**
 * The wall-clock budget of a tool call.
 *
 * A degraded site makes a fan-out over ten halls take five rounds of four
 * attempts of twenty seconds each: far past the timeout of the proxy in
 * front. The budget caps the call, and the halls that were not reached are
 * reported rather than waited for.
 */
export class Deadline {
  private readonly expiresAt: number;

  constructor(private readonly budgetMs: number = config.callBudgetMs) {
    this.expiresAt = Date.now() + budgetMs;
  }

  /** True when the budget is spent. */
  get expired(): boolean {
    return Date.now() >= this.expiresAt;
  }

  /** How much of the budget is left, in milliseconds. */
  get remainingMs(): number {
    return Math.max(0, this.expiresAt - Date.now());
  }

  /** The message a hall that was not reached gets. */
  get message(): string {
    return 'The call budget ran out before this hall was read.';
  }
}

export async function loadHallPage(
  hallId: HallId,
  date: string,
  today: string = todayIn(),
  options: { force?: boolean; background?: boolean; menuOptional?: boolean; deadline?: Deadline } = {},
): Promise<HallPage> {
  const hall = getHallDefinition(hallId);
  const key = `hall:${hallId}:${date}`;
  const ttl = ttlForDate(date, today);

  const { value, stale, cached } = await cache.fetch(
    key,
    ttl,
    async () => {
      // A request never outlives the budget of the call that asked for it.
      const controller = new AbortController();
      const budget = options.deadline?.remainingMs ?? config.timeoutMs;
      const timer = setTimeout(() => controller.abort(), Math.min(config.timeoutMs, budget));
      let html: string;
      try {
        html = await fetchText(menuUrl(hall, date), {
          background: options.background === true,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const $ = load(html);

      let parsed: ParsedMenu | null = null;
      let menuError: string | null = null;
      try {
        parsed = parseMenuPage($);
      } catch (error) {
        if (error instanceof ParseError) {
          menuError = error.message;
        } else {
          throw error;
        }
      }

      let location: LocationDetails = EMPTY_LOCATION;
      try {
        location = parseLocationDetails($);
      } catch {
        // The location block is missing on some pages; the menu does not
        // depend on it.
      }

      let periods: ServicePeriod[] = [];
      try {
        periods = parseTodaysHours($);
      } catch {
        // The hours block is missing on some pages; the menu does not depend
        // on it.
      }

      return { parsed, menuError, location, periods };
    },
    { force: options.force === true },
  );

  // A menu that could not be parsed is a failure of the menu, and of every
  // tool that reads one. The hours and the location are still good, so a
  // tool that only wants those asks for the menu to be optional.
  if (!value.parsed && !options.menuOptional) {
    throw new ServiceError(value.menuError ?? 'The menu page could not be parsed.');
  }

  const parsed = value.parsed;
  const menu: Menu = {
    hall: hall.id,
    date,
    meals: parsed?.meals ?? { Breakfast: [], Brunch: [], Lunch: [], Dinner: [] },
    mealLabels: parsed?.mealLabels ?? {},
    otherMeals: parsed?.otherMeals ?? [],
    unknownMealLabels: parsed?.unknownMealLabels ?? [],
    noMenu: parsed?.noMenu ?? false,
    renderedDate: parsed?.renderedDate ?? null,
    stale,
  };

  // The site serves another day's menu when the requested date is outside the
  // range it offers, and it says which day in the plain HTML. A page that
  // declares another day is refused here, so that every tool that reads a
  // menu is protected and not only the one that happens to check.
  if (menu.renderedDate && menu.renderedDate !== date) {
    throw new ServiceError(
      `The site returned the menu for ${menu.renderedDate} when ${date} was requested. ` +
        'The published range may have changed; try a date within the range the site offers.',
    );
  }

  return {
    hall,
    date,
    menu,
    location: value.location,
    periods: value.periods,
    stale,
    cached,
    menuError: value.menuError,
  };
}

/**
 * Get the menu of a hall for a date.
 *
 * The requested date is checked against the published range, and the date the
 * page declares is compared with the requested one: when the site falls back
 * to another day's menu the call fails instead of returning data that belongs
 * to a different day.
 */
export async function getMenu(hallId: HallId, date?: string): Promise<HallPage> {
  const today = todayIn();
  const requested = date ?? today;
  validateDate(requested, today);

  const page = await loadHallPage(hallId, requested, today, { deadline: new Deadline() });

  if (countItems(page.menu.meals) === 0) {
    throw new ServiceError(`No menu is published for ${requested} at ${page.hall.name}.`);
  }

  return page;
}

/**
 * The regular weekly schedule of every dining hall.
 *
 * The value is cached as a plain object and not as a `Map`: the persistent
 * cache stores it as JSON, and a `Map` serialises to `{}`, which would turn
 * the second run of the published package into a broken `get_hours`.
 */
export async function loadRegularHours(): Promise<Map<HallId, RegularHours>> {
  const { value } = await cache.fetch('regular-hours', config.ttl.regularHours, async () => {
    const html = await fetchText(`${config.baseUrl}${REGULAR_HOURS_PATH}`);
    return parseRegularHours(html);
  });

  if (Object.keys(value).length === 0) {
    // An entry written by an older build, before the value was a plain
    // object, is an empty object. It is dropped and read again.
    cache.delete('regular-hours');
    const fresh = await cache.fetch('regular-hours', config.ttl.regularHours, async () => {
      const html = await fetchText(`${config.baseUrl}${REGULAR_HOURS_PATH}`);
      return parseRegularHours(html);
    });
    return new Map(Object.entries(fresh.value) as [HallId, RegularHours][]);
  }

  return new Map(Object.entries(value) as [HallId, RegularHours][]);
}

const timeFmtCache = new Map<string, Intl.DateTimeFormat>();
function minutesNow(timeZone: string, now: Date): number {
  let fmt = timeFmtCache.get(timeZone);
  if (!fmt) { fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hour12: false }); timeFmtCache.set(timeZone, fmt); }
  const parts = fmt.formatToParts(now);
  const get = (type: 'hour' | 'minute'): number =>
    Number.parseInt(parts.find((part) => part.type === type)?.value ?? '0', 10);
  return get('hour') * 60 + get('minute');
}

/**
 * Parse a campus-local time of day, e.g. "12:30" or "7:05 pm", into the
 * number of minutes since midnight.
 */
export function parseTimeOfDay(value: string): number {
  const match = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(value.trim());
  if (!match) {
    throw new ServiceError(`"${value}" is not a time of day. Use the HH:MM format, e.g. "12:30".`);
  }
  const hours = Number.parseInt(match[1]!, 10);
  const minutes = Number.parseInt(match[2]!, 10);
  if (minutes > 59) {
    throw new ServiceError(`"${value}" is not a time of day. The minutes must be below 60.`);
  }
  const meridiem = match[3]?.toLowerCase();
  let hour = hours;
  if (meridiem === 'pm') {
    if (hours > 12) throw new ServiceError(`"${value}" is not a time of day. Use the HH:MM format.`);
    hour = hours === 12 ? 12 : hours + 12;
  } else if (meridiem === 'am') {
    if (hours > 12) throw new ServiceError(`"${value}" is not a time of day. Use the HH:MM format.`);
    hour = hours === 12 ? 0 : hours;
  } else if (hours > 24) {
    throw new ServiceError(`"${value}" is not a time of day. Use the HH:MM format.`);
  }
  return hour * 60 + minutes;
}

/**
 * Whether the service periods cover the given number of minutes since midnight.
 *
 * The window is half-open, `[start, end)`: a hall that closes at 10:30 is
 * closed at 10:30, and the periods that touch each other do not overlap.
 */
export function isOpenAtMinutes(periods: ServicePeriod[], current: number): boolean {
  return periods.some((period) => {
    if (period.closed) return false;
    const range = parseTimeRange(period.times);
    if (!range) return false;
    return current >= range.start && current < range.end;
  });
}

export function isOpenNow(periods: ServicePeriod[], now: Date = new Date()): boolean {
  return isOpenAtMinutes(periods, minutesNow(config.timezone, now));
}

/** The ten halls with the service periods of the requested day. */
export async function listLocations(date?: string, at?: string): Promise<{
  date: string;
  locations: LocationSummary[];
  failures: { hall: HallId; hallName: string; error: string }[];
}> {
  const today = todayIn();
  const requested = date ?? today;
  validateDate(requested, today);
  const now = new Date();
  const atMinutes = at === undefined ? minutesNow(config.timezone, now) : parseTimeOfDay(at);

  const deadline = new Deadline();
  const settled = await Promise.all(
    HALLS.map(async (hall) => {
      try {
        // The hours and the location are read even when the menu cannot be
        // parsed: a layout change in the menu is not a failure of the rest.
        const page = await loadHallPage(hall.id, requested, today, { menuOptional: true, deadline });
        const summary: LocationSummary = {
          ...hall,
          address: page.location.address,
          phone: page.location.phone,
          email: page.location.email,
          mapUrl: page.location.mapUrl,
          meals: publishedMeals(page.menu, page.periods),
          date: requested,
          today: page.periods,
          openNow: isOpenAtMinutes(page.periods, atMinutes),
          stale: page.stale,
        };
        return { hall, summary };
      } catch (error) {
        return {
          hall,
          error: error instanceof HttpError || error instanceof ServiceError ? error.message : String(error),
        };
      }
    }),
  );

  const locations: LocationSummary[] = [];
  const failures: { hall: HallId; hallName: string; error: string }[] = [];
  for (const entry of settled) {
    if ('summary' in entry && entry.summary) locations.push(entry.summary);
    else failures.push({ hall: entry.hall.id, hallName: entry.hall.name, error: entry.error ?? 'unknown error' });
  }

  return { date: requested, locations, failures };
}

/**
 * The meals a hall published for a day.
 *
 * The list comes from the service periods the site published for that day,
 * so `meals` and `today` never disagree: a Brunch period is a Brunch meal.
 * A meal the site published under a label this server has no slot for is
 * reported with the site's own label, so it is visible rather than missing.
 */
function publishedMeals(menu: Menu, periods: ServicePeriod[]): string[] {
  const meals: string[] = [];

  // The periods of the day come first: they are what the hall is serving.
  for (const period of periods) {
    const label = period.label.trim();
    if (!label || /^closed$/i.test(label)) continue;
    if (!meals.some((meal) => meal.toLowerCase() === label.toLowerCase())) meals.push(label);
  }

  // A meal the menu carries but the periods do not name is still served.
  for (const [meal, stations] of Object.entries(menu.meals) as [MealName, Station[]][]) {
    if (stations.length === 0) continue;
    if (!meals.some((entry) => entry.toLowerCase() === meal.toLowerCase())) meals.push(meal);
  }
  for (const other of menu.otherMeals) {
    if (other.stations.length === 0) continue;
    if (!meals.some((entry) => entry.toLowerCase() === other.label.toLowerCase())) {
      meals.push(other.label);
    }
  }
  return meals;
}

/**
 * The menu of a hall as domain values, grouped by meal and station.
 *
 * The encoding happens at the boundary: the sweep tools and `get_menu` carry
 * the same coded row, so a row means the same thing wherever it is read.
 */
export function menuGroups(page: HallPage): { meal: string; stations: { name: string; items: DishMatch[] }[] }[] {
  const groups: { meal: string; stations: { name: string; items: DishMatch[] }[] }[] = [];

  const push = (meal: string, station: string, item: DishMatch): void => {
    let group = groups.find((entry) => entry.meal === meal);
    if (!group) {
      group = { meal, stations: [] };
      groups.push(group);
    }
    let entry = group.stations.find((candidate) => candidate.name === station);
    if (!entry) {
      entry = { name: station, items: [] };
      group.stations.push(entry);
    }
    entry.items.push(item);
  };

  for (const [meal, stations] of Object.entries(page.menu.meals) as [
    MealName,
    { name: string; items: Parameters<typeof toDishMatch>[4][] }[],
  ][]) {
    for (const station of stations) {
      for (const item of station.items) {
        push(meal, station.name, toDishMatch(page.hall, page.date, meal, station.name, item));
      }
    }
  }
  for (const other of page.menu.otherMeals) {
    for (const station of other.stations) {
      for (const item of station.items) {
        push(other.label, station.name, toDishMatch(page.hall, page.date, other.label, station.name, item));
      }
    }
  }

  return groups;
}

/** The service periods of a hall for the requested day, plus the weekly schedule. */
export async function getHours(hallId?: HallId, date?: string): Promise<{
  date: string;
  hours: HallHours[];
  failures: { hall: HallId; hallName: string; error: string }[];
}> {
  const today = todayIn();
  const requested = date ?? today;
  validateDate(requested, today);
  const halls = hallId ? [getHallDefinition(hallId)] : HALLS;
  const [regular] = await Promise.all([loadRegularHours()]);
  const deadline = new Deadline();

  // One hall that cannot be read does not lose the other nine.
  const settled = await Promise.allSettled(
    halls.map(async (hall): Promise<HallHours> => {
      if (deadline.expired) throw new ServiceError(deadline.message);
      // The hours are read even when the menu cannot be parsed.
      const page = await loadHallPage(hall.id, requested, today, { menuOptional: true, deadline });
      return {
        hall: hall.id,
        name: hall.name,
        date: requested,
        today: page.periods,
        regular: regular.get(hall.id) ?? null,
        stale: page.stale,
      };
    }),
  );

  const hours: HallHours[] = [];
  const failures: { hall: HallId; hallName: string; error: string }[] = [];
  settled.forEach((entry, index) => {
    if (entry.status === 'fulfilled') {
      hours.push(entry.value);
      return;
    }
    const hall = halls[index]!;
    failures.push({
      hall: hall.id,
      hallName: hall.name,
      error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
    });
  });

  return { date: requested, hours, failures };
}

/** The halls that are serving at the given time of day. */
export async function findOpenNow(date?: string, at?: string): Promise<{
  date: string;
  at: string | null;
  open: LocationSummary[];
  closed: LocationSummary[];
  failures: { hall: HallId; hallName: string; error: string }[];
}> {
  const { date: day, locations, failures } = await listLocations(date, at);
  return {
    date: day,
    at: at ?? null,
    open: locations.filter((summary) => summary.openNow),
    closed: locations.filter((summary) => !summary.openNow),
    failures,
  };
}

function toDishMatch(
  hall: DiningHall,
  date: string,
  meal: string,
  station: string,
  item: {
    name: string;
    traits: string[];
    traitLabels: Record<string, string>;
    allergens: string[];
    mhealthyTier: number | null;
    carbonFootprint: CarbonLevel | null;
    nutrition: Nutrition | null;
  },
): DishMatch {
  const sodium = item.nutrition?.sodium ?? null;
  const sodiumMg = sodium ? parseNutritionNumber(sodium, 'sodium') : null;
  return {
    hall: hall.id,
    hallName: hall.name,
    date,
    meal,
    station,
    name: item.name,
    traits: item.traits,
    traitLabels: item.traitLabels,
    allergens: item.allergens,
    mhealthyTier: item.mhealthyTier,
    carbonFootprint: item.carbonFootprint,
    calories: item.nutrition?.calories ?? null,
    sodiumMg: sodiumMg,
    nutrition: item.nutrition ?? null,
  };
}

interface SweepOptions {
  /**
   * The halls to sweep. An empty list, or none at all, means every hall.
   */
  halls?: HallId[];
  date?: string;
  from?: string;
  to?: string;
  /** The meal to narrow the sweep to, as the site labels it. */
  meal?: string;
  station?: string;
  /** How many pages of the range to skip. */
  offset?: number;
}

/** How much of a range query the sweep could actually cover. */
export interface Coverage {
  /** The number of pages the query asked for. */
  requested: number;
  /** The number of pages that were already cached. */
  cached: number;
  /** The number of pages that were fetched now. */
  fetchedNow: number;
  /** The number of pages that were not served. */
  pending: number;
  /** The number of pages that could not be read. */
  failed: number;
  /** The number of pages that were served from an expired cache entry. */
  stale: number;
  /** The offset the window started at. */
  offset: number;
  /** The number of pages the whole range holds. */
  pages: number;
  /** The offset the next window starts at, or null when the range is done. */
  nextOffset: number | null;
}

interface Sweep {
  date: string;
  dateRange?: { from: string; to: string };
  matches: DishMatch[];
  failures: { hall: HallId; hallName: string; error: string }[];
  coverage?: Coverage;
  /** The days of the range whose page carried no menu. */
  emptyDates: string[];
  /** The meal labels the site used that this server cannot parse. */
  unknownMealLabels: string[];
  /** A station that matched nothing, with the names that do exist. */
  stationNote?: string;
  /** True when a day of the answer was served from an expired cache entry. */
  stale: boolean;
}

/** The days of a range, inclusive of both ends. */
export function dateRange(from: string, to: string): string[] {
  const start = parseIsoDate(from);
  const end = parseIsoDate(to);
  if (start === null || end === null) return [];
  const days: string[] = [];
  for (let timestamp = start; timestamp <= end; timestamp += DAY_MS) {
    days.push(formatIsoDate(timestamp));
  }
  return days;
}

/**
 * Resolve the requested days.
 *
 * A single `date` stands alone. A range is given by `from` and an optional
 * `to`, which defaults to the last day the site publishes. The two cannot be
 * combined.
 */
function resolveDays(options: SweepOptions, today: string): { days: string[]; range?: { from: string; to: string } } {
  const hasDate = options.date !== undefined;
  const hasRange = options.from !== undefined || options.to !== undefined;

  if (hasDate && hasRange) {
    throw new ServiceError('Use either "date" for a single day, or "from" and "to" for a range, not both.');
  }

  if (hasDate) {
    const date = options.date!;
    validateDate(date, today);
    return { days: [date] };
  }

  if (!hasRange) return { days: [today] };

  const from = options.from ?? today;
  const { maxDays } = config.dateWindow;
  const last = formatIsoDate((parseIsoDate(today) as number) + maxDays * DAY_MS);
  const to = options.to ?? last;

  validateDate(from, today);
  validateDate(to, today);

  if (parseIsoDate(from)! > parseIsoDate(to)!) {
    throw new ServiceError(`The start of the range (${from}) is after its end (${to}).`);
  }

  return { days: dateRange(from, to), range: { from, to } };
}

async function sweepMenus(options: SweepOptions, accept: (match: DishMatch) => boolean): Promise<Sweep> {
  const today = todayIn();
  const { days, range } = resolveDays(options, today);
  const halls = options.halls && options.halls.length > 0 ? options.halls.map((id) => getHallDefinition(id)) : HALLS;
  const deadline = new Deadline();

  const matches: DishMatch[] = [];
  const failures: { hall: HallId; hallName: string; error: string }[] = [];
  const unknownMealLabels = new Set<string>();
  const emptyDates = new Set<string>();
  const stationNames = new Set<string>();
  const matchedStations = new Set<string>();

  let requested = 0;
  let cached = 0;
  let fetchedNow = 0;
  let pending = 0;
  let failed = 0;
  let stale = 0;

  // The aggregation key of a range result: a dish is one row, whatever the
  // day it was seen on.
  const aggregated = new Map<string, DishMatch>();

  // The pages of a sweep, in the order they are read: every day, every hall.
  // A range is paged with an offset over this list, so an agent can ask for
  // the next window of a range it has not finished.
  const pages: { date: string; hall: DiningHall }[] = [];
  for (const date of days) {
    for (const hall of halls) pages.push({ date, hall });
  }

  const offset = Math.max(0, options.offset ?? 0);
  const window = pages.slice(offset);

  // The offset of the first page the call did not serve. The next window of
  // a range starts there.
  let firstUnserved: number | null = null;
  const unserved = (index: number): void => {
    const at = offset + index;
    if (firstUnserved === null || at < firstUnserved) firstUnserved = at;
  };

  for (const [index, { date, hall }] of window.entries()) {
    {
      requested += 1;

      // The budget of the call: a hall that is not reached is reported.
      if (deadline.expired) {
        pending += 1;
        unserved(index);
        failures.push({ hall: hall.id, hallName: hall.name, error: deadline.message });
        continue;
      }

      let page: HallPage;
      try {
        // The budget only counts the pages that have to be fetched. A page
        // that is on the disk is read from there and needs no request.
        if (fetchedNow >= config.maxRangeFetches && !(await cache.isCached(`hall:${hall.id}:${date}`))) {
          pending += 1;
          unserved(index);
          continue;
        }
        page = await loadHallPage(hall.id, date, today, { deadline });
        if (page.stale) stale += 1;
        if (page.cached) cached += 1;
        else fetchedNow += 1;
      } catch (error) {
        failed += 1;
        unserved(index);
        failures.push({
          hall: hall.id,
          hallName: hall.name,
          error: error instanceof HttpError || error instanceof ServiceError ? error.message : String(error),
        });
        continue;
      }

      for (const label of page.menu.unknownMealLabels ?? []) unknownMealLabels.add(label);

      let pageStationCount = 0;
      let stationMatched = false;
      // The meals of the page, the known ones and the ones the site published
      // under a label this server has no slot for.
      const pageMeals: { label: string; stations: { name: string; items: Parameters<typeof toDishMatch>[4][] }[] }[] = [
        ...(Object.entries(page.menu.meals) as [
          MealName,
          { name: string; items: Parameters<typeof toDishMatch>[4][] }[],
        ][]).map(([label, stations]) => ({ label, stations })),
        ...page.menu.otherMeals.map((other) => ({ label: other.label, stations: other.stations })),
      ];

      for (const { label: meal, stations } of pageMeals) {
        pageStationCount += stations.length;
        if (options.meal && meal.toLowerCase() !== options.meal.toLowerCase()) continue;
        for (const station of stations) {
          stationNames.add(station.name);
          if (options.station && station.name.toLowerCase() !== options.station.toLowerCase()) continue;
          if (options.station) stationMatched = true;
          for (const item of station.items) {
            const match = toDishMatch(hall, date, meal, station.name, item);
            if (!accept(match)) continue;

            if (!range) {
              matches.push(match);
              continue;
            }

            const aggregationKey = `${hall.id}|${meal}|${station.name}|${match.name}`;
            const existing = aggregated.get(aggregationKey);
            if (existing) {
              existing.dates!.push(date);
            } else {
              aggregated.set(aggregationKey, { ...match, dates: [date] });
            }
          }
        }
      }
      if (options.station && stationMatched) matchedStations.add(options.station.toLowerCase());

      // The day has no menu only when the page itself carried no station.
      // A meal or a station filter that matched nothing is a different thing,
      // and the response must not say both.
      if (pageStationCount === 0) emptyDates.add(date);
    }
  }

  if (range) {
    for (const match of aggregated.values()) matches.push(match);
  }

  matches.sort((a, b) => a.hall.localeCompare(b.hall) || a.meal.localeCompare(b.meal) || a.name.localeCompare(b.name));

  // The numbers add up: every page the query asked for was cached, fetched,
  // left pending or failed. The next offset is where the rest of the range
  // begins, so a wide range is read in windows.
  const coverage: Coverage | undefined = range
    ? {
        requested,
        cached,
        fetchedNow,
        pending,
        failed,
        stale,
        offset,
        pages: pages.length,
        nextOffset: firstUnserved,
      }
    : undefined;

  // A station that matches nothing is reported with the names that do exist.
  let stationNote: string | undefined;
  if (options.station && matchedStations.size === 0 && stationNames.size > 0) {
    const names = [...stationNames].sort().slice(0, 20);
    stationNote = `No station called "${options.station}" was found. The stations are: ${names.join(', ')}.`;
  }

  return {
    date: range ? range.from : days[0]!,
    dateRange: range,
    matches,
    failures,
    coverage,
    emptyDates: [...emptyDates].sort(),
    unknownMealLabels: [...unknownMealLabels].sort(),
    stationNote,
    stale: stale > 0,
  };
}

/**
 * Sort the rows of a sweep.
 *
 * The sort is applied to the whole answer, before the limit: the limit takes
 * the first rows of the order that was asked for. An unknown field is refused
 * rather than ignored, because a typo would otherwise return a list that
 * looks sorted and is not.
 */
function sortMatches(
  matches: DishMatch[],
  sortField: string | undefined,
  sortOrder: 'asc' | 'desc' | undefined,
): void {
  if (!sortField) return;

  const order = sortOrder === 'asc' ? 1 : -1;
  const getValue = (m: DishMatch): number | null => {
    if (sortField === 'calories') return m.calories;
    if (sortField === 'carbonFootprint') return m.carbonFootprint;
    if (sortField === 'sodium') return m.sodiumMg;
    if (sortField === 'proteinToCalorie' || sortField === 'protein_to_calorie') {
      const p = parseNutritionNumber(m.nutrition?.protein ?? null, 'protein');
      if (p === null || !m.calories) return null;
      return p / m.calories;
    }
    if (sortField === 'fiberToCalorie' || sortField === 'fiber_to_calorie') {
      const f = parseNutritionNumber(m.nutrition?.dietaryFiber ?? null, 'dietaryFiber');
      if (f === null || !m.calories) return null;
      return f / m.calories;
    }
    // A micronutrient sorts by its amount, the number the row carries.
    const micro = micronutrientSpec(sortField);
    if (micro) return micronutrientAmount(m.nutrition, micro);
    const raw = (m.nutrition as Record<string, unknown> | null)?.[sortField];
    const rawStr = typeof raw === 'string' ? raw : (raw == null ? null : (typeof raw === 'number' ? String(raw) : null));
    return parseNutritionNumber(rawStr, sortField);
  };

  matches.sort((a, b) => {
    const va = getValue(a);
    const vb = getValue(b);
    if (va === null && vb === null) return a.name.localeCompare(b.name);
    if (va === null) return 1;
    if (vb === null) return -1;
    if (va !== vb) return (va - vb) * order;
    return a.name.localeCompare(b.name);
  });
}

/**
 * The note that says how to see the rows the limit cut off.
 */
function truncatedNote(limit: number, total: number, sortBy?: string): string {
  const order = sortBy ? ` in the order asked for (${sortBy})` : '';
  return (
    `The rows are cut short: showing the first ${limit} of ${total} matches${order}. ` +
    'Ask again with a larger limit to see the rest.'
  );
}

/** Find dishes by name, in one hall or across all of them. */
export async function searchDishes(
  query: string,
  options: SweepOptions & { limit?: number; sort_by?: string; sort_order?: 'asc' | 'desc' } = {},
): Promise<DishSearchResult> {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new ServiceError('The search query must not be empty.');

  // The sort field is checked before anything is fetched, so a typo is
  // reported without spending a request on the site.
  const sortField = options.sort_by ? resolveSortField(options.sort_by) : undefined;

  const sweep = await sweepMenus(options, (match) => match.name.toLowerCase().includes(needle));
  sortMatches(sweep.matches, sortField, options.sort_order);
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));

  return {
    query: query.trim(),
    date: sweep.date,
    dateRange: sweep.dateRange,
    matches: sweep.matches.slice(0, limit),
    failures: sweep.failures,
    totalMatches: sweep.matches.length,
    truncated: sweep.matches.length > limit,
    stale: sweep.stale,
    coverage: sweep.coverage,
    emptyDates: sweep.emptyDates,
    unknownMealLabels: sweep.unknownMealLabels,
    stationNote: sweep.stationNote,
    truncationNote: sweep.matches.length > limit ? truncatedNote(limit, sweep.matches.length, options.sort_by) : undefined,
  };
}

export interface NutrientRange { min?: number; max?: number; unit?: string; }

export interface FilterOptions extends SweepOptions {
  exclude_allergens?: string[];
  require_traits?: string[];
  min_mhealthy?: number;
  max_carbon?: number;
  max_calories?: number;
  min_calories?: number;
  max_sodium_mg?: number;
  min_sodium_mg?: number;
  nutrients?: Record<string, NutrientRange>;
  query?: string;
  /** The meal to narrow the sweep to, as the site labels it. */
  meal?: string;
  station?: string;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  limit?: number;
}

const CARBON_RANK: Record<number, number> = { 1: 1, 2: 2, 3: 3 };

/** Filter the menus by allergen, trait, nutrient density, carbon and calories. */
export async function filterDishes(options: FilterOptions = {}): Promise<DishFilterResult> {
  const exclude = new Set(options.exclude_allergens ?? []);
  const require = options.require_traits ?? [];

  // The thresholds are checked before anything is fetched, so a bad bound is
  // reported without spending a request on the site.
  const ranges = new Map<string, ResolvedNutrientRange>();
  for (const [key, range] of Object.entries(options.nutrients ?? {})) {
    ranges.set(key, resolveNutrientRange(key, range));
  }

  // The sort field is checked before anything is fetched, so a typo is
  // reported without spending a request on the site.
  const sortField = options.sort_by ? resolveSortField(options.sort_by) : undefined;

  const sweep = await sweepMenus(options, (match) => {
    for (const allergen of exclude) {
      if (match.allergens.includes(allergen)) return false;
    }
    for (const trait of require) {
      if (!match.traits.includes(trait)) return false;
    }
    if (options.min_mhealthy !== undefined) {
      if (match.mhealthyTier === null || match.mhealthyTier < options.min_mhealthy) return false;
    }
    if (options.max_carbon !== undefined) {
      if (match.carbonFootprint === null) return false;
      if (CARBON_RANK[match.carbonFootprint]! > CARBON_RANK[options.max_carbon]!) return false;
    }
    if (options.query) {
      if (!match.name.toLowerCase().includes(options.query.trim().toLowerCase())) return false;
    }
    // backward compat calories
    if (options.max_calories !== undefined) {
      if (match.calories === null || match.calories > options.max_calories) return false;
    }
    if (options.min_calories !== undefined) {
      if (match.calories === null || match.calories < options.min_calories) return false;
    }
    if (options.max_sodium_mg !== undefined) {
      if (match.sodiumMg === null || match.sodiumMg > options.max_sodium_mg) return false;
    }
    if (options.min_sodium_mg !== undefined) {
      if (match.sodiumMg === null || match.sodiumMg < options.min_sodium_mg) return false;
    }
    // nutrients
    for (const range of ranges.values()) {
      const value = nutrientValueInUnit(range.key, range.unit, match.nutrition);
      if (range.min !== null) {
        if (value === null || value < range.min) return false;
      }
      if (range.max !== null) {
        if (value === null || value > range.max) return false;
      }
    }
    return true;
  });

  // The sort is applied to the whole answer, before the limit.
  sortMatches(sweep.matches, sortField, options.sort_order);

  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));

  return {
    date: sweep.date,
    dateRange: sweep.dateRange,
    matches: sweep.matches.slice(0, limit),
    failures: sweep.failures,
    totalMatches: sweep.matches.length,
    truncated: sweep.matches.length > limit,
    stale: sweep.stale,
    coverage: sweep.coverage,
    emptyDates: sweep.emptyDates,
    unknownMealLabels: sweep.unknownMealLabels,
    stationNote: sweep.stationNote,
    truncationNote: sweep.matches.length > limit ? truncatedNote(limit, sweep.matches.length, options.sort_by) : undefined,
  };
}

export interface ItemNutritionResult {
  hall: HallId;
  hallName: string;
  date: string;
  /** The meal, as the site labels it. */
  meal: string;
  station: string;
  name: string;
  traits: string[];
  traitLabels: Record<string, string>;
  allergens: string[];
  mhealthyTier: number | null;
  carbonFootprint: CarbonLevel | null;
  nutrition: unknown;
  /** The weight of a serving, derived from the published serving size. */
  servingSizeGrams: number | null;
  /**
   * The micronutrients: the percent the site publishes and the amount it
   * stands for.
   */
  micronutrients: Record<string, number | null>;
  warning: string;
}

/** A dish of a menu page, with the meal and the station it was served at. */
interface MenuCandidate {
  /** The meal, as the site labels it. */
  meal: string;
  station: string;
  name: string;
  traits: string[];
  traitLabels: Record<string, string>;
  allergens: string[];
  mhealthyTier: number | null;
  carbonFootprint: CarbonLevel | null;
  nutrition: Nutrition | null;
}

function candidatesOf(page: HallPage, meal?: string, station?: string): MenuCandidate[] {
  const candidates: MenuCandidate[] = [];
  const pageMeals: { label: string; stations: { name: string; items: Omit<MenuCandidate, 'meal' | 'station'>[] }[] }[] = [
    ...(Object.entries(page.menu.meals) as [
      MealName,
      { name: string; items: Omit<MenuCandidate, 'meal' | 'station'>[] }[],
    ][]).map(([label, stations]) => ({ label, stations })),
    ...page.menu.otherMeals.map((other) => ({ label: other.label, stations: other.stations })),
  ];
  for (const { label: mealName, stations } of pageMeals) {
    if (meal && mealName.toLowerCase() !== meal.toLowerCase()) continue;
    for (const entry of stations) {
      if (station && entry.name.toLowerCase() !== station.toLowerCase()) continue;
      for (const item of entry.items) {
        candidates.push({ meal: mealName, station: entry.name, ...item });
      }
    }
  }
  return candidates;
}

/**
 * Pick one dish out of the candidates.
 *
 * An exact name match wins, even when the hall serves that name more than
 * once; otherwise a unique substring match is used. An ambiguous name is
 * reported instead of being guessed.
 */
function resolveDish(
  candidates: MenuCandidate[],
  itemName: string,
  where: string,
): MenuCandidate {
  const needle = itemName.trim().toLowerCase();
  if (candidates.length === 0) {
    throw new ServiceError(`No dish called "${itemName}" is served ${where}.`);
  }

  const exact = candidates.filter((candidate) => candidate.name.toLowerCase() === needle);
  if (exact.length > 0) return exact[0]!;

  if (candidates.length === 1) return candidates[0]!;

  const names = [...new Set(candidates.map((candidate) => candidate.name))].slice(0, 10);
  throw new ServiceError(
    `"${itemName}" matches ${candidates.length} dishes ${where}. ` +
      `Be more specific. Candidates include: ${names.join(', ')}.`,
  );
}

/**
 * The micronutrients of a panel, as the published percent and the amount it
 * stands for.
 */
function micronutrientAmounts(
  nutrition: Nutrition | null | undefined,
): Record<string, number | null> {
  const amounts: Record<string, number | null> = {};
  for (const spec of MICRONUTRIENT_SPECS) {
    const raw = nutrition ? findMicronutrientValue(nutrition.micronutrients, spec.name) : null;
    const derived = deriveMicronutrient(spec.name, raw);
    amounts[spec.name] = derived?.amount ?? null;
  }
  return amounts;
}

/**
 * The full nutrition panel of a single dish.
 *
 * The item name is matched case-insensitively: an exact match wins, otherwise
 * a unique substring match is used. An ambiguous name is reported instead of
 * being guessed. The meal and the station narrow the candidates when the same
 * name is served more than once.
 */
export async function getItemNutrition(
  hallId: HallId,
  itemName: string,
  date?: string,
  meal?: string,
  station?: string,
): Promise<ItemNutritionResult> {
  const needle = itemName.trim().toLowerCase();
  if (!needle) throw new ServiceError('The item name must not be empty.');

  const today = todayIn();
  const requested = date ?? today;
  validateDate(requested, today);
  const page = await loadHallPage(hallId, requested, today, { deadline: new Deadline() });

  const where = `at ${page.hall.name} on ${requested}`;
  const all = candidatesOf(page, meal, station);
  const candidates = all.filter((candidate) => candidate.name.toLowerCase().includes(needle));
  const chosen = resolveDish(candidates, itemName, where);

  if (!chosen.nutrition) {
    throw new ServiceError(
      `${page.hall.name} does not publish a nutrition panel for "${chosen.name}" on ${requested}.`,
    );
  }

  return {
    hall: page.hall.id,
    hallName: page.hall.name,
    date: requested,
    meal: chosen.meal,
    station: chosen.station,
    name: chosen.name,
    traits: chosen.traits,
    traitLabels: chosen.traitLabels,
    allergens: chosen.allergens,
    mhealthyTier: chosen.mhealthyTier,
    carbonFootprint: chosen.carbonFootprint,
    nutrition: chosen.nutrition,
    servingSizeGrams: parseServingSizeGrams(chosen.nutrition?.servingSize ?? null),
    micronutrients: micronutrientAmounts(chosen.nutrition),
    warning: ALLERGEN_REMINDER,
  };
}

