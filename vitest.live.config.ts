import { defineConfig } from 'vitest/config';

/**
 * The live tests talk to the real site, so they run with the production
 * request profile (the politeness delay between requests stays on).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/live.test.ts'],
    testTimeout: 60_000,
  },
});
