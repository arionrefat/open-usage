import { describe, expect, test } from "bun:test";
import { goSpendSummary, monthLabel, periodFrom } from "../../../src/data/real/go-spend-summary";
import type { GoUsageHistory } from "../../../src/data/real/opencode-server";
import type { GoBilling, GoCostRow, GoPlan, GoUsageRow } from "../../../src/data/real/opencode-usage";

/** A day of the console's cost chart, which names no model. */
function row(usd: number, plan: GoPlan): GoCostRow {
  return { date: "2026-08-01", model: null, usd, keyId: null, plan };
}

/** A request from the console's request log, which is what names models. */
function usageRow(model: string, usd: number, plan: GoPlan): GoUsageRow {
  return {
    id: "rlg_test", sessionId: null, atMs: Date.parse("2026-08-01T00:00:00Z"), model,
    isRejected: false, inputTokens: 100, outputTokens: 10, reasoningTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, usd, plan,
  };
}

function month(rows: GoCostRow[], billing: GoBilling | null = null): GoUsageHistory {
  return { costs: { rows, keys: [] }, billing, workspaceId: "wrk_1", month: "2026-08" };
}

const NO_BILLING: GoBilling = {
  balanceUsd: 0,
  monthlyUsageUsd: null,
  monthlyLimitUsd: null,
  isAutoReloadOn: false,
  reloadAmountUsd: 20,
  hasLiteSubscription: true,
  hasSubscription: false,
};

describe("periodFrom", () => {
  test("subscription usage is reported as allowance, never as money charged", () => {
    // A Go subscriber can burn tens of dollars of allowance and be billed
    // nothing. Reporting that as spend overstates their costs by the whole sum.
    const period = periodFrom(month([row(40.92, "lite")], NO_BILLING));
    expect(period.allowanceUsed?.amountMinor).toBe(4_092_000_000);
    expect(period.total?.amountMinor).toBe(0);
  });

  test("pay-as-you-go usage is money charged", () => {
    const period = periodFrom(month([row(3, "payg")]));
    expect(period.total?.amountMinor).toBe(300_000_000);
    expect(period.allowanceUsed).toBeNull();
  });

  test("a mixed month keeps the two apart instead of adding them", () => {
    const period = periodFrom(
      month([row(10, "lite"), row(2, "payg"), row(1, "sub")]),
    );
    expect(period.allowanceUsed?.amountMinor).toBe(1_100_000_000);
    expect(period.total?.amountMinor).toBe(200_000_000);
  });

  test("metered charges outrank the row sum, since that is the actual bill", () => {
    const billing: GoBilling = { ...NO_BILLING, monthlyUsageUsd: 7.5 };
    const period = periodFrom(month([row(3, "payg")], billing));
    expect(period.total?.amountMinor).toBe(750_000_000);
  });

  test("each model row carries its own kind", () => {
    const period = periodFrom(month([row(12, "lite")]), [
      usageRow("kimi-k3", 10, "lite"),
      usageRow("gpt-5.1", 2, "payg"),
    ]);
    expect(period.models.map((model) => [model.model, model.kind])).toEqual([
      ["kimi-k3", "allowance"],
      ["gpt-5.1", "billed"],
    ]);
  });

  test("one model billed two ways stays on two rows", () => {
    // Collapsing them would hide which half was actually charged.
    const period = periodFrom(month([row(14, "lite")]), [
      usageRow("kimi-k3", 10, "lite"),
      usageRow("kimi-k3", 4, "payg"),
    ]);
    expect(period.models).toHaveLength(2);
    expect(period.models.map((model) => model.kind)).toEqual(["allowance", "billed"]);
  });

  test("keeps full precision rather than rounding to cents", () => {
    const period = periodFrom(month([row(0.00046411, "lite")]));
    expect(period.allowanceUsed?.amountMinor).toBe(46_411);
  });
});

describe("goSpendSummary", () => {
  test("newest month is current, the rest are history", () => {
    const summary = goSpendSummary([
      { ...month([row(10, "lite")]), month: "2026-08" },
      { ...month([row(40, "lite")]), month: "2026-07" },
    ]);
    expect(summary?.current.label).toBe("august 2026");
    expect(summary?.history.map((period) => period.label)).toEqual(["july 2026"]);
  });

  test("a month with no usage is dropped from history rather than shown as zero", () => {
    const summary = goSpendSummary([
      { ...month([row(10, "lite")]), month: "2026-08" },
      { ...month([]), month: "2026-06" },
    ]);
    expect(summary?.history).toHaveLength(0);
  });

  test("an empty current month still reports, so zero reads as measured", () => {
    const summary = goSpendSummary([{ ...month([]), month: "2026-08" }]);
    expect(summary?.current.total?.amountMinor).toBe(0);
  });

  test("returns null when there is nothing at all", () => {
    expect(goSpendSummary([])).toBeNull();
  });
});

describe("monthLabel", () => {
  test("reads as a month and year", () => {
    expect(monthLabel("2026-08")).toBe("august 2026");
    expect(monthLabel("2026-01")).toBe("january 2026");
  });
});
