#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./app";
import { APP_VERSION } from "./config";
import { runDaemonCommand } from "./daemon/cli";
import { checkForUpdate } from "./data/real/update-check";
import { selectUsageProvider } from "./data/real-provider";
import type { ProviderConnection, ProviderId, UsageSnapshot } from "./data/types";
import {
  isFlagEnabled,
  providerModeFromFlags,
  readFlags,
  startupFromFlagsAndPreferences,
} from "./lib/args";
import { helpText, versionText, wantsHelp, wantsVersion } from "./lib/cli-help";
import { sendDesktopNotification } from "./notifications/desktop";
import {
  clearCappedLimits,
  defaultLimitAlertsPath,
  notifyLimitChanges,
} from "./notifications/limit-alerts";
import { defaultPreferencesPath, readPreferences, updatePreferences } from "./preferences";
import { COLORS } from "./theme";

const argv = process.argv.slice(2);

// The daemon subcommands never draw, so they answer before the renderer exists.
// They come first because `daemon --help` documents the daemon, not the app.
if (argv[0] === "daemon") {
  const result = await runDaemonCommand(argv.slice(1));
  if (result.message) (result.exitCode === 0 ? console.log : console.error)(result.message);
  process.exit(result.exitCode);
}

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
const limitAlertsPath = defaultLimitAlertsPath();
const persistPreferences = (patch: Partial<typeof preferences>) => {
  const wasNotifying = preferences.notifyOnLimits;
  try {
    preferences = updatePreferences(preferencesPath, patch);
  } catch {
    // A read-only home directory must not prevent the dashboard from running.
    return false;
  }
  if (preferences.notifyOnLimits && !wasNotifying) {
    try {
      clearCappedLimits(limitAlertsPath);
    } catch {
      // A stale record costs at most one early "ready"; not worth failing the save over.
    }
  }
  return true;
};
const provider = selectUsageProvider(providerModeFromFlags(flags, "real"));
const notifyOnRefresh = provider.isSampleData
  ? undefined
  : (snapshot: UsageSnapshot, connections: Record<ProviderId, ProviderConnection>) => {
      if (!preferences.notifyOnLimits) return;
      // The dashboard has nowhere to report a failed delivery; the daemon logs them.
      void notifyLimitChanges(limitAlertsPath, snapshot, connections, sendDesktopNotification).catch(() => {});
    };
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
    onOnboardingFinish={({ notifyOnLimits }) =>
      persistPreferences({ hasCompletedOnboarding: true, notifyOnLimits })
    }
    onPreferencesChange={persistPreferences}
    onRefreshed={notifyOnRefresh}
    sendNotification={sendDesktopNotification}
  />,
);
