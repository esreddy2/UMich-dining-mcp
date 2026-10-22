import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/fixtures/**', 'tests/live.test.ts'],
    testTimeout: 30_000,
    // The tests answer the network with the committed fixtures, so the
    // politeness delay of the HTTP layer is switched off here. The persistent
    // cache is off too: the tests must never read or write the real cache.
    env: {
      UMICH_DINING_MIN_GAP_MS: '0',
      UMICH_DINING_MAX_CONCURRENCY: '8',
      UMICH_DINING_RETRY_BASE_MS: '1',
      UMICH_DINING_CACHE_DIR: 'off',
    },
  },
});
