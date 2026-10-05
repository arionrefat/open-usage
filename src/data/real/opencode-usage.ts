import { finiteNumber, isRecord, timestampMs } from "./json";

/**
 * Parsers for the opencode console's usage payloads: the per-day cost chart
 * (`/usage/cost-by-day`) and the request log (`/request-logs`).
 *
 * The chart reports money in micro-cents and counts as decimal strings, while
 * the request log uses plain numbers and dollars. Both are converted here so
 * nothing downstream has to know the wire units.
 */
export const COST_UNITS_PER_USD = 1e8;

export type GoPlan = "sub" | "lite" | "payg";

export interface GoCostRow {
  /** Calendar day as the console dates it, as YYYY-MM-DD. */
  date: string;
  /**
   * null when the figure is a day total the console did not break out by model.
   * Only the per-request table names models, and it reaches back 30 days.
   */
  model: string | null;
  usd: number;
  keyId: string | null;
  plan: GoPlan;
}

export interface GoApiKey {
  id: string;
  displayName: string;
  isDeleted: boolean;
}

export interface GoCostReport {
  rows: GoCostRow[];
  keys: GoApiKey[];
}

/** One day of the console's cost chart, before it is split into months. */
export interface GoCostDay {
  date: string;
  usd: number;
  tokens: number;
  requests: number;
}

/** One request from the console's request log. */
export interface GoUsageRow {
  /** The server's own request id, which is what lets a re-read of the log merge with the rows already held. */
  id: string;
  sessionId: string | null;
  atMs: number;
  model: string;
  /** Refused before inference ran - a 429 at the plan's cap - so it carries no tokens. */
  isRejected: boolean;
  inputTokens: number;
  /** Net of reasoning: the log counts reasoning inside its output, opencode.db beside it. */
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usd: number;
  plan: GoPlan;
}

/** One page of the request log, with what continues it. */
export interface GoUsagePage {
  rows: GoUsageRow[];
  nextCursor: string | null;
  /** The snapshot bound the first page fixed, which every later page must repeat. */
  untilMs: number | null;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Money and counts arrive as decimal strings, large ones included. */
export function numericField(value: unknown): number | null {
  const direct = finiteNumber(value);
  if (direct !== null) return direct;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function usdFromMicroCents(value: unknown): number | null {
  const units = numericField(value);
  return units === null ? null : units / COST_UNITS_PER_USD;
}

/**
 * The request log names the product a request was served under instead of
 * the money behind it. `standard` is Zen's pay-as-you-go, drawn from credit,
 * so it is spend. `go` and `go-plus` draw on a subscription already paid for,
 * and the console treats every other product as the workspace's own provider
 * connection, which opencode does not bill - all of that is allowance.
 */
export function planFromProduct(value: unknown): GoPlan {
  return value === "standard" ? "payg" : "lite";
}

function costDayFromRecord(value: unknown): GoCostDay | null {
  if (!isRecord(value)) return null;
  const { date } = value;
  const usd = usdFromMicroCents(value.totalCostMicroCents);
  if (typeof date !== "string" || !DATE_PATTERN.test(date) || usd === null) return null;
  return {
    date,
    usd,
    tokens: numericField(value.totalTokens) ?? 0,
    requests: numericField(value.totalRequests) ?? 0,
  };
}

/**
 * Reads the per-day cost chart. An array is the whole answer, so an empty one
 * is a workspace with no traffic in the window rather than a failure.
 */
export function parseCostDays(value: unknown): GoCostDay[] | null {
  if (!Array.isArray(value)) return null;
  const days = value.map(costDayFromRecord);
  return days.some((day) => day === null) ? null : (days as GoCostDay[]);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Only a request that ran carries counts, so a succeeded one missing them is
 * a renamed field rather than an empty request. Failing the page then is what
 * keeps a rename from reading as a month of zero usage.
 */
function usageRowFromRecord(value: unknown): GoUsageRow | null {
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  const atMs = timestampMs(value.startedAt);
  const model = nonEmptyString(value.model) ?? nonEmptyString(value.requestedModel);
  const { outcome } = value;
  if (id === null || atMs === null || model === null || typeof outcome !== "string") return null;

  const inputTokens = finiteNumber(value.inputTokens);
  const reportedOutput = finiteNumber(value.outputTokens);
  if (outcome === "succeeded" && (inputTokens === null || reportedOutput === null)) return null;
  const reasoningTokens = finiteNumber(value.reasoningTokens) ?? 0;
  return {
    id,
    sessionId: nonEmptyString(value.sessionID),
    atMs,
    model,
    isRejected: outcome === "rejected",
    inputTokens: inputTokens ?? 0,
    // Reasoning never exceeded output across a month of live rows, so it is a
    // part of output here, not a sibling; the clamp guards a request that ever
    // reports otherwise from going negative.
    outputTokens: Math.max(0, (reportedOutput ?? 0) - reasoningTokens),
    reasoningTokens,
    cacheReadTokens: finiteNumber(value.cacheReadTokens) ?? 0,
    // The console lists the two write lifetimes on separate lines, as the
    // older table's 5m and 1h fields were. No Go model has written cache yet,
    // so that they never overlap is the console's word rather than measured.
    cacheWriteTokens:
      (finiteNumber(value.cacheWriteTokens) ?? 0) + (finiteNumber(value.cacheWrite1hTokens) ?? 0),
    usd: finiteNumber(value.cost) ?? 0,
    plan: planFromProduct(value.product),
  };
}

/** Reads one page of the request log. */
export function parseUsagePage(value: unknown): GoUsagePage | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const rows: GoUsageRow[] = [];
  for (const item of value.items) {
    const row = usageRowFromRecord(item);
    if (row === null) return null;
    rows.push(row);
  }
  return {
    rows,
    nextCursor: nonEmptyString(value.nextCursor),
    untilMs: finiteNumber(value.until),
  };
}

/**
 * What a workspace is actually charged, as opposed to what it consumes. A Go
 * subscriber typically has a zero balance and no metered usage, which is what
 * makes their cost rows allowance rather than spend.
 */
export interface GoBilling {
  /** Pay-as-you-go credit on hand. */
  balanceUsd: number;
  /** Metered charges this month, when the account bills that way. */
  monthlyUsageUsd: number | null;
  monthlyLimitUsd: number | null;
  isAutoReloadOn: boolean;
  reloadAmountUsd: number | null;
  /** True when a Go (lite) subscription is attached. */
  hasLiteSubscription: boolean;
  hasSubscription: boolean;
}

/**
 * Reads the billing status, optionally enriched with the auto-recharge record.
 *
 * The console publishes a balance and a credit limit but no metered month total,
 * so `monthlyUsageUsd` stays null and the spend view falls back to the cost rows
 * rather than printing a figure the console never sent.
 */
export function parseBillingStatus(
  status: unknown,
  autoRecharge: unknown,
  options: { hasGoAccess: boolean },
): GoBilling | null {
  if (!isRecord(status)) return null;
  const balanceUsd = usdFromMicroCents(status.balanceMicroCents);
  if (balanceUsd === null) return null;
  const recharge = isRecord(autoRecharge) ? autoRecharge : null;
  return {
    balanceUsd,
    monthlyUsageUsd: null,
    monthlyLimitUsd: null,
    isAutoReloadOn: recharge?.enabled === true,
    reloadAmountUsd: recharge ? numericField(recharge.rechargeAmountDollars) : null,
    hasLiteSubscription: options.hasGoAccess,
    // Seat subscriptions are not a Go concept; the Go access flag is the only
    // plan state the console reports for this workspace.
    hasSubscription: false,
  };
}
