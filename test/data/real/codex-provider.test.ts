import { describe, expect, test } from "bun:test";
import { HOUR_MS } from "../../../src/data/real/aggregate";
import type { CodexAccountLimits } from "../../../src/data/real/codex-app-server";
import type { CodexLimitsSource } from "../../../src/data/real/codex-limits";
import { buildCodexProvider, createCodexMeta } from "../../../src/data/real/codex-provider";

const NOW = new Date(2026, 0, 15, 12);
const NOW_MS = NOW.getTime();
const DATE = "2026-01-15";

function source(limits: CodexAccountLimits | null, note = "codex source unavailable"): CodexLimitsSource {
  return {
    read: () => limits,
    note: () => note,
    poll: () => Promise.resolve(),
  };
}

function account(overrides: Partial<CodexAccountLimits> = {}): CodexAccountLimits {
  return {
    session: { usedPercent: 20, resetsAtMs: NOW_MS + HOUR_MS, windowMinutes: 300 },
    weekly: { usedPercent: 60, resetsAtMs: NOW_MS + 2 * HOUR_MS, windowMinutes: 10_080 },
    planType: "plus",
    resetCredits: 0,
    usage: null,
    fetchedAtMs: NOW_MS,
    ...overrides,
  };
}

function build(limits: CodexAccountLimits | null, buckets = new Map<number, number>()) {
  return buildCodexProvider({
    meta: createCodexMeta(),
    buckets,
    stats: undefined,
    limitsSource: source(limits),
    dates: [DATE],
    now: NOW,
  });
}

describe("buildCodexProvider", () => {
  test("labels available limits by each reported duration", () => {
    const provider = build(account());

    expect(provider.limits.map((limit) => limit.label)).toEqual(["5h limit", "7d limit"]);
    expect(provider.scopes.session.window).toBe("5h · codex");
    expect(provider.scopes.weekly.window).toBe("7d · codex");
  });

  test("puts a reset-credit alert on the first rendered row", () => {
    const provider = build(account({ resetCredits: 2 }));

    expect(provider.limits[0]?.alert?.text).toBe("✓ 2 free limit reset available");
    expect(provider.limits[1]?.alert).toBeUndefined();
  });

  test("renders a capless row with the source note when limits are unavailable", () => {
    const provider = build(null);

    expect(provider.limits).toEqual([
      expect.objectContaining({
        id: "weekly",
        percent: null,
        reset: "codex source unavailable",
        footnote: "codex source unavailable",
      }),
    ]);
  });

  test("uses server history instead of local buckets for the daily series", () => {
    const buckets = new Map([[Math.floor(NOW_MS / HOUR_MS), 1_000_000]]);
    const limits = account({
      usage: {
        dailyTokens: new Map([[DATE, 2_500_000]]),
        summary: null,
      },
    });

    const provider = build(limits, buckets);

    expect(provider.series.daily).toEqual([2.5]);
    expect(provider.series.hourly.some((value) => value === 1)).toBe(true);
  });
});
