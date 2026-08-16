import { afterAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PREFERENCES,
  readPreferences,
  updatePreferences,
  writePreferences,
} from "../src/preferences";

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function preferencesPath(): string {
  const root = mkdtempSync(join(tmpdir(), "open-usage-preferences-"));
  tempRoots.push(root);
  return join(root, "preferences.json");
}

describe("preferences", () => {
  test("defaults onboarding completion off for missing or malformed files", () => {
    expect(readPreferences("/nonexistent/preferences.json")).toEqual(DEFAULT_PREFERENCES);
    const path = preferencesPath();
    writeFileSync(path, "not json");
    expect(readPreferences(path)).toEqual(DEFAULT_PREFERENCES);
  });

  test("persists onboarding completion with restrictive permissions", () => {
    const path = preferencesPath();
    writePreferences(path, {
      hasCompletedOnboarding: true,
      defaultOverviewMode: "simple",
      pollIntervalMinutes: 4,
      warnThreshold: 90,
    });

    expect(readPreferences(path)).toEqual({
      hasCompletedOnboarding: true,
      defaultOverviewMode: "simple",
      pollIntervalMinutes: 4,
      warnThreshold: 90,
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      hasCompletedOnboarding: true,
      defaultOverviewMode: "simple",
      pollIntervalMinutes: 4,
      warnThreshold: 90,
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("syncs the temporary file before its durable rename", () => {
    const sync = spyOn(fs, "fsyncSync");
    try {
      writePreferences(preferencesPath(), DEFAULT_PREFERENCES);
      // One sync is the temp file; a second is attempted for the directory entry.
      expect(sync).toHaveBeenCalledTimes(2);
    } finally {
      sync.mockRestore();
    }
  });

  test("falls back for missing and non-boolean fields", () => {
    const path = preferencesPath();
    writeFileSync(path, JSON.stringify({
      hasCompletedOnboarding: "yes",
      defaultOverviewMode: "wide",
      pollIntervalMinutes: 9,
      warnThreshold: 95,
    }));
    expect(readPreferences(path)).toEqual(DEFAULT_PREFERENCES);
  });

  test("merges patches with changes written by another instance", () => {
    const path = preferencesPath();
    writePreferences(path, DEFAULT_PREFERENCES);
    updatePreferences(path, { defaultOverviewMode: "simple" });
    updatePreferences(path, { pollIntervalMinutes: 4 });

    expect(readPreferences(path)).toEqual({
      ...DEFAULT_PREFERENCES,
      defaultOverviewMode: "simple",
      pollIntervalMinutes: 4,
    });
  });

  test("preserves fields written by newer versions while updating known preferences", () => {
    const path = preferencesPath();
    writeFileSync(path, JSON.stringify({
      ...DEFAULT_PREFERENCES,
      futureSetting: { mode: "turbo" },
    }));

    updatePreferences(path, { warnThreshold: 90 });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      ...DEFAULT_PREFERENCES,
      warnThreshold: 90,
      futureSetting: { mode: "turbo" },
    });
  });
});
