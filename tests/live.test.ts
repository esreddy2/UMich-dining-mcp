import { describe, expect, it } from 'vitest';
import { countItems, countStations, getMenu, todayIn } from '../src/service.js';

/**
 * Network tests. They are skipped unless LIVE=1 is set:
 *
 *   npm run test:live
 */
const live = process.env['LIVE'] === '1';

describe('live site', () => {
  it.skipIf(!live)('serves the Bursley menu with the expected shape', async () => {
    const page = await getMenu('bursley', todayIn());
    const meals = Object.entries(page.menu.meals).filter(([, stations]) => stations.length > 0);
    expect(meals.length).toBeGreaterThan(0);
    expect(countStations(page.menu.meals)).toBeGreaterThan(0);
    expect(countItems(page.menu.meals)).toBeGreaterThan(0);
  });

  it.skipIf(!live)('never lets a 403 escape unhandled', async () => {
    const page = await getMenu('east-quad', todayIn());
    expect(countItems(page.menu.meals)).toBeGreaterThan(0);
  });
});
