import { APP_NAME } from "../config";
import { selectUsageProvider } from "../data/real-provider";
import type { UsageProvider, UsageSnapshot } from "../data/types";
import { isFlagEnabled, providerModeFromFlags, type ProviderMode } from "../lib/args";
import { defaultPreferencesPath, readPreferences } from "../preferences";
import { checkExitCode } from "./check";
import { formatOneLine } from "./oneline";
import { buildStatusReport, formatStatusJson, shownProviderIds } from "./report";

export interface StatusCommandResult {
  exitCode: number;
  /** Empty when there is nothing to print, as with --check on its own. */
  stdout: string;
  stderr: string;
}

export interface StatusCommandDependencies {
  selectProvider?: (mode: ProviderMode) => UsageProvider;
  now?: () => Date;
  readWarnThreshold?: () => number;
}

export const STATUS_EXIT_FAILURE = 1;
/** Follows CodexBar and caut, so scripts written for those read ours the same way. */
export const STATUS_EXIT_NO_SOURCES = 2;

const NO_SOURCES_MESSAGE = `${APP_NAME}: no usage sources found on this machine - sign in to claude, codex, or opencode first, or pass --mock for sample data`;
const CONFLICTING_FORMATS_MESSAGE = `${APP_NAME}: pass either --json or --oneline, not both`;

export function wantsStatusOutput(flags: Map<string, string>): boolean {
  return isFlagEnabled(flags, "json") || isFlagEnabled(flags, "oneline") || isFlagEnabled(flags, "check");
}

/**
 * --refresh polls as an automatic tick rather than as a key press, so it keeps
 * every throttle: a reading the daemon just took answers it, and a status bar
 * looping on it cannot flood a provider.
 */
function readSnapshot(provider: UsageProvider, shouldRefresh: boolean): Promise<UsageSnapshot> | UsageSnapshot {
  if (!shouldRefresh) return provider.readSnapshot();
  return provider.refresh({ reason: "interval", providerIds: shownProviderIds(provider.initialConnections()) });
}

function failure(exitCode: number, stderr: string): StatusCommandResult {
  return { exitCode, stdout: "", stderr };
}

/**
 * Prints and returns without drawing. Unless --refresh asks otherwise it reads
 * only the cache: a statusline may run this every few seconds, and starting the
 * claude or codex CLI that often would cost the account. The dashboard or the
 * daemon keeps the cache current.
 */
export async function runStatusCommand(
  flags: Map<string, string>,
  dependencies: StatusCommandDependencies = {},
): Promise<StatusCommandResult> {
  const isJson = isFlagEnabled(flags, "json");
  const isOneLine = isFlagEnabled(flags, "oneline");
  if (isJson && isOneLine) return failure(STATUS_EXIT_FAILURE, CONFLICTING_FORMATS_MESSAGE);

  const selectProvider = dependencies.selectProvider ?? selectUsageProvider;
  const mode = providerModeFromFlags(flags, "real");
  const provider = selectProvider(mode);
  const isSampleData = provider.isSampleData === true;
  // The dashboard falls back to sample figures with a banner; a script has no
  // banner to read, so it must never receive them unless it asked.
  if (isSampleData && mode !== "mock") return failure(STATUS_EXIT_NO_SOURCES, NO_SOURCES_MESSAGE);

  const snapshot = await readSnapshot(provider, isFlagEnabled(flags, "refresh"));
  const connections = provider.initialConnections();
  const now = dependencies.now?.() ?? new Date();
  const warnThreshold =
    dependencies.readWarnThreshold?.() ?? readPreferences(defaultPreferencesPath()).warnThreshold;

  let stdout = "";
  if (isJson) {
    const report = buildStatusReport(snapshot, connections, now, isSampleData);
    stdout = formatStatusJson(report, isFlagEnabled(flags, "pretty"));
  } else if (isOneLine) {
    stdout = formatOneLine(snapshot, connections, now, {
      warnThreshold,
      isColored: isFlagEnabled(flags, "color"),
      isSampleData,
    });
  }
  const exitCode = isFlagEnabled(flags, "check") ? checkExitCode(snapshot, connections, now, warnThreshold) : 0;
  return { exitCode, stdout, stderr: "" };
}
