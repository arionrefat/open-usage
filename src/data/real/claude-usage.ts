import { isRecord } from "./json";
import type { PollOptions } from "../types";

export interface ClaudeUsageWindow {
  percent: number;
  /** First-party display text, including the leading "resets". */
  reset: string;
}

export interface ClaudeCliUsage {
  session: ClaudeUsageWindow;
  weekly: ClaudeUsageWindow;
  fetchedAtMs: number;
}

export type ClaudeUsageFailure = "not-installed" | "not-logged-in" | "timeout" | "protocol";

export class ClaudeUsageError extends Error {
  constructor(
    readonly kind: ClaudeUsageFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClaudeUsageError";
  }
}

const WINDOW_PATTERN = /^(.+?):\s*([0-9]+(?:\.[0-9]+)?)% used\s*[·|-]\s*(resets .+)$/i;
const STALE_MARKER = /last-known usage/i;
const AGE_HOURS = /(\d+)\s*h(?:ours?)?\b/i;
const AGE_MINUTES = /(\d+)\s*m(?:in(?:utes?)?)?\b/i;

/** Claude can show cached bars for up to an hour when rate-limited. Age is subtracted from fetch time so our staleness window sees it too. Unparseable age fails closed. */
function staleAdjustedFetchTime(result: string, fetchedAtMs: number): number | null {
  const markerLine = result.split("\n").find((line) => STALE_MARKER.test(line));
  if (markerLine === undefined) return fetchedAtMs;
  const hours = Number(AGE_HOURS.exec(markerLine)?.[1] ?? 0);
  const minutes = Number(AGE_MINUTES.exec(markerLine)?.[1] ?? 0);
  const ageMs = (hours * 60 + minutes) * 60_000;
  return ageMs > 0 ? fetchedAtMs - ageMs : null;
}

/** Parses the text returned by the first-party `claude -p "/usage"` command. */
export function parseClaudeUsage(value: unknown, fetchedAtMs: number): ClaudeCliUsage | null {
  if (!isRecord(value) || typeof value.result !== "string") return null;

  let session: ClaudeUsageWindow | null = null;
  let weekly: ClaudeUsageWindow | null = null;
  for (const line of value.result.split("\n")) {
    const match = WINDOW_PATTERN.exec(line.trim());
    if (!match) continue;
    const label = match[1]?.toLowerCase();
    const rawPercent = Number(match[2]);
    const reset = match[3];
    if (!label || !Number.isFinite(rawPercent) || !reset) continue;
    const window = { percent: Math.min(100, Math.max(0, rawPercent)), reset };
    if (label === "current session") session = window;
    else if (label === "current week (all models)") weekly = window;
  }

  if (!session || !weekly) return null;
  const effectiveFetchedAtMs = staleAdjustedFetchTime(value.result, fetchedAtMs);
  return effectiveFetchedAtMs === null
    ? null
    : { session, weekly, fetchedAtMs: effectiveFetchedAtMs };
}

const REQUEST_TIMEOUT_MS = 15_000;

function spawnClaudeUsage() {
  return Bun.spawn(
    [
      "claude",
      "--safe-mode",
      "-p",
      "/usage",
      "--output-format",
      "json",
      "--no-session-persistence",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
}

/** Reads live subscription limits through Claude Code without touching its credentials. */
export async function readClaudeUsage(
  now: Date,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ClaudeCliUsage> {
  let proc: ReturnType<typeof spawnClaudeUsage>;
  try {
    proc = spawnClaudeUsage();
  } catch (error) {
    throw new ClaudeUsageError("not-installed", "claude cli not found", { cause: error });
  }

  let timedOut = false;
  const abort = () => proc.kill();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException("Refresh aborted", "AbortError");
    }
    if (timedOut) throw new ClaudeUsageError("timeout", "claude usage did not respond");
    if (exitCode !== 0) {
      throw new ClaudeUsageError("not-logged-in", "claude usage requires a signed-in cli");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch (error) {
      throw new ClaudeUsageError("protocol", "claude usage returned invalid json", { cause: error });
    }
    const usage = parseClaudeUsage(parsed, now.getTime());
    if (!usage) throw new ClaudeUsageError("protocol", "claude usage returned no plan limits");
    return usage;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    proc.kill();
  }
}

export interface ClaudeLimitsSource {
  read(): ClaudeCliUsage | null;
  note(): string | null;
  poll(now: Date, options?: PollOptions): Promise<void>;
}

const MIN_POLL_MS = 3 * 60_000;
const STALE_MS = 10 * 60_000;
const BACKOFF_MS = 5 * 60_000;

const NOTES: Record<ClaudeUsageFailure, string> = {
  "not-installed": "claude cli not installed",
  "not-logged-in": "claude cli not signed in - run claude login",
  timeout: "claude usage did not respond",
  protocol: "claude usage format changed",
};

export const dormantClaudeLimitsSource: ClaudeLimitsSource = {
  read: () => null,
  note: () => null,
  poll: () => Promise.resolve(),
};

type ClaudeUsageReader = typeof readClaudeUsage;

export function createClaudeLimitsSource(
  reader: ClaudeUsageReader = readClaudeUsage,
): ClaudeLimitsSource {
  let cached: ClaudeCliUsage | null = null;
  let note: string | null = null;
  let nextPollAtMs = 0;

  return {
    read: () => {
      if (!cached || Date.now() - cached.fetchedAtMs > STALE_MS) return null;
      return cached;
    },
    note: () => note,
    async poll(now, options = {}) {
      const nowMs = now.getTime();
      if (!options.force && nowMs < nextPollAtMs) return;
      nextPollAtMs = nowMs + MIN_POLL_MS;

      try {
        cached = await reader(now, { signal: options.signal });
        note = null;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        cached = null;
        nextPollAtMs = nowMs + BACKOFF_MS;
        if (error instanceof ClaudeUsageError) {
          note = NOTES[error.kind];
          return;
        }
        note = "claude live limits unavailable";
      }
    },
  };
}
