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
  model: { id: string | null; displayName: string | null } | null;
  effort: string | null;
  cost: {
    totalCostUsd: number | null;
    totalDurationMs: number | null;
    totalLinesAdded: number | null;
    totalLinesRemoved: number | null;
  } | null;
  contextWindow: {
    totalInputTokens: number | null;
    totalOutputTokens: number | null;
    contextWindowSize: number | null;
    usedPercentage: number | null;
    currentUsage: {
      inputTokens: number | null;
      outputTokens: number | null;
      cacheCreationInputTokens: number | null;
      cacheReadInputTokens: number | null;
    } | null;
  } | null;
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

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The raw JSON Claude Code pipes to the statusline command. */
export function parseUsageSnapshot(value: unknown): UsageSnapshotReading | null {
  if (!isRecord(value)) return null;
  const limits = isRecord(value.rate_limits) ? value.rate_limits : null;
  const model = isRecord(value.model) ? value.model : null;
  const effort = isRecord(value.effort) ? value.effort : null;
  const cost = isRecord(value.cost) ? value.cost : null;
  const context = isRecord(value.context_window) ? value.context_window : null;
  const current = context && isRecord(context.current_usage) ? context.current_usage : null;
  const reading: UsageSnapshotReading = {
    fiveHour: windowFrom(limits?.five_hour),
    sevenDay: windowFrom(limits?.seven_day),
    model: model
      ? { id: stringValue(model.id), displayName: stringValue(model.display_name) }
      : null,
    effort: effort ? stringValue(effort.level) : null,
    cost: cost
      ? {
          totalCostUsd: finiteNumber(cost.total_cost_usd),
          totalDurationMs: finiteNumber(cost.total_duration_ms),
          totalLinesAdded: finiteNumber(cost.total_lines_added),
          totalLinesRemoved: finiteNumber(cost.total_lines_removed),
        }
      : null,
    contextWindow: context
      ? {
          totalInputTokens: finiteNumber(context.total_input_tokens),
          totalOutputTokens: finiteNumber(context.total_output_tokens),
          contextWindowSize: finiteNumber(context.context_window_size),
          usedPercentage: finiteNumber(context.used_percentage),
          currentUsage: current
            ? {
                inputTokens: finiteNumber(current.input_tokens),
                outputTokens: finiteNumber(current.output_tokens),
                cacheCreationInputTokens: finiteNumber(current.cache_creation_input_tokens),
                cacheReadInputTokens: finiteNumber(current.cache_read_input_tokens),
              }
            : null,
        }
      : null,
  };
  return reading.fiveHour || reading.sevenDay || reading.model || reading.effort || reading.cost || reading.contextWindow
    ? reading
    : null;
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
