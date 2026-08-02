import {
  CodexProbeError,
  readCodexLimits,
  type CodexAccountLimits,
} from "./codex-app-server";

/**
 * Codex limits are polled out-of-band because the UI reads snapshots
 * synchronously. Spawning the CLI is heavier than an HTTP call, so the poll
 * interval is deliberately conservative.
 */
export interface CodexLimitsSource {
  read(): CodexAccountLimits | null;
  /** Shown wherever a percent would have been, or null when limits are present. */
  note(): string | null;
  poll(now: Date, signal?: AbortSignal): Promise<void>;
}

const MIN_POLL_MS = 60_000;
const BACKOFF_MS = 5 * 60_000;
/** Past this, a cached reading stops being reported as current. */
const STALE_MS = 15 * 60_000;

const NOTES: Record<string, string> = {
  "not-installed": "codex cli not installed",
  "not-logged-in": "codex not signed in - run codex login",
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
): CodexLimitsSource {
  let cached: CodexAccountLimits | null = null;
  let note: string | null = null;
  let nextPollAtMs = 0;

  return {
    read: () => (cached && Date.now() - cached.fetchedAtMs <= STALE_MS ? cached : null),
    note: () => note,
    async poll(now, signal) {
      const nowMs = now.getTime();
      if (nowMs < nextPollAtMs) return;
      nextPollAtMs = nowMs + MIN_POLL_MS;

      try {
        cached = await reader(now);
        note = null;
      } catch (error) {
        if (!(error instanceof CodexProbeError)) throw error;
        // A cancelled refresh is not a provider failure.
        if (signal?.aborted) throw error;
        nextPollAtMs = nowMs + BACKOFF_MS;
        cached = null;
        note = NOTES[error.kind] ?? "codex limits unavailable";
      }
    },
  };
}
