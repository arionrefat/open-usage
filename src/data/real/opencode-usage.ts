import { finiteNumber, isRecord, timestampMs } from "./json";
import {
  booleanField,
  hasValue,
  isEmptyArrayAtKey,
  numberField,
  objectLiterals,
  stringField,
  timestampField,
} from "./seroval-text";

/**
 * Parsers for opencode's usage history: the per-day cost chart (`getCosts`) and
 * the per-session table (`usage.list`).
 *
 * Field names and scaling are taken from the dashboard's own consuming code, not
 * from a sampled payload. Both endpoints report money in hundred-millionths of a
 * dollar, which the client divides by 1e8 before display.
 */
export const COST_UNITS_PER_USD = 1e8;

export type GoPlan = "sub" | "lite" | "payg";

export interface GoCostRow {
  /** Calendar day in the timezone the request asked for, as YYYY-MM-DD. */
  date: string;
  model: string;
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

export interface GoUsageRow {
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

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function usdFromUnits(units: number): number {
  return units / COST_UNITS_PER_USD;
}

function planFrom(value: unknown): GoPlan {
  return value === "sub" || value === "lite" ? value : "payg";
}

function costRowFromRecord(value: unknown): GoCostRow | null {
  if (!isRecord(value)) return null;
  const { date, model } = value;
  const units = finiteNumber(value.totalCost);
  if (typeof date !== "string" || !DATE_PATTERN.test(date)) return null;
  if (typeof model !== "string" || model.length === 0 || units === null) return null;
  return {
    date,
    model,
    usd: usdFromUnits(units),
    keyId: typeof value.keyId === "string" ? value.keyId : null,
    plan: planFrom(value.plan),
  };
}

function costRowFromBlock(block: string): GoCostRow | null {
  const date = stringField(block, "date");
  const model = stringField(block, "model");
  const units = numberField(block, "totalCost");
  if (date === null || !DATE_PATTERN.test(date) || model === null || units === null) return null;
  return {
    date,
    model,
    usd: usdFromUnits(units),
    keyId: stringField(block, "keyId"),
    plan: planFrom(stringField(block, "plan")),
  };
}

function apiKeyFromRecord(value: unknown): GoApiKey | null {
  if (!isRecord(value)) return null;
  const { id, displayName } = value;
  if (typeof id !== "string" || id.length === 0) return null;
  return {
    id,
    displayName: typeof displayName === "string" ? displayName : id,
    isDeleted: value.deleted === true,
  };
}

function costReportFromJson(text: string): GoCostReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.usage)) return null;
  const rows = parsed.usage.map(costRowFromRecord).filter((row): row is GoCostRow => row !== null);
  const keys = Array.isArray(parsed.keys)
    ? parsed.keys.map(apiKeyFromRecord).filter((key): key is GoApiKey => key !== null)
    : [];
  return { rows, keys };
}

function costReportFromSerializedText(text: string): GoCostReport | null {
  const rows = objectLiterals(text, ["date", "model", "totalCost"])
    .map(costRowFromBlock)
    .filter((row): row is GoCostRow => row !== null);
  // A month with no traffic still answers, as `usage:[]`, and is not a failure.
  if (rows.length === 0 && !isEmptyArrayAtKey(text, "usage")) return null;
  const keys = objectLiterals(text, ["id", "displayName"])
    .map((block) => {
      const id = stringField(block, "id");
      if (id === null) return null;
      return {
        id,
        displayName: stringField(block, "displayName") ?? id,
        isDeleted: booleanField(block, "deleted"),
      };
    })
    .filter((key): key is GoApiKey => key !== null);
  return { rows, keys };
}

/**
 * Reads the per-day cost chart response in either the JSON or the
 * serialized-JavaScript form the RPC may return.
 */
export function parseCostReport(text: string): GoCostReport | null {
  return costReportFromJson(text) ?? costReportFromSerializedText(text);
}

function usageRowFromRecord(value: unknown): GoUsageRow | null {
  if (!isRecord(value)) return null;
  const { model } = value;
  const inputTokens = finiteNumber(value.inputTokens);
  const outputTokens = finiteNumber(value.outputTokens);
  if (typeof model !== "string" || model.length === 0) return null;
  if (inputTokens === null || outputTokens === null) return null;
  const enrichment = isRecord(value.enrichment) ? value.enrichment : {};
  const keyId = value.keyID ?? value.keyId;
  return {
    sessionId: typeof value.sessionID === "string" ? value.sessionID : null,
    keyId: typeof keyId === "string" ? keyId : null,
    atMs: timestampMs(value.timeCreated),
    model,
    inputTokens,
    outputTokens,
    reasoningTokens: finiteNumber(value.reasoningTokens) ?? 0,
    cacheReadTokens: finiteNumber(value.cacheReadTokens) ?? 0,
    cacheWrite5mTokens: finiteNumber(value.cacheWrite5mTokens) ?? 0,
    cacheWrite1hTokens: finiteNumber(value.cacheWrite1hTokens) ?? 0,
    usd: usdFromUnits(finiteNumber(value.cost) ?? 0),
    plan: planFrom(enrichment.plan),
    isByok: value.byok === true,
  };
}

function usageRowFromBlock(block: string): GoUsageRow | null {
  const model = stringField(block, "model");
  const inputTokens = numberField(block, "inputTokens");
  const outputTokens = numberField(block, "outputTokens");
  if (model === null || inputTokens === null || outputTokens === null) return null;
  return {
    sessionId: stringField(block, "sessionID"),
    keyId: stringField(block, "keyID") ?? stringField(block, "keyId"),
    atMs: timestampField(block, "timeCreated"),
    model,
    inputTokens,
    outputTokens,
    reasoningTokens: numberField(block, "reasoningTokens") ?? 0,
    cacheReadTokens: numberField(block, "cacheReadTokens") ?? 0,
    cacheWrite5mTokens: numberField(block, "cacheWrite5mTokens") ?? 0,
    cacheWrite1hTokens: numberField(block, "cacheWrite1hTokens") ?? 0,
    usd: usdFromUnits(numberField(block, "cost") ?? 0),
    plan: planFrom(stringField(block, "plan")),
    isByok: booleanField(block, "byok"),
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
 * Billing mixes two scales, which the dashboard's own renderers settle:
 * `balance` and `monthlyUsage` are hundred-millionths and get divided by 1e8,
 * while `monthlyLimit` and `reloadAmount` are plain dollars printed as-is.
 */
function billingFromFields(
  read: (key: string) => number | null,
  has: (key: string) => boolean,
): GoBilling {
  return {
    balanceUsd: usdFromUnits(read("balance") ?? 0),
    monthlyUsageUsd: has("monthlyUsage") ? usdFromUnits(read("monthlyUsage") ?? 0) : null,
    monthlyLimitUsd: has("monthlyLimit") ? read("monthlyLimit") : null,
    isAutoReloadOn: has("reload"),
    reloadAmountUsd: read("reloadAmount"),
    hasLiteSubscription: has("lite") || has("liteSubscriptionID"),
    hasSubscription: has("subscription") || has("subscriptionID"),
  };
}

/**
 * Reads the billing record. Absent and null are treated alike: both mean the
 * account does not bill that way, which is the point of the distinction.
 */
export function parseBilling(text: string): GoBilling | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (isRecord(parsed) && "balance" in parsed) {
    const record = parsed;
    return billingFromFields(
      (key) => finiteNumber(record[key]),
      (key) => record[key] !== undefined && record[key] !== null && record[key] !== false,
    );
  }

  const block = objectLiterals(text, ["balance"])[0];
  if (block === undefined) return null;
  return billingFromFields(
    (key) => numberField(block, key),
    (key) => hasValue(block, key),
  );
}

/** Reads one page of the per-session usage table, in either wire form. */
export function parseUsageRows(text: string): GoUsageRow[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (Array.isArray(parsed)) {
    return parsed.map(usageRowFromRecord).filter((row): row is GoUsageRow => row !== null);
  }
  const rows = objectLiterals(text, ["model", "inputTokens", "outputTokens"])
    .map(usageRowFromBlock)
    .filter((row): row is GoUsageRow => row !== null);
  return rows.length > 0 ? rows : null;
}
