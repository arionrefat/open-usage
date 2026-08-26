import { readFileSync } from "node:fs";
import {
  OpencodeRateLimitError,
  OpencodeServerError,
  fetchGoServerLimits,
  filterCookieHeader,
  type GoServerLimits,
} from "./opencode-server";
import { fetchGoApiLimits } from "./opencode-api";
import { isRecord } from "./json";
import { formatAge } from "./aggregate";
import { createPolledSource } from "./polled-source";
import type { ConnectionStatus, PollOptions } from "../types";

/**
 * Server-truth go limits, polled out-of-band because the UI reads snapshots
 * synchronously. Without a cookie this stays dormant and the caller falls back
 * to the local spend estimate.
 */
export type GoCredentialKind = "api-key" | "cookie";

export interface GoLimitsSource {
  read(now?: Date): GoServerLimits | null;
  /** Why exact limits are missing, or null when they are present. */
  note(now?: Date): string | null;
  status?(): ConnectionStatus;
  credentialKind?(): GoCredentialKind | null;
  cookieExpiresAtMs(): number | null;
  poll(now: Date, options?: PollOptions): Promise<void>;
}

export interface GoLimitsSourceOptions {
  initial?: GoServerLimits | null;
  onUpdate?: (value: GoServerLimits) => void;
  apiFetcher?: typeof fetchGoApiLimits;
}

export const COOKIE_ENV_VAR = "OPEN_USAGE_OPENCODE_COOKIE";
// Namespaced like the cookie: opencode's own OPENCODE_API_KEY is exported on
// plenty of machines, and reading it would opt those users into a network call
// they never asked for.
export const API_KEY_ENV_VAR = "OPEN_USAGE_OPENCODE_API_KEY";

const MIN_POLL_MS = 60_000;
/** opencode.ai is a third-party host, so `r` cannot repeat faster than this. */
const MIN_FORCED_POLL_MS = 5_000;
const BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
/** Past this, a cached reading is rendered with a stale notice. */
const GO_LIMITS_STALE_MS = 15 * 60_000;

function configValue(path: string, key: "opencodeApiKey" | "opencodeCookie"): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || typeof parsed[key] !== "string") return null;
    const value = parsed[key].trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function readApiKey(path: string, env: Record<string, string | undefined>): string | null {
  const fromEnv = env[API_KEY_ENV_VAR]?.trim();
  return fromEnv || configValue(path, "opencodeApiKey");
}

export function readCookie(path: string, env: Record<string, string | undefined>): string | null {
  const fromEnv = env[COOKIE_ENV_VAR]?.trim();
  return fromEnv || configValue(path, "opencodeCookie");
}

interface GoCredential {
  kind: GoCredentialKind;
  value: string;
}

/**
 * The dashboard outranks the API key because `GET /zen/go/v1/usage` is still an
 * unmerged proposal that 404s in production. Flip this once the route ships, so
 * a configured key never silently costs a user the readings they already had.
 */
function readCredential(path: string, env: Record<string, string | undefined>): GoCredential | null {
  const cookie = readCookie(path, env);
  if (cookie) return { kind: "cookie", value: cookie };
  const apiKey = readApiKey(path, env);
  return apiKey ? { kind: "api-key", value: apiKey } : null;
}

/**
 * A reading only counts for the credential that fetched it. Entries cached
 * before source attribution existed are dashboard values.
 */
function matchesCredential(reading: GoServerLimits | null, kind: GoCredentialKind): boolean {
  if (!reading) return false;
  return kind === "api-key" ? reading.source === "api" : reading.source !== "api";
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
  status: () => "none",
  credentialKind: () => null,
  cookieExpiresAtMs: () => null,
  poll: () => Promise.resolve(),
};

/** Injectable so tests can drive the cache, backoff and staleness rules. */
type GoLimitsFetcher = typeof fetchGoServerLimits;

function describeGoFailure(error: unknown, kind: GoCredentialKind | null): string {
  if (!(error instanceof OpencodeServerError)) return "opencode unreachable";
  if (error.kind === "credentials") {
    return kind === "api-key"
      ? `opencode API key rejected - update ${API_KEY_ENV_VAR}`
      : "opencode session expired - paste a fresh cookie";
  }
  if (error.kind === "parse") {
    return kind === "api-key" ? "opencode usage API changed" : "opencode dashboard changed";
  }
  if (error.kind === "rate-limited") return "opencode is rate limiting - backing off";
  return "opencode unreachable";
}

export function createGoLimitsSource(
  configPath: string,
  env: Record<string, string | undefined> = process.env,
  fetcher: GoLimitsFetcher = fetchGoServerLimits,
  sourceOptions: GoLimitsSourceOptions = {},
): GoLimitsSource {
  let workspaceId: string | undefined;
  // Read once per attempt and reuse the same value through the request, so a
  // credential rewritten mid-poll cannot make the precheck and fetch disagree.
  let credentialForAttempt: GoCredential | null = null;
  let failureCredentialKind: GoCredentialKind | null = null;
  const apiFetcher = sourceOptions.apiFetcher ?? fetchGoApiLimits;

  const source = createPolledSource<GoServerLimits>({
    precheck: () => {
      credentialForAttempt = readCredential(configPath, env);
      failureCredentialKind = credentialForAttempt?.kind ?? null;
      // No remote credential is a normal local-only state. Leave the schedule
      // untouched so adding one takes effect on the next tick.
      if (!credentialForAttempt) return { note: null, isThrottled: false };
      // A pasted dashboard header missing its auth cookie has a specific fix.
      if (
        credentialForAttempt.kind === "cookie" &&
        filterCookieHeader(credentialForAttempt.value) === null
      ) {
        return {
          note: "no auth cookie found - re-copy the opencode.ai cookie header",
          isThrottled: true,
        };
      }
      return null;
    },
    fetch: async (now, signal) => {
      if (!credentialForAttempt) {
        throw new OpencodeServerError("missing opencode credential", "credentials");
      }
      if (credentialForAttempt.kind === "api-key") {
        workspaceId = undefined;
        return apiFetcher(credentialForAttempt.value, now, { signal });
      }
      const value = await fetcher(credentialForAttempt.value, now, { workspaceId, signal });
      workspaceId = value.workspaceId ?? workspaceId;
      return { ...value, source: value.source ?? "dashboard" };
    },
    fetchedAtMs: (value) => value.fetchedAtMs,
    describeFailure: (error) => describeGoFailure(error, failureCredentialKind),
    onFailure: (error) => {
      // Both an expired session and a dashboard redeploy invalidate the
      // discovered workspace id. A 429 does not.
      if (!(error instanceof OpencodeServerError) || failureCredentialKind !== "cookie") return;
      if (error.kind === "credentials" || error.kind === "parse") workspaceId = undefined;
    },
    retryDelayMs: (error) =>
      error instanceof OpencodeRateLimitError ? error.retryAfterMs : null,
    staleAfterMs: GO_LIMITS_STALE_MS,
    staleNote: (ageMs) => `cached limits stale (${formatAge(ageMs)} old)`,
    minPollMs: MIN_POLL_MS,
    minForcedPollMs: MIN_FORCED_POLL_MS,
    backoffMs: BACKOFF_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
    initial: sourceOptions.initial ?? null,
    onUpdate: sourceOptions.onUpdate,
  });

  return {
    read: (now) => {
      const credential = readCredential(configPath, env);
      if (!credential || source.isStale(now)) return null;
      if (credential.kind === "cookie" && filterCookieHeader(credential.value) === null) return null;
      const reading = source.read();
      return matchesCredential(reading, credential.kind) ? reading : null;
    },
    note: (now) => {
      // Removing remote credentials is an intentional return to local-only mode,
      // so an old request failure must not linger after the source is disabled.
      if (!readCredential(configPath, env)) return null;
      return source.note(now);
    },
    status: () => {
      const credential = readCredential(configPath, env);
      if (!credential) return "none";
      if (credential.kind === "cookie" && filterCookieHeader(credential.value) === null) return "expired";
      const status = source.status();
      // A reading the other credential fetched is not this one's evidence of
      // health, and `read` already refuses it. Saying "cached" over an estimate
      // the card is really showing would be a lie.
      const isClaimingData = status === "active" || status === "cached";
      if (isClaimingData && !matchesCredential(source.read(), credential.kind)) return "none";
      return status;
    },
    credentialKind: () => readCredential(configPath, env)?.kind ?? null,
    poll: source.poll,
    cookieExpiresAtMs: () => {
      // Only warn about the cookie that is actually authorizing the readings.
      const credential = readCredential(configPath, env);
      return credential?.kind === "cookie" ? cookieExpiryMs(credential.value) : null;
    },
  };
}
