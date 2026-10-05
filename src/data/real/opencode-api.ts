import { finiteNumber, isRecord, timestampMs } from "./json";
import {
  OpencodeRateLimitError,
  OpencodeServerError,
  isInsufficientBalance,
  retryAfterMs,
  type GoServerLimits,
} from "./opencode-server";

/** Merged in anomalyco/opencode#16513; answers percentages and resets, no dollars. */
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const DEFAULT_TIMEOUT_MS = 8_000;

interface ApiWindow {
  percent: number;
  resetAtMs: number | null;
}

/** The server floors `percent`, so `status` is what says a window is spent. */
function windowFrom(value: unknown): ApiWindow | null {
  if (!isRecord(value)) return null;
  const isCapped = value.status === "rate-limited";
  const percent = isCapped ? 100 : finiteNumber(value.percent);
  if (percent === null) return null;
  return { percent: Math.min(100, Math.max(0, percent)), resetAtMs: timestampMs(value.resetsAt) };
}

export function parseGoApiLimits(value: unknown, now: Date): GoServerLimits | null {
  if (!isRecord(value) || !isRecord(value.usage)) return null;
  const rolling = windowFrom(value.usage.rolling);
  if (!rolling) return null;
  const weekly = windowFrom(value.usage.weekly);
  const monthly = windowFrom(value.usage.monthly);
  return {
    rollingPercent: rolling.percent,
    rollingResetAtMs: rolling.resetAtMs,
    weeklyPercent: weekly?.percent ?? null,
    weeklyResetAtMs: weekly?.resetAtMs ?? null,
    monthlyPercent: monthly?.percent ?? null,
    monthlyResetAtMs: monthly?.resetAtMs ?? null,
    fetchedAtMs: now.getTime(),
    useBalance: null,
    source: "api",
  };
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
    // A valid key on a workspace with no Go plan: 403 `EntitlementError`.
    if (body.includes("EntitlementError")) {
      throw new OpencodeServerError("no opencode go subscription", "no-subscription");
    }
    throw new OpencodeServerError("opencode API key rejected", "credentials");
  }
  if (response.status === 429) {
    throw new OpencodeRateLimitError(retryAfterMs(response.headers.get("Retry-After")));
  }
  if (response.status === 400 || response.status === 404 || response.status === 422) {
    throw new OpencodeServerError(`HTTP ${response.status}`, "parse");
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
