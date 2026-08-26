import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateRowsFromDatabase,
  readOpencodeUsage,
  usageFromRows,
} from "../../../src/data/real/opencode-db";

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function tempDatabase(name: string): string {
  const root = mkdtempSync(join(tmpdir(), name));
  tempRoots.push(root);
  return join(root, "opencode.db");
}

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
  test("executes every aggregate query inside one read transaction", () => {
    let inTransaction = false;
    let queries = 0;
    const fake = {
      transaction<T>(callback: () => T) {
        return () => {
          inTransaction = true;
          try {
            return callback();
          } finally {
            inTransaction = false;
          }
        };
      },
      query() {
        return {
          all() {
            expect(inTransaction).toBe(true);
            queries += 1;
            return [];
          },
        };
      },
    };

    expect(aggregateRowsFromDatabase(fake as unknown as Database, 0)).toHaveLength(5);
    expect(queries).toBe(5);
  });

  test("reads model tokens, token split, and cost details from message rows", () => {
    const path = tempDatabase("opencode-db-");
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
    // Per-model bars must sum to the headline; counting cache reads in one and
    // not the other made the detail screen contradict the card above it.
    expect(stats?.modelTokens30d).toEqual({ sonnet: 1_900, haiku: 300 });
    const modelSum = Object.values(stats?.modelTokens30d ?? {}).reduce((a, b) => a + b, 0);
    expect(modelSum).toBe(stats?.tokens ?? 0);
    expect(stats?.tokenSplit30d).toEqual({
      input: 1_250, output: 650, reasoning: 200, cacheRead: 3_000, cacheWrite: 100,
    });
    expect(stats?.cost30d).toEqual({ totalUsd: 2.5, peakDayUsd: 2 });
  });

  test("folds cost into local days, so the peak is a day and not a UTC slice", () => {
    // Two charges an hour apart across local midnight are two local days in
    // every timezone. Bucketing by `time_created/86400000` merges them wherever
    // the offset puts local midnight on the far side of 00:00Z, and the peak
    // then reads as their sum instead of the larger day.
    const path = tempDatabase("opencode-db-localday-");
    const db = new Database(path);
    db.run("CREATE TABLE message (session_id TEXT, time_created INTEGER, data TEXT)");
    const insert = db.prepare("INSERT INTO message VALUES (?1, ?2, ?3)");
    const row = (cost: number) => JSON.stringify({
      role: "assistant", providerID: "opencode-go", modelID: "sonnet",
      tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      cost,
    });
    insert.run("s1", new Date(2026, 7, 1, 23, 30).getTime(), row(3));
    insert.run("s2", new Date(2026, 7, 2, 0, 30).getTime(), row(1));
    db.close();

    const stats = readOpencodeUsage(path, new Date(2026, 7, 5))?.stats.get("opencode-go");

    expect(stats?.cost30d?.totalUsd).toBeCloseTo(4, 6);
    expect(stats?.cost30d?.peakDayUsd).toBeCloseTo(3, 6);
  });

  test("keeps a day whole when its charges land in different quarter-hour slots", () => {
    const path = tempDatabase("opencode-db-slots-");
    const db = new Database(path);
    db.run("CREATE TABLE message (session_id TEXT, time_created INTEGER, data TEXT)");
    const insert = db.prepare("INSERT INTO message VALUES (?1, ?2, ?3)");
    const row = (cost: number) => JSON.stringify({
      role: "assistant", providerID: "opencode-go", modelID: "sonnet", tokens: {}, cost,
    });
    insert.run("s1", new Date(2026, 7, 1, 9, 0).getTime(), row(1));
    insert.run("s2", new Date(2026, 7, 1, 9, 20).getTime(), row(1));
    insert.run("s3", new Date(2026, 7, 1, 21, 40).getTime(), row(1));
    db.close();

    const stats = readOpencodeUsage(path, new Date(2026, 7, 5))?.stats.get("opencode-go");

    // Three slots, one day: the peak is the day's total, not a single slot.
    expect(stats?.cost30d?.peakDayUsd).toBeCloseTo(3, 6);
  });

  test("reads a WAL database that no process currently has open", () => {
    // SQLite cannot open a WAL database read-only unless the -shm file already
    // exists, and it needs write access to make one. A database at rest has no
    // sidecar files, so a readonly-only open reports every local figure as
    // unreadable on exactly the machines that have opencode installed and idle.
    // Reproduced against a real ~/.local/share/opencode/opencode.db before the
    // fix; copying the file alone is what puts it in that at-rest state.
    const source = tempDatabase("opencode-db-wal-");
    const db = new Database(source);
    db.run("PRAGMA journal_mode=WAL");
    db.run("CREATE TABLE message (session_id TEXT, time_created INTEGER, data TEXT)");
    db.prepare("INSERT INTO message VALUES (?1, ?2, ?3)").run(
      "s1",
      new Date(2026, 7, 1, 12).getTime(),
      JSON.stringify({
        role: "assistant", providerID: "opencode-go", modelID: "sonnet",
        tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    const atRest = tempDatabase("opencode-db-wal-rest-");
    copyFileSync(source, atRest);

    const stats = readOpencodeUsage(atRest, new Date(2026, 7, 5))?.stats.get("opencode-go");

    expect(stats?.tokens).toBe(30);
  });

  test("folds the renamed go provider id in with the old one", () => {
    // opencode 1.18 writes providerID "opencode"; earlier versions wrote
    // "opencode-go". A machine spanning the rename holds rows under both, and
    // reading only one name hides half the history - or all of it, on a fresh
    // install, which is what happens here.
    const path = tempDatabase("opencode-db-rename-");
    const db = new Database(path);
    db.run("CREATE TABLE message (session_id TEXT, time_created INTEGER, data TEXT)");
    const insert = db.prepare("INSERT INTO message VALUES (?1, ?2, ?3)");
    const row = (provider: string, output: number) => JSON.stringify({
      role: "assistant", providerID: provider, modelID: "mimo-v2.5-free",
      tokens: { input: 0, output, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    const atMs = new Date(2026, 7, 1, 12).getTime();
    insert.run("s1", atMs, row("opencode-go", 100));
    insert.run("s2", atMs + 1000, row("opencode", 25));
    db.close();

    const usage = readOpencodeUsage(path, new Date(2026, 7, 5));

    expect(usage?.stats.get("opencode-go")?.tokens).toBe(125);
    expect(usage?.stats.get("opencode-go")?.sessions).toBe(2);
    expect(usage?.stats.get("opencode")).toBeUndefined();
  });

  test("returns null when the db file does not exist", () => {
    expect(readOpencodeUsage("/nonexistent/path/opencode.db", new Date())).toBeNull();
  });

  test("throws when an existing database is unreadable", () => {
    const path = tempDatabase("opencode-corrupt-");
    writeFileSync(path, "not sqlite");
    expect(() => readOpencodeUsage(path, new Date())).toThrow();
  });
});
