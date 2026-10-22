export const HALL_IDS = [
  'bursley',
  'east-quad',
  'markley',
  'mosher-jordan',
  'north-quad',
  'south-quad',
  'twigs-at-oxford',
  'wolverine-village',
  'lawyers-club',
  'martha-cook',
] as const;

export type HallId = (typeof HALL_IDS)[number];

/**
 * The meals the site publishes.
 *
 * Brunch is the fourth one: the site publishes it on the weekend days, where
 * it is often the only meal of the afternoon.
 */
export type MealName = 'Breakfast' | 'Brunch' | 'Lunch' | 'Dinner';

export const MEAL_NAMES: readonly MealName[] = ['Breakfast', 'Brunch', 'Lunch', 'Dinner'];

export type CarbonLevel = 1 | 2 | 3;

export interface DiningHall {
  id: HallId;
  name: string;
  /** Path under /menus-locations/ */
  path: string;
  /** Canonical menu URL */
  url: string;
  residentsOnly: boolean;
  glutenFreePantry: boolean;
  address: string | null;
  phone: string | null;
  email: string | null;
  mapUrl: string | null;
  /** Meals published for the requested day, as published by the site. */
  meals: string[];
}

export interface Nutrition {
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

export interface MenuItem {
  name: string;
  /** Canonical trait slugs, closed under the vegan => vegetarian implication. */
  traits: string[];
  traitLabels: Record<string, string>;
  /** Canonical allergen slugs read from the item's own classes only. */
  allergens: string[];
  /** Ordinal nutrient-density tier 1..5, or null when the item has none. */
  mhealthyTier: number | null;
  /** Ordinal carbon footprint tier, or null when the item has none. */
  carbonFootprint: CarbonLevel | null;
  nutrition: Nutrition | null;
}

export interface Station {
  name: string;
  items: MenuItem[];
}

/** A meal the site published that this server has no slot for. */
export interface OtherMeal {
  /** The site's own label, e.g. "Supper". */
  label: string;
  stations: Station[];
}

export interface Menu {
  hall: HallId;
  date: string;
  meals: Record<MealName, Station[]>;
  /** The site's own meal labels, verbatim (they may differ from MealName). */
  mealLabels: Partial<Record<MealName, string>>;
  /** Meals the site published that this server has no slot for. */
  otherMeals: OtherMeal[];
  /** Meal labels the site used that this server does not know. */
  unknownMealLabels: string[];
  /** True when the site published its "no menu" marker for this day. */
  noMenu: boolean;
  /** Date the page actually rendered, when the page exposes it. */
  renderedDate: string | null;
  /** True when the payload came from a stale cache entry. */
  stale: boolean;
}

export interface ServicePeriod {
  /** The site's own label for the period, e.g. "Breakfast", "Lunch", "Brunch". */
  label: string;
  /** Normalised time range, e.g. "9:00 am - 10:30 am". */
  times: string;
  /** True when the site states the location is closed for that period. */
  closed: boolean;
}

export interface WeeklyHours {
  /** Individual weekday names, expanded from ranges like "Monday - Thursday". */
  days: string[];
  periods: ServicePeriod[];
  closed: boolean;
}

export interface RegularHours {
  hall: HallId;
  name: string;
  url: string | null;
  /** Weekly schedule keyed by weekday name. */
  weekly: WeeklyHours[];
}

export interface HallHours {
  hall: HallId;
  name: string;
  date: string;
  /** Service periods for the requested day, from the hall's own page. */
  today: ServicePeriod[];
  /** The regular weekly schedule from /menus-locations/regularhours/. */
  regular: RegularHours | null;
  stale: boolean;
}

export interface LocationSummary extends DiningHall {
  date: string;
  today: ServicePeriod[];
  openNow: boolean;
  stale: boolean;
}
