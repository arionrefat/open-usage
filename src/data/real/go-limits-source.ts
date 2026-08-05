import { readFileSync } from "node:fs";
import {
  OpencodeRateLimitError,
  OpencodeServerError,
  fetchGoServerLimits,
  filterCookieHeader,
  type GoServerLimits,
} from "./opencode-server";
import { isRecord } from "./json";
import { formatAge } from "./aggregate";
import { createPolledSource } from "./polled-source";
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

export interface GoLimitsSourceOptions {
  initial?: GoServerLimits | null;
  onUpdate?: (value: GoServerLimits) => void;
}

export const COOKIE_ENV_VAR = "OPEN_USAGE_OPENCODE_COOKIE";

const MIN_POLL_MS = 60_000;
/** opencode.ai is a third-party host, so `r` cannot repeat faster than this. */
const MIN_FORCED_POLL_MS = 5_000;
const BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
/** Past this, a cached reading is rendered with a stale notice. */
export const GO_LIMITS_STALE_MS = 15 * 60_000;

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

function describeGoFailure(error: unknown): string {
  if (!(error instanceof OpencodeServerError)) return "opencode unreachable - showing local estimate";
  if (error.kind === "credentials") return "opencode session expired - paste a fresh cookie";
  // A redeploy rotates the server function ids; the estimate carries on.
  if (error.kind === "parse") return "opencode dashboard changed - showing local estimate";
  if (error.kind === "rate-limited") return "opencode is rate limiting - backing off";
  return "opencode unreachable - showing local estimate";
}

export function createGoLimitsSource(
  configPath: string,
  env: Record<string, string | undefined> = process.env,
  fetcher: GoLimitsFetcher = fetchGoServerLimits,
  sourceOptions: GoLimitsSourceOptions = {},
): GoLimitsSource {
  let workspaceId: string | undefined;
  // Read once per attempt and reused by the fetch, so a cookie rewritten
  // mid-request cannot make the precheck and the request disagree.
  let cookieForAttempt: string | null = null;

  const source = createPolledSource<GoServerLimits>({
    precheck: () => {
      cookieForAttempt = readCookie(configPath, env);
      // No cookie at all is a configuration state, not a failure: leave the
      // schedule alone so pasting one takes effect on the next tick.
      if (!cookieForAttempt) return { note: null, isThrottled: false };
      // A paste missing the auth cookie is a different fix from an expired
      // session, so it must not be reported as one.
      if (filterCookieHeader(cookieForAttempt) === null) {
        return {
          note: "no auth cookie found - re-copy the opencode.ai cookie header",
          isThrottled: true,
        };
      }
      return null;
    },
    fetch: (now, signal) => fetcher(cookieForAttempt ?? "", now, { workspaceId, signal }),
    fetchedAtMs: (value) => value.fetchedAtMs,
    describeFailure: describeGoFailure,
    onFailure: (error) => {
      // Both an expired session and a redeploy invalidate the discovered id.
      // A 429 does not: dropping it would cost an extra request on every retry.
      if (!(error instanceof OpencodeServerError)) return;
      if (error.kind === "credentials" || error.kind === "parse") workspaceId = undefined;
    },
    retryDelayMs: (error) =>
      error instanceof OpencodeRateLimitError ? error.retryAfterMs : null,
    staleAfterMs: GO_LIMITS_STALE_MS,
    staleNote: (ageMs) =>
      `cached limits stale (${formatAge(ageMs)} old) - showing previous values`,
    minPollMs: MIN_POLL_MS,
    minForcedPollMs: MIN_FORCED_POLL_MS,
    backoffMs: BACKOFF_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
    initial: sourceOptions.initial ?? null,
    onUpdate: sourceOptions.onUpdate,
  });

  return {
    // Stale values stay available so the provider can render them with a notice.
    read: source.read,
    note: source.note,
    poll: source.poll,
    cookieExpiresAtMs: () => {
      const cookie = readCookie(configPath, env);
      return cookie ? cookieExpiryMs(cookie) : null;
    },
  };
}
