import { describe, expect, test } from "bun:test";
import {
  isFlagEnabled,
  providerModeFromFlags,
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
