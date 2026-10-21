import { describe, expect, it } from 'vitest';
import { parseMenuPage } from '../src/parser/menu.js';
import { HALL_FIXTURES, readFixture } from './helpers.js';

/**
 * The nutrition panels of the site, checked against the markup they are
 * written in.
 *
 * The panel of a dish is the `div.nutrition` that follows the dish inside the
 * item list, and it holds an FDA panel: a serving size, a calorie count, the
 * nine nutrients and the micronutrients.  The site writes the panel with two
 * broken tags - the serving size cell is closed with `</th>` and every dish
 * is closed with a `</li>` that has no matching element - so the values have
 * to be read from the rows of the table and not from the element structure.
 */

interface Row {
  className: string;
  text: string;
}

function rows(markup: string): Row[] {
  return [...markup.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/g)].map((match) => ({
    className: /class="([^"]*)"/.exec(match[1] ?? '')?.[1] ?? '',
    text: (match[2] ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
  }));
}

function panels(html: string): string[] {
  return [...html.matchAll(/<table class="nutrition-facts">([\s\S]*?)<\/table>/g)].map(
    (match) => match[1] ?? '',
  );
}

function allItems(html: string) {
  const menu = parseMenuPage(html);
  return Object.values(menu.meals).flat().flatMap((station) => station.items);
}

const NUTRIENT_FIELDS = [
  'totalFat',
  'saturatedFat',
  'transFat',
  'cholesterol',
  'sodium',
  'totalCarbohydrate',
  'dietaryFiber',
  'sugars',
  'protein',
] as const;

describe('nutrition panels', () => {
  it('reads the panel of a dish out of the rows of its table', () => {
    const html = readFixture('bursley.html');
    const oatmeal = allItems(html).find((item) => item.name === 'Oatmeal');
    const nutrition = oatmeal?.nutrition;

    // The values the site writes for the dish, read out of its table.
    const table = panels(html)[0] ?? '';
    const serving = rows(table).find((row) => row.className.includes('serving-size'));
    const calories = rows(table).find((row) => row.className.includes('portion-calories'));

    expect(serving?.text).toBe('Serving Size Cups (253g)');
    expect(calories?.text).toBe('Calories 183');
    expect(nutrition?.servingSize).toBe('Cups (253g)');
    expect(nutrition?.calories).toBe(183);
  });

  it('reads a serving size out of a row the site closes with the wrong tag', () => {
    const html = readFixture('bursley.html');
    // The site closes the serving size cell with </th> instead of </td>.
    const broken = /<tr class="serving-size">[\s\S]*?<\/th>[\s\S]*?<\/tr>/.exec(html);
    expect(broken).not.toBeNull();

    const items = allItems(html);
    const withServingSize = items.filter((item) => item.nutrition?.servingSize);
    expect(withServingSize.length).toBeGreaterThan(60);
    for (const item of withServingSize) {
      expect(item.nutrition?.servingSize).toMatch(/\S/);
    }
  });

  it('never turns a table heading into a value', () => {
    for (const fixture of Object.values(HALL_FIXTURES)) {
      for (const item of allItems(readFixture(fixture))) {
        const nutrition = item.nutrition;
        if (!nutrition) continue;
        const values = [
          nutrition.servingSize,
          ...NUTRIENT_FIELDS.map((field) => nutrition[field]),
        ];
        for (const value of values) {
          if (value === null) continue;
          expect(value.toLowerCase()).not.toContain('amount per serving');
          expect(value.toLowerCase()).not.toContain('daily value');
          expect(value.toLowerCase()).not.toContain('nutrition facts');
          expect(value.trim()).toBe(value);
          expect(value.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('keeps the units of the values and reads the calories as a number', () => {
    for (const fixture of Object.values(HALL_FIXTURES)) {
      for (const item of allItems(readFixture(fixture))) {
        const nutrition = item.nutrition;
        if (!nutrition) continue;
        for (const field of NUTRIENT_FIELDS) {
          const value = nutrition[field];
          if (value === null) continue;
          expect(value, `${item.name} ${field}`).toMatch(/^\d+(\.\d+)?(mg|g)$/);
        }
        expect(nutrition.calories, item.name).toBeTypeOf('number');
        expect(nutrition.calories ?? 0).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('reads the micronutrients as names with a percentage', () => {
    for (const fixture of Object.values(HALL_FIXTURES)) {
      for (const item of allItems(readFixture(fixture))) {
        const micronutrients = item.nutrition?.micronutrients;
        if (!micronutrients) continue;
        expect(Object.keys(micronutrients).length).toBeGreaterThan(0);
        for (const [name, value] of Object.entries(micronutrients)) {
          expect(name, item.name).toMatch(/\S/);
          // The site writes a percentage, but for a few dishes it writes the
          // percent sign without a number ("<td>%</td>" for the vitamin A of
          // the guacamole), and that is what the parser has to report.
          expect(value, `${item.name} ${name}`).toMatch(/^(\d+(\.\d+)?)?%$/);
        }
      }
    }
  });

  it('reads the panels in the order the site writes them', () => {
    for (const [hall, fixture] of Object.entries(HALL_FIXTURES)) {
      const html = readFixture(fixture);
      const items = allItems(html).filter((item) => item.nutrition !== null);
      const tables = panels(html);
      expect(items, hall).toHaveLength(tables.length);

      items.forEach((item, index) => {
        const tableRows = rows(tables[index] ?? '');
        const serving = tableRows.find((row) => row.className.includes('serving-size'));
        expect(serving?.text, `${hall} ${item.name}`).toContain(
          item.nutrition?.servingSize as string,
        );
        const calories = tableRows.find((row) => row.className.includes('portion-calories'));
        expect(calories?.text, `${hall} ${item.name}`).toContain(String(item.nutrition?.calories));
      });
    }
  });

  it('gives a dish the panel that follows it and not the one of its neighbour', () => {
    const html = readFixture('bursley.html');
    const items = allItems(html);
    const withPanel = items.filter((item) => item.nutrition !== null);

    // Two neighbouring dishes must not end up with the same panel.
    for (let index = 1; index < withPanel.length; index += 1) {
      const previous = withPanel[index - 1]?.nutrition;
      const current = withPanel[index]?.nutrition;
      const sameSource = tables_agree(html, index - 1, index);
      if (sameSource) continue;
      expect(current?.servingSize, `${withPanel[index]?.name}`).not.toBe(previous?.servingSize);
    }
  });

  it('leaves the dishes the site publishes without a panel empty', () => {
    const withoutPanel: string[] = [];
    for (const [hall, fixture] of Object.entries(HALL_FIXTURES)) {
      for (const item of allItems(readFixture(fixture))) {
        if (item.nutrition === null) withoutPanel.push(`${hall}: ${item.name}`);
      }
    }
    // The site publishes these dishes without a nutrition panel.
    expect(withoutPanel.sort()).toEqual(
      [
        'bursley: Sandwiches Made to Order',
        'bursley: Sandwiches Made to Order',
        'mosher-jordan: Sandwiches Made to Order',
        'mosher-jordan: Sandwiches Made to Order',
        'north-quad: UNIT CHOICE MEAL',
        'south-quad: No Service at this Time',
        'south-quad: No Service at this Time',
        'south-quad: Sandwiches Made to Order',
        'south-quad: Sandwiches Made to Order',
        'south-quad: UNIT CHOICE MEAL',
        'wolverine-village: Sandwiches Made to Order',
        'wolverine-village: Sandwiches Made to Order',
      ].sort(),
    );
  });
});

/** True when the two tables of the markup hold the same serving size. */
function tables_agree(html: string, first: number, second: number): boolean {
  const tables = panels(html);
  const servingOf = (index: number): string =>
    rows(tables[index] ?? '').find((row) => row.className.includes('serving-size'))?.text ?? '';
  return servingOf(first) === servingOf(second);
}
