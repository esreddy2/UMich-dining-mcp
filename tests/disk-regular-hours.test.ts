import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiskCache } from '../src/disk-cache.js';
import { parseRegularHours } from '../src/parser/hours.js';
import { readFixture } from './helpers.js';

/**
 * The regular hours through the disk cache.
 *
 * The value used to be a `Map`, which serialises to `{}`: the second process
 * that read the entry got an empty object and every `get_hours` call failed
 * with "regular.get is not a function". These are the two halves of that
 * reproduction.
 */
describe('the regular hours through the disk', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'umich-dining-hours-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('comes back usable in a second process', async () => {
    const regular = parseRegularHours(readFixture('regularhours.html'));

    // The first process writes it.
    const first = new DiskCache(dir);
    await first.set('regular-hours', regular, 60_000);

    // The second process reads it.
    const second = new DiskCache(dir);
    const entry = await second.get('regular-hours');
    expect(entry).not.toBeNull();

    const value = entry!.value as Record<string, { name: string; weekly: unknown[] }>;
    const hours = new Map(Object.entries(value));
    expect(hours.size).toBe(10);
    expect(hours.get('bursley')?.name).toBe('Bursley');
    expect(hours.get('bursley')?.weekly.length).toBeGreaterThan(0);
  });

  it('leaves no poisoned entry behind', async () => {
    const cache = new DiskCache(dir);
    await cache.set('regular-hours', parseRegularHours(readFixture('regularhours.html')), 60_000);

    const names = await readdir(dir);
    expect(names.filter((name) => name.endsWith('.json'))).toHaveLength(1);
  });
});
