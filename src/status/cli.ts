import { APP_NAME } from "../config";
import { selectUsageProvider } from "../data/real-provider";
import type { UsageProvider } from "../data/types";
import { isFlagEnabled, providerModeFromFlags, type ProviderMode } from "../lib/args";
import { buildStatusReport, formatStatusJson } from "./report";

export interface StatusCommandResult {
  exitCode: number;
  /** Printed to stdout on success and to stderr otherwise. */
  message: string;
}

/** Exit codes follow CodexBar and caut, so scripts written for those read ours the same way. */
export const STATUS_EXIT_NO_SOURCES = 2;

const NO_SOURCES_MESSAGE = `${APP_NAME}: no usage sources found on this machine - sign in to claude, codex, or opencode first, or pass --mock for sample data`;

export function wantsStatusOutput(flags: Map<string, string>): boolean {
  return isFlagEnabled(flags, "json");
}

/**
 * Prints what the cache already holds and returns. It never polls: a statusline
 * may run this every few seconds, and spawning the claude or codex CLI that often
 * would cost the account. The dashboard or the daemon keeps the cache current.
 */
export function runStatusCommand(
  flags: Map<string, string>,
  selectProvider: (mode: ProviderMode) => UsageProvider = selectUsageProvider,
  now: Date = new Date(),
): StatusCommandResult {
  const mode = providerModeFromFlags(flags, "real");
  const provider = selectProvider(mode);
  const isSampleData = provider.isSampleData === true;
  // The dashboard falls back to sample figures with a banner; a script has no
  // banner to read, so it must never receive them unless it asked.
  if (isSampleData && mode !== "mock") {
    return { exitCode: STATUS_EXIT_NO_SOURCES, message: NO_SOURCES_MESSAGE };
  }
  const report = buildStatusReport(provider.readSnapshot(), provider.initialConnections(), now, isSampleData);
  return { exitCode: 0, message: formatStatusJson(report, isFlagEnabled(flags, "pretty")) };
}
