import { describe, expect, test } from "bun:test";
import { createWeeklyTrend, parseUsageSnapshot } from "./statusline-snapshot";

const HOUR_MS = 3_600_000;

describe("parseUsageSnapshot", () => {
  test("reads both windows with epoch-second resets", () => {
    const reading = parseUsageSnapshot({
      rate_limits: {
        five_hour: { used_percentage: 21.4, resets_at: 1_785_350_000 },
        seven_day: { used_percentage: 88, resets_at: 1_785_500_000 },
      },
    });
    expect(reading?.fiveHour?.percent).toBeCloseTo(21.4);
    expect(reading?.fiveHour?.resetsAtMs).toBe(1_785_350_000_000);
    expect(reading?.sevenDay?.percent).toBe(88);
  });

  test("accepts epoch-millisecond and ISO resets", () => {
    const reading = parseUsageSnapshot({
      rate_limits: {
        five_hour: { used_percentage: 5, resets_at: 1_785_350_000_000 },
        seven_day: { used_percentage: 6, resets_at: "2026-07-30T12:00:00Z" },
      },
    });
    expect(reading?.fiveHour?.resetsAtMs).toBe(1_785_350_000_000);
    expect(reading?.sevenDay?.resetsAtMs).toBe(Date.parse("2026-07-30T12:00:00Z"));
  });

  test("survives partial or missing windows", () => {
    const reading = parseUsageSnapshot({
      rate_limits: { five_hour: { used_percentage: 12 } },
    });
    expect(reading?.fiveHour?.percent).toBe(12);
    expect(reading?.fiveHour?.resetsAtMs).toBeNull();
    expect(reading?.sevenDay).toBeNull();
  });

  test("returns null when nothing usable is present", () => {
    expect(parseUsageSnapshot(null)).toBeNull();
    expect(parseUsageSnapshot({})).toBeNull();
    expect(parseUsageSnapshot({ rate_limits: {} })).toBeNull();
    expect(
      parseUsageSnapshot({ rate_limits: { five_hour: { used_percentage: "high" } } }),
    ).toBeNull();
  });
});

describe("weekly trend", () => {
  test("needs two readings far enough apart", () => {
    const trend = createWeeklyTrend();
    expect(trend.observe(0, 80)).toBeNull();
    expect(trend.observe(60_000, 81)).toBeNull(); // one minute is too close
    expect(trend.observe(HOUR_MS, 82)).toBeCloseTo(2);
  });

  test("restarts the baseline after a window reset", () => {
    const trend = createWeeklyTrend();
    expect(trend.observe(0, 90)).toBeNull();
    expect(trend.observe(HOUR_MS, 3)).toBeNull(); // percent dropped: reset happened
    expect(trend.observe(2 * HOUR_MS, 5)).toBeCloseTo(2);
  });

  test("flat usage yields no trend", () => {
    const trend = createWeeklyTrend();
    trend.observe(0, 40);
    expect(trend.observe(HOUR_MS, 40)).toBeNull();
  });
});
