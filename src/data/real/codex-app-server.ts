import { isRecord } from "./json";

/**
 * Codex CLI exposes its own account state over a stdio JSON-RPC server, so
 * limits come from the tool that owns the credentials - no token is read,
 * refreshed or transmitted by this app. Shapes below are taken from
 * `codex app-server generate-json-schema`, not from third-party docs.
 */
export interface CodexWindow {
  usedPercent: number;
  resetsAtMs: number | null;
  windowMinutes: number | null;
}

export interface CodexUsageSummary {
  lifetimeTokens: number;
  peakDailyTokens: number;
  longestStreakDays: number;
}

export interface CodexUsageHistory {
  /** Server-side totals keyed by "YYYY-MM-DD"; sparse - idle days are absent. */
  dailyTokens: Map<string, number>;
  summary: CodexUsageSummary | null;
}

export interface CodexAccountLimits {
  session: CodexWindow | null;
  weekly: CodexWindow | null;
  planType: string | null;
  /** Free "reset my limits" grants the account currently holds. */
  resetCredits: number;
  usage: CodexUsageHistory | null;
  fetchedAtMs: number;
}

export type CodexProbeFailure =
  | "not-installed"
  | "not-logged-in"
  | "timeout"
  | "protocol";

export class CodexProbeError extends Error {
  constructor(
    readonly kind: CodexProbeFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexProbeError";
  }
}

/** Anything at or under six hours is a session window; longer is the weekly one. */
const SESSION_MAX_MINUTES = 360;

function windowFrom(value: unknown): CodexWindow | null {
  if (!isRecord(value)) return null;
  const used = value.usedPercent;
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  const resets = value.resetsAt;
  const minutes = value.windowDurationMins;
  const resetsAtMs =
    typeof resets === "number" && Number.isFinite(resets) ? resets * 1000 : null;
  const windowMinutes =
    typeof minutes === "number" && Number.isFinite(minutes) ? minutes : null;
  return {
    usedPercent: Math.min(100, Math.max(0, used)),
    // resetsAt is unix seconds.
    resetsAtMs,
    windowMinutes,
  };
}

function isSessionWindow(
  window: CodexWindow,
  index: number,
  secondary: CodexWindow | null,
): boolean {
  if (window.windowMinutes !== null) return window.windowMinutes <= SESSION_MAX_MINUTES;
  return index === 0 && secondary !== null;
}

/**
 * Windows are classified by their own reported duration rather than by
 * position: a Plus account can report a single weekly window as `primary`,
 * which a positional mapping would mislabel as the session window.
 */
export function parseRateLimits(result: unknown, fetchedAtMs: number): CodexAccountLimits | null {
  if (!isRecord(result)) return null;
  const snapshot = result.rateLimits;
  if (!isRecord(snapshot)) return null;

  const primary = windowFrom(snapshot.primary);
  const secondary = windowFrom(snapshot.secondary);

  let session: CodexWindow | null = null;
  let weekly: CodexWindow | null = null;
  for (const [index, window] of [primary, secondary].entries()) {
    if (!window) continue;
    if (isSessionWindow(window, index, secondary)) session ??= window;
    else weekly ??= window;
  }

  const plan = snapshot.planType;
  const credits = isRecord(result.rateLimitResetCredits)
    ? result.rateLimitResetCredits.availableCount
    : null;

  return {
    session,
    weekly,
    planType: typeof plan === "string" ? plan : null,
    resetCredits: typeof credits === "number" && Number.isFinite(credits) ? credits : 0,
    usage: null,
    fetchedAtMs,
  };
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Server-side token history; far more complete than any local transcript. */
export function parseUsageHistory(result: unknown): CodexUsageHistory | null {
  if (!isRecord(result)) return null;
  const buckets = result.dailyUsageBuckets;
  const dailyTokens = new Map<string, number>();
  if (Array.isArray(buckets)) {
    for (const bucket of buckets) {
      if (!isRecord(bucket)) continue;
      const { startDate } = bucket;
      const tokens = positiveNumber(bucket.tokens);
      if (typeof startDate !== "string" || tokens <= 0) continue;
      dailyTokens.set(startDate, (dailyTokens.get(startDate) ?? 0) + tokens);
    }
  }

  const raw = result.summary;
  let summary: CodexUsageSummary | null = null;
  if (isRecord(raw)) {
    summary = {
      lifetimeTokens: positiveNumber(raw.lifetimeTokens),
      peakDailyTokens: positiveNumber(raw.peakDailyTokens),
      longestStreakDays: positiveNumber(raw.longestStreakDays),
    };
  }

  if (dailyTokens.size === 0 && summary === null) return null;
  return { dailyTokens, summary };
}

export function parseAccountPlan(result: unknown): string | null {
  if (!isRecord(result)) return null;
  const account = result.account;
  if (!isRecord(account)) return null;
  const plan = account.planType;
  return typeof plan === "string" ? plan : null;
}

interface RpcOutcome {
  results: Map<number, unknown>;
  errors: Map<number, unknown>;
}

interface RpcRequest {
  id: number;
  method: string;
}

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Runs one short-lived, sandboxed app-server and collects the replies to the
 * given requests. The child is always killed, including on the timeout path.
 */
function spawnAppServer() {
  // Sandboxed read-only and untrusted: this only ever reads account state.
  return Bun.spawn(["codex", "-s", "read-only", "-a", "untrusted", "app-server"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
}

function writeRpcMessage(
  stdin: ReturnType<typeof spawnAppServer>["stdin"],
  id: number,
  method: string,
  params: Record<string, unknown>,
): void {
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function collectRpcLine(
  line: string,
  wanted: Set<number>,
  results: Map<number, unknown>,
  errors: Map<number, unknown>,
): void {
  if (!line) return;

  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    // Banner or log noise on stdout is not fatal.
    return;
  }
  if (!isRecord(message) || typeof message.id !== "number") return;

  if (message.error !== undefined) errors.set(message.id, message.error);
  else results.set(message.id, message.result);
  wanted.delete(message.id);
}

async function runRequests(
  requests: RpcRequest[],
  timeoutMs: number,
): Promise<RpcOutcome> {
  let proc: ReturnType<typeof spawnAppServer>;
  try {
    proc = spawnAppServer();
  } catch (error) {
    throw new CodexProbeError("not-installed", "codex cli not found", { cause: error });
  }

  const results = new Map<number, unknown>();
  const errors = new Map<number, unknown>();
  const wanted = new Set(requests.map((request) => request.id));

  try {
    writeRpcMessage(proc.stdin, 0, "initialize", {
      clientInfo: { name: "limitless", title: "Limitless", version: "0" },
    });
    for (const { id, method } of requests) {
      writeRpcMessage(proc.stdin, id, method, {});
    }
    await proc.stdin.flush();

    const timeoutAtMs = Date.now() + timeoutMs;
    const decoder = new TextDecoder();
    let pendingText = "";

    for await (const chunk of proc.stdout) {
      pendingText += decoder.decode(chunk as Uint8Array);
      let newlineIndex = pendingText.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = pendingText.slice(0, newlineIndex).trim();
        pendingText = pendingText.slice(newlineIndex + 1);
        collectRpcLine(line, wanted, results, errors);
        newlineIndex = pendingText.indexOf("\n");
      }
      if (wanted.size === 0) break;
      if (Date.now() > timeoutAtMs) {
        throw new CodexProbeError("timeout", "codex app-server did not answer in time");
      }
    }
  } finally {
    proc.kill();
  }

  if (wanted.size > 0 && results.size === 0 && errors.size === 0) {
    throw new CodexProbeError("protocol", "codex app-server returned no usable reply");
  }
  return { results, errors };
}

const RATE_LIMITS_ID = 1;
const ACCOUNT_ID = 2;
const USAGE_ID = 3;

function isLoggedOut(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  return message.includes("login") || message.includes("auth") || message.includes("account");
}

/** Reads plan limits from the local Codex CLI. Throws `CodexProbeError`. */
export async function readCodexLimits(
  now: Date,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<CodexAccountLimits> {
  const { results, errors } = await runRequests(
    [
      { id: RATE_LIMITS_ID, method: "account/rateLimits/read" },
      { id: ACCOUNT_ID, method: "account/read" },
      { id: USAGE_ID, method: "account/usage/read" },
    ],
    timeoutMs,
  );

  const failure = errors.get(RATE_LIMITS_ID);
  if (failure !== undefined) {
    throw new CodexProbeError(
      isLoggedOut(failure) ? "not-logged-in" : "protocol",
      "codex refused the rate limit request",
    );
  }

  const limits = parseRateLimits(results.get(RATE_LIMITS_ID), now.getTime());
  if (!limits) throw new CodexProbeError("protocol", "no rate limits in codex reply");

  return {
    ...limits,
    planType: limits.planType ?? parseAccountPlan(results.get(ACCOUNT_ID)),
    // Usage history is a bonus: limits stay usable if this call is unsupported.
    usage: errors.has(USAGE_ID) ? null : parseUsageHistory(results.get(USAGE_ID)),
  };
}
