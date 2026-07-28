import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./app";
import { mockUsageProvider } from "./data/mock-provider";
import { VIEW_KEYS, type OverviewMode, type Screen, type ViewKey } from "./state/app-state";

/**
 * The design exposes its start state as authoring props; the CLI mirrors them so
 * every screen can be opened directly, e.g. `bun dev --screen onboarding`.
 */
function parseArgs(argv: string[]) {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const [name, inlineValue] = arg.slice(2).split("=", 2);
    if (!name) continue;
    flags.set(name, inlineValue ?? argv[++i] ?? "");
  }

  const screen = flags.get("screen");
  const view = flags.get("view");
  const mode = flags.get("mode");

  return {
    screen: (screen === "onboarding" ? "onboarding" : "app") satisfies Screen as Screen,
    view: (VIEW_KEYS.includes(view as ViewKey) ? view : "overview") as ViewKey,
    mode: (mode === "simple" || mode === "simplified" ? "simple" : "detailed") as OverviewMode,
    useSeverityColors: flags.has("severity-colors"),
    isDailySplitVisible: !flags.has("no-daily-split"),
  };
}

const startup = parseArgs(process.argv.slice(2));
const renderer = await createCliRenderer({ targetFps: 30, useMouse: true });
createRoot(renderer).render(<App provider={mockUsageProvider} startup={startup} />);
