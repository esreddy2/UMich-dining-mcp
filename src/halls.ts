import type { DiningHall, HallId } from './types.js';

export const BASE_URL = 'https://dining.umich.edu';
export const MENUS_LOCATIONS_PATH = '/menus-locations/';
export const REGULAR_HOURS_PATH = '/menus-locations/regularhours/';

/**
 * The ten dining halls. The path is the part under /menus-locations/ that
 * serves the hall's menu page.
 *
 * Names are the site's own names, corrected only where the site has a typo:
 * the Wolverine Village page title reads "Wolverine VIllage".
 */
export const HALLS: readonly DiningHall[] = [
  {
    id: 'bursley',
    name: 'Bursley',
    path: 'dining-halls/bursley',
    url: `${BASE_URL}${MENUS_LOCATIONS_PATH}dining-halls/bursley/`,
    residentsOnly: false,
    glutenFreePantry: true,
    address: null,
    phone: null,
    email: null,
    mapUrl: null,
    meals: ['Breakfast', 'Lunch', 'Dinner'],
  },
  {
    id: 'east-quad',
    name: 'East Quad',
    path: 'dining-halls/east-quad',
    url: `${BASE_URL}${MENUS_LOCATIONS_PATH}dining-halls/east-quad/`,
    residentsOnly: false,
    glutenFreePantry: true,
    address: null,
    phone: null,
    email: null,
    mapUrl: null,
    meals: ['Dinner'],
  },
  {
    id: 'markley',
    name: 'Markley',
    path: 'dining-halls/markley',
    url: `${BASE_URL}${MENUS_LOCATIONS_PATH}dining-halls/markley/`,
    residentsOnly: false,
    glutenFreePantry: false,
    address: null,
    phone: null,
    email: null,
    mapUrl: null,
    meals: ['Dinner'],
  },
  {
    id: 'mosher-jordan',
    name: 'Mosher-Jordan',
    path: 'dining-halls/mosher-jordan',
    url: `${BASE_URL}${MENUS_LOCATIONS_PATH}dining-halls/mosher-jordan/`,
    residentsOnly: false,
    glutenFreePantry: true,
    address: null,
    phone: null,
    email: null,
    mapUrl: null,
    meals: ['Breakfast', 'Lunch', 'Dinner'],
  },
  {
    id: 'north-quad',
    name: 'North Quad',
    path: 'dining-halls/north-quad',
    url: `${BASE_URL}${MENUS_LOCATIONS_PATH}dining-halls/north-quad/`,
    residentsOnly: false,
    glutenFreePantry: false,
    address: null,
    phone: null,
    email: null,
    mapUrl: null,
    meals: ['Dinner'],
  },
  {
    id: 'south-quad',
    name: 'South Quad',
    path: 'dining-halls/south-quad',
    url: `${BASE_URL}${MENUS_LOCATIONS_PATH}dining-halls/south-quad/`,
    residentsOnly: false,
    glutenFreePantry: true,
    address: null,
    phone: null,
    email: null,
    mapUrl: null,
    meals: ['Breakfast', 'Lunch', 'Dinner'],
  },
  {
    id: 'twigs-at-oxford',
    name: 'Twigs at Oxford',
    path: 'dining-halls/twigs-at-oxford',
    url: `${BASE_URL}${MENUS_LOCATIONS_PATH}dining-halls/twigs-at-oxford/`,
    residentsOnly: false,
    glutenFreePantry: false,
    address: null,
    phone: null,
    email: null,
    mapUrl: null,
    meals: ['Dinner'],
  },
  {
    id: 'wolverine-village',
    name: 'Wolverine Village',
    path: 'dining-halls/wolverine-village-dining-hall',
    url: `${BASE_URL}${MENUS_LOCATIONS_PATH}dining-halls/wolverine-village-dining-hall/`,
    residentsOnly: false,
    glutenFreePantry: false,
    address: null,
    phone: null,
    email: null,
    mapUrl: null,
    meals: ['Breakfast', 'Lunch', 'Dinner'],
  },
  {
    id: 'lawyers-club',
    name: 'Lawyers Club',
    path: 'dining-halls/select-access/lawyers-club',
    url: `${BASE_URL}${MENUS_LOCATIONS_PATH}dining-halls/select-access/lawyers-club/`,
    residentsOnly: true,
    glutenFreePantry: false,
    address: null,
    phone: null,
    email: null,
    mapUrl: null,
    meals: ['Lunch', 'Dinner'],
  },
  {
    id: 'martha-cook',
    name: 'Martha Cook',
    path: 'dining-halls/select-access/martha-cook',
    url: `${BASE_URL}${MENUS_LOCATIONS_PATH}dining-halls/select-access/martha-cook/`,
    residentsOnly: true,
    glutenFreePantry: false,
    address: null,
    phone: null,
    email: null,
    mapUrl: null,
    meals: ['Dinner'],
  },
];

const BY_ID = new Map<HallId, DiningHall>(HALLS.map((hall) => [hall.id, hall]));

const HALL_ALIASES: Record<string, HallId> = {
  bursley: 'bursley',
  east: 'east-quad',
  eastquad: 'east-quad',
  markley: 'markley',
  mosher: 'mosher-jordan',
  mosherjordan: 'mosher-jordan',
  mojo: 'mosher-jordan',
  north: 'north-quad',
  northquad: 'north-quad',
  south: 'south-quad',
  southquad: 'south-quad',
  twigs: 'twigs-at-oxford',
  oxford: 'twigs-at-oxford',
  twigsatoxford: 'twigs-at-oxford',
  wolverine: 'wolverine-village',
  village: 'wolverine-village',
  willage: 'wolverine-village',
  wolverinevillage: 'wolverine-village',
  wovlerine: 'wolverine-village',
  lawyers: 'lawyers-club',
  lawyer: 'lawyers-club',
  lawyersclub: 'lawyers-club',
  martha: 'martha-cook',
  cook: 'martha-cook',
  marthacook: 'martha-cook',
};

function normalizeHallKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function resolveHallId(value: string): HallId {
  const key = normalizeHallKey(value);
  const aliased = HALL_ALIASES[key];
  if (aliased) return aliased;
  const byId = HALLS.find((hall) => normalizeHallKey(hall.id) === key);
  if (byId) return byId.id;
  const byName = HALLS.find((hall) => normalizeHallKey(hall.name) === key);
  if (byName) return byName.id;
  throw new Error(`Unknown dining hall: ${value}`);
}

export function getHallDefinition(id: HallId): DiningHall {
  const hall = BY_ID.get(id);
  if (!hall) throw new Error(`Unknown dining hall: ${id}`);
  return hall;
}

export function isHallId(value: string): value is HallId {
  return BY_ID.has(value as HallId);
}

/**
 * Map a location URL from the site back to a hall id. The regular hours page
 * links to every location, so the path is a reliable key even where the site's
 * display name has a typo ("Wolverine VIllage").
 */
export function hallIdFromUrl(url: string): HallId | null {
  const match = /\/menus-locations\/(.+?)\/?(?:[?#].*)?$/.exec(url.trim());
  if (!match || match[1] === undefined) return null;
  const path = match[1].replace(/\/+$/, '');
  for (const hall of HALLS) {
    if (hall.path === path) return hall.id;
  }
  return null;
}
