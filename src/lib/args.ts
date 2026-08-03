import { type AppStateOptions, type OverviewMode, type Screen, type ViewKey } from "../state/app-state";
import type { AppPreferences } from "../preferences";

export function readFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) continue;

    const [name, inlineValue] = arg.slice(2).split("=", 2);
    if (!name) continue;
    const next = argv[index + 1];
    if (inlineValue !== undefined) flags.set(name, inlineValue);
    else if (next && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else flags.set(name, "");
  }
  return flags;
}

export function isFlagEnabled(flags: Map<string, string>, name: string): boolean {
  if (!flags.has(name)) return false;
  return !["0", "false", "no", "off"].includes((flags.get(name) ?? "").toLowerCase());
}

export type ProviderMode = "mock" | "real";

/** --mock wins over --real; each entry point picks its own default. */
export function providerModeFromFlags(flags: Map<string, string>, fallback: ProviderMode): ProviderMode {
  if (isFlagEnabled(flags, "mock")) return "mock";
  if (isFlagEnabled(flags, "real")) return "real";
  return fallback;
}

function screenFromFlag(value: string | undefined): Screen {
  return value === "onboarding" ? "onboarding" : "app";
}

function viewFromFlag(value: string | undefined): ViewKey {
  if (value === "claude" || value === "codex" || value === "go" || value === "settings") {
    return value;
  }
  return "overview";
}

function modeFromFlag(value: string | undefined): OverviewMode {
  return value === "simple" || value === "simplified" ? "simple" : "detailed";
}

export function startupFromFlags(flags: Map<string, string>): Omit<AppStateOptions, "connections"> {
  const screen = flags.get("screen");
  const view = flags.get("view");
  const mode = flags.get("mode");

  return {
    screen: screenFromFlag(screen),
    view: viewFromFlag(view),
    mode: modeFromFlag(mode),
    useSeverityColors: isFlagEnabled(flags, "severity-colors"),
    isDailySplitVisible: !isFlagEnabled(flags, "no-daily-split"),
  };
}

export function startupFromFlagsAndPreferences(
  flags: Map<string, string>,
  preferences: AppPreferences,
): Omit<AppStateOptions, "connections"> {
  const startup = startupFromFlags(flags);
  return {
    ...startup,
    screen: !preferences.hasCompletedOnboarding && !flags.has("screen") ? "onboarding" : startup.screen,
    mode: flags.has("mode") ? startup.mode : preferences.defaultOverviewMode,
    pollIntervalMinutes: preferences.pollIntervalMinutes,
    warnThreshold: preferences.warnThreshold,
  };
}
