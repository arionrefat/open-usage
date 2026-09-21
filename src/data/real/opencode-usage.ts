import { finiteNumber, isRecord, timestampMs } from "./json";

/**
 * Parsers for the opencode console's usage payloads: the per-day cost chart
 * (`/usage/cost-by-day`) and the per-request table (`/usage/rows`).
 *
 * The console reports money in micro-cents and counts as decimal strings, both
 * of which are converted here so nothing downstream has to know the wire units.
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
  /** The server's own row id, which is what lets a re-read of the table merge with the rows already held. */
  id: string | null;
  /** Always null on the console API, which reports requests rather than sessions. */
  sessionId: string | null;
  keyId: string | null;
  atMs: number | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  usd: number;
  plan: GoPlan;
  isByok: boolean;
}

/** One page of the per-request table, with the cursor that continues it. */
export interface GoUsagePage {
  rows: GoUsageRow[];
  nextCursor: string | null;
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
 * Requests billed against money are spend; everything else draws on an
 * allowance already paid for. `free` and `byok` cost the workspace nothing, so
 * they belong on the allowance side rather than in a billed total.
 */
const BILLED_SOURCES = new Set(["managed-inference", "credit", "seat-credit"]);

export function planFromBillingSource(value: unknown): GoPlan {
  if (typeof value !== "string") return "lite";
  return BILLED_SOURCES.has(value) ? "payg" : "lite";
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

function usageRowFromRecord(value: unknown): GoUsageRow | null {
  if (!isRecord(value)) return null;
  const { model } = value;
  const inputTokens = numericField(value.inputTokens);
  const outputTokens = numericField(value.outputTokens);
  if (typeof model !== "string" || model.length === 0) return null;
  if (inputTokens === null || outputTokens === null) return null;
  const id = value.id;
  return {
    id: typeof id === "string" ? id : typeof id === "number" ? String(id) : null,
    sessionId: null,
    keyId: typeof value.serviceApiKeyId === "string" ? value.serviceApiKeyId : null,
    atMs: timestampMs(value.createdAt),
    model,
    inputTokens,
    outputTokens,
    reasoningTokens: numericField(value.reasoningTokens) ?? 0,
    cacheReadTokens: numericField(value.cacheReadTokens) ?? 0,
    cacheWrite5mTokens: numericField(value.cacheWrite5mTokens) ?? 0,
    cacheWrite1hTokens: numericField(value.cacheWrite1hTokens) ?? 0,
    usd: usdFromMicroCents(value.costMicroCents) ?? 0,
    plan: planFromBillingSource(value.billingSource),
    isByok: value.billingSource === "byok",
  };
}

/** Reads one page of the per-request usage table. */
export function parseUsagePage(value: unknown): GoUsagePage | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const rows = value.items.map(usageRowFromRecord);
  if (rows.some((row) => row === null)) return null;
  return {
    rows: rows as GoUsageRow[],
    nextCursor: typeof value.nextCursor === "string" ? value.nextCursor : null,
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
