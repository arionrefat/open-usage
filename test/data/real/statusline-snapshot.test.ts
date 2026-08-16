import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWeeklyTrend,
  parseUsageSnapshot,
  readUsageSnapshot,
} from "../../../src/data/real/statusline-snapshot";

const HOUR_MS = 3_600_000;
const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function snapshotFixture(contents: unknown, mtime: Date): string {
  const root = mkdtempSync(join(tmpdir(), "open-usage-statusline-"));
  tempRoots.push(root);
  const path = join(root, "usage-snapshot.json");
  writeFileSync(path, JSON.stringify(contents));
  utimesSync(path, mtime, mtime);
  return path;
}

describe("parseUsageSnapshot", () => {
  test("reads the full statusline payload", () => {
    const reading = parseUsageSnapshot({
      model: { id: "claude-opus-4-1", display_name: "Opus 4.1" },
      effort: { level: "high" },
      cost: {
        total_cost_usd: 2.6,
        total_duration_ms: 42_000,
        total_lines_added: 0,
        total_lines_removed: 1,
      },
      context_window: {
        total_input_tokens: 120_000,
        total_output_tokens: 5_000,
        context_window_size: 1_000_000,
        used_percentage: 12.5,
        current_usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
        },
      },
    });

    expect(reading?.model).toEqual({ id: "claude-opus-4-1", displayName: "Opus 4.1" });
    expect(reading?.effort).toBe("high");
    expect(reading?.cost).toEqual({
      totalCostUsd: 2.6,
      totalDurationMs: 42_000,
      totalLinesAdded: 0,
      totalLinesRemoved: 1,
    });
    expect(reading?.contextWindow?.currentUsage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 40,
    });
  });

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
    expect(reading?.model).toBeNull();
    expect(reading?.contextWindow).toBeNull();
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

describe("readUsageSnapshot", () => {
  test("reads a real fixture and derives age and written time from its mtime", () => {
    const written = new Date("2026-08-16T10:15:30.000Z");
    const now = new Date("2026-08-16T10:20:00.000Z");
    const path = snapshotFixture(
      { rate_limits: { five_hour: { used_percentage: 27, resets_at: 1_786_900_000 } } },
      written,
    );

    const file = readUsageSnapshot(path, now);
    expect(file?.reading.fiveHour?.percent).toBe(27);
    expect(file?.writtenAtMs).toBe(written.getTime());
    expect(file?.ageMs).toBe(4 * 60_000 + 30_000);
  });

  test("clamps a future file mtime to zero age without changing writtenAtMs", () => {
    const now = new Date("2026-08-16T10:20:00.000Z");
    const written = new Date("2026-08-16T10:21:00.000Z");
    const path = snapshotFixture({ effort: { level: "high" } }, written);

    expect(readUsageSnapshot(path, now)).toMatchObject({
      ageMs: 0,
      writtenAtMs: written.getTime(),
    });
  });
});
