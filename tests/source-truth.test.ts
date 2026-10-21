import { describe, expect, it } from 'vitest';
import { parseMenuPage } from '../src/parser/menu.js';
import { MEAL_NAMES, type MealName, type MenuItem, type Nutrition } from '../src/types.js';
import { HALL_FIXTURES, readFixture } from './helpers.js';

/**
 * A second, deliberately simple reader of the site's markup.
 *
 * Everything in this file works on the raw text of a fixture with regular
 * expressions only: it never builds a tree and never imports the parser.
 * A parser that mis-nests an element, loses a dish, drops a trait or shifts
 * a nutrition panel onto the wrong dish shows up here, because the facts are
 * taken from the markup and not from the parser.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  hellip: '...',
  times: 'x',
  deg: '°',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  szlig: 'ß',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  shy: '',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity.startsWith('#x') || entity.startsWith('#X')
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named ?? match;
  });
}

/** The text of a fragment of markup: tags become spaces, entities are decoded. */
function text(markup: string): string {
  return decodeEntities(markup.replace(/<[^>]*>/g, ' ').replace(/[\u00a0]/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

interface SourceRow {
  className: string;
  text: string;
}

/** The rows of one nutrition table, as the site writes them. */
function tableRows(markup: string): SourceRow[] {
  const rows: SourceRow[] = [];
  for (const match of markup.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/g)) {
    const className = /class="([^"]*)"/.exec(match[1] ?? '')?.[1] ?? '';
    rows.push({ className, text: text(match[2] ?? '') });
  }
  return rows;
}

/** The dish names of the markup, in the order they appear. */
function itemNames(markup: string): string[] {
  return [...markup.matchAll(/<span class="item-name">([\s\S]*?)<\/span>/g)].map((match) =>
    text(match[1] ?? ''),
  );
}

/**
 * The classes of the element each dish belongs to.
 *
 * The element of a dish is the `li` that opens just before its name; the
 * trait list of the dish comes after the name, so the closest `li` in front
 * of the name is always the dish itself.
 */
function itemClasses(markup: string): string[] {
  const classes: string[] = [];
  for (const match of markup.matchAll(/<span class="item-name">/g)) {
    const before = markup.slice(0, match.index);
    const open = [...before.matchAll(/<li\b([^>]*)>/g)].pop();
    classes.push(/class="([^"]*)"/.exec(open?.[1] ?? '')?.[1] ?? '');
  }
  return classes;
}

/** The nutrition tables of the markup, in the order they appear. */
function nutritionTables(markup: string): string[] {
  return [...markup.matchAll(/<table class="nutrition-facts">([\s\S]*?)<\/table>/g)].map(
    (match) => match[1] ?? '',
  );
}

/** The station headings of the menu, the `h4` elements of the page. */
function stationHeadings(markup: string): string[] {
  return [...markup.matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>/g)].map((match) => text(match[1] ?? ''));
}

/** The meal headings of the menu, the `h3` elements of the menu block. */
function mealHeadings(markup: string): string[] {
  const start = markup.indexOf('<div id="mdining-items">');
  const block = start >= 0 ? markup.slice(start) : markup;
  return [...block.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)].map((match) => text(match[1] ?? ''));
}

/** The headings of the page that are not stations. */
const PAGE_HEADINGS = ['Special Diets', 'MyNutrition'];

/**
 * The heading of the hours block names the day the page shows: "Today's
 * Hours" for the current day, "Thursday's Hours" for another one. It is
 * matched by its ending, because the day in it changes with the capture.
 */
function isPageHeading(heading: string): boolean {
  return PAGE_HEADINGS.includes(heading) || /Hours$/.test(heading);
}

type NutrientField =
  | 'totalFat'
  | 'saturatedFat'
  | 'transFat'
  | 'cholesterol'
  | 'sodium'
  | 'totalCarbohydrate'
  | 'dietaryFiber'
  | 'sugars'
  | 'protein';

/** The name the site writes in the table for every nutrient. */
const NUTRIENT_ROW: [NutrientField, string][] = [
  ['totalFat', 'Total Fat'],
  ['saturatedFat', 'Saturated Fat'],
  ['transFat', 'Trans Fat'],
  ['cholesterol', 'Cholesterol'],
  ['sodium', 'Sodium'],
  ['totalCarbohydrate', 'Total Carbohydrate'],
  ['dietaryFiber', 'Dietary Fiber'],
  ['sugars', 'Sugars'],
  ['protein', 'Protein'],
];

interface ParsedDish {
  meal: MealName;
  station: string;
  name: string;
  traits: string[];
  allergens: string[];
  nutrition: Nutrition | null;
}

function dishes(html: string): ParsedDish[] {
  const result: ParsedDish[] = [];
  for (const station of stations(html)) {
    for (const item of station.items) {
      result.push({
        meal: station.meal,
        station: station.name,
        name: item.name,
        traits: item.traits,
        allergens: item.allergens,
        nutrition: item.nutrition,
      });
    }
  }
  return result;
}

interface ParsedStation {
  meal: MealName;
  name: string;
  items: MenuItem[];
}

/** The stations of the page, in the order of the markup. */
function stations(html: string): ParsedStation[] {
  const menu = parseMenuPage(html);
  const order = mealHeadings(html).filter((label): label is MealName =>
    (MEAL_NAMES as readonly string[]).includes(label),
  );
  const result: ParsedStation[] = [];
  for (const meal of order.length > 0 ? order : MEAL_NAMES) {
    for (const station of menu.meals[meal]) {
      result.push({ meal, name: station.name, items: station.items });
    }
  }
  return result;
}

describe('the parser against the raw markup', () => {
  for (const [hall, fixture] of Object.entries(HALL_FIXTURES)) {
    describe(hall, () => {
      const html = readFixture(fixture);
      const parsed = dishes(html);

      it('reads as many dishes as the markup names', () => {
        expect(parsed).toHaveLength(itemNames(html).length);
      });

      it('reads the dish names in the order of the markup', () => {
        expect(parsed.map((dish) => dish.name)).toEqual(itemNames(html));
      });

      it('reads every station of the page', () => {
        const headings = stationHeadings(html);
        const stationsOfPage = stations(html).map((station) => station.name);
        // The stations are the headings of the page, in the same order; the
        // three headings that are not stations sit in front of them.  A hall
        // may serve the same station in more than one meal, so the two lists
        // are compared as they are, duplicates included.
        const stationHeadingsOfPage = headings.filter(
          (heading) => !isPageHeading(heading),
        );
        expect(stationsOfPage).toEqual(stationHeadingsOfPage);
      });

      it('reads the traits and the allergens from the element of every dish', () => {
        const classes = itemClasses(html);
        expect(classes).toHaveLength(parsed.length);

        parsed.forEach((dish, index) => {
          const elementClasses = (classes[index] ?? '').split(/\s+/).filter(Boolean);
          const traitClasses = elementClasses
            .filter((name) => name.startsWith('trait-'))
            .map((name) => name.slice('trait-'.length));
          const allergenClasses = elementClasses
            .filter((name) => name.startsWith('allergen-'))
            .map((name) => name.slice('allergen-'.length));

          // The site publishes the trait list separately from the classes, so
          // the parsed traits hold the classes and everything the list adds.
          expect(
            dish.traits.filter((trait) => traitClasses.includes(trait)).sort(),
            `${dish.name} traits`,
          ).toEqual([...traitClasses].sort());
          for (const trait of dish.traits) {
            expect(traitClasses.includes(trait) || trait === 'vegetarian', `${dish.name} trait`).toBe(
              true,
            );
          }
          expect(dish.allergens, `${dish.name} allergens`).toEqual([...allergenClasses].sort());
        });
      });

      it('reads a nutrition panel for every table of the markup', () => {
        const tables = nutritionTables(html);
        const withPanel = parsed.filter((dish) => dish.nutrition !== null);
        expect(withPanel).toHaveLength(tables.length);
      });

      it('reads every value of every panel out of the rows of its table', () => {
        const tables = nutritionTables(html);
        const withPanel = parsed.filter((dish) => dish.nutrition !== null);

        withPanel.forEach((dish, index) => {
          const rows = tableRows(tables[index] ?? '');
          const nutrition = dish.nutrition;
          if (!nutrition) throw new Error(`${dish.name} has no panel`);

          const serving = rows.find((row) => row.className.includes('serving-size'));
          expect(serving, `${dish.name} serving size`).toBeDefined();
          expect(nutrition.servingSize).not.toBeNull();
          expect(serving?.text).toContain(nutrition.servingSize as string);

          const calories = rows.find((row) => row.className.includes('portion-calories'));
          expect(calories, `${dish.name} calories`).toBeDefined();
          expect(calories?.text).toContain(String(nutrition.calories));

          for (const [field, nutrient] of NUTRIENT_ROW) {
            const value = nutrition[field];
            if (typeof value !== 'string') continue;
            const row = rows.find((entry) => entry.text.startsWith(nutrient));
            expect(row, `${dish.name} ${nutrient}`).toBeDefined();
            expect(row?.text, `${dish.name} ${nutrient}`).toContain(value);
          }

          const micronutrientRows = rows.filter((row) => row.className.includes('micronutrient'));
          expect(Object.keys(nutrition.micronutrients)).toHaveLength(micronutrientRows.length);
          for (const row of micronutrientRows) {
            const name = Object.keys(nutrition.micronutrients).find((key) => row.text.startsWith(key));
            expect(name, `${dish.name} micronutrient "${row.text}"`).toBeDefined();
            expect(row.text).toContain(nutrition.micronutrients[name as string]);
          }
        });
      });

      it('reads the panels in the order of the tables', () => {
        const tables = nutritionTables(html);
        const withPanel = parsed.filter((dish) => dish.nutrition !== null);
        // Two dishes that share a panel would show up here: the panels of the
        // site are in the order of the dishes that own them.
        const sizes = withPanel.map((dish) => dish.nutrition?.servingSize);
        const tableSizes = tables.map((markup) => {
          const row = tableRows(markup).find((entry) => entry.className.includes('serving-size'));
          return row?.text.replace(/^Serving Size\s*/i, '') ?? null;
        });
        expect(sizes).toEqual(tableSizes);
      });

      it('never reads a panel for a dish the site publishes without one', () => {
        const panels = parsed.filter((dish) => dish.nutrition !== null).length;
        const tables = nutritionTables(html).length;
        expect(panels).toBe(tables);
      });
    });
  }

  it('reads 562 dishes and 550 panels across the ten halls', () => {
    let dishes_ = 0;
    let panels = 0;
    for (const fixture of Object.values(HALL_FIXTURES)) {
      const html = readFixture(fixture);
      const parsed = dishes(html);
      dishes_ += parsed.length;
      panels += parsed.filter((dish) => dish.nutrition !== null).length;
      expect(parsed).toHaveLength(itemNames(html).length);
    }
    expect(dishes_).toBe(562);
    expect(panels).toBe(550);
  });
});
