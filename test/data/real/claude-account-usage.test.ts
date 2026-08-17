import { describe, expect, test } from "bun:test";
import {
  hasSpendFigure,
  parseClaudeAccountUsage,
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

describe("readClaudeAccountUsage", () => {
  test("a missing file reads as absent rather than throwing", () => {
    expect(readClaudeAccountUsage("/nonexistent/.claude.json")).toBeNull();
  });
});
