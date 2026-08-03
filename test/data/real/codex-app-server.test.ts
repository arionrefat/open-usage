import { describe, expect, test } from "bun:test";
import { parseAccount, parseRateLimits, parseUsageHistory } from "../../../src/data/real/codex-app-server";

/** Shape generated from `codex app-server generate-json-schema` on codex-cli 0.146.0. */
const LIVE_RESPONSE = {
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1786212362 },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null,
    spendControlReached: false,
    planType: "plus",
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1786212362 },
      secondary: null,
    },
    "codex-mini-latest": {
      limitId: "codex-mini-latest",
      limitName: "codex mini",
      primary: { usedPercent: 37.4, windowDurationMins: 10080, resetsAt: 1786212362 },
      secondary: null,
    },
  },
  rateLimitResetCredits: {
    availableCount: 1,
    credits: [{ id: "x", resetType: "codexRateLimits", status: "available", grantedAt: 1 }],
  },
};

const NOW_MS = 1_786_000_000_000;

describe("parseRateLimits", () => {
  test("classifies a lone weekly primary window by its duration", () => {
    const limits = parseRateLimits(LIVE_RESPONSE, NOW_MS);
    // A positional mapping would have called this the session window.
    expect(limits?.session).toBeNull();
    expect(limits?.weekly).toEqual({
      usedPercent: 0,
      resetsAtMs: 1786212362 * 1000,
      windowMinutes: 10080,
    });
    expect(limits?.planType).toBe("plus");
    expect(limits?.resetCredits).toBe(1);
    expect(limits?.additionalRateLimits).toEqual([
      {
        name: "codex mini",
        usedPercent: 37.4,
        resetsAtMs: 1786212362 * 1000,
        windowMinutes: 10080,
      },
    ]);
    expect(limits?.credits).toEqual({ balance: 0, unlimited: false });
  });

  test("splits a short and a long window into the right scopes", () => {
    const limits = parseRateLimits(
      {
        rateLimits: {
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_786_000_600 },
          secondary: { usedPercent: 88, windowDurationMins: 10080, resetsAt: 1_786_100_000 },
          planType: "pro",
        },
      },
      NOW_MS,
    );
    expect(limits?.session?.usedPercent).toBe(42);
    expect(limits?.weekly?.usedPercent).toBe(88);
  });

  test("falls back to position when a duration is missing", () => {
    const limits = parseRateLimits(
      {
        rateLimits: {
          primary: { usedPercent: 10 },
          secondary: { usedPercent: 20 },
        },
      },
      NOW_MS,
    );
    expect(limits?.session?.usedPercent).toBe(10);
    expect(limits?.weekly?.usedPercent).toBe(20);
  });

  test("treats a lone undated window as the weekly one", () => {
    const limits = parseRateLimits({ rateLimits: { primary: { usedPercent: 10 } } }, NOW_MS);
    expect(limits?.session).toBeNull();
    expect(limits?.weekly?.usedPercent).toBe(10);
  });

  test("survives nulls, clamps percentages and defaults the credit count", () => {
    const limits = parseRateLimits(
      { rateLimits: { primary: { usedPercent: 150 }, secondary: null } },
      NOW_MS,
    );
    expect(limits?.weekly?.usedPercent).toBe(100);
    expect(limits?.weekly?.resetsAtMs).toBeNull();
    expect(limits?.resetCredits).toBe(0);
    expect(limits?.planType).toBeNull();
    expect(limits?.additionalRateLimits).toEqual([]);
    expect(limits?.credits).toBeNull();
  });

  test("rejects replies without a rate limit snapshot", () => {
    expect(parseRateLimits(null, NOW_MS)).toBeNull();
    expect(parseRateLimits({}, NOW_MS)).toBeNull();
    expect(parseRateLimits({ rateLimits: "nope" }, NOW_MS)).toBeNull();
  });
});

describe("parseUsageHistory", () => {
  /** Captured verbatim from `account/usage/read`. */
  const LIVE_USAGE = {
    summary: {
      lifetimeTokens: 401496457,
      peakDailyTokens: 110289890,
      longestRunningTurnSec: 1802,
      currentStreakDays: 0,
      longestStreakDays: 3,
    },
    dailyUsageBuckets: [
      { startDate: "2026-07-05", tokens: 18094581 },
      { startDate: "2026-07-29", tokens: 28885042 },
    ],
  };

  test("reads sparse daily buckets and the summary", () => {
    const usage = parseUsageHistory(LIVE_USAGE);
    expect(usage?.dailyTokens.get("2026-07-05")).toBe(18094581);
    expect(usage?.dailyTokens.get("2026-07-29")).toBe(28885042);
    // Idle days are simply absent rather than zero-filled.
    expect(usage?.dailyTokens.has("2026-07-06")).toBe(false);
    expect(usage?.summary?.lifetimeTokens).toBe(401496457);
    expect(usage?.summary?.longestRunningTurnSec).toBe(1802);
    expect(usage?.summary?.currentStreakDays).toBe(0);
    expect(usage?.summary?.longestStreakDays).toBe(3);
  });

  test("drops malformed buckets and sums duplicate dates", () => {
    const usage = parseUsageHistory({
      dailyUsageBuckets: [
        { startDate: "2026-07-05", tokens: 10 },
        { startDate: "2026-07-05", tokens: 5 },
        { startDate: "2026-07-06", tokens: -3 },
        { startDate: 7, tokens: 10 },
        null,
      ],
    });
    expect(usage?.dailyTokens.get("2026-07-05")).toBe(15);
    expect(usage?.dailyTokens.has("2026-07-06")).toBe(false);
    expect(usage?.summary).toBeNull();
  });

  test("returns null when there is nothing usable", () => {
    expect(parseUsageHistory(null)).toBeNull();
    expect(parseUsageHistory({})).toBeNull();
    expect(parseUsageHistory({ dailyUsageBuckets: [] })).toBeNull();
    // An all-zero summary is malformed, not a real account record.
    expect(
      parseUsageHistory({
        summary: {
          lifetimeTokens: 0,
          peakDailyTokens: 0,
          longestRunningTurnSec: 0,
          currentStreakDays: 0,
          longestStreakDays: 0,
        },
      }),
    ).toBeNull();
  });
});

describe("parseAccount", () => {
  test("reads the plan and auth type from an account reply", () => {
    expect(parseAccount({ account: { type: "chatgpt", planType: "plus" } })).toEqual({
      planType: "plus",
      type: "chatgpt",
    });
    expect(parseAccount({ account: {} })).toEqual({ planType: null, type: null });
    expect(parseAccount(null)).toEqual({ planType: null, type: null });
  });
});

describe("legacy additional limits", () => {
  test("falls back to the array shape when the map is absent", () => {
    const limits = parseRateLimits(
      {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 1, windowDurationMins: 10080 },
          additionalRateLimits: [
            { limitId: "codex-mini-latest", limitName: "codex mini", usedPercent: 37.4 },
          ],
        },
      },
      NOW_MS,
    );
    expect(limits?.additionalRateLimits).toEqual([
      { name: "codex mini", usedPercent: 37.4, resetsAtMs: null, windowMinutes: null },
    ]);
  });
});
