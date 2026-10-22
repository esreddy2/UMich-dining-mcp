import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { closeTraits, carbonFootprint, mhealthyTier, traitLabel } from '../taxonomy.js';
import type { MealName, MenuItem, OtherMeal, Station } from '../types.js';
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
  /** Meals the site published that this server has no slot for. */
  otherMeals: OtherMeal[];
  /** Meal labels the site used that this server does not know. */
  unknownMealLabels: string[];
  /** The date the page says it rendered, when the page exposes it. */
  renderedDate: string | null;
  itemCount: number;
  stationCount: number;
  /** True when the site published its "no menu" marker. */
  noMenu: boolean;
}

/**
 * The meal labels the site uses. Brunch is the fourth: the site publishes it
 * on the weekend days, where it is often the only meal of the afternoon.
 */
export const MEAL_BY_LABEL: Record<string, MealName> = {
  breakfast: 'Breakfast',
  brunch: 'Brunch',
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
 * The date the page declares, read from `h2.menuTitle span.date`.
 *
 * The site writes it in the plain HTML: "Menu for Thursday, October 22, 2026".
 * This is the date the page is about, and it is what the out-of-window guard
 * compares with the date that was asked for.
 */
export function extractDeclaredDate($: CheerioAPI): string | null {
  const text = normalizeText($('h2.menuTitle span.date, .menuTitle span.date').first().text());
  if (!text) return null;

  const match = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(text);
  if (!match) return null;
  const month = MONTHS[match[1]!.toLowerCase()];
  const day = Number.parseInt(match[2]!, 10);
  const year = Number.parseInt(match[3]!, 10);
  if (!month || !Number.isFinite(day) || !Number.isFinite(year)) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * The date the page rendered.
 *
 * The plain HTML states it in `h2.menuTitle span.date`; a page rendered in a
 * browser also carries a jQuery UI datepicker, which is used as a fallback.
 */
export function extractRenderedDate($: CheerioAPI): string | null {
  const declared = extractDeclaredDate($);
  if (declared) return declared;

  // The datepicker is injected by a script, so a plain HTTP fetch never has
  // one: the check is made once, before the four queries below.
  const picker = $('.ui-datepicker, .datepicker').first();
  if (picker.length === 0) return null;

  const monthText = normalizeText(picker.find('.ui-datepicker-month, .datepicker-month').first().text());
  const yearText = normalizeText(picker.find('.ui-datepicker-year, .datepicker-year').first().text());
  const active = picker.find('.ui-state-active').first();
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
export function parseMenuPage(htmlOr$: string | CheerioAPI): ParsedMenu {
  const $ = typeof htmlOr$ === 'string' ? load(htmlOr$) : htmlOr$;
  const root = $('#mdining-items');
  if (root.length === 0) {
    throw new ParseError('The page has no #mdining-items container; it is not a dining hall menu page.');
  }

  const meals: Record<MealName, Station[]> = { Breakfast: [], Brunch: [], Lunch: [], Dinner: [] };
  const mealLabels: Partial<Record<MealName, string>> = {};
  const otherMeals: OtherMeal[] = [];
  const unknownMealLabels: string[] = [];
  let itemCount = 0;
  let stationCount = 0;

  root.children('h3').each((_, heading) => {
    const label = normalizeText($(heading).text());
    const courses = $(heading).next('.courses');
    if (courses.length === 0) return;

    const stations = parseStations($, courses);
    const meal = MEAL_BY_LABEL[label.toLowerCase()];
    if (!meal) {
      // A label this server has no slot for is kept as its own bucket: the
      // dishes of an unknown meal are still the site's dishes.
      unknownMealLabels.push(label);
      otherMeals.push({ label, stations });
    } else {
      mealLabels[meal] = label;
      meals[meal] = stations;
    }
    stationCount += stations.length;
    for (const station of stations) itemCount += station.items.length;
  });

  // The site says so itself when a hall publishes no menu for a day.
  const noMenu = root.find('p.no-menu, .no-menu').length > 0;

  if (stationCount === 0 && !noMenu) {
    throw new ParseError('The menu page contains no stations; the site layout has probably changed.');
  }

  return {
    meals,
    mealLabels,
    otherMeals,
    unknownMealLabels,
    renderedDate: extractRenderedDate($),
    itemCount,
    stationCount,
    noMenu,
  };
}
