import { readFileSync } from "node:fs";
import {
  OpencodeServerError,
  fetchGoServerLimits,
  filterCookieHeader,
  type GoServerLimits,
} from "./opencode-server";
import { isRecord } from "./json";
import type { PollOptions } from "../types";

/**
 * Server-truth go limits, polled out-of-band because the UI reads snapshots
 * synchronously. Without a cookie this stays dormant and the caller falls back
 * to the local spend estimate.
 */
export interface GoLimitsSource {
  read(): GoServerLimits | null;
  /** Why server limits are missing, or null when they are present. */
  note(): string | null;
  cookieExpiresAtMs(): number | null;
  poll(now: Date, options?: PollOptions): Promise<void>;
}

export const COOKIE_ENV_VAR = "LIMITLESS_OPENCODE_COOKIE";

const MIN_POLL_MS = 60_000;
const BACKOFF_MS = 5 * 60_000;
/** Past this, a cached reading stops being reported as server truth. */
const STALE_MS = 15 * 60_000;

export function readCookie(path: string, env: Record<string, string | undefined>): string | null {
  const fromEnv = env[COOKIE_ENV_VAR]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || typeof parsed.opencodeCookie !== "string") return null;
    const fromConfig = parsed.opencodeCookie.trim();
    return fromConfig.length > 0 ? fromConfig : null;
  } catch {
    return null;
  }
}

export function cookieExpiryMs(cookieHeader: string): number | null {
  const filtered = filterCookieHeader(cookieHeader);
  if (!filtered) return null;
  const firstCookie = filtered.split(";", 1)[0];
  const equals = firstCookie?.indexOf("=") ?? -1;
  if (equals < 1) return null;
  const expiryField = firstCookie?.slice(equals + 1).split("*")[5];
  if (!expiryField || !/^\d+$/.test(expiryField)) return null;
  const expiryMs = Number(expiryField);
  return Number.isFinite(expiryMs) && expiryMs > 0 ? expiryMs : null;
}

export const dormantGoLimitsSource: GoLimitsSource = {
  read: () => null,
  note: () => null,
  cookieExpiresAtMs: () => null,
  poll: () => Promise.resolve(),
};

/** Injectable so tests can drive the cache, backoff and staleness rules. */
type GoLimitsFetcher = typeof fetchGoServerLimits;

export function createGoLimitsSource(
  configPath: string,
  env: Record<string, string | undefined> = process.env,
  fetcher: GoLimitsFetcher = fetchGoServerLimits,
): GoLimitsSource {
  let cached: GoServerLimits | null = null;
  let workspaceId: string | undefined;
  let note: string | null = null;
  let nextPollAtMs = 0;

  function readFreshCache(): GoServerLimits | null {
    if (!cached) return null;
    const cacheAgeMs = Date.now() - cached.fetchedAtMs;
    return cacheAgeMs <= STALE_MS ? cached : null;
  }

  return {
    // An offline machine must fall back to the local estimate rather than keep
    // showing an old percentage as if it were current.
    read: readFreshCache,
    note: () => note,
    cookieExpiresAtMs: () => {
      const cookie = readCookie(configPath, env);
      return cookie ? cookieExpiryMs(cookie) : null;
    },
    async poll(now, options = {}) {
      const nowMs = now.getTime();
      const pollIsThrottled = nowMs < nextPollAtMs;
      if (!options.force && pollIsThrottled) return;

      const cookie = readCookie(configPath, env);
      if (!cookie) {
        cached = null;
        note = null;
        return;
      }
      // A paste missing the auth cookie is a different fix from an expired
      // session, so it must not be reported as one.
      const cookieHasAuth = filterCookieHeader(cookie) !== null;
      if (!cookieHasAuth) {
        cached = null;
        note = "no auth cookie found - re-copy the opencode.ai cookie header";
        nextPollAtMs = nowMs + MIN_POLL_MS;
        return;
      }

      nextPollAtMs = nowMs + MIN_POLL_MS;
      try {
        cached = await fetcher(cookie, now, { workspaceId, signal: options.signal });
        note = null;
      } catch (error) {
        // A caller-cancelled refresh is not a provider failure, so it must not
        // trigger the backoff or claim opencode is unreachable.
        if (options.signal?.aborted) throw error;
        nextPollAtMs = nowMs + BACKOFF_MS;
        cached = null;
        if (!(error instanceof OpencodeServerError)) {
          note = "opencode unreachable - showing local estimate";
          return;
        }
        if (error.kind === "credentials") {
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
        note = "opencode unreachable - showing local estimate";
      }
    },
  };
}
