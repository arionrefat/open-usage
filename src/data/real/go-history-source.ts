import type { SpendSummary } from "../types";
import { goSpendSummary } from "./go-spend-summary";
import { fetchGoUsageHistory, type GoUsageHistory } from "./opencode-server";
import type { GoBilling } from "./opencode-usage";

/**
 * Server-side month history, polled out-of-band because the UI reads snapshots
 * synchronously. Dormant without a cookie: opencode.db carries no per-model cost
 * history, so there is nothing to fall back to here.
 */
export interface GoHistorySource {
  read(): SpendSummary | null;
  billing(): GoBilling | null;
  poll(now: Date, options?: { force?: boolean; signal?: AbortSignal }): Promise<void>;
}

/** Completed months never change, and the open one moves slowly. */
const MIN_POLL_MS = 30 * 60_000;
const MIN_FORCED_POLL_MS = 30_000;
const BACKOFF_MS = 15 * 60_000;
/** The open month plus two closed ones, which is what the history line shows. */
const MONTHS = 3;

export const dormantGoHistorySource: GoHistorySource = {
  read: () => null,
  billing: () => null,
  poll: async () => {},
};

export function createGoHistorySource(
  readCookieHeader: () => string | null,
  options: { fetchHistory?: typeof fetchGoUsageHistory } = {},
): GoHistorySource {
  const fetchHistory = options.fetchHistory ?? fetchGoUsageHistory;
  let summary: SpendSummary | null = null;
  let billing: GoBilling | null = null;
  let lastAttemptMs = 0;
  let nextAllowedMs = 0;
  let workspaceId: string | undefined;

  return {
    read: () => summary,
    billing: () => billing,
    async poll(now, pollOptions = {}) {
      const nowMs = now.getTime();
      const minimumGap = pollOptions.force ? MIN_FORCED_POLL_MS : MIN_POLL_MS;
      if (nowMs - lastAttemptMs < minimumGap || nowMs < nextAllowedMs) return;
      lastAttemptMs = nowMs;

      const cookie = readCookieHeader();
      if (!cookie) return;

      try {
        const months: GoUsageHistory[] = [];
        for (let monthsAgo = 0; monthsAgo < MONTHS; monthsAgo += 1) {
          const month = await fetchHistory(cookie, now, {
            monthsAgo,
            workspaceId,
            signal: pollOptions.signal,
          });
          workspaceId = month.workspaceId;
          months.push(month);
        }
        summary = goSpendSummary(months);
        billing = months[0]?.billing ?? null;
        nextAllowedMs = 0;
      } catch {
        // History is supplementary; a failure leaves the last good copy in place
        // rather than blanking the screen.
        nextAllowedMs = nowMs + BACKOFF_MS;
      }
    },
  };
}
