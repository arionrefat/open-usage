import { existsSync, readFileSync } from "node:fs";
import { isRecord } from "./json";

export interface HistoryEvent {
  epochMs: number;
  sessionId: string;
}

export interface HistoryStats {
  prompts: number;
  sessions: number;
  latestMs: number;
}

const EMPTY_STATS: HistoryStats = { prompts: 0, sessions: 0, latestMs: 0 };

export function parseHistoryLine(line: string): HistoryEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (typeof parsed.timestamp !== "number" || !Number.isFinite(parsed.timestamp)) return null;
  if (typeof parsed.sessionId !== "string" || parsed.sessionId.length === 0) return null;
  return { epochMs: parsed.timestamp, sessionId: parsed.sessionId };
}

export function historyStatsFromLines(lines: Iterable<string>, sinceMs: number): HistoryStats {
  const sessionIds = new Set<string>();
  let prompts = 0;
  let latestMs = 0;
  for (const line of lines) {
    const event = parseHistoryLine(line);
    if (!event || event.epochMs < sinceMs) continue;
    prompts += 1;
    sessionIds.add(event.sessionId);
    latestMs = Math.max(latestMs, event.epochMs);
  }
  return { prompts, sessions: sessionIds.size, latestMs };
}

/** Prompt and session counts since `sinceMs`; zeros when the file is absent. */
export function readHistoryStats(path: string, sinceMs: number): HistoryStats {
  if (!existsSync(path)) return EMPTY_STATS;
  try {
    return historyStatsFromLines(readFileSync(path, "utf8").split("\n"), sinceMs);
  } catch {
    return EMPTY_STATS;
  }
}
