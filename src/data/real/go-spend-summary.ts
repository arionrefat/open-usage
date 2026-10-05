import type { ModelSpend, Money, SpendKind, SpendPeriod, SpendSummary } from "../types";
import { COST_UNITS_PER_USD, type GoPlan, type GoUsageRow } from "./opencode-usage";
import type { GoCostSpan, GoUsageHistory } from "./opencode-server";

/**
 * Turns opencode's per-day cost rows into a spend summary.
 *
 * The one rule that matters here: rows on a subscription are allowance consumed,
 * not money charged, and the two are reported in separate fields. Adding them
 * would tell a Go subscriber they spent tens of dollars they were never billed.
 */

/** Server figures are hundred-millionths of a dollar, so nothing is rounded away. */
const COST_EXPONENT = Math.log10(COST_UNITS_PER_USD);

function usdToMoney(usd: number): Money {
  return {
    amountMinor: Math.round(usd * COST_UNITS_PER_USD),
    currency: "USD",
    exponent: COST_EXPONENT,
  };
}

/** Plain dollars, unlike the cost rows: billing mixes the two scales. */
function dollarsToMoney(dollars: number): Money {
  return { amountMinor: Math.round(dollars * 100), currency: "USD", exponent: 2 };
}

function kindOf(row: { plan: GoPlan }): SpendKind {
  return row.plan === "payg" ? "billed" : "allowance";
}

const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/** "2026-08" reads as "august 2026", matching the other providers' period labels. */
export function monthLabel(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  if (year === undefined || monthNumber === undefined) return month;
  const name = new Date(year, monthNumber - 1, 1).toLocaleDateString("en-US", { month: "long" });
  return `${name.toLowerCase()} ${year}`;
}

interface ModelTotal {
  usd: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/**
 * One row per model per kind. A model used both on plan and pay-as-you-go stays
 * on two rows, since collapsing them would hide which half was charged.
 *
 * Only the per-request table names models, so this is empty for a month the
 * console can answer for with day totals alone.
 */
function modelsFrom(rows: GoUsageRow[]): ModelSpend[] {
  const totals = new Map<SpendKind, Map<string, ModelTotal>>();
  for (const row of rows) {
    const kind = kindOf(row);
    const byModel = totals.get(kind) ?? new Map<string, ModelTotal>();
    const running = byModel.get(row.model) ?? { usd: 0, tokens: { ...NO_TOKENS } };
    running.usd += row.usd;
    running.tokens.input += row.inputTokens;
    running.tokens.output += row.outputTokens + row.reasoningTokens;
    running.tokens.cacheRead += row.cacheReadTokens;
    running.tokens.cacheWrite += row.cacheWriteTokens;
    byModel.set(row.model, running);
    totals.set(kind, byModel);
  }
  return [...totals]
    .flatMap(([kind, byModel]) =>
      [...byModel].map(([model, total]) => ({
        model,
        tokens: total.tokens,
        cost: usdToMoney(total.usd),
        exactness: "exact" as const,
        kind,
      })),
    )
    .sort((left, right) => (right.cost?.amountMinor ?? 0) - (left.cost?.amountMinor ?? 0));
}

/** The per-request rows that fall inside a month, which is what names its models. */
export function rowsInMonth(rows: GoUsageRow[], month: string): GoUsageRow[] {
  return rows.filter((row) => monthKeyOf(row.atMs) === month);
}

function monthKeyOf(atMs: number): string {
  const at = new Date(atMs);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}`;
}

/** How much of a month, up to today for the open one, some cost reply answered for. */
export type MonthCoverage =
  | { kind: "full" }
  | { kind: "from"; date: string }
  | { kind: "partial" }
  | { kind: "none" };

function lastDayOfMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year ?? 1970, monthNumber ?? 1, 0));
  return last.toISOString().slice(0, 10);
}

export function monthCoverage(month: string, spans: GoCostSpan[], today: string): MonthCoverage {
  const first = `${month}-01`;
  const monthEnd = lastDayOfMonth(month);
  const last = today >= first && today < monthEnd ? today : monthEnd;
  const touching = spans.filter((span) => span.until >= first && span.from <= last);
  if (touching.some((span) => span.from <= first && span.until >= last)) return { kind: "full" };
  const [only] = touching;
  if (touching.length === 1 && only && only.until >= last) return { kind: "from", date: only.from };
  return touching.length > 0 ? { kind: "partial" } : { kind: "none" };
}

function fromLabel(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `from ${day.toLowerCase()}`;
}

/**
 * Inside coverage an absent day was unspent; outside it nobody asked, so a
 * month with neither coverage nor banked days is unknown rather than free.
 */
export function periodFrom(
  history: GoUsageHistory,
  usageRows: GoUsageRow[] = [],
  coverage: MonthCoverage = { kind: "full" },
): SpendPeriod {
  const rows = history.costs.rows;
  const label = monthLabel(history.month);
  const limit =
    history.billing?.monthlyLimitUsd != null ? dollarsToMoney(history.billing.monthlyLimitUsd) : null;
  if (coverage.kind === "none" && rows.length === 0) {
    return {
      label,
      total: null,
      allowanceUsed: null,
      limit,
      exactness: "unavailable",
      models: modelsFrom(usageRows),
      isBeforeRecordsBegan: true,
    };
  }

  const sumWhere = (kind: SpendKind) =>
    rows.filter((row) => kindOf(row) === kind).reduce((sum, row) => sum + row.usd, 0);
  const billed = sumWhere("billed");
  const allowance = sumWhere("allowance");
  const hasAllowance = rows.some((row) => kindOf(row) === "allowance");
  const windowLabel =
    coverage.kind === "from" ? fromLabel(coverage.date) : coverage.kind === "full" ? null : "partial record";

  return {
    label,
    // Metered charges outrank the row sum: they are what the account was billed.
    total: usdToMoney(history.billing?.monthlyUsageUsd ?? billed),
    allowanceUsed: hasAllowance ? usdToMoney(allowance) : null,
    ...(windowLabel ? { totalWindowLabel: windowLabel } : {}),
    limit,
    exactness: "exact",
    models: modelsFrom(usageRows),
    isBeforeRecordsBegan: false,
  };
}

/** Newest month first. */
export function goSpendSummary(
  months: GoUsageHistory[],
  usageRows: GoUsageRow[] | null,
  coverage: GoCostSpan[],
  asOfMs: number,
): SpendSummary | null {
  const today = new Date(asOfMs).toISOString().slice(0, 10);
  const periods = months.map((month) =>
    periodFrom(
      month,
      usageRows ? rowsInMonth(usageRows, month.month) : [],
      monthCoverage(month.month, coverage, today),
    ),
  );
  const [current, ...history] = periods;
  if (!current) return null;
  return {
    current,
    // Only a wholly known unspent month is dropped; an unknown or partial one must not read as zero.
    history: history.filter(
      (period) =>
        period.isBeforeRecordsBegan ||
        period.totalWindowLabel !== undefined ||
        (period.allowanceUsed ?? period.total)?.amountMinor,
    ),
    // Nothing here is priced locally; every figure is the server's own.
    pricesAsOf: "",
    unpricedModels: [],
  };
}
