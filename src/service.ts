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
  RegularHours,
  ServicePeriod,
} from './types.js';
import { ALLERGEN_CAVEAT } from './taxonomy.js';

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
  meal: MealName;
  station: string;
  name: string;
  traits: string[];
  traitLabels: Record<string, string>;
  allergens: string[];
  mhealthyTier: number | null;
  carbonFootprint: 'low' | 'medium' | 'high' | null;
  calories: number | null;
  sodiumMg: number | null;
}

export interface DishSearchResult {
  query: string;
  date: string;
  matches: DishMatch[];
  /** Halls that could not be read; the other halls are still reported. */
  failures: { hall: HallId; hallName: string; error: string }[];
  totalMatches: number;
  warning: string;
}

export interface DishFilterResult {
  date: string;
  matches: DishMatch[];
  failures: { hall: HallId; hallName: string; error: string }[];
  totalMatches: number;
  warning: string;
}

interface HallPage {
  hall: DiningHall;
  date: string;
  menu: ParsedMenu;
  location: LocationDetails;
  periods: ServicePeriod[];
  renderedDate: string | null;
  stale: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The current date in the time zone the site publishes "today" in. */
export function todayIn(timeZone: string = config.timezone, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
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
 * location details, so one request serves all of them.
 */
export async function loadHallPage(
  hallId: HallId,
  date: string,
  today: string = todayIn(),
): Promise<HallPage> {
  const hall = getHallDefinition(hallId);
  const key = `hall:${hallId}:${date}`;
  const ttl = ttlForDate(date, today);

  const { value, stale } = await cache.fetch(key, ttl, async () => {
    const html = await fetchText(menuUrl(hall, date));
    let menu: ParsedMenu;
    let location: LocationDetails;
    let periods: ServicePeriod[];
    try {
      const $ = load(html);
      menu = parseMenuPage(html);
      location = parseLocationDetails($);
      periods = parseTodaysHours($);
    } catch (error) {
      if (error instanceof ParseError) throw new ServiceError(error.message);
      throw error;
    }
    return { menu, location, periods };
  });

  return {
    hall,
    date,
    menu: value.menu,
    location: value.location,
    periods: value.periods,
    renderedDate: value.menu.renderedDate,
    stale,
  };
}

/**
 * Get the menu of a hall for a date.
 *
 * The requested date is checked against the published range, and the date the
 * page actually rendered is compared with the requested one: when the site
 * falls back to another day's menu the call fails instead of returning data
 * that belongs to a different day.
 */
export async function getMenu(hallId: HallId, date?: string): Promise<HallPage> {
  const today = todayIn();
  const requested = date ?? today;
  validateDate(requested, today);

  const page = await loadHallPage(hallId, requested, today);

  if (page.renderedDate && page.renderedDate !== requested) {
    throw new ServiceError(
      `The site returned the menu for ${page.renderedDate} when ${requested} was requested. ` +
        'The published range may have changed; try a date within the range the site offers.',
    );
  }

  if (page.menu.itemCount === 0) {
    throw new ServiceError(`No menu is published for ${requested} at ${page.hall.name}.`);
  }

  return page;
}

/** The regular weekly schedule of every dining hall. */
export async function loadRegularHours(): Promise<Map<HallId, RegularHours>> {
  const { value } = await cache.fetch('regular-hours', config.ttl.regularHours, async () => {
    const html = await fetchText(`${config.baseUrl}${REGULAR_HOURS_PATH}`);
    return parseRegularHours(html);
  });
  return value;
}

function minutesNow(timeZone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now);
  const get = (type: 'hour' | 'minute'): number =>
    Number.parseInt(parts.find((part) => part.type === type)?.value ?? '0', 10);
  return get('hour') * 60 + get('minute');
}

export function isOpenNow(periods: ServicePeriod[], now: Date = new Date()): boolean {
  const current = minutesNow(config.timezone, now);
  return periods.some((period) => {
    if (period.closed) return false;
    const range = parseTimeRange(period.times);
    if (!range) return false;
    return current >= range.start && current <= range.end;
  });
}

/** The ten halls with the service periods of the requested day. */
export async function listLocations(date?: string): Promise<{
  date: string;
  locations: LocationSummary[];
  failures: { hall: HallId; hallName: string; error: string }[];
}> {
  const today = todayIn();
  const requested = date ?? today;
  validateDate(requested, today);
  const now = new Date();

  const settled = await Promise.all(
    HALLS.map(async (hall) => {
      try {
        const page = await loadHallPage(hall.id, requested, today);
        const summary: LocationSummary = {
          ...hall,
          address: page.location.address,
          phone: page.location.phone,
          email: page.location.email,
          mapUrl: page.location.mapUrl,
          meals: publishedMeals(page.menu),
          date: requested,
          today: page.periods,
          openNow: isOpenNow(page.periods, now),
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

function publishedMeals(menu: ParsedMenu): MealName[] {
  const meals: MealName[] = [];
  for (const [meal, stations] of Object.entries(menu.meals) as [MealName, { items: unknown[] }[]][]) {
    if (stations.length > 0) meals.push(meal);
  }
  return meals;
}

/** The service periods of a hall for the requested day, plus the weekly schedule. */
export async function getHours(hallId?: HallId, date?: string): Promise<HallHours[]> {
  const today = todayIn();
  const requested = date ?? today;
  validateDate(requested, today);
  const halls = hallId ? [getHallDefinition(hallId)] : HALLS;
  const regular = await loadRegularHours();

  return Promise.all(
    halls.map(async (hall): Promise<HallHours> => {
      const page = await loadHallPage(hall.id, requested, today);
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
}

/** The halls that are serving at the current time. */
export async function findOpenNow(): Promise<{
  date: string;
  open: LocationSummary[];
  closed: LocationSummary[];
  failures: { hall: HallId; hallName: string; error: string }[];
}> {
  const { date, locations, failures } = await listLocations();
  return {
    date,
    open: locations.filter((summary) => summary.openNow),
    closed: locations.filter((summary) => !summary.openNow),
    failures,
  };
}

function toDishMatch(
  hall: DiningHall,
  date: string,
  meal: MealName,
  station: string,
  item: {
    name: string;
    traits: string[];
    traitLabels: Record<string, string>;
    allergens: string[];
    mhealthyTier: number | null;
    carbonFootprint: 'low' | 'medium' | 'high' | null;
    nutrition: { calories: number | null; sodium: string | null } | null;
  },
): DishMatch {
  const sodium = item.nutrition?.sodium ?? null;
  const sodiumMg = sodium ? Number.parseInt(sodium.replace(/[^0-9]/g, ''), 10) : null;
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
    sodiumMg: Number.isFinite(sodiumMg) ? sodiumMg : null,
  };
}

interface SweepOptions {
  hall?: HallId;
  date?: string;
}

interface Sweep {
  date: string;
  matches: DishMatch[];
  failures: { hall: HallId; hallName: string; error: string }[];
}

async function sweepMenus(options: SweepOptions, accept: (match: DishMatch) => boolean): Promise<Sweep> {
  const today = todayIn();
  const date = options.date ?? today;
  validateDate(date, today);
  const halls = options.hall ? [getHallDefinition(options.hall)] : HALLS;

  const matches: DishMatch[] = [];
  const failures: { hall: HallId; hallName: string; error: string }[] = [];

  await Promise.all(
    halls.map(async (hall) => {
      try {
        const page = await loadHallPage(hall.id, date, today);
        for (const [meal, stations] of Object.entries(page.menu.meals) as [
          MealName,
          { name: string; items: Parameters<typeof toDishMatch>[4][] }[],
        ][]) {
          for (const station of stations) {
            for (const item of station.items) {
              const match = toDishMatch(hall, date, meal, station.name, item);
              if (accept(match)) matches.push(match);
            }
          }
        }
      } catch (error) {
        failures.push({
          hall: hall.id,
          hallName: hall.name,
          error: error instanceof HttpError || error instanceof ServiceError ? error.message : String(error),
        });
      }
    }),
  );

  matches.sort((a, b) => a.hall.localeCompare(b.hall) || a.meal.localeCompare(b.meal) || a.name.localeCompare(b.name));
  return { date, matches, failures };
}

/** Find dishes by name, in one hall or across all of them. */
export async function searchDishes(
  query: string,
  options: SweepOptions & { limit?: number } = {},
): Promise<DishSearchResult> {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new ServiceError('The search query must not be empty.');

  const sweep = await sweepMenus(options, (match) => match.name.toLowerCase().includes(needle));
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));

  return {
    query: query.trim(),
    date: sweep.date,
    matches: sweep.matches.slice(0, limit),
    failures: sweep.failures,
    totalMatches: sweep.matches.length,
    warning: ALLERGEN_CAVEAT,
  };
}

export interface FilterOptions extends SweepOptions {
  exclude_allergens?: string[];
  require_traits?: string[];
  min_mhealthy?: number;
  max_carbon?: 'low' | 'medium' | 'high';
  max_calories?: number;
  max_sodium_mg?: number;
  limit?: number;
}

const CARBON_RANK: Record<'low' | 'medium' | 'high', number> = { low: 1, medium: 2, high: 3 };

/** Filter the menus by allergen, trait, nutrient density, carbon and calories. */
export async function filterDishes(options: FilterOptions = {}): Promise<DishFilterResult> {
  const exclude = new Set(options.exclude_allergens ?? []);
  const require = options.require_traits ?? [];

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
      if (CARBON_RANK[match.carbonFootprint] > CARBON_RANK[options.max_carbon]) return false;
    }
    if (options.max_calories !== undefined) {
      if (match.calories === null || match.calories > options.max_calories) return false;
    }
    if (options.max_sodium_mg !== undefined) {
      if (match.sodiumMg === null || match.sodiumMg > options.max_sodium_mg) return false;
    }
    return true;
  });

  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));

  return {
    date: sweep.date,
    matches: sweep.matches.slice(0, limit),
    failures: sweep.failures,
    totalMatches: sweep.matches.length,
    warning: ALLERGEN_CAVEAT,
  };
}

export interface ItemNutritionResult {
  hall: HallId;
  hallName: string;
  date: string;
  meal: MealName;
  station: string;
  name: string;
  traits: string[];
  traitLabels: Record<string, string>;
  allergens: string[];
  mhealthyTier: number | null;
  carbonFootprint: 'low' | 'medium' | 'high' | null;
  nutrition: unknown;
  warning: string;
}

/**
 * The full nutrition panel of a single dish.
 *
 * The item name is matched case-insensitively: an exact match wins, otherwise
 * a unique substring match is used. An ambiguous name is reported instead of
 * being guessed.
 */
export async function getItemNutrition(
  hallId: HallId,
  itemName: string,
  date?: string,
): Promise<ItemNutritionResult> {
  const needle = itemName.trim().toLowerCase();
  if (!needle) throw new ServiceError('The item name must not be empty.');

  const today = todayIn();
  const requested = date ?? today;
  validateDate(requested, today);
  const page = await loadHallPage(hallId, requested, today);

  const candidates: {
    meal: MealName;
    station: string;
    name: string;
    traits: string[];
    traitLabels: Record<string, string>;
    allergens: string[];
    mhealthyTier: number | null;
    carbonFootprint: 'low' | 'medium' | 'high' | null;
    nutrition: unknown;
  }[] = [];

  for (const [meal, stations] of Object.entries(page.menu.meals) as [MealName, { name: string; items: unknown[] }[]][]) {
    for (const station of stations) {
      for (const item of station.items as {
        name: string;
        traits: string[];
        traitLabels: Record<string, string>;
        allergens: string[];
        mhealthyTier: number | null;
        carbonFootprint: 'low' | 'medium' | 'high' | null;
        nutrition: unknown;
      }[]) {
        if (item.name.toLowerCase().includes(needle)) {
          candidates.push({ meal, station: station.name, ...item });
        }
      }
    }
  }

  if (candidates.length === 0) {
    throw new ServiceError(`No dish called "${itemName}" is served at ${page.hall.name} on ${requested}.`);
  }

  const exact = candidates.filter((candidate) => candidate.name.toLowerCase() === needle);
  const chosen = exact.length === 1 ? exact[0] : exact.length > 1 ? exact[0] : candidates.length === 1 ? candidates[0] : null;

  if (!chosen) {
    const names = [...new Set(candidates.map((candidate) => candidate.name))].slice(0, 10);
    throw new ServiceError(
      `"${itemName}" matches ${candidates.length} dishes at ${page.hall.name} on ${requested}. ` +
        `Be more specific. Candidates include: ${names.join(', ')}.`,
    );
  }

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
    warning: ALLERGEN_CAVEAT,
  };
}
