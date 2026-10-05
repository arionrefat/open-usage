import { describe, expect, test } from "bun:test";
import {
  goSpendSummary,
  monthCoverage,
  monthLabel,
  periodFrom,
} from "../../../src/data/real/go-spend-summary";
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
  isAutoReloadPending: false,
  autoReloadFailure: null,
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
  /** What three months of daily polling would have answered for, up to the 18th of August. */
  const COVERED = [{ from: "2026-06-01", until: "2026-08-18" }];
  const AS_OF_MS = Date.parse("2026-08-18T12:00:00Z");

  test("newest month is current, the rest are history", () => {
    const summary = goSpendSummary(
      [
        { ...month([row(10, "lite")]), month: "2026-08" },
        { ...month([row(40, "lite")]), month: "2026-07" },
      ],
      null,
      COVERED,
      AS_OF_MS,
    );
    expect(summary?.current.label).toBe("august 2026");
    expect(summary?.current.totalWindowLabel).toBeUndefined();
    expect(summary?.history.map((period) => period.label)).toEqual(["july 2026"]);
  });

  test("a month answered for with no usage is dropped rather than shown as zero", () => {
    const summary = goSpendSummary(
      [
        { ...month([row(10, "lite")]), month: "2026-08" },
        { ...month([]), month: "2026-06" },
      ],
      null,
      COVERED,
      AS_OF_MS,
    );
    expect(summary?.history).toHaveLength(0);
  });

  test("a month nobody answered for reads as not recorded, never as zero", () => {
    // What the 30-minute poll did to August before days were banked: a reply
    // that no longer reached the month turned it into a $0 month.
    const summary = goSpendSummary(
      [
        { ...month([row(10, "lite")]), month: "2026-10" },
        { ...month([]), month: "2026-09" },
        { ...month([]), month: "2026-08" },
      ],
      null,
      [{ from: "2026-09-06", until: "2026-10-05" }],
      Date.parse("2026-10-05T21:00:00Z"),
    );
    const [september, august] = summary?.history ?? [];
    // September was answered for from the 6th and spent nothing in that time,
    // which still leaves its first five days unknown, so it stays on the line.
    expect(september?.totalWindowLabel).toBe("from sep 6");
    expect(september?.total?.amountMinor).toBe(0);
    expect(august?.label).toBe("august 2026");
    expect(august?.total).toBeNull();
    expect(august?.allowanceUsed).toBeNull();
    expect(august?.exactness).toBe("unavailable");
    expect(august?.isBeforeRecordsBegan).toBe(true);
  });

  test("a month answered for only from some day on says from when", () => {
    const summary = goSpendSummary(
      [
        { ...month([row(1, "lite")]), month: "2026-10" },
        { ...month([{ ...row(15.26, "lite"), date: "2026-09-08" }]), month: "2026-09" },
      ],
      null,
      [{ from: "2026-09-06", until: "2026-10-05" }],
      Date.parse("2026-10-05T21:00:00Z"),
    );
    expect(summary?.current.totalWindowLabel).toBeUndefined();
    expect(summary?.history[0]?.totalWindowLabel).toBe("from sep 6");
    expect(summary?.history[0]?.exactness).toBe("exact");
  });

  test("banked days with no record of which reads they came from are a partial record", () => {
    const summary = goSpendSummary(
      [
        { ...month([row(1, "lite")]), month: "2026-08" },
        { ...month([row(4, "lite")]), month: "2026-07" },
      ],
      null,
      [],
      0,
    );
    expect(summary?.history[0]?.totalWindowLabel).toBe("partial record");
    expect(summary?.history[0]?.allowanceUsed?.amountMinor).toBe(4 * 1e8);
  });

  test("an empty current month still reports, so zero reads as measured", () => {
    const summary = goSpendSummary([{ ...month([]), month: "2026-08" }], null, COVERED, AS_OF_MS);
    expect(summary?.current.total?.amountMinor).toBe(0);
  });

  test("returns null when there is nothing at all", () => {
    expect(goSpendSummary([], null, COVERED, AS_OF_MS)).toBeNull();
  });
});

describe("monthCoverage", () => {
  test("tells whole, from-a-day, scattered and absent coverage apart", () => {
    const today = "2026-10-05";
    expect(monthCoverage("2026-10", [{ from: "2026-09-06", until: "2026-10-05" }], today)).toEqual({ kind: "full" });
    expect(monthCoverage("2026-09", [{ from: "2026-09-06", until: "2026-10-05" }], today)).toEqual({
      kind: "from",
      date: "2026-09-06",
    });
    expect(
      monthCoverage(
        "2026-09",
        [
          { from: "2026-09-01", until: "2026-09-10" },
          { from: "2026-09-14", until: "2026-10-05" },
        ],
        today,
      ),
    ).toEqual({ kind: "partial" });
    expect(monthCoverage("2026-08", [{ from: "2026-09-06", until: "2026-10-05" }], today)).toEqual({ kind: "none" });
  });
});

describe("monthLabel", () => {
  test("reads as a month and year", () => {
    expect(monthLabel("2026-08")).toBe("august 2026");
    expect(monthLabel("2026-01")).toBe("january 2026");
  });
});
