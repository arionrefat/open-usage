import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./app";
import { selectUsageProvider } from "./data/real-provider";
import { isFlagEnabled, providerModeFromFlags, readFlags, startupFromFlags } from "./lib/args";
import { COLORS } from "./theme";

const flags = readFlags(process.argv.slice(2));
const startup = startupFromFlags(flags);
const provider = selectUsageProvider(providerModeFromFlags(flags, "real"));
const renderer = await createCliRenderer({
  targetFps: 30,
  useMouse: true,
  exitOnCtrlC: false,
  screenMode: "alternate-screen",
  backgroundColor: COLORS.bg,
});

// OpenTUI's own signal handlers destroy the renderer but never exit, which
// left orphaned sessions polling (and leaking) for days. Exit explicitly.
function shutdown(exitCode: number): void {
  renderer.destroy();
  process.exit(exitCode);
}
process.on("SIGHUP", () => shutdown(129));
process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));
process.stdin.on("end", () => shutdown(0));
process.stdin.on("close", () => shutdown(0));

createRoot(renderer).render(
  <App
    provider={provider}
    startup={startup}
    isPollingEnabled={!isFlagEnabled(flags, "no-poll")}
  />,
);
