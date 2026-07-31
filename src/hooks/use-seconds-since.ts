import { useEffect, useState } from "react";

const SECOND_MS = 1000;
const COARSE_AFTER_SECONDS = 60;
const COARSE_STEP_MS = 10 * SECOND_MS;

function elapsedSeconds(timestamp: number): number {
  return Math.max(0, Math.floor((Date.now() - timestamp) / SECOND_MS));
}

/**
 * Seconds elapsed since `timestamp`, ticking every second for the first minute
 * and every 10s after. Keep consumers small: Bun leaks native memory on every
 * React commit (oven-sh/bun#27514), so idle commits must stay rare and cheap.
 */
export function useSecondsSince(timestamp: number): number {
  const [seconds, setSeconds] = useState(() => elapsedSeconds(timestamp));

  useEffect(() => {
    setSeconds(elapsedSeconds(timestamp));
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const delay = elapsedSeconds(timestamp) < COARSE_AFTER_SECONDS ? SECOND_MS : COARSE_STEP_MS;
      timer = setTimeout(() => {
        setSeconds(elapsedSeconds(timestamp));
        schedule();
      }, delay);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [timestamp]);

  return seconds;
}
