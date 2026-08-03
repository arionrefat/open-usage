import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PREFERENCES,
  readPreferences,
  writePreferences,
} from "../src/preferences";

function preferencesPath(): string {
  return join(mkdtempSync(join(tmpdir(), "limitless-preferences-")), "preferences.json");
}

describe("preferences", () => {
  test("defaults Codex startup refresh off for missing or malformed files", () => {
    expect(readPreferences("/nonexistent/preferences.json")).toEqual(DEFAULT_PREFERENCES);
    const path = preferencesPath();
    writeFileSync(path, "not json");
    expect(readPreferences(path)).toEqual(DEFAULT_PREFERENCES);
  });

  test("persists only the explicit startup choice with restrictive permissions", () => {
    const path = preferencesPath();
    writePreferences(path, { refreshCodexOnStartup: true, hasCompletedOnboarding: true });

    expect(readPreferences(path)).toEqual({
      refreshCodexOnStartup: true,
      hasCompletedOnboarding: true,
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      refreshCodexOnStartup: true,
      hasCompletedOnboarding: true,
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("falls back for missing and non-boolean fields", () => {
    const path = preferencesPath();
    writeFileSync(path, JSON.stringify({ refreshCodexOnStartup: "yes" }));
    expect(readPreferences(path).refreshCodexOnStartup).toBe(false);
  });
});
