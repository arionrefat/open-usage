import {
  CodexProbeError,
  readCodexLimits,
  type CodexAccountLimits,
} from "./codex-app-server";
import type { PollOptions } from "../types";

/**
 * Codex limits are polled out-of-band because the UI reads snapshots
 * synchronously. Spawning the CLI is heavier than an HTTP call, so the poll
 * interval is deliberately conservative.
 */
export interface CodexLimitsSource {
  read(): CodexAccountLimits | null;
  /** Shown wherever a percent would have been, or null when limits are present. */
  note(): string | null;
  poll(now: Date, options?: PollOptions): Promise<void>;
}

export interface CodexLimitsSourceOptions {
  initial?: CodexAccountLimits | null;
  onUpdate?: (value: CodexAccountLimits) => void;
}

const MIN_POLL_MS = 60_000;
const BACKOFF_MS = 5 * 60_000;
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
  poll: () => Promise.resolve(),
};

type CodexLimitsReader = typeof readCodexLimits;

export function createCodexLimitsSource(
  reader: CodexLimitsReader = readCodexLimits,
  sourceOptions: CodexLimitsSourceOptions = {},
): CodexLimitsSource {
  let cached: CodexAccountLimits | null = sourceOptions.initial ?? null;
  let note: string | null = null;
  let nextPollAtMs = 0;

  function readCache(): CodexAccountLimits | null {
    if (!cached) return null;
    return cached;
  }

  return {
    read: readCache,
    note: () => {
      if (note) return note;
      if (cached && Date.now() - cached.fetchedAtMs > CODEX_LIMITS_STALE_MS) {
        return `cached limits stale (${Math.max(1, Math.floor((Date.now() - cached.fetchedAtMs) / 60_000))}m old) - press r to refresh`;
      }
      return null;
    },
    async poll(now, options = {}) {
      const nowMs = now.getTime();
      const pollIsThrottled = nowMs < nextPollAtMs;
      if (!options.force && pollIsThrottled) return;
      nextPollAtMs = nowMs + MIN_POLL_MS;

      try {
        cached = await reader(now, { signal: options.signal });
        sourceOptions.onUpdate?.(cached);
        note = null;
      } catch (error) {
        // A cancelled refresh is not a provider failure.
        if (options.signal?.aborted) throw error;
        nextPollAtMs = nowMs + BACKOFF_MS;
        note = error instanceof CodexProbeError
          ? (NOTES[error.kind] ?? "codex limits unavailable")
          : "codex limits unavailable";
      }
    },
  };
}
