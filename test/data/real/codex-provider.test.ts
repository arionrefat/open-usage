import { describe, expect, test } from "bun:test";
import { DAY_MS, HOUR_MS } from "../../../src/data/real/aggregate";
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
    resetCreditsExpireAtMs: null,
    isSpendControlReached: false,
    additionalRateLimits: [],
    credits: null,
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

function buildWithStats(sessions: number) {
  return buildCodexProvider({
    meta: createCodexMeta(),
    buckets: new Map(),
    stats: { sessions, tokens: 100, latestMs: NOW_MS, topModel: null },
    limitsSource: source(account()),
    dates: [DATE],
    now: NOW,
  });
}

describe("buildCodexProvider", () => {
  test("preserves the raw 30-day session count", () => {
    expect(buildWithStats(11).sessions30d).toBe(11);
  });

  test("labels available limits by each reported duration", () => {
    const provider = build(account());

    expect(provider.limits.map((limit) => limit.label)).toEqual(["5h limit", "7d limit"]);
    expect(provider.scopes.session.window).toBe("5h · codex");
    expect(provider.scopes.weekly.window).toBe("7d · codex");
  });

  test("puts a reset-credit alert on the first rendered row", () => {
    const provider = build(account({ resetCredits: 2 }));

    expect(provider.limits[0]?.alert?.text).toBe("✓ 2 free resets");
    // A grant is the way out of a capped week, so the overview states it too.
    expect(provider.limits[0]?.alert?.isOnCard).toBe(true);
    expect(provider.limits[1]?.alert).toBeUndefined();
  });

  test("states the deadline on a grant that expires", () => {
    const single = build(account({ resetCredits: 1, resetCreditsExpireAtMs: NOW_MS + 27 * DAY_MS }));
    expect(single.limits[0]?.alert?.text).toBe("✓ 1 free reset · expires in 27d 0h");

    // With several grants the soonest deadline is the one that can be missed.
    const many = build(account({ resetCredits: 3, resetCreditsExpireAtMs: NOW_MS + 2 * DAY_MS }));
    expect(many.limits[0]?.alert?.text).toBe("✓ 3 free resets · next expires in 2d 0h");
  });

  test("a passed deadline is dropped rather than counted down into the negative", () => {
    const provider = build(account({ resetCredits: 1, resetCreditsExpireAtMs: NOW_MS - HOUR_MS }));

    expect(provider.limits[0]?.alert?.text).toBe("✓ 1 free reset");
  });

  test("a reached spend control outranks a grant, because it blocks below the cap", () => {
    const provider = build(
      account({ resetCredits: 1, isSpendControlReached: true, weekly: {
        usedPercent: 40,
        resetsAtMs: NOW_MS + 2 * HOUR_MS,
        windowMinutes: 10_080,
      } }),
    );

    // The meter reads 40%, so only this line explains why codex refuses to run.
    expect(provider.limits[0]?.alert?.text).toBe("▲ spend control reached");
    expect(provider.limits[0]?.alert?.isOnCard).toBe(true);
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
    expect(provider.activityScope).toBe("account");
  });

  test("moves usage summary records out of the footer", () => {
    const provider = build(account({
      usage: {
        dailyTokens: new Map(),
        summary: {
          lifetimeTokens: 401_496_457,
          peakDailyTokens: 110_289_890,
          longestRunningTurnSec: 3_782,
          currentStreakDays: 2,
          longestStreakDays: 3,
        },
      },
    }));

    expect(provider.details?.[0]).toEqual({
      title: "records",
      rows: [
        { label: "lifetime tokens", value: "401M" },
        { label: "peak day", value: "110M" },
        { label: "longest turn", value: "1h 3m" },
        { label: "current streak", value: "2d" },
        { label: "longest streak", value: "3d" },
      ],
    });
    expect(provider.detailFooter).toBeUndefined();
  });

  test("shows one share row for each per-model limit", () => {
    const provider = build(account({
      additionalRateLimits: [
        { name: "codex mini", usedPercent: 37.4, resetsAtMs: null, windowMinutes: 10080 },
        { name: "gpt-5", usedPercent: 81, resetsAtMs: null, windowMinutes: 10080 },
      ],
    }));

    expect(provider.details).toEqual([{
      title: "per-model limits",
      rows: [
        { label: "codex mini", value: "37%", percent: 37.4 },
        { label: "gpt-5", value: "81%", percent: 81 },
      ],
    }]);
  });

  test("hides a zero credit balance and shows unlimited credits", () => {
    expect(build(account({ credits: { balance: 0, unlimited: false } })).details).toBeUndefined();

    expect(build(account({ credits: { balance: 0, unlimited: true } })).details).toEqual([{
      title: "credits",
      rows: [{ label: "balance", value: "unlimited" }],
    }]);
  });
});
