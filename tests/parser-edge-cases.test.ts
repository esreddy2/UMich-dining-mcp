import { describe, expect, it } from 'vitest';
import { parseMenuPage } from '../src/parser/menu.js';
import { HALL_FIXTURES, readFixture } from './helpers.js';

/**
 * The behaviour of the parser on small, hand written pages.
 *
 * The pages here are written from the shape of the site's markup, not from
 * the parser: every case is a situation the site can produce, and the
 * expectation is what the site means, not what the code happens to do.
 */

/** A nutrition panel as the site writes it, including the broken tags. */
const PANEL = `<div class="nutrition">
    <div class="nutrition-wrapper">
      <table class="nutrition-facts">
        <tr class="nutrition-facts-header"><th colspan="2"><h6 class="large-nutrition-facts">Nutrition Facts</h6></th></tr>
        <tr class="serving-size"><td colspan="2"><strong>Serving Size</strong> 1 Cup (253g)</th></tr>
        <tr><td colspan="2" class="small-nutrition-facts"><strong>Amount Per Serving</strong></td></tr>
        <tr class="portion-calories thick-border"><td colspan="2"><strong>Calories</strong> 183</td></tr>
        <tr><td></td><td class="small-nutrition-facts" title="Percent Daily Values are based on a 2,000 calorie diet.">% Daily Value*</td></tr>
        <tr class="has-subitems"><td><strong>Total Fat</strong> 3g</td><td><strong>5%</strong></td></tr>
        <tr class="indent"><td>Saturated Fat 1g</td><td><strong>2%</strong></td></tr>
        <tr class="indent"><td>Trans Fat 0g</td><td></td></tr>
        <tr><td><strong>Cholesterol</strong> 0mg</td><td><strong>0%</strong></td></tr>
        <tr><td><strong>Sodium</strong> 3mg</td><td><strong>0%</strong></td></tr>
        <tr class="has-subitems"><td><strong>Total Carbohydrate</strong> 33g</td><td><strong>12%</strong></td></tr>
        <tr class="indent"><td>Dietary Fiber 5g</td><td><strong>20%</strong></td></tr>
        <tr class="indent"><td>Sugars 1g</td><td><strong>1%</strong></td></tr>
        <tr><td><strong>Protein</strong> 6g</td><td><strong>8%</strong></td></tr>
        <tr class="micronutrient first"><td>Vitamin A</td><td>0%</td></tr>
        <tr class="micronutrient"><td>Vitamin C</td><td>0%</td></tr>
        <tr class="micronutrient"><td>Calcium</td><td>3%</td></tr>
        <tr class="micronutrient"><td>Iron</td><td>11%</td></tr>
      </table>
    </div>
  </div>`;

interface Dish {
  name?: string;
  classes?: string;
  traits?: { slug: string; label: string }[];
  panel?: string;
}

interface Station {
  heading?: string;
  dishes: Dish[];
}

function station(heading: string | undefined, dishes: Dish[]): string {
  const items = dishes
    .map((dish) => {
      const traits = dish.traits
        ? `<ul class="traits">${dish.traits
            .map((trait) => `<li class="${trait.slug}" title="${trait.label}">${trait.label}</li>`)
            .join('')}</ul>`
        : '';
      return `<li class="${dish.classes ?? ''}">
              <a href="#"><h5><span class="item-name">${dish.name ?? ''}</span></h5>${traits}</a>
            </li>
            ${dish.panel ?? ''}`;
    })
    .join('\n');
  return `<li>${heading === undefined ? '' : `<h4>${heading}</h4>`}
          <ul class="items">${items}</ul>
        </li>`;
}

function page(meals: { label: string; stations: Station[] }[], extra = ''): string {
  const body = meals
    .map(
      (meal) =>
        `<h3><a href="#"><i class="fa fa-plus"></i> ${meal.label}</a></h3>
        <div class="courses">
          <ul class="courses_wrapper">${meal.stations
            .map((entry) => station(entry.heading, entry.dishes))
            .join('')}</ul>
        </div>`,
    )
    .join('');
  return `<!doctype html><html><body><div id="mdining-items">${body}</div>${extra}</body></html>`;
}

describe('the parser on small pages', () => {
  it('counts a station as a station and not as a dish', () => {
    const menu = parseMenuPage(
      page([{ label: 'Breakfast', stations: [{ heading: 'Hot Cereal', dishes: [{ name: 'Oatmeal' }] }] }]),
    );
    expect(menu.stationCount).toBe(1);
    expect(menu.itemCount).toBe(1);
    expect(menu.meals.Breakfast[0]?.name).toBe('Hot Cereal');
    expect(menu.meals.Breakfast[0]?.items[0]?.name).toBe('Oatmeal');
  });

  it('reads the traits of the classes and of the published list', () => {
    const menu = parseMenuPage(
      page([
        {
          label: 'Breakfast',
          stations: [
            {
              heading: 'Hot Cereal',
              dishes: [
                {
                  name: 'Oatmeal',
                  classes: 'trait-vegan trait-mhealthy5',
                  traits: [{ slug: 'vegan', label: 'Vegan' }],
                },
              ],
            },
          ],
        },
      ]),
    );
    const item = menu.meals.Breakfast[0]?.items[0];
    expect(item?.traits).toEqual(['mhealthy5', 'vegan', 'vegetarian']);
    expect(item?.traitLabels['vegan']).toBe('Vegan');
    expect(item?.mhealthyTier).toBe(5);
    expect(item?.carbonFootprint).toBeNull();
  });

  it('keeps the traits of a dish that publishes no list', () => {
    const menu = parseMenuPage(
      page([
        {
          label: 'Lunch',
          stations: [{ heading: 'Deli', dishes: [{ name: 'Turkey Sandwich', classes: 'allergen-milk' }] }],
        },
      ]),
    );
    const item = menu.meals.Lunch[0]?.items[0];
    expect(item?.traits).toEqual([]);
    expect(item?.allergens).toEqual(['milk']);
  });

  it('gives a dish the panel that follows it', () => {
    const menu = parseMenuPage(
      page([
        {
          label: 'Breakfast',
          stations: [{ heading: 'Hot Cereal', dishes: [{ name: 'Oatmeal', panel: PANEL }] }],
        },
      ]),
    );
    const nutrition = menu.meals.Breakfast[0]?.items[0]?.nutrition;
    expect(nutrition?.servingSize).toBe('1 Cup (253g)');
    expect(nutrition?.calories).toBe(183);
    expect(nutrition?.totalFat).toBe('3g');
    expect(nutrition?.saturatedFat).toBe('1g');
    expect(nutrition?.transFat).toBe('0g');
    expect(nutrition?.cholesterol).toBe('0mg');
    expect(nutrition?.sodium).toBe('3mg');
    expect(nutrition?.totalCarbohydrate).toBe('33g');
    expect(nutrition?.dietaryFiber).toBe('5g');
    expect(nutrition?.sugars).toBe('1g');
    expect(nutrition?.protein).toBe('6g');
    expect(nutrition?.micronutrients).toEqual({
      'Vitamin A': '0%',
      'Vitamin C': '0%',
      Calcium: '3%',
      Iron: '11%',
    });
  });

  it('gives a dish the panel that is nested in its own element', () => {
    const nested = `<li class="trait-vegan">
        <a href="#"><h5><span class="item-name">Oatmeal</span></h5>
          <ul class="traits"><li class="vegan" title="Vegan">Vegan</li></ul>
        </a>
        ${PANEL}
      </li>`;
    const html = `<!doctype html><html><body><div id="mdining-items">
        <h3><a href="#">Breakfast</a></h3>
        <div class="courses"><ul class="courses_wrapper">
          <li><h4>Hot Cereal</h4><ul class="items">${nested}</ul></li>
        </ul></div>
      </div></body></html>`;
    const menu = parseMenuPage(html);
    expect(menu.meals.Breakfast[0]?.items[0]?.nutrition?.calories).toBe(183);
  });

  it('leaves a dish without a panel empty', () => {
    const menu = parseMenuPage(
      page([{ label: 'Dinner', stations: [{ heading: 'Deli', dishes: [{ name: 'Made to Order' }] }] }]),
    );
    expect(menu.meals.Dinner[0]?.items[0]?.nutrition).toBeNull();
  });

  it('leaves a dish with a nutrition element but no table empty', () => {
    const menu = parseMenuPage(
      page([
        {
          label: 'Dinner',
          stations: [
            {
              heading: 'Deli',
              dishes: [{ name: 'Made to Order', panel: '<div class="nutrition"></div>' }],
            },
          ],
        },
      ]),
    );
    expect(menu.meals.Dinner[0]?.items[0]?.nutrition).toBeNull();
  });

  it('skips a dish without a name', () => {
    const menu = parseMenuPage(
      page([
        {
          label: 'Dinner',
          stations: [
            { heading: 'Deli', dishes: [{ name: '' }, { name: 'Made to Order' }] },
          ],
        },
      ]),
    );
    expect(menu.itemCount).toBe(1);
    expect(menu.meals.Dinner[0]?.items[0]?.name).toBe('Made to Order');
  });

  it('skips a station without a heading', () => {
    const menu = parseMenuPage(
      page([
        {
          label: 'Dinner',
          stations: [
            { heading: undefined, dishes: [{ name: 'Orphan Dish' }] },
            { heading: 'Deli', dishes: [{ name: 'Made to Order' }] },
          ],
        },
      ]),
    );
    expect(menu.stationCount).toBe(1);
    expect(menu.itemCount).toBe(1);
    expect(menu.meals.Dinner[0]?.name).toBe('Deli');
  });

  it('reports a meal the server does not know instead of guessing it', () => {
    const menu = parseMenuPage(
      page([
        { label: 'Supper', stations: [{ heading: 'Deli', dishes: [{ name: 'Made to Order' }] }] },
        { label: 'Dinner', stations: [{ heading: 'Deli', dishes: [{ name: 'Made to Order' }] }] },
      ]),
    );
    expect(menu.unknownMealLabels).toEqual(['Supper']);
    // The meals the server knows are still read.
    expect(menu.meals.Dinner[0]?.items[0]?.name).toBe('Made to Order');
  });

  it('keeps the label of the site for every meal it knows', () => {
    const menu = parseMenuPage(
      page([
        { label: 'Breakfast', stations: [{ heading: 'Toast', dishes: [{ name: 'Egg' }] }] },
        { label: 'Lunch', stations: [{ heading: 'Deli', dishes: [{ name: 'Soup' }] }] },
        { label: 'Dinner', stations: [{ heading: 'Deli', dishes: [{ name: 'Stew' }] }] },
      ]),
    );
    expect(menu.mealLabels).toEqual({ Breakfast: 'Breakfast', Lunch: 'Lunch', Dinner: 'Dinner' });
    expect(menu.unknownMealLabels).toEqual([]);
  });

  it('does not read the traits of the page into the dish', () => {
    const extra = `<ul class="allergens"><li class="trait-vegan">Vegan</li></ul>`;
    const menu = parseMenuPage(
      page([{ label: 'Dinner', stations: [{ heading: 'Deli', dishes: [{ name: 'Stew' }] }] }], extra),
    );
    expect(menu.meals.Dinner[0]?.items[0]?.traits).toEqual([]);
  });

  it('rejects a page that is not a menu', () => {
    expect(() => parseMenuPage('<html><body><p>nothing here</p></body></html>')).toThrow(
      /no #mdining-items container/,
    );
  });

  it('rejects a menu without stations', () => {
    expect(() =>
      parseMenuPage(
        '<html><body><div id="mdining-items"><h3><a href="#">Breakfast</a></h3></div></body></html>',
      ),
    ).toThrow(/no stations/);
  });
});

describe('the parser on the pages of the site', () => {
  it('reads the meal block of every hall without an error', () => {
    for (const fixture of Object.values(HALL_FIXTURES)) {
      const menu = parseMenuPage(readFixture(fixture));
      expect(menu.stationCount, fixture).toBeGreaterThan(0);
      expect(menu.itemCount, fixture).toBeGreaterThan(0);
    }
  });

  it('reads the dishes of the menu block and of no other block', () => {
    // The page holds a block with the hours of the day, a block with the
    // diets and a block with the nutrition tool; none of them is a station.
    for (const fixture of Object.values(HALL_FIXTURES)) {
      const html = readFixture(fixture);
      const menu = parseMenuPage(html);
      const stations = Object.values(menu.meals).flat().map((station) => station.name);
      expect(stations, fixture).not.toContain("Today's Hours");
      expect(stations, fixture).not.toContain('Special Diets');
      expect(stations, fixture).not.toContain('MyNutrition');

      const names = Object.values(menu.meals)
        .flat()
        .flatMap((station) => station.items.map((item) => item.name));
      expect(names, fixture).toHaveLength(
        (html.match(/<span class="item-name">/g) ?? []).length,
      );
    }
  });
});
