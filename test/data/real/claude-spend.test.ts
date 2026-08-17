import { describe, expect, test } from "bun:test";
import { buildClaudeSpend } from "../../../src/data/real/claude-spend";
import type { ClaudeAccountUsage } from "../../../src/data/real/claude-account-usage";
import { loadPriceTable, type TokenUsage } from "../../../src/data/real/pricing";
import {
  emptySpendStore,
  recordDayTokens,
  recordSpendReading,
  type SpendStore,
} from "../../../src/data/real/spend-store";

const TABLE = loadPriceTable("/nonexistent/pricing.json");
const NOW = new Date(2026, 7, 17, 12);
const MILLION = 1_000_000;

function tokens(partial: Partial<TokenUsage> = {}): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...partial };
}

function creditAccount(usedMinor: number): ClaudeAccountUsage {
  return {
    spend: {
      used: { amountMinor: usedMinor, currency: "USD", exponent: 2 },
      limit: { amountMinor: 5000, currency: "USD", exponent: 2 },
      balance: null,
      percent: 37,
      isEnabled: true,
    },
    extraUsage: {
      isEnabled: true,
      isSpendLimitReached: false,
      wasEverEnabled: true,
      utilization: 37,
    },
    fetchedAtMs: NOW.getTime(),
  };
}

function storeWithDays(days: Record<string, Record<string, TokenUsage>>): SpendStore {
  return recordDayTokens(emptySpendStore(), days, null);
}

describe("buildClaudeSpend with an exact figure", () => {
  const days = {
    "2026-08-10": {
      "claude-opus-5": tokens({ output: 2 * MILLION }),
      "claude-sonnet-5": tokens({ output: 1 * MILLION }),
    },
  };

  /** `observedAtMs` is when the cycle was first seen, which is its start. */
  function build(usedMinor: number, observedAtMs = new Date(2026, 6, 20).getTime()) {
    let store = storeWithDays(days);
    store = recordSpendReading(
      store,
      { amountMinor: usedMinor, currency: "USD", exponent: 2 },
      observedAtMs,
    );
    return buildClaudeSpend({ account: creditAccount(usedMinor), store, table: TABLE, now: NOW });
  }

  test("the headline is Claude's own figure, not the priced estimate", () => {
    const spend = build(1842);

    expect(spend?.current.exactness).toBe("exact");
    expect(spend?.current.total).toEqual({ amountMinor: 1842, currency: "USD", exponent: 2 });
  });

  test("the per-model parts sum exactly to the headline", () => {
    const spend = build(1842);
    const parts = spend?.current.models.reduce((sum, m) => sum + (m.cost?.amountMinor ?? 0), 0);

    expect(parts).toBe(1842);
  });

  test("parts still sum exactly when the split does not divide evenly", () => {
    // 2:1 priced weights against 1 cent cannot split cleanly; the remainder
    // must land somewhere rather than leaving the parts short of the total.
    for (const amount of [1, 3, 7, 99, 1_000_003]) {
      const spend = build(amount);
      const parts = spend?.current.models.reduce((sum, m) => sum + (m.cost?.amountMinor ?? 0), 0);
      expect(parts).toBe(amount);
    }
  });

  test("the split follows the priced weights", () => {
    // Opus 5 output is $25/M, Sonnet 5 is $15/M: 2M opus vs 1M sonnet is
    // $50 against $15, so opus takes roughly 77%.
    const spend = build(6500);
    const opus = spend?.current.models.find((m) => m.model === "claude-opus-5");

    expect(opus?.cost?.amountMinor).toBe(5000);
  });

  test("the period is labelled by the calendar month, which is what was asked", () => {
    const spend = build(1842);

    expect(spend?.current.label).toBe("august 2026");
    expect(spend?.current.totalWindowLabel).toBeUndefined();
  });

  test("the plan cap rides along with the total", () => {
    expect(build(1842)?.current.limit?.amountMinor).toBe(5000);
  });

  test("a cycle first seen mid-month keeps its own label and does not apportion", () => {
    // We only learn a cycle's start when we first observe it. A cycle observed
    // after the month began cannot be spread across the whole month's tokens,
    // so the money keeps its own window label and the split stays an estimate.
    const spend = build(1842, new Date(2026, 7, 12).getTime());

    expect(spend?.current.exactness).toBe("exact");
    expect(spend?.current.totalWindowLabel).toContain("cycle since");
    expect(spend?.current.models.every((m) => m.exactness === "estimated")).toBe(true);
  });
});

describe("buildClaudeSpend without an exact figure", () => {
  test("prices the tokens and labels the result an estimate", () => {
    const store = storeWithDays({
      "2026-08-10": { "claude-opus-5": tokens({ output: 2 * MILLION }) },
    });
    const spend = buildClaudeSpend({ account: null, store, table: TABLE, now: NOW });

    expect(spend?.current.exactness).toBe("estimated");
    // 2M output at $25/M.
    expect(spend?.current.total?.amountMinor).toBe(5000);
    expect(spend?.current.models[0]?.exactness).toBe("estimated");
  });

  test("falls back to calendar months when there is no cycle to anchor to", () => {
    const store = storeWithDays({
      "2026-08-10": { "claude-opus-5": tokens({ output: MILLION }) },
      "2026-07-10": { "claude-opus-5": tokens({ output: MILLION }) },
    });
    const spend = buildClaudeSpend({ account: null, store, table: TABLE, now: NOW });

    expect(spend?.current.label).toBe("august 2026");
    expect(spend?.history[0]?.label).toBe("july 2026");
    expect(spend?.history[0]?.total?.amountMinor).toBe(2500);
  });

  test("an estimated total equals the sum of its priced parts", () => {
    const store = storeWithDays({
      "2026-08-10": {
        "claude-opus-5": tokens({ output: MILLION, cacheRead: 3 * MILLION }),
        "claude-haiku-4-5": tokens({ input: 5 * MILLION }),
      },
    });
    const spend = buildClaudeSpend({ account: null, store, table: TABLE, now: NOW });
    const parts = spend?.current.models.reduce((sum, m) => sum + (m.cost?.amountMinor ?? 0), 0);

    expect(parts).toBe(spend?.current.total?.amountMinor);
  });
});

describe("buildClaudeSpend edge cases", () => {
  test("an unknown model is surfaced as unpriced rather than counted as free", () => {
    const store = storeWithDays({
      "2026-08-10": { "claude-brand-new": tokens({ output: MILLION }) },
    });
    const spend = buildClaudeSpend({ account: null, store, table: TABLE, now: NOW });

    expect(spend?.unpricedModels).toEqual(["claude-brand-new"]);
    expect(spend?.current.models[0]?.cost).toBeNull();
    expect(spend?.current.models[0]?.exactness).toBe("unavailable");
  });

  test("fast usage is kept as its own row", () => {
    const store = storeWithDays({
      "2026-08-10": {
        "claude-opus-5": tokens({ output: MILLION }),
        "claude-opus-5::fast": tokens({ output: MILLION }),
      },
    });
    const spend = buildClaudeSpend({ account: null, store, table: TABLE, now: NOW });
    const fast = spend?.current.models.find((m) => m.isFast);

    expect(fast?.model).toBe("claude-opus-5");
    // Fast output is $50/M against the standard $25/M.
    expect(fast?.cost?.amountMinor).toBe(5000);
  });

  test("nothing recorded and no money means no spend section at all", () => {
    expect(
      buildClaudeSpend({ account: null, store: emptySpendStore(), table: TABLE, now: NOW }),
    ).toBeUndefined();
  });

  test("a period predating our records is flagged rather than shown as zero", () => {
    const store = storeWithDays({
      "2026-08-10": { "claude-opus-5": tokens({ output: MILLION }) },
    });
    const spend = buildClaudeSpend({ account: null, store, table: TABLE, now: NOW });

    expect(spend?.current.isBeforeRecordsBegan).toBe(true);
  });

  test("models are ordered by cost, highest first", () => {
    const store = storeWithDays({
      "2026-08-10": {
        "claude-haiku-4-5": tokens({ output: MILLION }),
        "claude-opus-5": tokens({ output: MILLION }),
        "claude-sonnet-5": tokens({ output: MILLION }),
      },
    });
    const spend = buildClaudeSpend({ account: null, store, table: TABLE, now: NOW });

    expect(spend?.current.models.map((m) => m.model)).toEqual([
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
  });
});
