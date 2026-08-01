import { readFileSync } from "node:fs";
import {
  OpencodeServerError,
  fetchGoServerLimits,
  filterCookieHeader,
  type GoServerLimits,
} from "./opencode-server";

/**
 * Server-truth go limits, polled out-of-band because the UI reads snapshots
 * synchronously. Without a cookie this stays dormant and the caller falls back
 * to the local spend estimate.
 */
export interface GoLimitsSource {
  read(): GoServerLimits | null;
  /** Why server limits are missing, or null when they are present. */
  note(): string | null;
  poll(now: Date, signal?: AbortSignal): Promise<void>;
}

export const COOKIE_ENV_VAR = "LIMITLESS_OPENCODE_COOKIE";

const MIN_POLL_MS = 60_000;
const BACKOFF_MS = 5 * 60_000;

export function readCookie(path: string, env: Record<string, string | undefined>): string | null {
  const fromEnv = env[COOKIE_ENV_VAR]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const fromFile = readFileSync(path, "utf8").trim();
    return fromFile.length > 0 ? fromFile : null;
  } catch {
    return null;
  }
}

export const dormantGoLimitsSource: GoLimitsSource = {
  read: () => null,
  note: () => null,
  poll: () => Promise.resolve(),
};

export function createGoLimitsSource(cookiePath: string, env = process.env): GoLimitsSource {
  let cached: GoServerLimits | null = null;
  let workspaceId: string | undefined;
  let note: string | null = null;
  let nextPollAtMs = 0;

  return {
    read: () => cached,
    note: () => note,
    async poll(now, signal) {
      const nowMs = now.getTime();
      if (nowMs < nextPollAtMs) return;

      const cookie = readCookie(cookiePath, env);
      if (!cookie) {
        cached = null;
        note = null;
        return;
      }
      // A paste missing the auth cookie is a different fix from an expired
      // session, so it must not be reported as one.
      if (!filterCookieHeader(cookie)) {
        cached = null;
        note = "no auth cookie found - re-copy the opencode.ai cookie header";
        nextPollAtMs = nowMs + MIN_POLL_MS;
        return;
      }

      nextPollAtMs = nowMs + MIN_POLL_MS;
      try {
        cached = await fetchGoServerLimits(cookie, now, { workspaceId, signal });
        note = null;
      } catch (error) {
        if (!(error instanceof OpencodeServerError)) throw error;
        nextPollAtMs = nowMs + BACKOFF_MS;
        if (error.kind === "credentials") {
          cached = null;
          workspaceId = undefined;
          note = "opencode session expired - paste a fresh cookie";
          return;
        }
        if (error.kind === "parse") {
          // A redeploy rotates the server function ids; the estimate carries on.
          workspaceId = undefined;
          note = "opencode dashboard changed - showing local estimate";
          return;
        }
        note = cached ? null : "opencode unreachable - showing local estimate";
      }
    },
  };
}
