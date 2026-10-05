import { describe, expect, test } from "bun:test";
import { mergeCostHistory, mergeSpans, type BankedCosts } from "../../../src/data/real/go-cost-history";
import type { GoCostReply } from "../../../src/data/real/opencode-server";
import type { GoBilling, GoCostRow } from "../../../src/data/real/opencode-usage";

const NOW = new Date("2026-10-05T21:00:00Z");
const WINDOW = { from: "2026-09-06", until: "2026-10-05" };

const BILLING: GoBilling = {
  balanceUsd: 0,
  monthlyUsageUsd: null,
  monthlyLimitUsd: null,
  isAutoReloadOn: false,
  reloadAmountUsd: 20,
  hasLiteSubscription: true,
  hasSubscription: false,
};

function day(date: string, usd: number): GoCostRow {
  return { date, model: null, usd, keyId: null, plan: "lite" };
}

function reply(rows: GoCostRow[], partial: Partial<GoCostReply> = {}): GoCostReply {
  return { rows, coverage: WINDOW, billing: BILLING, workspaceId: "wrk_test", ...partial };
}

/** August and early September as a poll before the backend move banked them. */
function banked(workspaceId = "wrk_test"): BankedCosts {
  return {
    months: [
      {
        costs: { rows: [day("2026-09-01", 2), day("2026-09-08", 1)], keys: [] },
        billing: BILLING,
        workspaceId,
        month: "2026-09",
      },
      { costs: { rows: [day("2026-08-26", 3.07)], keys: [] }, billing: null, workspaceId, month: "2026-08" },
    ],
    costCoverage: [{ from: "2026-08-01", until: "2026-09-10" }],
  };
}

const dates = (rows: GoCostRow[]) => rows.map((row) => `${row.date}=${row.usd}`);

describe("mergeCostHistory", () => {
  test("keeps banked days the reply no longer reaches and takes the server's figure inside it", () => {
    const merged = mergeCostHistory(banked(), reply([day("2026-09-08", 1.5), day("2026-10-04", 0.53)]), NOW, 3);

    expect(merged.months.map((month) => month.month)).toEqual(["2026-10", "2026-09", "2026-08"]);
    expect(dates(merged.months[0]?.costs.rows ?? [])).toEqual(["2026-10-04=0.53"]);
    // 1 September is older than the window and survives; the 8th is restated.
    expect(dates(merged.months[1]?.costs.rows ?? [])).toEqual(["2026-09-01=2", "2026-09-08=1.5"]);
    expect(dates(merged.months[2]?.costs.rows ?? [])).toEqual(["2026-08-26=3.07"]);
    expect(merged.coverage).toEqual([{ from: "2026-08-01", until: "2026-10-05" }]);
    expect(merged.hasCostGap).toBe(false);
  });

  test("the window's cut first day never replaces a whole one already banked", () => {
    const merged = mergeCostHistory(
      banked(),
      // 5 September is before the window's first whole day, so this is a part of it.
      reply([day("2026-09-01", 0.2)], { coverage: { from: "2026-09-02", until: "2026-10-05" } }),
      NOW,
      3,
    );

    expect(dates(merged.months[1]?.costs.rows ?? [])).toContain("2026-09-01=2");
  });

  test("a reply that drops a day it answered for before is not trusted for coverage", () => {
    // 8 September carried spend and sits inside the window, yet the reply leaves
    // it out: the shape of the `since` query that came back with two days.
    const merged = mergeCostHistory(banked(), reply([day("2026-10-04", 0.53)]), NOW, 3);

    expect(merged.hasCostGap).toBe(true);
    expect(merged.coverage).toEqual([{ from: "2026-08-01", until: "2026-09-10" }]);
    expect(dates(merged.months[1]?.costs.rows ?? [])).toContain("2026-09-08=1");
  });

  test("days banked under another workspace are not carried over", () => {
    const merged = mergeCostHistory(banked("wrk_other"), reply([day("2026-10-04", 0.53)]), NOW, 3);

    expect(merged.months[2]?.costs.rows).toEqual([]);
    expect(merged.coverage).toEqual([WINDOW]);
  });

  test("a failed billing read keeps the last good record", () => {
    const merged = mergeCostHistory(banked(), reply([], { billing: null }), NOW, 3);

    expect(merged.months[0]?.billing).toEqual(BILLING);
    expect(merged.months[1]?.billing).toBeNull();
  });

  test("drops coverage older than the months it keeps", () => {
    const merged = mergeCostHistory(
      { ...banked(), costCoverage: [{ from: "2026-06-01", until: "2026-07-03" }] },
      reply([day("2026-09-08", 1)]),
      NOW,
      3,
    );

    expect(merged.coverage).toEqual([WINDOW]);
  });
});

describe("mergeSpans", () => {
  test("joins overlapping and adjacent runs but keeps a real gap", () => {
    expect(
      mergeSpans([
        { from: "2026-09-14", until: "2026-10-05" },
        { from: "2026-09-01", until: "2026-09-12" },
        { from: "2026-09-10", until: "2026-09-13" },
        { from: "2026-08-01", until: "2026-08-20" },
      ]),
    ).toEqual([
      { from: "2026-08-01", until: "2026-08-20" },
      { from: "2026-09-01", until: "2026-10-05" },
    ]);
  });
});
