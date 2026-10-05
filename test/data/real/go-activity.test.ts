import { describe, expect, test } from "bun:test";
import { blendedTokens, goActivityFromRows } from "../../../src/data/real/go-activity";
import type { GoUsageRow } from "../../../src/data/real/opencode-usage";

function row(partial: Partial<GoUsageRow> = {}): GoUsageRow {
  return {
    id: "rlg_test",
    sessionId: "ses_test1",
    atMs: new Date(2026, 7, 20, 10, 0).getTime(),
    model: "deepseek-v4-flash",
    isRejected: false,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    usd: 0,
    plan: "lite",
    ...partial,
  };
}

describe("blendedTokens", () => {
  test("holds cache reads out, matching the local db's own basis", () => {
    // opencode.db sums input + output + reasoning + cache.write. The dashboard
    // has to agree exactly, or the same provider would report two different
    // totals depending on which source answered.
    const usage = row({
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 5,
      cacheWriteTokens: 5,
      cacheReadTokens: 900_000,
    });

    expect(blendedTokens(usage)).toBe(40);
  });
});

describe("goActivityFromRows", () => {
  test("builds buckets, per-model bars and a split that agree with each other", () => {
    const { buckets, stats } = goActivityFromRows([
      row({ sessionId: "ses_test1", inputTokens: 100, outputTokens: 50, cacheReadTokens: 7_000 }),
      row({ sessionId: "ses_test1", model: "kimi-k3", outputTokens: 25 }),
      row({ sessionId: "ses_test2", inputTokens: 10, reasoningTokens: 15 }),
    ]);

    const bucketSum = [...buckets.values()].reduce((a, b) => a + b, 0);
    const modelSum = Object.values(stats.modelTokens30d ?? {}).reduce((a, b) => a + b, 0);

    expect(stats.tokens).toBe(200);
    expect(bucketSum).toBe(200);
    expect(modelSum).toBe(200);
    expect(stats.sessions).toBe(2);
    expect(stats.topModel).toBe("deepseek-v4-flash");
    // Cache reads are measured but never folded into the headline.
    expect(stats.tokenSplit30d?.cacheRead).toBe(7_000);
  });

  test("peaks the cost on a local day rather than a single row", () => {
    const { stats } = goActivityFromRows([
      row({ atMs: new Date(2026, 7, 20, 9, 0).getTime(), usd: 1, outputTokens: 1 }),
      row({ atMs: new Date(2026, 7, 20, 21, 0).getTime(), usd: 1, outputTokens: 1 }),
      row({ atMs: new Date(2026, 7, 21, 9, 0).getTime(), usd: 1.5, outputTokens: 1 }),
    ]);

    expect(stats.cost30d?.totalUsd).toBeCloseTo(3.5, 6);
    expect(stats.cost30d?.peakDayUsd).toBeCloseTo(2, 6);
  });

  test("a refused request counts its session but not toward the top model", () => {
    const { stats, rejected30d } = goActivityFromRows([
      row({ sessionId: "ses_test1", model: "glm-5.3-flash", outputTokens: 4 }),
      row({ sessionId: "ses_test2", model: "grok-4.7", isRejected: true }),
      row({ sessionId: "ses_test2", model: "grok-4.7", isRejected: true }),
    ]);

    expect(rejected30d).toBe(2);
    expect(stats.topModel).toBe("glm-5.3-flash");
    expect(stats.sessions).toBe(2);
    expect(stats.tokens).toBe(4);
  });
});
