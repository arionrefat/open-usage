import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "./data/real/json";

export interface AppPreferences {
  hasCompletedOnboarding: boolean;
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  hasCompletedOnboarding: false,
};

export function defaultPreferencesPath(): string {
  return join(homedir(), ".config", "limitless", "preferences.json");
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
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function writePreferences(path: string, preferences: AppPreferences): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
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
