import type { Cheerio, CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import type { Nutrition } from '../types.js';
import { normalizeText } from './text.js';

/** The nine nutrients of the FDA panel the site publishes, in panel order. */
const MAJOR_NUTRIENTS = [
  'Total Carbohydrate',
  'Total Fat',
  'Saturated Fat',
  'Trans Fat',
  'Dietary Fiber',
  'Cholesterol',
  'Sugars',
  'Protein',
  'Sodium',
] as const;

type MajorField =
  | 'totalFat'
  | 'saturatedFat'
  | 'transFat'
  | 'cholesterol'
  | 'sodium'
  | 'totalCarbohydrate'
  | 'dietaryFiber'
  | 'sugars'
  | 'protein';

const FIELD_BY_NAME: Record<string, MajorField> = {
  'Total Fat': 'totalFat',
  'Saturated Fat': 'saturatedFat',
  'Trans Fat': 'transFat',
  Cholesterol: 'cholesterol',
  Sodium: 'sodium',
  'Total Carbohydrate': 'totalCarbohydrate',
  'Dietary Fiber': 'dietaryFiber',
  Sugars: 'sugars',
  Protein: 'protein',
};

/**
 * The site wraps the nutrient name in a `<strong>` in most rows, but the
 * indented sub-nutrients ("Saturated Fat", "Trans Fat", "Dietary Fiber",
 * "Sugars") are plain text. The name is therefore taken from the `<strong>`
 * when there is one and matched against the panel vocabulary otherwise.
 */
function splitNameAndValue(cellText: string, strongText: string | null): { name: string; value: string } {
  if (strongText) {
    const at = cellText.toLowerCase().indexOf(strongText.toLowerCase());
    const value = at >= 0 ? cellText.slice(at + strongText.length).trim() : cellText.replace(strongText, '').trim();
    return { name: strongText, value };
  }
  for (const candidate of MAJOR_NUTRIENTS) {
    if (cellText.toLowerCase().startsWith(candidate.toLowerCase())) {
      return { name: candidate, value: cellText.slice(candidate.length).trim() };
    }
  }
  return { name: cellText, value: '' };
}

/**
 * Parse the `table.nutrition-facts` of a nutrition panel.
 *
 * Values keep their units ("3g", "0mg") because they are the site's own text;
 * only the calorie count is a number.
 */
export function parseNutrition($: CheerioAPI, panel: Cheerio<Element>): Nutrition | null {
  const table = panel.find('table.nutrition-facts').first();
  if (table.length === 0) return null;

  const nutrition: Nutrition = {
    servingSize: null,
    calories: null,
    totalFat: null,
    saturatedFat: null,
    transFat: null,
    cholesterol: null,
    sodium: null,
    totalCarbohydrate: null,
    dietaryFiber: null,
    sugars: null,
    protein: null,
    micronutrients: {},
  };

  table.find('tr').each((_, row) => {
    const rowEl = $(row);
    const className = rowEl.attr('class') ?? '';
    if (className.includes('nutrition-facts-header')) return;

    const cells = rowEl.children('td');
    if (cells.length === 0) return;
    const first = cells.eq(0);
    const cellText = normalizeText(first.text());
    if (!cellText) return;
    if (cellText.toLowerCase() === 'amount per serving') return;
    if (cells.length > 1 && normalizeText(cells.eq(1).text()).startsWith('% Daily Value')) return;

    const strong = first.find('strong').first();
    const strongText = strong.length > 0 ? normalizeText(strong.text()) : null;

    if (className.includes('micronutrient')) {
      const name = strongText ?? cellText;
      const value = cells.length > 1 ? normalizeText(cells.eq(1).text()) : '';
      if (name && value) nutrition.micronutrients[name] = value;
      return;
    }

    const { name, value } = splitNameAndValue(cellText, strongText);

    if (className.includes('serving-size') || name.toLowerCase() === 'serving size') {
      nutrition.servingSize = value || null;
      return;
    }

    if (className.includes('portion-calories') || name.toLowerCase() === 'calories') {
      const parsed = Number.parseInt(value.replace(/[^0-9]/g, ''), 10);
      nutrition.calories = Number.isFinite(parsed) ? parsed : null;
      return;
    }

    const field = FIELD_BY_NAME[name];
    if (field) nutrition[field] = value || null;
  });

  const hasAny = Object.values(nutrition).some((value) =>
    typeof value === 'object' ? Object.keys(value).length > 0 : value !== null,
  );
  return hasAny ? nutrition : null;
}
