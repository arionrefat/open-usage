#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./app";
import { APP_VERSION } from "./config";
import { checkForUpdate } from "./data/real/update-check";
import { selectUsageProvider } from "./data/real-provider";
import {
  isFlagEnabled,
  providerModeFromFlags,
  readFlags,
  startupFromFlagsAndPreferences,
} from "./lib/args";
import { helpText, versionText, wantsHelp, wantsVersion } from "./lib/cli-help";
import { defaultPreferencesPath, readPreferences, updatePreferences } from "./preferences";
import { COLORS } from "./theme";

const argv = process.argv.slice(2);

// Answer before the renderer takes over the terminal.
if (wantsHelp(argv)) {
  console.log(helpText());
  process.exit(0);
}
if (wantsVersion(argv)) {
  console.log(versionText());
  process.exit(0);
}

const flags = readFlags(argv);
const preferencesPath = defaultPreferencesPath();
let preferences = readPreferences(preferencesPath);
const startup = startupFromFlagsAndPreferences(flags, preferences);
const persistPreferences = (patch: Partial<typeof preferences>) => {
  try {
    preferences = updatePreferences(preferencesPath, patch);
    return true;
  } catch {
    // A read-only home directory must not prevent the dashboard from running.
    return false;
  }
};
const provider = selectUsageProvider(providerModeFromFlags(flags, "real"));
// Stable identity: a fresh closure each render would re-run the effect behind it.
const checkUpdate = () => checkForUpdate({ currentVersion: APP_VERSION });
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
    checkUpdate={checkUpdate}
    onOnboardingFinish={() => persistPreferences({ hasCompletedOnboarding: true })}
    onPreferencesChange={persistPreferences}
  />,
);
