import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOpencodeUsage, usageFromRows } from "../../../src/data/real/opencode-db";

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

  test("picks the most-used model per provider", () => {
    const usage = usageFromRows(
      [],
      [{ provider: "openai", sessions: 2, tokens: 100, latest: 5 }],
      [
        { provider: "openai", model: "gpt-5.6-sol", msgs: 900 },
        { provider: "openai", model: "gpt-5-mini", msgs: 40 },
        { provider: "opencode-go", model: "claude-sonnet", msgs: 12 },
        { provider: "openai", model: 7, msgs: 5000 },
      ],
    );
    expect(usage.stats.get("openai")?.topModel).toBe("gpt-5.6-sol");
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
    expect(usage.stats.get("openai")).toEqual({
      sessions: 0,
      tokens: 0,
      latestMs: 0,
      topModel: null,
    });
  });
});

describe("readOpencodeUsage", () => {
  test("reads model tokens, token split, and cost details from message rows", () => {
    const path = join(mkdtempSync(join(tmpdir(), "opencode-db-")), "opencode.db");
    const db = new Database(path);
    db.run("CREATE TABLE message (session_id TEXT, time_created INTEGER, data TEXT)");
    const insert = db.prepare("INSERT INTO message VALUES (?1, ?2, ?3)");
    const atMs = Date.parse("2026-08-01T12:00:00Z");
    insert.run("s1", atMs, JSON.stringify({
      role: "assistant", providerID: "opencode-go", modelID: "sonnet",
      tokens: { input: 1000, output: 500, reasoning: 200, cache: { read: 3000, write: 100 } },
      cost: 1.25,
    }));
    insert.run("s2", atMs + 1000, JSON.stringify({
      role: "assistant", providerID: "opencode-go", modelID: "haiku",
      tokens: { input: 200, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.75,
    }));
    insert.run("s3", atMs - 86_400_000, JSON.stringify({
      role: "assistant", providerID: "opencode-go", modelID: "sonnet",
      tokens: { input: 50, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.5,
    }));
    db.close();

    const stats = readOpencodeUsage(path, new Date("2026-08-02T12:00:00Z"))?.stats.get("opencode-go");
    expect(stats?.modelTokens30d).toEqual({ sonnet: 4_900, haiku: 300 });
    expect(stats?.tokenSplit30d).toEqual({
      input: 1_250, output: 650, reasoning: 200, cacheRead: 3_000, cacheWrite: 100,
    });
    expect(stats?.cost30d).toEqual({ totalUsd: 2.5, peakDayUsd: 2 });
  });

  test("returns null when the db file does not exist", () => {
    expect(readOpencodeUsage("/nonexistent/path/opencode.db", new Date())).toBeNull();
  });
});
