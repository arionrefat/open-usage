import type { ModelSpend, Money, SpendKind, SpendPeriod, SpendSummary } from "../types";
import { COST_UNITS_PER_USD, type GoCostRow } from "./opencode-usage";
import type { GoUsageHistory } from "./opencode-server";

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

function kindOf(row: GoCostRow): SpendKind {
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

/**
 * One row per model per kind. A model used both on plan and pay-as-you-go stays
 * on two rows, since collapsing them would hide which half was charged.
 */
function modelsFrom(rows: GoCostRow[]): ModelSpend[] {
  const totals = new Map<SpendKind, Map<string, number>>();
  for (const row of rows) {
    const kind = kindOf(row);
    const byModel = totals.get(kind) ?? new Map<string, number>();
    byModel.set(row.model, (byModel.get(row.model) ?? 0) + row.usd);
    totals.set(kind, byModel);
  }
  return [...totals]
    .flatMap(([kind, byModel]) =>
      [...byModel].map(([model, usd]) => ({
        model,
        // Cost rows carry no token counts; usage.list holds those, per session.
        tokens: { ...NO_TOKENS },
        cost: usdToMoney(usd),
        exactness: "exact" as const,
        kind,
      })),
    )
    .sort((left, right) => (right.cost?.amountMinor ?? 0) - (left.cost?.amountMinor ?? 0));
}

export function periodFrom(history: GoUsageHistory): SpendPeriod {
  const rows = history.costs.rows;
  const sumWhere = (kind: SpendKind) =>
    rows.filter((row) => kindOf(row) === kind).reduce((sum, row) => sum + row.usd, 0);

  const billed = sumWhere("billed");
  const allowance = sumWhere("allowance");
  const hasAllowance = rows.some((row) => kindOf(row) === "allowance");

  return {
    label: monthLabel(history.month),
    // Metered charges outrank the row sum: they are what the account was billed.
    total: usdToMoney(history.billing?.monthlyUsageUsd ?? billed),
    allowanceUsed: hasAllowance ? usdToMoney(allowance) : null,
    limit:
      history.billing?.monthlyLimitUsd != null
        ? dollarsToMoney(history.billing.monthlyLimitUsd)
        : null,
    exactness: "exact",
    models: modelsFrom(rows),
    isBeforeRecordsBegan: false,
  };
}

/**
 * Newest month first. The server keeps the history itself, so unlike Claude Code
 * there is no local store to reconcile and no partly covered day to guard.
 */
export function goSpendSummary(months: GoUsageHistory[]): SpendSummary | null {
  const periods = months.map(periodFrom);
  const [current, ...history] = periods;
  if (!current) return null;
  return {
    current,
    history: history.filter((period) => (period.allowanceUsed ?? period.total)?.amountMinor),
    // Nothing here is priced locally; every figure is the server's own.
    pricesAsOf: "",
    unpricedModels: [],
  };
}
