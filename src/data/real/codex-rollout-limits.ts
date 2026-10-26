import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { DAY_MS, formatAge } from "./aggregate";
import { parseRateLimits, type CodexAccountLimits, type CodexWindow } from "./codex-app-server";
import type { CodexLimitsSource } from "./codex-limits";
import { isMissingFile } from "./fs-errors";
import { isRecord } from "./json";
import { matchingLines } from "./jsonl";
import { createPolledSource } from "./polled-source";

/**
 * Without any codex binary, the next best record of the account's limits is the
 * `rate_limits` snapshot codex writes into each rollout's `token_count` events.
 * It is the server's own reading, but only as fresh as the last codex turn on
 * this device, and openai/codex#14880 leaves it null on some events.
 */
const TOKEN_COUNT_MARKER = '"type":"token_count"';
/** Older rollouts than this cannot say anything about a current weekly window. */
const MAX_SNAPSHOT_AGE_MS = 7 * DAY_MS;
/** A recent rollout with no snapshot is likely; a long run of them is not worth reading. */
const MAX_FILES_SCANNED = 20;

function newestRollouts(codexHome: string): string[] {
  const sessions = join(codexHome, "sessions");
  let entries: string[];
  try {
    entries = readdirSync(sessions, { recursive: true, encoding: "utf8" });
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  // `rollout-<local ISO time>-<id>.jsonl`, so the name orders by start time.
  return entries
    .filter((entry) => entry.endsWith(".jsonl"))
    .sort((a, b) => basename(b).localeCompare(basename(a)))
    .slice(0, MAX_FILES_SCANNED)
    .map((entry) => join(sessions, entry));
}

/** The rollout's snake_case window, renamed to what the app-server parser reads. */
function wireWindow(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return {
    usedPercent: value.used_percent,
    windowDurationMins: value.window_minutes,
    resetsAt: value.resets_at,
  };
}

function wireRateLimits(value: Record<string, unknown>): Record<string, unknown> {
  const credits = isRecord(value.credits) ? value.credits : null;
  return {
    rateLimits: {
      limitId: value.limit_id,
      planType: value.plan_type,
      primary: wireWindow(value.primary),
      secondary: wireWindow(value.secondary),
      credits: credits ? { balance: credits.balance, unlimited: credits.unlimited } : null,
      spendControlReached: value.spend_control_reached,
      rateLimitReachedType: value.rate_limit_reached_type,
    },
  };
}

interface Snapshot {
  atMs: number;
  rateLimits: Record<string, unknown>;
}

function lastSnapshot(path: string): Snapshot | null {
  let latest: Snapshot | null = null;
  for (const line of matchingLines(path, [TOKEN_COUNT_MARKER])) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed.payload) || parsed.payload.type !== "token_count") continue;
    const rateLimits = parsed.payload.rate_limits;
    if (!isRecord(rateLimits) || typeof parsed.timestamp !== "string") continue;
    const atMs = Date.parse(parsed.timestamp);
    if (!Number.isFinite(atMs)) continue;
    if (!latest || atMs >= latest.atMs) latest = { atMs, rateLimits };
  }
  return latest;
}

/** A window whose reset has passed says nothing about the one running now. */
function current(window: CodexWindow | null, nowMs: number): CodexWindow | null {
  if (!window || (window.resetsAtMs !== null && window.resetsAtMs <= nowMs)) return null;
  return window;
}

/** null when no rollout from the last week carries a snapshot. */
export function readRolloutLimits(codexHome: string, now: Date): CodexAccountLimits | null {
  const nowMs = now.getTime();
  for (const path of newestRollouts(codexHome)) {
    try {
      if (nowMs - statSync(path).mtimeMs > MAX_SNAPSHOT_AGE_MS) continue;
    } catch (error) {
      // Rotated between the listing and the stat.
      if (isMissingFile(error)) continue;
      throw error;
    }
    const snapshot = lastSnapshot(path);
    if (!snapshot) continue;
    const limits = parseRateLimits(wireRateLimits(snapshot.rateLimits), snapshot.atMs);
    if (!limits) continue;
    return { ...limits, session: current(limits.session, nowMs), weekly: current(limits.weekly, nowMs) };
  }
  return null;
}

class NoRolloutLimitsError extends Error {
  constructor() {
    super("no recent codex session carries a rate limit snapshot");
    this.name = "NoRolloutLimitsError";
  }
}

/** Reading local files is cheap, so this follows the app's own poll. */
const MIN_POLL_MS = 60_000;
const MIN_FORCED_POLL_MS = 5_000;

function describeAge(ageMs: number): string {
  const age = formatAge(ageMs);
  return age === "just now" ? age : `${age} ago`;
}

export function createCodexRolloutLimitsSource(codexHome: string): CodexLimitsSource {
  const source = createPolledSource<CodexAccountLimits>({
    fetch: (now) => {
      const limits = readRolloutLimits(codexHome, now);
      if (!limits) return Promise.reject(new NoRolloutLimitsError());
      return Promise.resolve(limits);
    },
    fetchedAtMs: (value) => value.fetchedAtMs,
    describeFailure: (error) =>
      error instanceof NoRolloutLimitsError
        ? "no codex cli - limits appear after a codex session"
        : "codex sessions unreadable",
    // Always past due: the reading is the last session's, never a live one,
    // so the note says how old it is every time it is shown.
    staleAfterMs: 0,
    staleNote: (ageMs) => `from the last codex session, ${describeAge(ageMs)}`,
    minPollMs: MIN_POLL_MS,
    minForcedPollMs: MIN_FORCED_POLL_MS,
    backoffMs: MIN_POLL_MS,
    maxBackoffMs: MIN_POLL_MS,
  });
  return {
    read: source.read,
    note: source.note,
    // A rollout is a copy of an earlier reading, so it is never live.
    status: () => (source.status() === "active" ? "cached" : source.status()),
    poll: source.poll,
  };
}
