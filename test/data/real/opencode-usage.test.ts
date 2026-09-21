import { describe, expect, test } from "bun:test";
import {
  parseBillingStatus,
  parseCostDays,
  parseUsagePage,
} from "../../../src/data/real/opencode-usage";

/**
 * Shapes taken from live console responses. Money is micro-cents and every
 * count arrives as a decimal string, which is what the 1e8 scaling below is for.
 */
const COST_BY_DAY = [
  { date: "2026-08-26", totalCostMicroCents: "307425758", totalTokens: "21511342", totalRequests: "200" },
  { date: "2026-08-28", totalCostMicroCents: "19425181", totalTokens: "9092164", totalRequests: "118" },
];

const USAGE_ROW = {
  id: 2095385180,
  orgId: "wrk_01KWJ21MX7C6XMR8MJ01ST2Z6E",
  userId: null,
  principalType: "service-account",
  serviceApiKeyId: "key_01KXWPQRHHEVSJBW98THT3MSGW",
  appReferrer: "opencode",
  provider: "opencode-go",
  model: "glm-5.3-flash",
  inputTokens: 2981,
  outputTokens: 55,
  reasoningTokens: 0,
  cacheReadTokens: 41344,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  billingSource: "go",
  costMicroCents: "171497",
  createdAt: "2026-09-20T11:22:44.000Z",
};

describe("parseCostDays", () => {
  test("reads day totals and converts micro-cents to dollars", () => {
    // Taking totalCostMicroCents at face value would report a $3.07 day as
    // $307 million.
    const days = parseCostDays(COST_BY_DAY);
    expect(days).toHaveLength(2);
    expect(days?.[0]).toEqual({
      date: "2026-08-26",
      usd: 3.07425758,
      tokens: 21511342,
      requests: 200,
    });
  });

  test("a workspace with no traffic answers with an empty chart, not a failure", () => {
    expect(parseCostDays([])).toEqual([]);
  });

  test("rejects a payload that is not the chart", () => {
    expect(parseCostDays({ items: [] })).toBeNull();
    expect(parseCostDays([{ date: "not-a-date", totalCostMicroCents: "1" }])).toBeNull();
    expect(parseCostDays([{ date: "2026-08-26" }])).toBeNull();
  });
});

describe("parseUsagePage", () => {
  test("reads one page of the per-request table", () => {
    const page = parseUsagePage({ items: [USAGE_ROW], nextCursor: "cursor_1" });
    expect(page?.nextCursor).toBe("cursor_1");
    expect(page?.rows[0]).toEqual({
      id: "2095385180",
      sessionId: null,
      keyId: "key_01KXWPQRHHEVSJBW98THT3MSGW",
      atMs: Date.parse("2026-09-20T11:22:44.000Z"),
      model: "glm-5.3-flash",
      inputTokens: 2981,
      outputTokens: 55,
      reasoningTokens: 0,
      cacheReadTokens: 41344,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      usd: 0.00171497,
      plan: "lite",
      isByok: false,
    });
  });

  test("the last page has no cursor", () => {
    const page = parseUsagePage({ items: [], nextCursor: null });
    expect(page).toEqual({ rows: [], nextCursor: null });
  });

  test("bills credit-funded requests and leaves plan requests as allowance", () => {
    const page = parseUsagePage({
      items: [
        { ...USAGE_ROW, billingSource: "credit" },
        { ...USAGE_ROW, billingSource: "byok" },
        { ...USAGE_ROW, billingSource: "free" },
      ],
      nextCursor: null,
    });
    expect(page?.rows.map((row) => row.plan)).toEqual(["payg", "lite", "lite"]);
    expect(page?.rows.map((row) => row.isByok)).toEqual([false, true, false]);
  });

  test("rejects a payload that is not a page", () => {
    expect(parseUsagePage([USAGE_ROW])).toBeNull();
    expect(parseUsagePage({ items: [{ model: "glm-5.3" }] })).toBeNull();
  });
});

describe("parseBillingStatus", () => {
  test("reads the balance and the auto-recharge record", () => {
    const billing = parseBillingStatus(
      { billingMode: "prepaid", balanceMicroCents: "250000000", creditLimitMicroCents: null },
      { enabled: true, thresholdDollars: 5, rechargeAmountDollars: 20 },
      { hasGoAccess: true },
    );
    expect(billing?.balanceUsd).toBe(2.5);
    expect(billing?.isAutoReloadOn).toBe(true);
    expect(billing?.reloadAmountUsd).toBe(20);
    expect(billing?.hasLiteSubscription).toBe(true);
  });

  test("a go account reports no metered month, because the console publishes none", () => {
    const billing = parseBillingStatus(
      { balanceMicroCents: "0" },
      { enabled: false, rechargeAmountDollars: 20 },
      { hasGoAccess: true },
    );
    expect(billing?.monthlyUsageUsd).toBeNull();
    expect(billing?.monthlyLimitUsd).toBeNull();
    expect(billing?.isAutoReloadOn).toBe(false);
  });

  test("a lapsed plan leaves no subscription flag set", () => {
    const billing = parseBillingStatus({ balanceMicroCents: "0" }, null, { hasGoAccess: false });
    expect(billing?.hasLiteSubscription).toBe(false);
    expect(billing?.hasSubscription).toBe(false);
  });

  test("rejects a payload with no billing record", () => {
    expect(parseBillingStatus(null, null, { hasGoAccess: true })).toBeNull();
    expect(parseBillingStatus({ billingMode: "prepaid" }, null, { hasGoAccess: true })).toBeNull();
  });
});
