import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

export const FIXTURE_DIR = join(HERE, 'fixtures');
export const SNAPSHOT_DIR = join(HERE, 'snapshots');
export const EXPECTED_DIR = join(FIXTURE_DIR, 'expected');

/** The date the committed fixtures were captured for. */
export const FIXTURE_DATE = readFileSync(join(FIXTURE_DIR, 'capture-date.txt'), 'utf-8').trim();

/** The fixture file of a hall, named after its path under /menus-locations/. */
export const HALL_FIXTURES: Record<string, string> = {
  bursley: 'bursley.html',
  'east-quad': 'east-quad.html',
  markley: 'markley.html',
  'mosher-jordan': 'mosher-jordan.html',
  'north-quad': 'north-quad.html',
  'south-quad': 'south-quad.html',
  'twigs-at-oxford': 'twigs-at-oxford.html',
  'wolverine-village': 'wolverine-village-dining-hall.html',
  'lawyers-club': 'lawyers-club.html',
  'martha-cook': 'martha-cook.html',
};

export function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf-8');
}

export interface HallSnapshot {
  meals: Record<string, number>;
  stations: number;
  items: number;
  dishLines: string[];
}

export interface ItemNameSnapshot {
  capturedFor: string;
  halls: Record<string, HallSnapshot>;
}

export function readItemNameSnapshot(): ItemNameSnapshot {
  return JSON.parse(readFileSync(join(SNAPSHOT_DIR, 'item-names.json'), 'utf-8')) as ItemNameSnapshot;
}

/**
 * The expected data of a hall, written by `tests/oracle/build_expected.py`.
 *
 * The oracle is a second implementation of the site reader that shares no
 * code with `src/`, so the expectations describe the markup of the site and
 * not the behaviour of the parser under test.
 */
export interface ExpectedNutrition {
  servingSize: string | null;
  calories: number | null;
  totalFat: string | null;
  saturatedFat: string | null;
  transFat: string | null;
  cholesterol: string | null;
  sodium: string | null;
  totalCarbohydrate: string | null;
  dietaryFiber: string | null;
  sugars: string | null;
  protein: string | null;
  micronutrients: Record<string, string>;
}

export interface ExpectedPanel {
  /** The values read out of the rows of the nutrition table. */
  values: ExpectedNutrition;
}

export interface ExpectedItem {
  name: string;
  /** The `trait-*` classes of the item element. */
  traitClasses: string[];
  /** The `allergen-*` classes of the item element. */
  allergenClasses: string[];
  /** The trait list the site publishes with the item. */
  publishedTraits: { slug: string; label: string }[];
  /** The nutrition panel that follows the item, or null when there is none. */
  panel: ExpectedPanel | null;
}

export interface ExpectedStation {
  name: string;
  items: ExpectedItem[];
}

export interface ExpectedMeal {
  /** The label the site uses for the meal. */
  label: string;
  stations: ExpectedStation[];
}

export interface ExpectedHall {
  hall: string;
  meals: ExpectedMeal[];
  todayHours: { label: string; times: string }[];
  location: { address: string | null; phone: string | null; email: string | null; mapUrl: string | null };
  counts: { meals: number; stations: number; items: number; panels: number };
  source: { itemNameSpans: number; nutritionDivs: number; nutritionTables: number };
}

export interface ExpectedRegularHours {
  name: string;
  url: string | null;
  weekly: {
    dayLabel: string;
    days: string[];
    periods: { label: string; times: string; raw: string }[];
  }[];
}

export function readExpected(hall: string): ExpectedHall {
  return JSON.parse(readFileSync(join(EXPECTED_DIR, `${hall}.json`), 'utf-8')) as ExpectedHall;
}

export function readExpectedRegularHours(): Record<string, ExpectedRegularHours> {
  return JSON.parse(
    readFileSync(join(EXPECTED_DIR, 'regular-hours.json'), 'utf-8'),
  ) as Record<string, ExpectedRegularHours>;
}

/**
 * Answer every request with the committed fixtures, so the service layer can
 * be tested without the network.
 */
export interface FetchMock {
  calls: string[];
}

function fixtureForUrl(url: string): string | null {
  const path = new URL(url).pathname.replace(/^\/+/, '');
  if (path === 'menus-locations/regularhours') return readFixture('regularhours.html');
  const match = /^menus-locations\/(.+?)\/?$/.exec(path);
  if (!match || match[1] === undefined) return null;
  const name = `${match[1].split('/').pop()}.html`;
  try {
    return readFixture(name);
  } catch {
    return null;
  }
}

export function mockFixtureFetch(): FetchMock {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const body = fixtureForUrl(url);
    if (body === null) return new Response('not found', { status: 404 });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  });
  return { calls };
}

/** Answer every request with the given body, and count the calls. */
export function mockHtmlFetch(body: string, status = 200): FetchMock {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  });
  return { calls };
}
