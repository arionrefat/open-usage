import { finiteNumber, isRecord, timestampMs } from "./json";

/**
 * Parsers for the console's cost chart, which sends micro-cents and decimal
 * strings, and its request log, which sends plain numbers and dollars.
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

export interface GoUsageRow {
  id: string;
  sessionId: string | null;
  atMs: number;
  model: string;
  /** Refused before inference ran, such as a 429 at a cap, so it carries no tokens. */
  isRejected: boolean;
  inputTokens: number;
  /** Net of reasoning: the log counts reasoning inside output, opencode.db beside it. */
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usd: number;
  plan: GoPlan;
}

export interface GoUsagePage {
  rows: GoUsageRow[];
  nextCursor: string | null;
  /** Fixed by the first page; every later page must repeat it. */
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
 * `standard` is Zen pay-as-you-go from credit. `go` and `go-plus` draw on a paid
 * subscription, and the console treats any other product as the workspace's own provider.
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

/** A succeeded request without counts is a renamed field, which must fail rather than read as zero usage. */
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
    // Reasoning never exceeded output across 506 live rows, so it is part of output.
    outputTokens: Math.max(0, (reportedOutput ?? 0) - reasoningTokens),
    reasoningTokens,
    cacheReadTokens: finiteNumber(value.cacheReadTokens) ?? 0,
    // Separate lines in the console; unverified, since no Go model has written cache yet.
    cacheWriteTokens:
      (finiteNumber(value.cacheWriteTokens) ?? 0) + (finiteNumber(value.cacheWrite1hTokens) ?? 0),
    usd: finiteNumber(value.cost) ?? 0,
    plan: planFromProduct(value.product),
  };
}

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
  isAutoReloadPending: boolean;
  autoReloadFailure: string | null;
  /** True when a Go (lite) subscription is attached. */
  hasLiteSubscription: boolean;
  hasSubscription: boolean;
}

/** Only `null` has been seen live, so an unprintable reason still counts as a failure. */
function failureFrom(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" ? value : "unknown reason";
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
    isAutoReloadPending: recharge?.pending === true,
    autoReloadFailure: failureFrom(recharge?.failureReason),
    hasLiteSubscription: options.hasGoAccess,
    // Seat subscriptions are not a Go concept; the Go access flag is the only
    // plan state the console reports for this workspace.
    hasSubscription: false,
  };
}
