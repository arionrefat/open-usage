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

/**
 * One page of `GET /console/api/request-logs` as the console sent it on
 * 2026-10-06, ids replaced and headers, location and user agent emptied. The
 * three outcomes are all here: a grok-4.7 request whose reasoning sits inside
 * its output, the 429 that followed it at the five-hour cap, and a failure.
 */
const REQUEST_LOG_PAGE = {
  items: [
    {
      id: "rlg_test1",
      requestID: "req_test1",
      workspaceID: "wrk_test",
      startedAt: 1791233490912,
      finishedAt: 1791233736913,
      durationMs: 246001,
      outcome: "succeeded",
      category: "inference",
      protocol: "openai-responses",
      product: "go",
      path: "/inference/go/openai/v1/responses",
      method: "POST",
      stream: true,
      app: "pi",
      sessionID: "ses_test1",
      userAgent: "pi/test",
      serviceAccountID: "sva_test",
      serviceAPIKeyID: "key_test",
      requestedModel: "grok-4.7",
      model: "grok-4.7",
      provider: "opencode",
      connectionID: null,
      statusCode: 200,
      errorCode: null,
      errorMessage: null,
      timeToFirstTokenMs: 2920,
      inputTokens: 4067,
      outputTokens: 16926,
      reasoningMode: "effort",
      reasoningEffort: "high",
      firstTokenAt: 1791233493832,
      lastTokenAt: 1791233736071,
      reasoningTokens: 16855,
      cacheReadTokens: 113152,
      cacheWriteTokens: 0,
      cost: 0.16084381,
      providerCost: null,
      country: "XX",
      region: "test",
      city: "test",
      requestHeaders: {},
      responseHeaders: {},
      metadata: {},
      attemptCount: 1,
      attempts: [
        {
          provider: "opencode",
          model: "grok-4.7",
          statusCode: 200,
          durationMs: 245131,
          errorCode: null,
          errorMessage: null,
        },
      ],
    },
    {
      id: "rlg_test2",
      requestID: "req_test2",
      workspaceID: "wrk_test",
      startedAt: 1791233736875,
      finishedAt: 1791233736942,
      durationMs: 67,
      outcome: "rejected",
      category: "inference",
      protocol: "openai-responses",
      product: "go",
      path: "/inference/go/openai/v1/responses",
      method: "POST",
      stream: true,
      app: "pi",
      sessionID: "ses_test1",
      userAgent: "pi/test",
      serviceAccountID: "sva_test",
      serviceAPIKeyID: "key_test",
      requestedModel: "grok-4.7",
      model: "grok-4.7",
      provider: "opencode",
      connectionID: null,
      statusCode: 429,
      errorCode: "inference_failed",
      errorMessage: "The inference request failed.",
      reasoningMode: "effort",
      reasoningEffort: "high",
      providerCost: null,
      country: "XX",
      region: "test",
      city: "test",
      requestHeaders: {},
      responseHeaders: {},
      metadata: {},
      attemptCount: 0,
      attempts: [],
    },
    {
      id: "rlg_test3",
      requestID: "req_test3",
      workspaceID: "wrk_test",
      startedAt: 1791034991546,
      finishedAt: 1791035022866,
      durationMs: 31320,
      outcome: "failed",
      category: "inference",
      protocol: "openai-chat",
      product: "go",
      path: "/inference/go/openai/v1/chat/completions",
      method: "POST",
      stream: true,
      app: "pi",
      sessionID: "ses_test2",
      userAgent: "pi/test",
      serviceAccountID: "sva_test",
      serviceAPIKeyID: "key_test",
      requestedModel: "glm-5.3-flash",
      model: "glm-5.3-flash",
      provider: "opencode",
      connectionID: null,
      statusCode: 200,
      errorCode: "inference_failed",
      errorMessage: null,
      reasoningMode: "effort",
      reasoningEffort: "high",
      providerCost: null,
      country: "XX",
      region: "test",
      city: "test",
      requestHeaders: {},
      responseHeaders: {},
      metadata: {},
      attemptCount: 1,
      attempts: [
        {
          provider: "opencode",
          model: "glm-5.3-flash",
          statusCode: 200,
          durationMs: 30553,
          errorCode: "inference_failed",
          errorMessage: null,
        },
      ],
    },
  ],
  nextCursor: "cursor_test",
  until: 1791235844773,
  retentionDays: 30,
};

const [SUCCEEDED, REJECTED] = REQUEST_LOG_PAGE.items;

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
  test("reads one page of the live request log", () => {
    const page = parseUsagePage(REQUEST_LOG_PAGE);
    expect(page?.nextCursor).toBe("cursor_test");
    expect(page?.untilMs).toBe(1791235844773);
    expect(page?.rows).toHaveLength(3);
    expect(page?.rows[0]).toEqual({
      id: "rlg_test1",
      sessionId: "ses_test1",
      atMs: 1791233490912,
      model: "grok-4.7",
      isRejected: false,
      inputTokens: 4067,
      // 16926 reported, 16855 of it reasoning: the split must not count it twice.
      outputTokens: 71,
      reasoningTokens: 16855,
      cacheReadTokens: 113152,
      cacheWriteTokens: 0,
      // Plain dollars on this route, unlike the cost chart's micro-cents.
      usd: 0.16084381,
      plan: "lite",
    });
  });

  test("output plus reasoning gives back what the log reported", () => {
    const row = parseUsagePage(REQUEST_LOG_PAGE)?.rows[0];
    expect((row?.outputTokens ?? 0) + (row?.reasoningTokens ?? 0)).toBe(16926);
  });

  test("a request refused at the cap is kept, flagged and empty", () => {
    const [, rejected, failed] = parseUsagePage(REQUEST_LOG_PAGE)?.rows ?? [];
    expect(rejected?.isRejected).toBe(true);
    expect(rejected?.inputTokens).toBe(0);
    expect(rejected?.usd).toBe(0);
    // A failure ran inference and is not a refusal at a cap.
    expect(failed?.isRejected).toBe(false);
  });

  test("the last page has no cursor", () => {
    const page = parseUsagePage({ items: [], nextCursor: null, until: 1, retentionDays: 30 });
    expect(page).toEqual({ rows: [], nextCursor: null, untilMs: 1 });
  });

  test("bills pay-as-you-go requests and leaves plan and own-provider requests as allowance", () => {
    const page = parseUsagePage({
      items: [
        { ...SUCCEEDED, id: "rlg_a", product: "standard" },
        { ...SUCCEEDED, id: "rlg_b", product: "go-plus" },
        { ...SUCCEEDED, id: "rlg_c", product: "byok" },
      ],
      nextCursor: null,
    });
    expect(page?.rows.map((row) => row.plan)).toEqual(["payg", "lite", "lite"]);
  });

  test("a succeeded request missing its counts is drift, not an empty request", () => {
    const renamed = Object.fromEntries(
      Object.entries({ ...SUCCEEDED, input_tokens: 4067 }).filter(([key]) => key !== "inputTokens"),
    );
    expect(parseUsagePage({ items: [renamed], nextCursor: null })).toBeNull();
    // A refusal carries no counts at all and is still a valid row.
    expect(parseUsagePage({ items: [REJECTED], nextCursor: null })?.rows).toHaveLength(1);
  });

  test("rejects a payload that is not a page", () => {
    expect(parseUsagePage(REQUEST_LOG_PAGE.items)).toBeNull();
    expect(parseUsagePage({ items: [{ model: "glm-5.3" }] })).toBeNull();
    expect(parseUsagePage({ items: [{ ...SUCCEEDED, id: undefined }] })).toBeNull();
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

  test("keeps a pending or failed top-up, which the live record reports as null and false", () => {
    // Verbatim from a live `GET /console/api/billing/auto-recharge`.
    const live = { enabled: false, thresholdDollars: 5, rechargeAmountDollars: 20, pending: false, failureReason: null };
    const quiet = parseBillingStatus({ balanceMicroCents: "0" }, live, { hasGoAccess: true });
    expect(quiet?.isAutoReloadPending).toBe(false);
    expect(quiet?.autoReloadFailure).toBeNull();

    const failed = parseBillingStatus(
      { balanceMicroCents: "0" },
      { ...live, enabled: true, pending: true, failureReason: "card_declined" },
      { hasGoAccess: true },
    );
    expect(failed?.isAutoReloadPending).toBe(true);
    expect(failed?.autoReloadFailure).toBe("card_declined");
    // A reason in a shape we cannot print is still a failure, not silence.
    const odd = parseBillingStatus({ balanceMicroCents: "0" }, { ...live, failureReason: { code: 1 } }, { hasGoAccess: true });
    expect(odd?.autoReloadFailure).toBe("unknown reason");
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
