import { describe, expect, test } from "bun:test";
import { readOpencodeUsage, usageFromRows } from "./opencode-db";

describe("usageFromRows", () => {
  test("groups hour rows by provider", () => {
    const usage = usageFromRows(
      [
        { hour: 100, provider: "openai", tokens: 500 },
        { hour: 101, provider: "openai", tokens: 300 },
        { hour: 100, provider: "opencode-go", tokens: 200 },
      ],
      [
        { provider: "openai", sessions: 4, tokens: 800, latest: 9_000 },
        { provider: "opencode-go", sessions: 2, tokens: 200, latest: 12_000 },
      ],
    );

    expect(usage.buckets.get("openai")?.get(100)).toBe(500);
    expect(usage.buckets.get("openai")?.get(101)).toBe(300);
    expect(usage.buckets.get("opencode-go")?.get(100)).toBe(200);
    expect(usage.stats.get("openai")?.sessions).toBe(4);
    expect(usage.latestMs).toBe(12_000);
  });

  test("drops malformed rows instead of throwing", () => {
    const usage = usageFromRows(
      [
        null,
        "row",
        { hour: "x", provider: "openai", tokens: 5 },
        { hour: 1, provider: 7, tokens: 5 },
        { hour: 1, provider: "openai", tokens: null },
        { hour: 1, provider: "openai", tokens: -3 },
      ],
      [null, { provider: "openai" }],
    );
    expect(usage.buckets.size).toBe(0);
    expect(usage.stats.get("openai")).toEqual({ sessions: 0, tokens: 0, latestMs: 0 });
  });
});

describe("readOpencodeUsage", () => {
  test("returns null when the db file does not exist", () => {
    expect(readOpencodeUsage("/nonexistent/path/opencode.db", new Date())).toBeNull();
  });
});
