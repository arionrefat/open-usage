import {
  CodexProbeError,
  readCodexLimits,
  type CodexAccountLimits,
} from "./codex-app-server";
import { formatAge } from "./aggregate";
import { createPolledSource } from "./polled-source";
import type { ConnectionStatus, PollOptions } from "../types";

/**
 * Codex limits are polled out-of-band because the UI reads snapshots
 * synchronously. Spawning the CLI is heavier than an HTTP call, so the poll
 * interval is deliberately conservative.
 */
export interface CodexLimitsSource {
  read(): CodexAccountLimits | null;
  /** Shown wherever a percent would have been, or null when limits are present. */
  note(): string | null;
  status?(): ConnectionStatus;
  poll(now: Date, options?: PollOptions): Promise<void>;
}

export interface CodexLimitsSourceOptions {
  initial?: CodexAccountLimits | null;
  onUpdate?: (value: CodexAccountLimits) => void;
}

const MIN_POLL_MS = 60_000;
/** Spawning the CLI is not free, so `r` cannot repeat faster than this. */
const MIN_FORCED_POLL_MS = 5_000;
const BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
/** Past this, a cached reading is rendered with a stale notice. */
export const CODEX_LIMITS_STALE_MS = 15 * 60_000;

const NOTES: Record<string, string> = {
  "not-installed": "codex cli not installed",
  "not-logged-in": "codex not signed in - run codex login",
  "unsupported-auth": "plan limits need chatgpt sign-in, not an api key",
  timeout: "codex cli did not respond",
  protocol: "codex cli returned an unexpected reply",
};

export const stubCodexLimitsSource: CodexLimitsSource = {
  read: () => null,
  note: () => "codex limits not connected",
  status: () => "none",
  poll: () => Promise.resolve(),
};

type CodexLimitsReader = typeof readCodexLimits;

export function createCodexLimitsSource(
  reader: CodexLimitsReader = readCodexLimits,
  sourceOptions: CodexLimitsSourceOptions = {},
): CodexLimitsSource {
  return createPolledSource<CodexAccountLimits>({
    fetch: (now, signal) => reader(now, { signal }),
    fetchedAtMs: (value) => value.fetchedAtMs,
    describeFailure: (error) =>
      error instanceof CodexProbeError
        ? (NOTES[error.kind] ?? "codex limits unavailable")
        : "codex limits unavailable",
    staleAfterMs: CODEX_LIMITS_STALE_MS,
    staleNote: (ageMs) => `cached limits stale (${formatAge(ageMs)} old) - press r to refresh`,
    minPollMs: MIN_POLL_MS,
    minForcedPollMs: MIN_FORCED_POLL_MS,
    backoffMs: BACKOFF_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
    initial: sourceOptions.initial ?? null,
    onUpdate: sourceOptions.onUpdate,
  });
}
