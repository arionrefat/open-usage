import { version as LIMITLESS_VERSION } from "../../../package.json";
import { isRecord } from "./json";

/**
 * Rate limits via the sandboxed `codex app-server` stdio JSON-RPC server.
 * Shapes from `codex app-server generate-json-schema`.
 */
export interface CodexWindow {
  usedPercent: number;
  resetsAtMs: number | null;
  windowMinutes: number | null;
}

export interface CodexUsageSummary {
  lifetimeTokens: number;
  peakDailyTokens: number;
  longestRunningTurnSec: number;
  currentStreakDays: number;
  longestStreakDays: number;
}

export interface CodexAdditionalRateLimit extends CodexWindow {
  name: string;
}

export interface CodexCredits {
  balance: number | null;
  unlimited: boolean;
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
  additionalRateLimits: CodexAdditionalRateLimit[];
  credits: CodexCredits | null;
  usage: CodexUsageHistory | null;
  fetchedAtMs: number;
}

export type CodexProbeFailure =
  | "not-installed"
  | "not-logged-in"
  | "unsupported-auth"
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
    resetsAtMs,
    windowMinutes,
  };
}

function namedWindow(id: string, item: unknown): CodexAdditionalRateLimit | null {
  if (!isRecord(item)) return null;
  const nameValue = item.limitName ?? item.modelName ?? item.model ?? item.limitId ?? id;
  const window = windowFrom(item) ?? windowFrom(item.primary) ?? windowFrom(item.secondary);
  if (typeof nameValue !== "string" || nameValue.length === 0 || !window) return null;
  return { name: nameValue, ...window };
}

/** Canonical multi-bucket interface on current CLIs: a map keyed by limit id. */
function rateLimitsByLimitIdFrom(value: unknown, mainLimitId: string | null): CodexAdditionalRateLimit[] {
  if (!isRecord(value)) return [];
  const limits: CodexAdditionalRateLimit[] = [];
  for (const [id, item] of Object.entries(value)) {
    if (id === mainLimitId) continue;
    const limit = namedWindow(id, item);
    if (limit) limits.push(limit);
  }
  return limits;
}

/** Legacy fallback: older CLIs carried extra limits as an array on the snapshot. */
function additionalRateLimitsFrom(value: unknown): CodexAdditionalRateLimit[] {
  if (!Array.isArray(value)) return [];
  const limits: CodexAdditionalRateLimit[] = [];
  for (const item of value) {
    const limit = namedWindow("", item);
    if (limit) limits.push(limit);
  }
  return limits;
}

function creditsFrom(value: unknown): CodexCredits | null {
  if (!isRecord(value)) return null;
  const numericBalance =
    typeof value.balance === "number" ? value.balance : Number(value.balance);
  return {
    balance: Number.isFinite(numericBalance) ? numericBalance : null,
    unlimited: value.unlimited === true,
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

/** Windows classified by reported duration, not position: a Plus account reports one weekly window as primary. */
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
  const mainLimitId = typeof snapshot.limitId === "string" ? snapshot.limitId : null;
  const byLimitId = rateLimitsByLimitIdFrom(result.rateLimitsByLimitId, mainLimitId);
  const additionalRateLimits =
    byLimitId.length > 0 ? byLimitId : additionalRateLimitsFrom(snapshot.additionalRateLimits);
  const accountCredits = creditsFrom(snapshot.credits);
  const credits = isRecord(result.rateLimitResetCredits)
    ? result.rateLimitResetCredits.availableCount
    : null;

  return {
    session,
    weekly,
    planType: typeof plan === "string" ? plan : null,
    resetCredits: typeof credits === "number" && Number.isFinite(credits) ? credits : 0,
    additionalRateLimits,
    credits: accountCredits,
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
    const candidate: CodexUsageSummary = {
      lifetimeTokens: positiveNumber(raw.lifetimeTokens),
      peakDailyTokens: positiveNumber(raw.peakDailyTokens),
      longestRunningTurnSec: positiveNumber(raw.longestRunningTurnSec),
      currentStreakDays: positiveNumber(raw.currentStreakDays),
      longestStreakDays: positiveNumber(raw.longestStreakDays),
    };
    // An all-zero summary is a malformed reply, not a real account record.
    if (Object.values(candidate).some((value) => value > 0)) summary = candidate;
  }

  if (dailyTokens.size === 0 && summary === null) return null;
  return { dailyTokens, summary };
}

export interface CodexAccountInfo {
  planType: string | null;
  /** e.g. "chatgpt", "apiKey" - tells plan-limit failures from real sign-outs. */
  type: string | null;
}

export function parseAccount(result: unknown): CodexAccountInfo {
  if (!isRecord(result)) return { planType: null, type: null };
  const account = result.account;
  if (!isRecord(account)) return { planType: null, type: null };
  return {
    planType: typeof account.planType === "string" ? account.planType : null,
    type: typeof account.type === "string" ? account.type : null,
  };
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

/** Runs one short-lived, sandboxed app-server child. Always killed. */
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

function writeRpcNotification(
  stdin: ReturnType<typeof spawnAppServer>["stdin"],
  method: string,
): void {
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
}

/** Returns the replied-to id, or null for notifications and unparseable noise. */
function collectRpcLine(
  line: string,
  wanted: Set<number>,
  results: Map<number, unknown>,
  errors: Map<number, unknown>,
): number | null {
  if (!line) return null;

  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(message) || typeof message.id !== "number") return null;

  if (message.error !== undefined) errors.set(message.id, message.error);
  else results.set(message.id, message.result);
  wanted.delete(message.id);
  return message.id;
}

async function runRequests(
  requests: RpcRequest[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RpcOutcome> {
  let proc: ReturnType<typeof spawnAppServer>;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    proc = spawnAppServer();
  } catch (error) {
    throw new CodexProbeError("not-installed", "codex cli not found", { cause: error });
  }

  const results = new Map<number, unknown>();
  const errors = new Map<number, unknown>();
  const wanted = new Set([0, ...requests.map((request) => request.id)]);

  try {
    // The protocol handshake is initialize -> initialized -> requests; sending
    // requests before the notification works today but is not guaranteed to.
    writeRpcMessage(proc.stdin, 0, "initialize", {
      clientInfo: { name: "limitless", title: "Limitless", version: LIMITLESS_VERSION },
    });
    await proc.stdin.flush();

    const decoder = new TextDecoder();
    let pendingText = "";
    let requestsSent = false;
    const sendRequests = () => {
      if (requestsSent) return;
      requestsSent = true;
      writeRpcNotification(proc.stdin, "initialized");
      for (const { id, method } of requests) {
        writeRpcMessage(proc.stdin, id, method, {});
      }
      void proc.stdin.flush();
    };

    const responses = (async () => {
      for await (const chunk of proc.stdout) {
        // stream: true keeps multibyte characters split across chunks intact.
        pendingText += decoder.decode(chunk as Uint8Array, { stream: true });
        let newlineIndex = pendingText.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = pendingText.slice(0, newlineIndex).trim();
          pendingText = pendingText.slice(newlineIndex + 1);
          const repliedId = collectRpcLine(line, wanted, results, errors);
          if (repliedId === 0) sendRequests();
          newlineIndex = pendingText.indexOf("\n");
        }
        if (wanted.size === 0) return;
      }
    })();
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        proc.kill();
        reject(new CodexProbeError("timeout", "codex app-server did not answer in time"));
      }, timeoutMs);
    });
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => {
        proc.kill();
        reject(signal?.reason ?? new DOMException("Refresh aborted", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    await Promise.race([responses, deadline, cancelled]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abort) signal?.removeEventListener("abort", abort);
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
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CodexAccountLimits> {
  const { results, errors } = await runRequests(
    [
      { id: RATE_LIMITS_ID, method: "account/rateLimits/read" },
      { id: ACCOUNT_ID, method: "account/read" },
      { id: USAGE_ID, method: "account/usage/read" },
    ],
    options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    options.signal,
  );

  const account = parseAccount(results.get(ACCOUNT_ID));
  const failure = errors.get(RATE_LIMITS_ID);
  if (failure !== undefined) {
    // API-key/Bedrock accounts are signed in but have no ChatGPT plan limits.
    const signedInWithoutPlanLimits =
      account.type !== null && account.type !== "chatgpt" && isLoggedOut(failure);
    throw new CodexProbeError(
      signedInWithoutPlanLimits
        ? "unsupported-auth"
        : isLoggedOut(failure)
          ? "not-logged-in"
          : "protocol",
      "codex refused the rate limit request",
    );
  }

  const limits = parseRateLimits(results.get(RATE_LIMITS_ID), now.getTime());
  if (!limits) throw new CodexProbeError("protocol", "no rate limits in codex reply");

  return {
    ...limits,
    planType: limits.planType ?? account.planType,
    usage: errors.has(USAGE_ID) ? null : parseUsageHistory(results.get(USAGE_ID)),
  };
}
