import { useEffect, useState } from "react";

const SECOND_MS = 1000;
export const FINE_STEP_SECONDS = 5;
const FINE_STEP_MS = FINE_STEP_SECONDS * SECOND_MS;
const COARSE_AFTER_SECONDS = 60;
const COARSE_STEP_MS = 10 * SECOND_MS;

export interface SecondsSinceScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

const systemScheduler: SecondsSinceScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  // The seam types its handle as `unknown` so tests can pass a plain counter;
  // only this implementation knows the handle is really a timer.
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

function elapsedSeconds(timestamp: number, scheduler: SecondsSinceScheduler): number {
  return Math.max(0, Math.floor((scheduler.now() - timestamp) / SECOND_MS));
}

/**
 * Seconds elapsed since `timestamp`, ticking every five seconds for the first
 * minute and every ten after. Keep consumers small: Bun leaks native memory on
 * every React commit (oven-sh/bun#27514), so idle commits must stay rare and
 * cheap. Five rather than one because with polling on the timestamp moves
 * every minute, which makes the fine cadence the permanent one - and a commit
 * a second for the life of the session cost about a percent of a core for
 * a label nobody reads to the second.
 */
export function useSecondsSince(
  timestamp: number,
  scheduler: SecondsSinceScheduler = systemScheduler,
): number {
  const [seconds, setSeconds] = useState(() => elapsedSeconds(timestamp, scheduler));

  useEffect(() => {
    setSeconds(elapsedSeconds(timestamp, scheduler));
    let timer: unknown;
    const schedule = () => {
      const delay = elapsedSeconds(timestamp, scheduler) < COARSE_AFTER_SECONDS
        ? FINE_STEP_MS
        : COARSE_STEP_MS;
      timer = scheduler.setTimeout(() => {
        setSeconds(elapsedSeconds(timestamp, scheduler));
        schedule();
      }, delay);
    };
    schedule();
    return () => scheduler.clearTimeout(timer);
  }, [scheduler, timestamp]);

  return seconds;
}
