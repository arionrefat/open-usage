import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalModelId,
  isPricedModel,
  loadPriceTable,
  modelUsageKey,
  priceTokens,
  splitModelUsageKey,
  type TokenUsage,
} from "../../../src/data/real/pricing";

function tokens(partial: Partial<TokenUsage> = {}): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...partial };
}

const MILLION = 1_000_000;

describe("canonicalModelId", () => {
  test("strips the context-window suffix, which does not change price", () => {
    expect(canonicalModelId("claude-opus-5[1m]")).toBe("claude-opus-5");
  });

  test("strips a trailing date stamp", () => {
    expect(canonicalModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  test("leaves a plain id alone", () => {
    expect(canonicalModelId("claude-sonnet-5")).toBe("claude-sonnet-5");
  });
});

describe("priceTokens", () => {
  test("prices input and output at the published per-million rates", () => {
    // Opus 5 is $5 in / $25 out per million.
    const { usd } = priceTokens("claude-opus-5", tokens({ input: MILLION, output: MILLION }));

    expect(usd).toBeCloseTo(30, 10);
  });

  test("cache reads bill at a tenth of input", () => {
    const { usd } = priceTokens("claude-opus-5", tokens({ cacheRead: MILLION }));

    expect(usd).toBeCloseTo(0.5, 10);
  });

  test("cache writes bill at 1.25x for 5m and 2x for 1h", () => {
    const short = priceTokens("claude-opus-5", tokens({ cacheWrite5m: MILLION }));
    const long = priceTokens("claude-opus-5", tokens({ cacheWrite1h: MILLION }));

    expect(short.usd).toBeCloseTo(6.25, 10);
    expect(long.usd).toBeCloseTo(10, 10);
  });

  test("fast mode bills at its own rate", () => {
    const standard = priceTokens("claude-opus-5", tokens({ output: MILLION, speed: "standard" }));
    const fast = priceTokens("claude-opus-5", tokens({ output: MILLION, speed: "fast" }));

    expect(standard.usd).toBeCloseTo(25, 10);
    expect(fast.usd).toBeCloseTo(50, 10);
  });

  test("a model with no fast rate ignores the fast flag rather than inventing one", () => {
    const fast = priceTokens("claude-sonnet-5", tokens({ output: MILLION, speed: "fast" }));

    expect(fast.usd).toBeCloseTo(15, 10);
  });

  test("an unknown model reports null, never zero", () => {
    // A zero here would silently understate a real bill.
    const { usd } = priceTokens("claude-something-new", tokens({ output: MILLION }));

    expect(usd).toBeNull();
    expect(isPricedModel("claude-something-new")).toBe(false);
  });

  test("the 1m context variant prices as the base model", () => {
    const base = priceTokens("claude-opus-5", tokens({ output: MILLION }));
    const wide = priceTokens("claude-opus-5[1m]", tokens({ output: MILLION }));

    expect(wide.usd).toBe(base.usd);
  });
});

describe("modelUsageKey", () => {
  test("round-trips a standard model", () => {
    expect(splitModelUsageKey(modelUsageKey("claude-opus-5", "standard"))).toEqual({
      model: "claude-opus-5",
      speed: "standard",
    });
  });

  test("keeps fast usage in its own bucket so it cannot be priced as standard", () => {
    const key = modelUsageKey("claude-opus-5", "fast");

    expect(key).not.toBe("claude-opus-5");
    expect(splitModelUsageKey(key)).toEqual({ model: "claude-opus-5", speed: "fast" });
  });
});

describe("loadPriceTable", () => {
  test("a missing overrides file falls back to the shipped table", () => {
    const table = loadPriceTable("/nonexistent/pricing.json");

    expect(table["claude-opus-5"]?.input).toBe(5);
  });

  test("overrides replace a shipped price without a release", () => {
    const dir = mkdtempSync(join(tmpdir(), "open-usage-pricing-"));
    const path = join(dir, "pricing.json");
    writeFileSync(path, JSON.stringify({ "claude-opus-5": { input: 4, output: 20 } }));

    const table = loadPriceTable(path);

    expect(table["claude-opus-5"]).toEqual({ input: 4, output: 20 });
    expect(table["claude-sonnet-5"]?.input).toBe(3);
  });

  test("a malformed entry is skipped rather than breaking every price", () => {
    const dir = mkdtempSync(join(tmpdir(), "open-usage-pricing-"));
    const path = join(dir, "pricing.json");
    writeFileSync(path, JSON.stringify({ "claude-opus-5": { input: "free" } }));

    const table = loadPriceTable(path);

    expect(table["claude-opus-5"]?.input).toBe(5);
  });
});
