import { readFileSync } from "node:fs";
import { isRecord } from "./json";

/**
 * Claude Code only writes the usage snapshot from a statusline command, so an
 * unconfigured statusline is a setup gap, not a stale session. Telling those
 * two apart decides whether "open a session" is useful advice or a dead end.
 */
export function hasStatuslineConfigured(settingsPath: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (!isRecord(parsed)) return false;
    const statusLine = parsed.statusLine;
    if (!isRecord(statusLine)) return false;
    return typeof statusLine.command === "string" && statusLine.command.trim().length > 0;
  } catch {
    return false;
  }
}
