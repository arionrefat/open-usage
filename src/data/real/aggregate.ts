import type { UsageSeries } from "../types";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60_000;
const TOKENS_PER_MILLION = 1_000_000;
const BURN_WINDOW_HOURS = 3;

/** Token totals bucketed by floor(epochMs / HOUR_MS) - enough for every series. */
export type HourBuckets = Map<number, number>;

export function addToBucket(buckets: HourBuckets, epochMs: number, tokens: number): void {
  if (!Number.isFinite(epochMs) || !Number.isFinite(tokens) || tokens <= 0) return;
  const hour = Math.floor(epochMs / HOUR_MS);
  buckets.set(hour, (buckets.get(hour) ?? 0) + tokens);
}

export function mergeBuckets(target: HourBuckets, source: HourBuckets): void {
  for (const [hour, tokens] of source) target.set(hour, (target.get(hour) ?? 0) + tokens);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Local-time YYYY-MM-DD, matching SQLite's 'localtime' date() buckets. */
export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** The last `days` local dates ending today, oldest first. */
export function dailyDateKeys(now: Date, days = 30): string[] {
  return Array.from({ length: days }, (_, index) =>
    localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1 - index))),
  );
}

/** Charts and formatTokens hold token counts in millions. */
export function toMillions(tokens: number): number {
  return tokens / TOKENS_PER_MILLION;
}

/** Zero-filled UsageSeries with `daily` aligned to `dates` and `hourly` for today. */
export function seriesFromBuckets(buckets: HourBuckets, dates: string[], now: Date): UsageSeries {
  const dayIndex = new Map(dates.map((date, index) => [date, index]));
  const daily = dates.map(() => 0);
  const hourly = Array.from({ length: 24 }, () => 0);
  const todayKey = localDateKey(now);

  for (const [hour, tokens] of buckets) {
    const at = new Date(hour * HOUR_MS);
    const key = localDateKey(at);
    const index = dayIndex.get(key);
    if (index !== undefined) daily[index] = (daily[index] ?? 0) + toMillions(tokens);
    if (key === todayKey) {
      const slot = at.getHours();
      hourly[slot] = (hourly[slot] ?? 0) + toMillions(tokens);
    }
  }
  return { daily, hourly };
}

/** Average tokens/hour over the trailing window, current hour included. */
export function tokensPerHour(
  buckets: HourBuckets,
  now: Date,
  windowHours = BURN_WINDOW_HOURS,
): number {
  const currentHour = Math.floor(now.getTime() / HOUR_MS);
  let total = 0;
  for (let hour = currentHour - windowHours + 1; hour <= currentHour; hour++) {
    total += buckets.get(hour) ?? 0;
  }
  return total / windowHours;
}

export function formatRate(perHour: number): string {
  if (perHour >= TOKENS_PER_MILLION) return `${(perHour / TOKENS_PER_MILLION).toFixed(1)}M tok/h`;
  if (perHour >= 1_000) return `${Math.round(perHour / 1_000)}K tok/h`;
  return `${Math.round(perHour)} tok/h`;
}

/** "2d 11h", "1h 37m", "42m" - never negative. */
export function formatCountdown(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/** "Tue 19:40" in local time. */
export function formatClock(epochMs: number): string {
  const date = new Date(epochMs);
  const weekday = date.toLocaleDateString("en-US", { weekday: "short" });
  return `${weekday} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** "just now", "4m", "2h 10m" - for snapshot age captions. */
export function formatAge(ms: number): string {
  if (ms < MINUTE_MS) return "just now";
  return formatCountdown(ms);
}
