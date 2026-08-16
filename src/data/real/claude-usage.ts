import { isRecord } from "./json";
import { createPolledSource } from "./polled-source";
import { createSubprocessGuard, subprocessEnvironment } from "./subprocess";
import type { ConnectionStatus, PollOptions } from "../types";

export interface ClaudeUsageWindow {
  percent: number;
  /** First-party display text, including the leading "resets". */
  reset: string;
}

export interface ClaudeCliUsage {
  session: ClaudeUsageWindow;
  weekly: ClaudeUsageWindow;
  fable?: ClaudeUsageWindow;
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

const WINDOW_PATTERN = /^(.+?):\s*([0-9]+(?:\.[0-9]+)?)% used(?:\s*[·|-]\s*(resets .+))?$/i;
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
  let fable: ClaudeUsageWindow | null = null;
  for (const line of value.result.split("\n")) {
    const match = WINDOW_PATTERN.exec(line.trim());
    if (!match) continue;
    const label = match[1]?.toLowerCase();
    const rawPercent = Number(match[2]);
    if (!label || !Number.isFinite(rawPercent)) continue;
    const reset = match[3];
    // Claude omits the reset clause on windows that have not started accruing yet.
    if (!reset && rawPercent !== 0) continue;
    const window = {
      percent: Math.min(100, Math.max(0, rawPercent)),
      reset: reset ?? (label === "current session" ? "starts when a message is sent" : "no usage yet"),
    };
    if (label === "current session") session = window;
    else if (label === "current week (all models)") weekly = window;
    else if (label === "current week (fable)") fable = window;
  }

  if (!session || !weekly) return null;
  const effectiveFetchedAtMs = staleAdjustedFetchTime(value.result, fetchedAtMs);
  return effectiveFetchedAtMs === null
    ? null
    : {
        session,
        weekly,
        ...(fable ? { fable } : {}),
        fetchedAtMs: effectiveFetchedAtMs,
      };
}

const REQUEST_TIMEOUT_MS = 15_000;

interface ClaudeUsageReadOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Test seam; production discovers `claude` through PATH. */
  executable?: string;
  /** Test seam; production inherits the scrubbed process environment. */
  env?: Record<string, string | undefined>;
  killGraceMs?: number;
}

function spawnClaudeUsage(options: ClaudeUsageReadOptions) {
  return Bun.spawn(
    [
      options.executable ?? "claude",
      "--safe-mode",
      "-p",
      "/usage",
      "--output-format",
      "json",
      "--no-session-persistence",
    ],
    { stdout: "pipe", stderr: "ignore", env: subprocessEnvironment(options.env) },
  );
}

/** Reads live subscription limits through Claude Code without touching its credentials. */
export async function readClaudeUsage(
  now: Date,
  options: ClaudeUsageReadOptions = {},
): Promise<ClaudeCliUsage> {
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException("Refresh aborted", "AbortError");
  }
  let proc: ReturnType<typeof spawnClaudeUsage>;
  try {
    proc = spawnClaudeUsage(options);
  } catch (error) {
    throw new ClaudeUsageError("not-installed", "claude cli not found", { cause: error });
  }

  const guard = createSubprocessGuard(proc, {
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    signal: options.signal,
    timeoutError: () => new ClaudeUsageError("timeout", "claude usage did not respond"),
    killGraceMs: options.killGraceMs,
  });
  try {
    const { output, exitCode } = await guard.waitFor(
      (async () => ({
        output: await new Response(proc.stdout).text(),
        exitCode: await proc.exited,
      }))(),
    );
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
    guard.dispose();
  }
}

export interface ClaudeLimitsSource {
  read(): ClaudeCliUsage | null;
  note(): string | null;
  status?(): ConnectionStatus;
  poll(now: Date, options?: PollOptions): Promise<void>;
}

export interface ClaudeLimitsSourceOptions {
  initial?: ClaudeCliUsage | null;
  onUpdate?: (value: ClaudeCliUsage) => void;
  /**
   * True while a fresh statusline snapshot already carries the session and
   * weekly windows, which leaves the CLI responsible only for Fable. Checked on
   * every tick, so the cadence tightens again the moment that cover lapses.
   */
  isCoveredBySnapshot?: () => boolean;
}

/** Cadence when the CLI is the only source of the session and weekly windows. */
const MIN_POLL_MS = 3 * 60_000;
/**
 * Cadence when a fresh statusline snapshot already carries the session and
 * weekly windows for free. All the CLI still adds is the Fable window, and a
 * weekly bar cannot move far in twenty minutes, so this trades a little Fable
 * latency for roughly six times fewer requests against the account.
 */
const SNAPSHOT_COVERED_POLL_MS = 20 * 60_000;
export const CLAUDE_LIMITS_STALE_MS = 10 * 60_000;
/** Sits above the snapshot-covered cadence so a routine tick never reads stale. */
export const CLAUDE_FABLE_STALE_MS = SNAPSHOT_COVERED_POLL_MS + 5 * 60_000;
const BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
/**
 * Every poll is a real request against the account, so `r` is floored harder
 * than the local-CLI providers: a held key must not turn into an API flood.
 */
const MIN_FORCED_POLL_MS = 15_000;

const NOTES: Record<ClaudeUsageFailure, string> = {
  "not-installed": "claude cli not installed",
  "not-logged-in": "claude cli not signed in - run claude login",
  timeout: "claude usage did not respond",
  protocol: "claude usage format changed",
};

export const dormantClaudeLimitsSource: ClaudeLimitsSource = {
  read: () => null,
  note: () => null,
  status: () => "none",
  poll: () => Promise.resolve(),
};

type ClaudeUsageReader = typeof readClaudeUsage;

export function createClaudeLimitsSource(
  reader: ClaudeUsageReader = readClaudeUsage,
  sourceOptions: ClaudeLimitsSourceOptions = {},
): ClaudeLimitsSource {
  // Staleness is reported by the provider, which weighs the CLI reading against
  // the statusline snapshot, so no stale note is configured here.
  return createPolledSource<ClaudeCliUsage>({
    fetch: (now, signal) => reader(now, { signal }),
    fetchedAtMs: (value) => value.fetchedAtMs,
    minPollMs: () =>
      sourceOptions.isCoveredBySnapshot?.() ? SNAPSHOT_COVERED_POLL_MS : MIN_POLL_MS,
    describeFailure: (error) =>
      error instanceof ClaudeUsageError ? NOTES[error.kind] : "claude live limits unavailable",
    minForcedPollMs: MIN_FORCED_POLL_MS,
    backoffMs: BACKOFF_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
    initial: sourceOptions.initial ?? null,
    onUpdate: sourceOptions.onUpdate,
  });
}
