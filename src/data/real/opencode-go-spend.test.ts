import { describe, expect, test } from "bun:test";
import { HOUR_MS, DAY_MS } from "./aggregate";
import {
  GO_SESSION_MS,
  goSpendFrom,
  readGoSpend,
  spendFromRows,
  type SpendEvent,
} from "./opencode-go-spend";

const NOW = new Date("2026-08-15T12:00:00Z");
const NOW_MS = NOW.getTime();
const CAPS = { sessionUsd: 12, weeklyUsd: 30, monthlyUsd: 60 };

function at(msAgo: number, usd: number): SpendEvent {
  return { atMs: NOW_MS - msAgo, usd };
}

describe("goSpendFrom", () => {
  test("scores each window against its cap", () => {
    const spend = goSpendFrom([at(HOUR_MS, 3), at(2 * DAY_MS, 6)], NOW, CAPS);

    // Only the 1h-old event is inside the 5h window.
    expect(spend.session.usd).toBe(3);
    expect(spend.session.percent).toBeCloseTo(25);
    // Both are inside the week.
    expect(spend.weekly.usd).toBe(9);
    expect(spend.weekly.percent).toBeCloseTo(30);
  });

  test("rolling reset is when the oldest spend in the window ages out", () => {
    const spend = goSpendFrom([at(4 * HOUR_MS, 1), at(HOUR_MS, 1)], NOW, CAPS);
    expect(spend.session.resetAtMs).toBe(NOW_MS - 4 * HOUR_MS + GO_SESSION_MS);
  });

  test("spend older than the window is excluded", () => {
    const spend = goSpendFrom([at(6 * HOUR_MS, 5)], NOW, CAPS);
    expect(spend.session.usd).toBe(0);
    expect(spend.session.percent).toBe(0);
    expect(spend.session.resetAtMs).toBeNull();
    expect(spend.weekly.usd).toBe(5);
  });

  test("reports over-cap honestly rather than clamping to 100", () => {
    const spend = goSpendFrom([at(3 * DAY_MS, 90)], NOW, CAPS);
    expect(spend.monthly.usd).toBe(90);
    expect(spend.monthly.percent).toBeCloseTo(150);
  });

  test("without an anchor the cycle falls back to the 1st", () => {
    const spend = goSpendFrom([at(3 * DAY_MS, 5)], NOW, CAPS);
    expect(spend.monthly.resetAtMs).toBe(new Date(2026, 8, 1).getTime());
  });

  test("the cycle is anchored to the subscription day, not the 1st", () => {
    // Anchored to the 20th: the open cycle is Jul 20 -> Aug 20, so late-July
    // spend still counts even though the calendar month has rolled over.
    const anchor = new Date("2026-05-20T09:00:00Z").getTime();
    const spend = goSpendFrom([at(20 * DAY_MS, 7)], NOW, CAPS, anchor);
    expect(spend.monthly.usd).toBe(7);
    expect(spend.monthly.resetAtMs).toBe(new Date(2026, 7, 20).getTime());

    // Spend before the cycle opened stays out of it.
    const earlier = goSpendFrom([at(30 * DAY_MS, 7)], NOW, CAPS, anchor);
    expect(earlier.monthly.usd).toBe(0);
  });

  test("a 31st anchor clamps into short months", () => {
    const anchor = new Date("2026-01-31T09:00:00Z").getTime();
    const spend = goSpendFrom([], new Date("2026-02-15T12:00:00Z"), CAPS, anchor);
    // The Jan 31 cycle renews on Feb 28, the closest day February has.
    expect(spend.monthly.resetAtMs).toBe(new Date(2026, 1, 28).getTime());
  });

  test("no spend yields zeroed windows rather than nulls", () => {
    const spend = goSpendFrom([], NOW, CAPS);
    expect(spend.session.percent).toBe(0);
    expect(spend.weekly.percent).toBe(0);
    expect(spend.latestMs).toBe(0);
  });

  test("a zero cap cannot produce Infinity", () => {
    const spend = goSpendFrom([at(HOUR_MS, 5)], NOW, { ...CAPS, sessionUsd: 0 });
    expect(spend.session.percent).toBe(0);
  });
});

describe("spendFromRows", () => {
  test("keeps well-formed rows and drops the rest", () => {
    const events = spendFromRows([
      { at: 1_000, usd: 0.5 },
      null,
      "row",
      { at: "x", usd: 1 },
      { at: 2_000, usd: null },
      { at: 3_000, usd: 0 },
      { at: 4_000, usd: -1 },
    ]);
    expect(events).toEqual([{ atMs: 1_000, usd: 0.5 }]);
  });
});

describe("readGoSpend", () => {
  test("returns null when the db file does not exist", () => {
    expect(readGoSpend("/nonexistent/path/opencode.db", NOW)).toBeNull();
  });
});
