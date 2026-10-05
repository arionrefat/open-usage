import { describe, expect, test } from "bun:test";
import { DAY_MS, HOUR_MS } from "../../../src/data/real/aggregate";
import type { CodexAccountLimits } from "../../../src/data/real/codex-app-server";
import type { CodexLimitsSource } from "../../../src/data/real/codex-limits";
import { buildCodexProvider, createCodexMeta } from "../../../src/data/real/codex-provider";
import { COLORS } from "../../../src/theme";

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
  test("carries the subscription end date beside the plan codex reports", () => {
    const provider = buildCodexProvider({
      meta: createCodexMeta(),
      buckets: new Map(),
      stats: undefined,
      limitsSource: source(account()),
      subscriptionEndsAtMs: NOW_MS + 20 * DAY_MS,
      dates: [DATE],
      now: NOW,
    });

    expect(provider.meta.planShort).toBe("Plus");
    expect(provider.meta.planEnd).toEqual({ text: "until Feb 4", isSoon: false });
  });

  test("names each plan the way codex's own status line does", () => {
    const labels = Object.fromEntries(
      ["go", "plus", "prolite", "pro", "promax", "team", "self_serve_business_prolite", "edu_plus"].map(
        (planType) => [planType, build(account({ planType })).meta.plan],
      ),
    );

    expect(labels).toEqual({
      go: "Go",
      plus: "Plus",
      prolite: "Pro 100",
      pro: "Pro 200",
      promax: "Pro 500",
      team: "Business",
      self_serve_business_prolite: "Business Premium",
      edu_plus: "Education Plus",
    });
  });

  test("title-cases a plan codex adds before it is named here", () => {
    expect(build(account({ planType: "pro_ultra" })).meta.plan).toBe("Pro Ultra");
  });

  test("states no end date without a live plan to attach it to", () => {
    const provider = buildCodexProvider({
      meta: createCodexMeta(),
      buckets: new Map(),
      stats: undefined,
      limitsSource: source(null),
      subscriptionEndsAtMs: NOW_MS + 20 * DAY_MS,
      dates: [DATE],
      now: NOW,
    });

    expect(provider.meta.planEnd).toBeUndefined();
  });

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

  test("surfaces a backend workspace block even below the percentage cap", () => {
    const provider = build(account({
      rateLimitReachedType: "workspace_member_credits_depleted",
      weekly: {
        usedPercent: 40,
        resetsAtMs: NOW_MS + 2 * HOUR_MS,
        windowMinutes: 10_080,
      },
    }));

    expect(provider.limits[0]?.alert?.text).toBe("▲ workspace credits depleted");
  });

  test("turns the backend's refusal of included usage into a red line, whatever the meters say", () => {
    const provider = build(account({
      isOrdinaryUsageAllowed: false,
      weekly: { usedPercent: 40, resetsAtMs: NOW_MS + 2 * HOUR_MS, windowMinutes: 10_080 },
    }));

    expect(provider.limits[0]?.alert).toEqual({
      text: "▲ included usage blocked",
      color: COLORS.danger,
      isOnCard: true,
    });
  });

  test("a usage block outranks a grant but still counts it", () => {
    const provider = build(account({
      isOrdinaryUsageAllowed: false,
      resetCredits: 2,
      resetCreditsExpireAtMs: NOW_MS + 2 * DAY_MS,
    }));

    expect(provider.limits[0]?.alert?.text).toBe("▲ included usage blocked · 2 free resets");
  });

  test("a named cause outranks the bare usage block", () => {
    const spend = build(account({ isOrdinaryUsageAllowed: false, isSpendControlReached: true }));
    const workspace = build(account({
      isOrdinaryUsageAllowed: false,
      rateLimitReachedType: "workspace_owner_usage_limit_reached",
    }));

    expect(spend.limits[0]?.alert?.text).toBe("▲ spend control reached");
    expect(workspace.limits[0]?.alert?.text).toBe("▲ workspace usage limit reached");
  });

  test("reads an unknown or allowed usage permission as no block", () => {
    expect(build(account({ isOrdinaryUsageAllowed: null, resetCredits: 1 })).limits[0]?.alert?.text)
      .toBe("✓ 1 free reset");
    expect(build(account({ isOrdinaryUsageAllowed: true })).limits[0]?.alert).toBeUndefined();
  });

  test("hands the same verdict to notifications, so a reset meter under a block is not ready", () => {
    expect(build(account({ isOrdinaryUsageAllowed: false })).usageBlock).toEqual({
      isBlocked: true,
      reason: "included usage blocked",
    });
    expect(build(account({ isOrdinaryUsageAllowed: false, isSpendControlReached: true })).usageBlock)
      .toEqual({ isBlocked: true, reason: "spend control reached" });
    // Without the field the named causes are all there is, so a lifted spend
    // control still reads as lifted.
    expect(build(account({ isOrdinaryUsageAllowed: null })).usageBlock).toEqual({ isBlocked: false });
    expect(build(null).usageBlock).toBeUndefined();
  });

  test("keeps the block on screen when codex reports no window to carry it", () => {
    const provider = build(account({ isOrdinaryUsageAllowed: false, session: null, weekly: null }));

    expect(provider.limits).toHaveLength(1);
    expect(provider.limits[0]).toMatchObject({ id: "weekly", percent: null });
    expect(provider.limits[0]?.alert?.text).toBe("▲ included usage blocked");
    expect(build(account({ session: null, weekly: null })).limits).toEqual([]);
  });

  test("stays quiet on a classification that does not mean blocked", () => {
    const provider = build(account({
      rateLimitReachedType: "none",
      resetCredits: 2,
      weekly: { usedPercent: 5, resetsAtMs: NOW_MS + 2 * HOUR_MS, windowMinutes: 10_080 },
    }));

    expect(provider.limits[0]?.alert?.text).toContain("free reset");
  });

  test("renders the effective monthly credit limit as a real pressure lane", () => {
    const provider = build(account({
      planType: "self_serve_business_usage_based",
      spendControl: { usedPercent: 85, resetsAtMs: NOW_MS + 10 * DAY_MS },
    }));

    expect(provider.meta.plan).toBe("Business");
    expect(provider.limits[2]).toMatchObject({
      id: "monthly-credit",
      label: "monthly credits",
      percent: 85,
    });
    // No dollar label until a real workspace payload settles dollars vs cents.
    expect(provider.limits[2]?.detailValueLabel).toBeUndefined();
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

  test("keeps the daily series local and blended even when server history exists", () => {
    // The server's own history is account-wide and counts cached input, so it
    // cannot share an axis with the other providers - or with this provider's
    // own hourly view and burn rate, which are local.
    const buckets = new Map([[Math.floor(NOW_MS / HOUR_MS), 1_000_000]]);
    const limits = account({
      usage: {
        dailyTokens: new Map([[DATE, 2_500_000]]),
        summary: null,
      },
    });

    const provider = build(limits, buckets);

    expect(provider.series.daily.at(-1)).toBe(1);
    expect(provider.series.hourly.some((value) => value === 1)).toBe(true);
  });

  test("reports the account-wide window total as a labelled row, not as bars", () => {
    const limits = account({
      usage: {
        dailyTokens: new Map([[DATE, 2_500_000]]),
        summary: null,
      },
    });

    const rows = build(limits, new Map()).details?.find((s) => s.title === "records")?.rows ?? [];

    expect(rows[0]?.label).toBe("account 30d · incl. cached");
    expect(rows[0]?.value).toBe("2.5M");
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
