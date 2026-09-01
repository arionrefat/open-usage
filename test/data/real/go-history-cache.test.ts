import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGoHistoryCache, writeGoHistoryCache } from "../../../src/data/real/go-history-cache";
import type { GoHistoryReading } from "../../../src/data/real/go-history-source";

function tempCache(run: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "open-usage-go-history-"));
  try {
    run(join(directory, "go-history.json"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const fetchedAtMs = Date.now();
const reading: GoHistoryReading = {
  months: [
    {
      costs: {
        rows: [{ date: "2026-08-01", model: "kimi-k3", usd: 1.5, keyId: null, plan: "lite" }],
        keys: [{ id: "key_1", displayName: "laptop", isDeleted: false }],
      },
      billing: {
        balanceUsd: 0,
        monthlyUsageUsd: null,
        monthlyLimitUsd: null,
        isAutoReloadOn: false,
        reloadAmountUsd: 20,
        hasLiteSubscription: true,
        hasSubscription: false,
      },
      workspaceId: "wrk_1",
      month: "2026-08",
    },
  ],
  rows: [
    {
      id: "usg_1",
      sessionId: "ses_1",
      keyId: null,
      atMs: fetchedAtMs,
      model: "kimi-k3",
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      usd: 0,
      plan: "lite",
      isByok: false,
    },
  ],
  fetchedAtMs,
};

describe("go history cache", () => {
  test("round-trips a reading with restrictive permissions", () => {
    tempCache((path) => {
      writeGoHistoryCache(path, reading);
      expect(readGoHistoryCache(path)).toEqual(reading);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });
  });

  test("one corrupt row discards the reading rather than the row", () => {
    tempCache((path) => {
      writeGoHistoryCache(path, reading);
      const raw = JSON.parse(readFileSync(path, "utf8"));
      raw.reading.rows[0].inputTokens = "many";
      writeFileSync(path, JSON.stringify(raw));

      expect(readGoHistoryCache(path)).toBeNull();
    });
  });

  test("a missing, malformed, or foreign-version file reads as no history", () => {
    tempCache((path) => {
      expect(readGoHistoryCache(path)).toBeNull();
      writeFileSync(path, "not json");
      expect(readGoHistoryCache(path)).toBeNull();
      writeFileSync(path, JSON.stringify({ version: 2, reading }));
      expect(readGoHistoryCache(path)).toBeNull();
    });
  });
});
