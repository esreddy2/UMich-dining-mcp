import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cache } from '../src/cache.js';
import { filterDishes, todayIn } from '../src/service.js';
import { mockFixtureFetch } from './helpers.js';

describe('dish filters', () => {
  beforeEach(() => {
    cache.clear();
    vi.unstubAllGlobals();
  });

  it('excludes the dishes that carry a listed allergen', async () => {
    mockFixtureFetch();
    const result = await filterDishes({ exclude_allergens: ['milk'] });
    expect(result.matches.length).toBeGreaterThan(0);
    for (const match of result.matches) {
      expect(match.allergens).not.toContain('milk');
    }
    expect(result.matches.some((match) => match.allergens.includes('milk'))).toBe(false);
  });

  it('keeps the vegan dishes when vegetarian is required', async () => {
    mockFixtureFetch();
    const result = await filterDishes({ require_traits: ['vegetarian'] });
    const vegan = result.matches.filter((match) => match.traits.includes('vegan'));
    expect(vegan.length).toBeGreaterThan(0);
    for (const match of result.matches) {
      expect(match.traits).toContain('vegetarian');
    }
  });

  it('requires every listed trait', async () => {
    mockFixtureFetch();
    const both = await filterDishes({ require_traits: ['vegan', 'halal'] });
    for (const match of both.matches) {
      expect(match.traits).toContain('vegan');
      expect(match.traits).toContain('halal');
    }

    const veganOnly = await filterDishes({ require_traits: ['vegan'] });
    expect(both.totalMatches).toBeLessThanOrEqual(veganOnly.totalMatches);
  });

  it('reads the nutrient-density tier as a minimum', async () => {
    mockFixtureFetch();
    const result = await filterDishes({ min_mhealthy: 3 });
    expect(result.matches.length).toBeGreaterThan(0);
    for (const match of result.matches) {
      expect(match.mhealthyTier).not.toBeNull();
      expect(match.mhealthyTier as number).toBeGreaterThanOrEqual(3);
    }
  });

  it('reads the carbon footprint as a maximum', async () => {
    mockFixtureFetch();
    const result = await filterDishes({ max_carbon: 'medium' });
    expect(result.matches.length).toBeGreaterThan(0);
    for (const match of result.matches) {
      expect(['low', 'medium']).toContain(match.carbonFootprint);
    }
  });

  it('applies the calorie and sodium caps', async () => {
    mockFixtureFetch();
    const result = await filterDishes({ max_calories: 300, max_sodium_mg: 500 });
    for (const match of result.matches) {
      expect(match.calories).not.toBeNull();
      expect(match.calories as number).toBeLessThanOrEqual(300);
      expect(match.sodiumMg).not.toBeNull();
      expect(match.sodiumMg as number).toBeLessThanOrEqual(500);
    }
  });

  it('reports the halls it could not read', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('markley')) return new Response('boom', { status: 500 });
      return new Response('<html><body>nope</body></html>', { status: 200 });
    });

    const result = await filterDishes({ hall: 'bursley' });
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0]?.hall).toBe('bursley');
  });

  it('carries the allergen warning', async () => {
    mockFixtureFetch();
    const result = await filterDishes({ exclude_allergens: ['milk'] });
    expect(result.warning).toMatch(/allergen/i);
    expect(result.warning).toMatch(/coeliac/i);
  });

  it('uses the requested day', async () => {
    mockFixtureFetch();
    const today = todayIn();
    const result = await filterDishes({});
    expect(result.date).toBe(today);
  });
});
