import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { closeTraits, carbonFootprint, mhealthyTier, traitLabel } from '../taxonomy.js';
import type { MealName, MenuItem, Station } from '../types.js';
import { parseNutrition } from './nutrition.js';
import { normalizeText } from './text.js';

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export interface ParsedMenu {
  /** Stations per meal. Meals that are not published are empty arrays. */
  meals: Record<MealName, Station[]>;
  /** The site's own label for each meal, e.g. "Brunch" where it says so. */
  mealLabels: Partial<Record<MealName, string>>;
  /** Meal labels the site used that this server does not know. */
  unknownMealLabels: string[];
  /** The date the page says it rendered, when the page exposes it. */
  renderedDate: string | null;
  itemCount: number;
  stationCount: number;
}

const MEAL_BY_LABEL: Record<string, MealName> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
};

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * The date the page rendered, read from the jQuery UI datepicker the site
 * builds in the browser. The raw HTML does not contain it (the picker is
 * injected by script), so this returns null for a plain HTTP fetch and a date
 * for a rendered page.
 */
export function extractRenderedDate($: CheerioAPI): string | null {
  const monthText = normalizeText($('.ui-datepicker-month, .datepicker-month').first().text());
  const yearText = normalizeText($('.ui-datepicker-year, .datepicker-year').first().text());
  const active = $('.ui-state-active').first();
  const dayText = normalizeText(active.text()) || normalizeText(active.find('a, span').first().text());
  if (!monthText || !yearText || !dayText) return null;

  const month = MONTHS[monthText.toLowerCase()];
  const year = Number.parseInt(yearText, 10);
  const day = Number.parseInt(dayText, 10);
  if (!month || !Number.isFinite(year) || !Number.isFinite(day)) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function parseItem($: CheerioAPI, li: Cheerio<Element>): MenuItem | null {
  const name = normalizeText(li.find('span.item-name').first().text());
  if (!name) return null;

  const classes = (li.attr('class') ?? '').split(/\s+/).filter(Boolean);
  const traitSlugs: string[] = [];
  const allergens: string[] = [];

  for (const className of classes) {
    if (className.startsWith('trait-')) traitSlugs.push(className.slice('trait-'.length));
    if (className.startsWith('allergen-')) allergens.push(className.slice('allergen-'.length));
  }

  // The published trait list is the authoritative source; the classes are the
  // fallback for items that carry no trait list at all.
  const traitLabels: Record<string, string> = {};
  li.find('ul.traits > li').each((_, traitElement) => {
    const trait = $(traitElement);
    const slug = (trait.attr('class') ?? '').split(/\s+/).filter(Boolean)[0];
    if (!slug) return;
    if (!traitSlugs.includes(slug)) traitSlugs.push(slug);
    const label = normalizeText(trait.attr('title') ?? trait.text());
    if (label) traitLabels[slug] = label;
  });

  const traits = closeTraits(traitSlugs);
  for (const trait of traits) {
    if (!traitLabels[trait]) traitLabels[trait] = traitLabel(trait);
  }

  // The nutrition panel is the item's next sibling, not a child of it. Only
  // the immediate next sibling counts: the panel of the following item must
  // never be attributed to this one. A nested panel is accepted as well in
  // case the site changes the layout.
  const next = li.next();
  const siblingPanel = next.hasClass('nutrition') ? next : null;
  const nestedPanel = li.find('.nutrition').first();
  const panel = siblingPanel ?? (nestedPanel.length > 0 ? nestedPanel : null);
  const nutrition = panel ? parseNutrition($, panel) : null;

  return {
    name,
    traits,
    traitLabels,
    allergens: [...new Set(allergens)].sort(),
    mhealthyTier: mhealthyTier(traits),
    carbonFootprint: carbonFootprint(traits),
    nutrition,
  };
}

function parseStations($: CheerioAPI, courses: Cheerio<Element>): Station[] {
  const stations: Station[] = [];
  courses.find('ul.courses_wrapper').children('li').each((_, stationElement) => {
    const stationLi = $(stationElement);
    const name = normalizeText(stationLi.children('h4').first().text());
    if (!name) return;

    const items: MenuItem[] = [];
    stationLi.find('ul.items').children('li').each((__, itemElement) => {
      const itemLi = $(itemElement);
      // The station <li> is an ancestor of the item <li>; it must never be
      // counted as an item.
      if (itemLi.children('h4').length > 0) return;
      const item = parseItem($, itemLi);
      if (item) items.push(item);
    });

    stations.push({ name, items });
  });
  return stations;
}

/**
 * Parse a dining hall menu page.
 *
 * The menu lives in `#mdining-items`: an `h3` per meal followed by a
 * `div.courses` holding `ul.courses_wrapper > li` stations, each with an `h4`
 * name and a `ul.items` list of items.
 */
export function parseMenuPage(html: string): ParsedMenu {
  const $ = load(html);
  const root = $('#mdining-items');
  if (root.length === 0) {
    throw new ParseError('The page has no #mdining-items container; it is not a dining hall menu page.');
  }

  const meals: Record<MealName, Station[]> = { Breakfast: [], Lunch: [], Dinner: [] };
  const mealLabels: Partial<Record<MealName, string>> = {};
  const unknownMealLabels: string[] = [];
  let itemCount = 0;
  let stationCount = 0;

  root.children('h3').each((_, heading) => {
    const label = normalizeText($(heading).text());
    const courses = $(heading).next('.courses');
    if (courses.length === 0) return;

    const meal = MEAL_BY_LABEL[label.toLowerCase()];
    if (!meal) {
      unknownMealLabels.push(label);
      return;
    }

    const stations = parseStations($, courses);
    mealLabels[meal] = label;
    meals[meal] = stations;
    stationCount += stations.length;
    for (const station of stations) itemCount += station.items.length;
  });

  if (stationCount === 0) {
    throw new ParseError('The menu page contains no stations; the site layout has probably changed.');
  }

  return {
    meals,
    mealLabels,
    unknownMealLabels,
    renderedDate: extractRenderedDate($),
    itemCount,
    stationCount,
  };
}
