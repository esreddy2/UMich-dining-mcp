/**
 * Regenerate the test fixtures.
 *
 * The fixtures are the live pages of the ten dining halls for one date plus
 * the regular hours page. They are committed so the test suite never needs the
 * network; run this script when the site's HTML changes.
 *
 *   npm run capture                 # today
 *   npm run capture -- 2026-10-22   # a specific date
 *
 * The date is the day of the campus, not the day of the host: a capture that
 * runs before dawn in Ann Arbor must record the day the site is serving, not
 * the day that is already over in UTC. The date is written to
 * `tests/fixtures/capture-date.txt`, which the oracle and the tests read, so
 * the fixtures and the expected data always agree on which day they describe.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchText } from '../src/http.js';
import { HALLS, REGULAR_HOURS_PATH } from '../src/halls.js';
import { config } from '../src/config.js';
import { dayIn } from '../src/clock.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, '..', 'tests', 'fixtures');

/** The fixture file name of a hall page. */
function fixtureName(path: string): string {
  return `${path.split('/').pop()}.html`;
}

async function capture(url: string, target: string): Promise<void> {
  const html = await fetchText(url);
  await writeFile(target, html, 'utf-8');
  process.stderr.write(`${target.replace(`${FIXTURE_DIR}/`, '')}: ${html.length} bytes\n`);
}

async function main(): Promise<void> {
  // The day of the campus, which is not the day of the host: the server may
  // run in Chicago or in UTC, and the site publishes the campus day.
  const date = process.argv[2] ?? dayIn(config.timezone);
  await mkdir(FIXTURE_DIR, { recursive: true });

  for (const hall of HALLS) {
    const url = `${config.baseUrl}/menus-locations/${hall.path}/?menuDate=${date}`;
    await capture(url, join(FIXTURE_DIR, fixtureName(hall.path)));
  }

  await capture(`${config.baseUrl}${REGULAR_HOURS_PATH}`, join(FIXTURE_DIR, 'regularhours.html'));
  await writeFile(join(FIXTURE_DIR, 'capture-date.txt'), `${date}\n`, 'utf-8');
  process.stderr.write(`fixtures captured for ${date}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`capture failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
