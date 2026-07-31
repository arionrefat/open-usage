import { VIEW_KEYS, type AppStateOptions, type OverviewMode, type Screen, type ViewKey } from "../state/app-state";

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

export function startupFromFlags(flags: Map<string, string>): Omit<AppStateOptions, "connections"> {
  const screen = flags.get("screen");
  const view = flags.get("view");
  const mode = flags.get("mode");

  return {
    screen: (screen === "onboarding" ? "onboarding" : "app") satisfies Screen as Screen,
    view: (VIEW_KEYS.includes(view as ViewKey) ? view : "overview") as ViewKey,
    mode: (mode === "simple" || mode === "simplified" ? "simple" : "detailed") as OverviewMode,
    useSeverityColors: isFlagEnabled(flags, "severity-colors"),
    isDailySplitVisible: !isFlagEnabled(flags, "no-daily-split"),
  };
}
