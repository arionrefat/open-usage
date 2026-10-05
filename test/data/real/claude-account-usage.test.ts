import { describe, expect, test } from "bun:test";
import {
  hasSpendFigure,
  parseClaudeAccountUsage,
  parseWeeklyBreakdown,
  readClaudeAccountUsage,
} from "../../../src/data/real/claude-account-usage";

/** The shape observed on a live subscription account with credits switched off. */
const CREDITS_OFF = {
  cachedUsageUtilization: {
    fetchedAtMs: 1786961143758,
    utilization: {
      extra_usage: {
        is_enabled: false,
        monthly_limit: null,
        used_credits: null,
        utilization: null,
        spend_limit_reached: false,
        credits_ever_enabled: true,
        user_disabled: true,
      },
      spend: {
        used: { amount_minor: 0, currency: "USD", exponent: 2 },
        limit: null,
        percent: 0,
        enabled: false,
        balance: null,
        cap: null,
      },
    },
  },
};

/** The same block as it would read on an account actually running on credits. */
const CREDITS_ON = {
  cachedUsageUtilization: {
    fetchedAtMs: 1786961143758,
    utilization: {
      extra_usage: {
        is_enabled: true,
        utilization: 37,
        spend_limit_reached: false,
        credits_ever_enabled: true,
      },
      spend: {
        used: { amount_minor: 1842, currency: "USD", exponent: 2 },
        limit: { amount_minor: 5000, currency: "USD", exponent: 2 },
        balance: { amount_minor: 3158, currency: "USD", exponent: 2 },
        percent: 37,
        enabled: true,
      },
    },
  },
};

describe("parseClaudeAccountUsage", () => {
  test("reads real money from a credit account", () => {
    const usage = parseClaudeAccountUsage(CREDITS_ON);

    expect(usage?.spend.used).toEqual({ amountMinor: 1842, currency: "USD", exponent: 2 });
    expect(usage?.spend.limit?.amountMinor).toBe(5000);
    expect(usage?.spend.balance?.amountMinor).toBe(3158);
    expect(usage?.extraUsage.isEnabled).toBe(true);
    expect(hasSpendFigure(usage)).toBe(true);
  });

  test("credits off parses without inventing a figure", () => {
    const usage = parseClaudeAccountUsage(CREDITS_OFF);

    expect(usage).not.toBeNull();
    expect(usage?.extraUsage.isEnabled).toBe(false);
    expect(usage?.spend.limit).toBeNull();
    // A zero reading with credits off is not a spend figure to report.
    expect(hasSpendFigure(usage)).toBe(false);
  });

  test("an older Claude Code with no cached block reads as absent", () => {
    expect(parseClaudeAccountUsage({ oauthAccount: {} })).toBeNull();
    expect(parseClaudeAccountUsage(null)).toBeNull();
    expect(hasSpendFigure(null)).toBe(false);
  });

  test("a money object missing its exponent is refused rather than guessed", () => {
    const usage = parseClaudeAccountUsage({
      cachedUsageUtilization: {
        utilization: { spend: { used: { amount_minor: 500, currency: "USD" }, enabled: true } },
      },
    });

    expect(usage?.spend.used).toBeNull();
  });

  test("flags survive even when every money field is null", () => {
    const usage = parseClaudeAccountUsage({
      cachedUsageUtilization: {
        utilization: { extra_usage: { is_enabled: true, spend_limit_reached: true } },
      },
    });

    expect(usage?.extraUsage.isEnabled).toBe(true);
    expect(usage?.extraUsage.isSpendLimitReached).toBe(true);
  });
});

/** `seven_day_breakdown` in the shape `~/.claude.json` carries it. */
const BREAKDOWN = {
  as_of: "2026-10-05T21:38:20.621254+00:00",
  window_started_at: "2026-09-29T23:59:59.538998+00:00",
  rows: [
    { key: "claude_code", display_name: "Claude Code", percent: 88 },
    { key: "chat", display_name: "Chats", percent: 7 },
    { key: "cowork", display_name: "Cowork", percent: 5 },
    { key: "other", display_name: "Other", percent: 0 },
  ],
};

function withBreakdown(breakdown: unknown): unknown {
  return {
    cachedUsageUtilization: {
      ...CREDITS_OFF.cachedUsageUtilization,
      utilization: { ...CREDITS_OFF.cachedUsageUtilization.utilization, seven_day_breakdown: breakdown },
    },
  };
}

describe("parseWeeklyBreakdown", () => {
  test("reads the share of the week by surface, in the server's order", () => {
    expect(parseClaudeAccountUsage(withBreakdown(BREAKDOWN))?.weeklyBreakdown).toEqual({
      asOfMs: Date.parse("2026-10-05T21:38:20.621254+00:00"),
      windowStartedAtMs: Date.parse("2026-09-29T23:59:59.538998+00:00"),
      rows: [
        { key: "claude_code", label: "Claude Code", percent: 88 },
        { key: "chat", label: "Chats", percent: 7 },
        { key: "cowork", label: "Cowork", percent: 5 },
        { key: "other", label: "Other", percent: 0 },
      ],
    });
  });

  test("tolerates the rounding of whole-number shares", () => {
    const rows = [
      { key: "a", display_name: "A", percent: 34 },
      { key: "b", display_name: "B", percent: 33 },
      { key: "c", display_name: "C", percent: 34 },
    ];
    expect(parseWeeklyBreakdown({ ...BREAKDOWN, rows })?.rows).toHaveLength(3);
  });

  test("any mismatch drops the whole breakdown without touching the spend", () => {
    const row = BREAKDOWN.rows[0]!;
    const mismatches: unknown[] = [
      undefined,
      null,
      { ...BREAKDOWN, rows: [] },
      { ...BREAKDOWN, rows: "Claude Code 88%" },
      { ...BREAKDOWN, as_of: undefined },
      { ...BREAKDOWN, window_started_at: "last monday" },
      { ...BREAKDOWN, window_started_at: "2026-10-06T00:00:00+00:00" },
      { ...BREAKDOWN, rows: [{ ...row, percent: "88" }, ...BREAKDOWN.rows.slice(1)] },
      { ...BREAKDOWN, rows: [{ ...row, display_name: "" }, ...BREAKDOWN.rows.slice(1)] },
      { ...BREAKDOWN, rows: [{ ...row, key: 7 }, ...BREAKDOWN.rows.slice(1)] },
      { ...BREAKDOWN, rows: [...BREAKDOWN.rows, row] },
      // Shares reported as fractions would be a change of unit.
      { ...BREAKDOWN, rows: BREAKDOWN.rows.map((item) => ({ ...item, percent: item.percent / 100 })) },
      { ...BREAKDOWN, rows: [{ ...row, percent: 188 }, ...BREAKDOWN.rows.slice(1)] },
    ];
    for (const breakdown of mismatches) {
      const usage = parseClaudeAccountUsage(withBreakdown(breakdown));
      expect(usage?.weeklyBreakdown).toBeNull();
      expect(usage?.spend.used?.amountMinor).toBe(0);
    }
  });
});

describe("readClaudeAccountUsage", () => {
  test("a missing file reads as absent rather than throwing", () => {
    expect(readClaudeAccountUsage("/nonexistent/.claude.json")).toBeNull();
  });
});
