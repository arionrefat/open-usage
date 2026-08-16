import { describe, expect, test } from "bun:test";
import {
  isFlagEnabled,
  providerModeFromFlags,
  positiveIntegerFlag,
  readFlags,
  startupFromFlags,
  startupFromFlagsAndPreferences,
} from "../../src/lib/args";
import { DEFAULT_PREFERENCES } from "../../src/preferences";

describe("CLI flags", () => {
  test("does not consume the next flag as a boolean value", () => {
    const flags = readFlags(["--severity-colors", "--view", "settings", "--no-daily-split"]);

    expect(flags.get("severity-colors")).toBe("");
    expect(flags.get("view")).toBe("settings");
    expect(startupFromFlags(flags)).toMatchObject({
      view: "settings",
      useSeverityColors: true,
      isDailySplitVisible: false,
    });
  });

  test("honors explicit false values", () => {
    const flags = readFlags(["--severity-colors=false"]);
    expect(isFlagEnabled(flags, "severity-colors")).toBe(false);
  });

  test("stops parsing options at the conventional marker", () => {
    const flags = readFlags(["--mock", "--", "--real", "--view=settings"]);
    expect([...flags]).toEqual([["mock", ""]]);
  });

  test("preserves equals signs inside inline values", () => {
    expect(readFlags(["--keys=a=b=c"]).get("keys")).toBe("a=b=c");
  });

  test("does not record a value-taking flag without a value", () => {
    const preferences = { ...DEFAULT_PREFERENCES, hasCompletedOnboarding: false };
    for (const argv of [["--screen"], ["--screen="], ["--screen", "--mock"]]) {
      const flags = readFlags(argv);
      expect(flags.has("screen")).toBe(false);
      expect(startupFromFlagsAndPreferences(flags, preferences).screen).toBe("onboarding");
    }
  });

  test("accepts only finite positive integer dimensions", () => {
    expect(positiveIntegerFlag(readFlags([]), "width", 140)).toBe(140);
    expect(positiveIntegerFlag(readFlags(["--width=80"]), "width", 140)).toBe(80);
    for (const value of ["0", "-1", "1.5", "NaN", "Infinity"]) {
      expect(positiveIntegerFlag(readFlags([`--height=${value}`]), "height", 46)).toBeNull();
    }
  });

  test("picks the provider mode with --mock beating --real", () => {
    expect(providerModeFromFlags(readFlags([]), "real")).toBe("real");
    expect(providerModeFromFlags(readFlags([]), "mock")).toBe("mock");
    expect(providerModeFromFlags(readFlags(["--mock"]), "real")).toBe("mock");
    expect(providerModeFromFlags(readFlags(["--real"]), "mock")).toBe("real");
    expect(providerModeFromFlags(readFlags(["--mock", "--real"]), "real")).toBe("mock");
    expect(providerModeFromFlags(readFlags(["--mock=false"]), "mock")).toBe("mock");
  });

  test("merges saved startup settings while preserving explicit flags", () => {
    const preferences = {
      ...DEFAULT_PREFERENCES,
      hasCompletedOnboarding: false,
      defaultOverviewMode: "simple" as const,
      pollIntervalMinutes: 4,
      warnThreshold: 90,
    };

    expect(startupFromFlagsAndPreferences(readFlags([]), preferences)).toMatchObject({
      screen: "onboarding",
      mode: "simple",
      pollIntervalMinutes: 4,
      warnThreshold: 90,
    });
    expect(
      startupFromFlagsAndPreferences(
        readFlags(["--screen", "app", "--mode", "detailed"]),
        preferences,
      ),
    ).toMatchObject({
      screen: "app",
      mode: "detailed",
      pollIntervalMinutes: 4,
      warnThreshold: 90,
    });
  });
});
