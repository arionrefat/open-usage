import { readFileSync, statSync } from "node:fs";
import { HOUR_MS } from "./aggregate";
import { isRecord } from "./json";

export interface RateWindowReading {
  percent: number;
  resetsAtMs: number | null;
}

export interface UsageSnapshotReading {
  fiveHour: RateWindowReading | null;
  sevenDay: RateWindowReading | null;
}

export interface SnapshotFile {
  reading: UsageSnapshotReading;
  /** How long ago the statusline last wrote the file. */
  ageMs: number;
  writtenAtMs: number;
}

export const SNAPSHOT_FRESH_MS = 10 * 60 * 1000;
const EPOCH_MS_FLOOR = 1e12;
const MIN_TREND_GAP_HOURS = 5 / 60;

/** resets_at arrives as an epoch - tolerate seconds, milliseconds, or ISO text. */
function epochToMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > EPOCH_MS_FLOOR ? value : value * 1000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function windowFrom(value: unknown): RateWindowReading | null {
  if (!isRecord(value)) return null;
  const percent = value.used_percentage;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  return { percent: Math.max(0, percent), resetsAtMs: epochToMs(value.resets_at) };
}

/** The raw JSON Claude Code pipes to the statusline command. */
export function parseUsageSnapshot(value: unknown): UsageSnapshotReading | null {
  if (!isRecord(value)) return null;
  const limits = value.rate_limits;
  if (!isRecord(limits)) return null;
  const reading: UsageSnapshotReading = {
    fiveHour: windowFrom(limits.five_hour),
    sevenDay: windowFrom(limits.seven_day),
  };
  return reading.fiveHour || reading.sevenDay ? reading : null;
}

/** Reads ~/.claude/usage-snapshot.json; null when missing or unparseable. */
export function readUsageSnapshot(path: string, now: Date): SnapshotFile | null {
  try {
    const stats = statSync(path);
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const reading = parseUsageSnapshot(parsed);
    if (!reading) return null;
    return {
      reading,
      ageMs: Math.max(0, now.getTime() - stats.mtimeMs),
      writtenAtMs: stats.mtimeMs,
    };
  } catch {
    return null;
  }
}

export interface WeeklyTrend {
  /** Percent-per-hour since the first in-process reading, or null without a usable delta. */
  observe(atMs: number, percent: number): number | null;
}

/**
 * Two snapshot readings give a weekly burn slope. A drop in percent means the
 * window reset, so the baseline restarts there.
 */
export function createWeeklyTrend(): WeeklyTrend {
  let baseline: { atMs: number; percent: number } | null = null;
  return {
    observe(atMs, percent) {
      if (!baseline || percent < baseline.percent) {
        baseline = { atMs, percent };
        return null;
      }
      const hours = (atMs - baseline.atMs) / HOUR_MS;
      if (hours < MIN_TREND_GAP_HOURS) return null;
      const rate = (percent - baseline.percent) / hours;
      return rate > 0 ? rate : null;
    },
  };
}
