import { describe, expect, test } from "bun:test";
import { blendedTokens, goActivityFromRows } from "../../../src/data/real/go-activity";
import type { GoUsageRow } from "../../../src/data/real/opencode-usage";

function row(partial: Partial<GoUsageRow> = {}): GoUsageRow {
  return {
    sessionId: "ses_1",
    keyId: null,
    atMs: new Date(2026, 7, 20, 10, 0).getTime(),
    model: "deepseek-v4-flash",
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    usd: 0,
    plan: "lite",
    isByok: false,
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
      cacheWrite5mTokens: 3,
      cacheWrite1hTokens: 2,
      cacheReadTokens: 900_000,
    });

    expect(blendedTokens(usage)).toBe(40);
  });
});

describe("goActivityFromRows", () => {
  test("builds buckets, per-model bars and a split that agree with each other", () => {
    const { buckets, stats } = goActivityFromRows([
      row({ sessionId: "a", inputTokens: 100, outputTokens: 50, cacheReadTokens: 7_000 }),
      row({ sessionId: "a", model: "kimi-k3", outputTokens: 25 }),
      row({ sessionId: "b", inputTokens: 10, reasoningTokens: 15 }),
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

  test("keeps an untimed row in the totals without placing it on a day", () => {
    const { buckets, stats } = goActivityFromRows([row({ atMs: null, outputTokens: 90 })]);

    expect(stats.tokens).toBe(90);
    expect(buckets.size).toBe(0);
  });
});
