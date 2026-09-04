import { isRecord } from "./json";
import {
  OpencodeRateLimitError,
  OpencodeServerError,
  isInsufficientBalance,
  retryAfterMs,
  type GoServerLimits,
} from "./opencode-server";

const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const DEFAULT_TIMEOUT_MS = 8_000;

const PERCENT_KEYS = [
  "usagePercent",
  "usedPercent",
  "percentUsed",
  "percent",
  "usage_percent",
  "used_percent",
];
const RESET_IN_KEYS = [
  "resetInSec",
  "resetInSeconds",
  "resetSeconds",
  "reset_sec",
  "reset_in_sec",
  "resetsInSec",
  "resetsInSeconds",
];
const RESET_AT_KEYS = [
  "resetAt",
  "resetsAt",
  "reset_at",
  "resets_at",
  "nextReset",
  "next_reset",
  "renewAt",
  "renew_at",
];
const ROLLING_KEYS = [
  "rolling5h",
  "rolling5H",
  "rollingUsage",
  "rolling_usage",
  "rollingWindow",
  "rolling_window",
  "rolling",
];
const WEEKLY_KEYS = ["weeklyUsage", "weekly", "weekly_usage", "weeklyWindow", "weekly_window"];
const MONTHLY_KEYS = ["monthlyUsage", "monthly", "monthly_usage", "monthlyWindow", "monthly_window"];
/** Any unit: good enough to divide into a percentage, not to print with a `$`. */
const USED_KEYS = ["used", "usage", "usageDollars", "usageUsd", "usedDollars", "consumed", "count", "usedTokens"];
const LIMIT_KEYS = ["limit", "limitDollars", "limitUsd", "total", "quota", "max", "cap", "tokenLimit"];
/** Only names that state their unit, because these are rendered as dollars. */
const USD_USED_KEYS = ["usageDollars", "usageUsd", "usedDollars", "usedUsd", "costUsd"];
const USD_LIMIT_KEYS = ["limitDollars", "limitUsd", "capDollars", "capUsd"];

interface ApiWindow {
  percent: number;
  resetAtMs: number | null;
  usedUsd: number | null;
  limitUsd: number | null;
}

function firstFinite(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function pairFrom(
  record: Record<string, unknown>,
  usedKeys: string[],
  limitKeys: string[],
): { used: number; limit: number } | null {
  const used = firstFinite(record, usedKeys);
  const limit = firstFinite(record, limitKeys);
  return used !== null && limit !== null && limit > 0 ? { used, limit } : null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * A percent field is read on a 0-100 scale. Rescaling small values as fractions
 * would turn a genuine 1% into a maxed-out bar, which is the worse failure.
 */
function percentFrom(record: Record<string, unknown>): number | null {
  const direct = firstFinite(record, PERCENT_KEYS);
  if (direct !== null) return clampPercent(direct);
  const ratio = pairFrom(record, USED_KEYS, LIMIT_KEYS);
  return ratio ? clampPercent((ratio.used / ratio.limit) * 100) : null;
}

function epochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) return null;
    return value >= 1e12 ? value : value * 1000;
  }
  if (typeof value !== "string") return null;
  const numeric = Number(value.trim());
  if (Number.isFinite(numeric)) return epochMs(numeric);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The percentage is the number the card lives on; the reset is decoration. */
function resetAtMsFrom(record: Record<string, unknown>, nowMs: number): number | null {
  const resetInSec = firstFinite(record, RESET_IN_KEYS);
  if (resetInSec !== null) return nowMs + Math.max(0, resetInSec) * 1000;
  for (const key of RESET_AT_KEYS) {
    const resetAtMs = epochMs(record[key]);
    if (resetAtMs !== null) return resetAtMs;
  }
  return null;
}

function windowFrom(value: unknown, nowMs: number): ApiWindow | null {
  if (!isRecord(value)) return null;
  const percent = percentFrom(value);
  if (percent === null) return null;
  const dollars = pairFrom(value, USD_USED_KEYS, USD_LIMIT_KEYS);
  return {
    percent,
    resetAtMs: resetAtMsFrom(value, nowMs),
    usedUsd: dollars?.used ?? null,
    limitUsd: dollars?.limit ?? null,
  };
}

function firstRecord(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  for (const key of keys) {
    if (isRecord(record[key])) return record[key];
  }
  return null;
}

function limitsFromRecord(record: Record<string, unknown>, nowMs: number): GoServerLimits | null {
  if (isRecord(record.usage)) {
    const nested = limitsFromRecord(record.usage, nowMs);
    if (nested) return nested;
  }
  const rolling = windowFrom(firstRecord(record, ROLLING_KEYS), nowMs);
  if (!rolling) return null;
  const weekly = windowFrom(firstRecord(record, WEEKLY_KEYS), nowMs);
  const monthly = windowFrom(firstRecord(record, MONTHLY_KEYS), nowMs);
  return {
    rollingPercent: rolling.percent,
    rollingResetAtMs: rolling.resetAtMs,
    weeklyPercent: weekly?.percent ?? null,
    weeklyResetAtMs: weekly?.resetAtMs ?? null,
    monthlyPercent: monthly?.percent ?? null,
    monthlyResetAtMs: monthly?.resetAtMs ?? null,
    rollingUsd: rolling.usedUsd,
    rollingCapUsd: rolling.limitUsd,
    weeklyUsd: weekly?.usedUsd ?? null,
    weeklyCapUsd: weekly?.limitUsd ?? null,
    monthlyUsd: monthly?.usedUsd ?? null,
    monthlyCapUsd: monthly?.limitUsd ?? null,
    fetchedAtMs: nowMs,
    useBalance: null,
    source: "api",
  };
}

/** Parses the supported OpenCode Go API response, including its nested `usage` envelope. */
export function parseGoApiLimits(value: unknown, now: Date): GoServerLimits | null {
  if (!isRecord(value)) return null;
  const nowMs = now.getTime();
  const direct = limitsFromRecord(value, nowMs);
  if (direct) return direct;
  for (const key of ["data", "result", "payload"]) {
    if (!isRecord(value[key])) continue;
    const nested = limitsFromRecord(value[key], nowMs);
    if (nested) return nested;
  }
  return null;
}

/** Exact OpenCode Go limits through the API-key-authenticated public endpoint. */
export async function fetchGoApiLimits(
  apiKey: string,
  now: Date,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<GoServerLimits> {
  const token = apiKey.trim();
  if (!token) throw new OpencodeServerError("missing opencode API key", "credentials");

  const deadline = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let response: Response;
  try {
    response = await fetch(OPENCODE_GO_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "open-usage",
      },
      redirect: "error",
      signal,
    });
  } catch (error) {
    throw new OpencodeServerError("request failed", "network", { cause: error });
  }

  if (response.status === 401 || response.status === 403) {
    // A drained account is refused with the same status as a bad key, so the
    // body is what separates "top up" from "replace your key".
    const body = await response.text().catch(() => "");
    if (isInsufficientBalance(body)) {
      throw new OpencodeServerError("insufficient opencode balance", "insufficient-balance");
    }
    throw new OpencodeServerError("opencode API key rejected", "credentials");
  }
  if (response.status === 429) {
    throw new OpencodeRateLimitError(retryAfterMs(response.headers.get("Retry-After")));
  }
  if (!response.ok) throw new OpencodeServerError(`HTTP ${response.status}`, "network");

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new OpencodeServerError("invalid JSON response", "parse", { cause: error });
  }
  const limits = parseGoApiLimits(body, now);
  if (!limits) throw new OpencodeServerError("no usage in response", "parse");
  return limits;
}
