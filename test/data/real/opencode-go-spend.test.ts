import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOUR_MS, DAY_MS } from "../../../src/data/real/aggregate";
import {
  GO_SESSION_MS,
  goQuotaWeight,
  goSpendFrom,
  readGoSpend,
  spendFromRows,
  type SpendEvent,
} from "../../../src/data/real/opencode-go-spend";

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

  test("the monthly figure is a trailing 30d window with no claimed cycle reset", () => {
    const spend = goSpendFrom([at(20 * DAY_MS, 7), at(31 * DAY_MS, 11)], NOW, CAPS);
    expect(spend.monthly.usd).toBe(7);
    // The oldest in-window spend aging out is the only reset signal available.
    expect(spend.monthly.resetAtMs).toBe(NOW_MS - 20 * DAY_MS + 30 * DAY_MS);
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

  test("weighs $15-allowance models 4x against the $60 quota", () => {
    const events = spendFromRows([
      { at: 1_000, usd: 1, model: "kimi-k3" },
      { at: 1_000, usd: 1, model: "deepseek-v4-pro" },
      { at: 1_000, usd: 1, model: "glm-5.2" },
      { at: 1_000, usd: 1, model: "some-future-model" },
      { at: 1_000, usd: 1 },
    ]);
    expect(events.map((event) => event.usd)).toEqual([4, 4, 1, 1, 1]);
  });
});

describe("goQuotaWeight", () => {
  test("matches the published per-model allowances", () => {
    expect(goQuotaWeight("kimi-k3")).toBe(4);
    expect(goQuotaWeight("grok-4.5")).toBe(4);
    expect(goQuotaWeight("deepseek-v4-flash")).toBe(1);
    expect(goQuotaWeight(null)).toBe(1);
  });
});

describe("readGoSpend", () => {
  test("returns null when the db file does not exist", () => {
    expect(readGoSpend("/nonexistent/path/opencode.db", NOW)).toBeNull();
  });

  test("throws when an existing database is unreadable", () => {
    const path = join(mkdtempSync(join(tmpdir(), "opencode-spend-corrupt-")), "opencode.db");
    writeFileSync(path, "not sqlite");
    expect(() => readGoSpend(path, NOW)).toThrow();
  });
});
