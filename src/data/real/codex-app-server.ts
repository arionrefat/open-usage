import { APP_NAME, APP_VERSION } from "../../config";
import { isRecord } from "./json";
import { createSubprocessGuard, subprocessEnvironment } from "./subprocess";

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

export interface CodexSpendControl {
  limit: number;
  used: number;
  usedPercent: number;
  resetsAtMs: number | null;
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
  /** Soonest deadline among those grants; they are use-it-or-lose-it. */
  resetCreditsExpireAtMs: number | null;
  /** A spend control can block the account well below its percentage cap. */
  isSpendControlReached: boolean;
  /** Backend classification for exhausted rate, workspace-credit, or usage limits. */
  rateLimitReachedType?: string | null;
  /** Effective monthly workspace credit limit, when the CLI publishes one. */
  spendControl?: CodexSpendControl | null;
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
  | "incompatible"
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

function durationSuffix(window: CodexWindow, fallback: "primary" | "secondary"): string {
  const minutes = window.windowMinutes;
  if (minutes === null) return fallback;
  if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function namedWindows(id: string, item: unknown): CodexAdditionalRateLimit[] {
  if (!isRecord(item)) return [];
  const nameValue = item.limitName ?? item.modelName ?? item.model ?? item.limitId ?? id;
  if (typeof nameValue !== "string" || nameValue.length === 0) return [];

  const direct = windowFrom(item);
  if (direct) return [{ name: nameValue, ...direct }];
  const windows = [
    ["primary", windowFrom(item.primary)],
    ["secondary", windowFrom(item.secondary)],
  ] as const;
  const present = windows.filter((entry): entry is readonly ["primary" | "secondary", CodexWindow] => entry[1] !== null);
  return present.map(([position, window]) => ({
    name: present.length > 1 ? `${nameValue} · ${durationSuffix(window, position)}` : nameValue,
    ...window,
  }));
}

/** Canonical multi-bucket interface on current CLIs: a map keyed by limit id. */
function rateLimitsByLimitIdFrom(value: unknown, mainLimitId: string | null): CodexAdditionalRateLimit[] {
  if (!isRecord(value)) return [];
  const limits: CodexAdditionalRateLimit[] = [];
  for (const [id, item] of Object.entries(value)) {
    // `codex` is the canonical main bucket. The fallback matters for sparse
    // payloads that omit the mirrored root limit id.
    if (id === mainLimitId || (mainLimitId === null && id === "codex")) continue;
    limits.push(...namedWindows(id, item));
  }
  return limits;
}

/** Legacy fallback: older CLIs carried extra limits as an array on the snapshot. */
function additionalRateLimitsFrom(value: unknown): CodexAdditionalRateLimit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => namedWindows("", item));
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

function flexibleNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function spendControlFrom(value: unknown): CodexSpendControl | null {
  if (!isRecord(value)) return null;
  const limit = flexibleNumber(value.limit);
  if (limit === null || limit <= 0) return null;
  const reportedUsed = flexibleNumber(value.used);
  const remaining = flexibleNumber(value.remainingPercent);
  // A cap with no consumption figure is not a measurement of zero, and a
  // "$0.00 of $50.00" lane would present the guess as one.
  if (reportedUsed === null && remaining === null) return null;
  const used = reportedUsed ?? limit * (100 - Math.min(100, Math.max(0, remaining ?? 0))) / 100;
  const usedPercent = Math.min(100, Math.max(0, (used / limit) * 100));
  const resetsAt = flexibleNumber(value.resetsAt);
  return {
    limit,
    used: Math.max(0, used),
    usedPercent,
    resetsAtMs: resetsAt !== null && resetsAt > 0 ? resetsAt * 1000 : null,
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
    resetCreditsExpireAtMs: resetCreditExpiryMs(result.rateLimitResetCredits),
    isSpendControlReached: snapshot.spendControlReached === true,
    rateLimitReachedType:
      typeof snapshot.rateLimitReachedType === "string" ? snapshot.rateLimitReachedType : null,
    spendControl: spendControlFrom(snapshot.individualLimit),
    additionalRateLimits,
    credits: accountCredits,
    usage: null,
    fetchedAtMs,
  };
}

/** Soonest expiry among the grants still available to spend. */
function resetCreditExpiryMs(value: unknown): number | null {
  if (!isRecord(value) || !Array.isArray(value.credits)) return null;
  let soonest: number | null = null;
  for (const credit of value.credits) {
    if (!isRecord(credit) || credit.status !== "available") continue;
    const expiresAt = credit.expiresAt;
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) continue;
    const expiresAtMs = expiresAt * 1000;
    if (soonest === null || expiresAtMs < soonest) soonest = expiresAtMs;
  }
  return soonest;
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

export interface RpcOutcome {
  results: Map<number, unknown>;
  errors: Map<number, unknown>;
}

export interface RpcRequest {
  id: number;
  method: string;
}

const REQUEST_TIMEOUT_MS = 15_000;

/** Runs one short-lived, sandboxed app-server child. Always killed. */
export interface RunRequestsOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Test seam; production discovers `codex` through PATH. */
  executable?: string;
  /** Test seam; production inherits the scrubbed process environment. */
  env?: Record<string, string | undefined>;
  killGraceMs?: number;
}

function spawnAppServer(options: RunRequestsOptions) {
  // Sandboxed read-only with approvals off: this only ever reads account state.
  return Bun.spawn([options.executable ?? "codex", "-s", "read-only", "-a", "never", "app-server"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: subprocessEnvironment(options.env),
  });
}

const MAX_DIAGNOSTIC_CHARS = 160;

/**
 * Drained concurrently so a chatty child never stalls on a full stderr pipe.
 * A CLI that refuses our arguments says so here and nowhere else.
 */
async function readDiagnostic(stderr: ReadableStream<Uint8Array>): Promise<string | null> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stderr) {
    if (text.length > MAX_DIAGNOSTIC_CHARS) continue;
    text += decoder.decode(chunk, { stream: true });
  }
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0);
  if (!line) return null;
  const cleaned = line.trim().replace(/^error:\s*/i, "");
  return cleaned.length > MAX_DIAGNOSTIC_CHARS
    ? `${cleaned.slice(0, MAX_DIAGNOSTIC_CHARS - 1)}…`
    : cleaned;
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

export async function runRequests(
  requests: RpcRequest[],
  options: RunRequestsOptions = {},
): Promise<RpcOutcome> {
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException("Refresh aborted", "AbortError");
  }
  let proc: ReturnType<typeof spawnAppServer>;
  try {
    proc = spawnAppServer(options);
  } catch (error) {
    throw new CodexProbeError("not-installed", "codex cli not found", { cause: error });
  }

  const diagnostic = readDiagnostic(proc.stderr).catch(() => null);
  const results = new Map<number, unknown>();
  const errors = new Map<number, unknown>();
  const wanted = new Set([0, ...requests.map((request) => request.id)]);
  const guard = createSubprocessGuard(proc, {
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    signal: options.signal,
    timeoutError: () => new CodexProbeError("timeout", "codex app-server did not answer in time"),
    killGraceMs: options.killGraceMs,
  });

  try {
    // The protocol handshake is initialize -> initialized -> requests; sending
    // requests before the notification works today but is not guaranteed to.
    writeRpcMessage(proc.stdin, 0, "initialize", {
      clientInfo: { name: APP_NAME, title: "Open Usage", version: APP_VERSION },
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
        pendingText += decoder.decode(chunk, { stream: true });
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
    await guard.waitFor(responses);
  } finally {
    guard.dispose();
  }

  if (wanted.size > 0 && results.size === 0 && errors.size === 0) {
    // The child is dead by now, so its stderr has closed and this cannot hang.
    const complaint = await diagnostic;
    if (complaint) throw new CodexProbeError("incompatible", complaint);
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
  options: RunRequestsOptions = {},
): Promise<CodexAccountLimits> {
  const { results, errors } = await runRequests(
    [
      { id: RATE_LIMITS_ID, method: "account/rateLimits/read" },
      { id: ACCOUNT_ID, method: "account/read" },
      { id: USAGE_ID, method: "account/usage/read" },
    ],
    options,
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
