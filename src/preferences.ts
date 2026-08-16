import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  configPath,
  DEFAULT_POLL_INTERVAL_MINUTES,
  DEFAULT_WARN_THRESHOLD,
  POLL_INTERVAL_OPTIONS,
  WARN_THRESHOLD_OPTIONS,
} from "./config";
import { isRecord } from "./data/real/json";
import { withFileLock } from "./lib/file-lock";
import type { OverviewMode } from "./state/app-state";

export interface AppPreferences {
  hasCompletedOnboarding: boolean;
  defaultOverviewMode: OverviewMode;
  pollIntervalMinutes: number;
  warnThreshold: number;
}

export type AppPreferencePatch = Partial<Omit<AppPreferences, "hasCompletedOnboarding">>;

export const DEFAULT_PREFERENCES: AppPreferences = {
  hasCompletedOnboarding: false,
  defaultOverviewMode: "detailed",
  pollIntervalMinutes: DEFAULT_POLL_INTERVAL_MINUTES,
  warnThreshold: DEFAULT_WARN_THRESHOLD,
};

export function defaultPreferencesPath(): string {
  return configPath("preferences.json");
}

export function readPreferences(path: string): AppPreferences {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return DEFAULT_PREFERENCES;
    return {
      hasCompletedOnboarding:
        typeof parsed.hasCompletedOnboarding === "boolean"
          ? parsed.hasCompletedOnboarding
          : DEFAULT_PREFERENCES.hasCompletedOnboarding,
      defaultOverviewMode:
        parsed.defaultOverviewMode === "simple" || parsed.defaultOverviewMode === "detailed"
          ? parsed.defaultOverviewMode
          : DEFAULT_PREFERENCES.defaultOverviewMode,
      pollIntervalMinutes:
        typeof parsed.pollIntervalMinutes === "number" &&
        Number.isInteger(parsed.pollIntervalMinutes) &&
        POLL_INTERVAL_OPTIONS.includes(parsed.pollIntervalMinutes as (typeof POLL_INTERVAL_OPTIONS)[number])
          ? parsed.pollIntervalMinutes
          : DEFAULT_PREFERENCES.pollIntervalMinutes,
      warnThreshold:
        typeof parsed.warnThreshold === "number" &&
        WARN_THRESHOLD_OPTIONS.includes(parsed.warnThreshold as (typeof WARN_THRESHOLD_OPTIONS)[number])
          ? parsed.warnThreshold
          : DEFAULT_PREFERENCES.warnThreshold,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function writePreferencesFile(path: string, preferences: unknown): void {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function writePreferences(path: string, preferences: AppPreferences): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  withFileLock(path, () => writePreferencesFile(path, preferences));
}

export function updatePreferences(
  path: string,
  patch: Partial<AppPreferences>,
): AppPreferences {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withFileLock(path, () => {
    let existing: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isRecord(parsed)) existing = parsed;
    } catch {
      // Missing or malformed preferences are repaired from defaults below.
    }
    const preferences = { ...readPreferences(path), ...patch };
    writePreferencesFile(path, { ...existing, ...preferences });
    return preferences;
  });
}
