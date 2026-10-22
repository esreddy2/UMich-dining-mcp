import { config } from './config.js';
import { diskCache } from './disk-cache.js';
import { HALLS } from './halls.js';
import { loadHallPage, todayIn } from './service.js';
import type { HallId } from './types.js';

/**
 * The background warmer.
 *
 * It fills the persistent cache so a range query is served from disk: today's
 * ten halls every half hour, and the future days once a day. It runs only in
 * the long-lived HTTP mode; a one-shot stdio client starts no background job.
 */

const TODAY_INTERVAL_MS = 30 * 60 * 1000;
const FUTURE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * The gap between the future days of a cold start.
 *
 * The whole published window is 14 days. Spreading them over the first hours
 * keeps a restart from putting 150 requests on the site at once.
 */
const FUTURE_STAGGER_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The days the warmer keeps warm: today and the published future window. */
export function warmerDays(today: string): string[] {
  const base = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(base)) return [today];
  const days: string[] = [];
  const minOffset = -3;
  for (let offset = minOffset; offset <= config.dateWindow.maxDays; offset += 1) {
    days.push(new Date(base + offset * DAY_MS).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Warm the given halls and dates.
 *
 * Every hall and day is isolated: one failure never stops the others. The
 * pages are read in the background, so they never stand in front of a live
 * request.
 */
export async function warm(
  halls: readonly HallId[] = HALLS.map((hall) => hall.id),
  dates: readonly string[] = [todayIn()],
  today: string = todayIn(),
): Promise<{ warmed: number; failed: number }> {
  let warmed = 0;
  let failed = 0;

  for (const hall of halls) {
    for (const date of dates) {
      try {
        // A page that is still live in memory or on disk needs no request:
        // the warmer refetches only when the TTL has run out.
        await loadHallPage(hall, date, today, { force: false, background: true });
        warmed += 1;
      } catch {
        // The warmer never fails the server: one page is not worth a report.
        failed += 1;
      }
    }
  }

  return { warmed, failed };
}

/**
 * Prune the persistent cache.
 *
 * An entry whose day left the published window is dropped, as is one older
 * than the maximum age; over the size cap the oldest entries go first.
 */
export async function pruneCache(today: string = todayIn()): Promise<number> {
  if (!diskCache.enabled) return 0;
  const base = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(base)) return 0;
  const earliest = new Date(base + config.dateWindow.minDays * DAY_MS).toISOString().slice(0, 10);
  const latest = new Date(base + config.dateWindow.maxDays * DAY_MS).toISOString().slice(0, 10);
  return diskCache.prune({ earliestDate: earliest, latestDate: latest });
}

export class Warmer {
  private timer: NodeJS.Timeout | null = null;
  private futureTimer: NodeJS.Timeout | null = null;
  private running = false;
  /** True while a pass is in flight, so two passes never overlap. */
  private busy = false;

  /** Start the warmer. It does nothing when the persistent cache is off. */
  start(): void {
    if (!diskCache.enabled || this.timer) return;

    const tickToday = async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        const today = todayIn();
        await warm(HALLS.map((hall) => hall.id), [today], today);
      } finally {
        this.busy = false;
      }
    };

    const tickFuture = async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        const today = todayIn();
        const days = warmerDays(today).slice(1);
        if (days.length === 0) return;
        await warm(HALLS.map((hall) => hall.id), days, today);
      } finally {
        this.busy = false;
      }
    };

    // The first pass fills the cache for today. The future days are spread
    // over the hours that follow: a restart must not put 150 requests on the
    // site at once, which is what every deploy used to do.
    void tickToday();
    this.futureTimer = setInterval(() => {
      void tickFuture();
    }, FUTURE_INTERVAL_MS);
    this.futureTimer.unref?.();

    // The future days, one day at a time, spaced over the first hours.
    const days = warmerDays(todayIn()).slice(1);
    days.forEach((day, index) => {
      const timer = setTimeout(() => {
        void warm(HALLS.map((hall) => hall.id), [day], todayIn());
      }, (index + 1) * FUTURE_STAGGER_MS);
      timer.unref?.();
    });

    this.timer = setInterval(() => {
      void tickToday();
    }, TODAY_INTERVAL_MS);
    this.timer.unref?.();

    this.running = true;
  }

  /** Stop the warmer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.futureTimer) {
      clearInterval(this.futureTimer);
      this.futureTimer = null;
    }
    this.running = false;
  }

  get active(): boolean {
    return this.running;
  }
}

export const warmer = new Warmer();

export { TODAY_INTERVAL_MS, FUTURE_INTERVAL_MS };
