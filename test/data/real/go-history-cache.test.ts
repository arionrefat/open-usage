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
        isAutoReloadPending: false,
        autoReloadFailure: "card_declined",
        hasLiteSubscription: true,
        hasSubscription: false,
      },
      workspaceId: "wrk_1",
      month: "2026-08",
    },
  ],
  rows: [
    {
      id: "rlg_test1",
      sessionId: "ses_test1",
      atMs: fetchedAtMs,
      model: "kimi-k3",
      isRejected: false,
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usd: 0,
      plan: "lite",
    },
  ],
  costCoverage: [{ from: "2026-07-20", until: "2026-08-18" }],
  hasCostGap: false,
  hasRequestLogDrift: false,
  fetchedAtMs,
};

/** What the release before the request log wrote, rows from the retired usage table included. */
const VERSION_1_FILE = {
  version: 1,
  reading: {
    // Billing records then carried no auto-recharge state.
    months: reading.months.map((month) => {
      if (!month.billing) return month;
      const { isAutoReloadPending: _pending, autoReloadFailure: _failure, ...billing } = month.billing;
      return { ...month, billing };
    }),
    rows: [
      {
        id: "2095385180",
        sessionId: null,
        keyId: null,
        atMs: fetchedAtMs,
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
      },
    ],
    fetchedAtMs,
  },
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
      writeFileSync(path, JSON.stringify({ version: 3, reading }));
      expect(readGoHistoryCache(path)).toBeNull();
    });
  });

  test("an older file keeps its months and drops rows the request log cannot join", () => {
    tempCache((path) => {
      writeFileSync(path, JSON.stringify(VERSION_1_FILE));

      const migrated = readGoHistoryCache(path);
      expect(migrated?.months[0]?.costs).toEqual(reading.months[0]?.costs);
      expect(migrated?.months[0]?.billing?.autoReloadFailure).toBeNull();
      expect(migrated?.months[0]?.billing?.isAutoReloadPending).toBe(false);
      // Banked, but nothing recorded which days those reads answered for.
      expect(migrated?.costCoverage).toEqual([]);
      // Old table ids share nothing with request log ids, so keeping these
      // would count every request twice once the log is walked.
      expect(migrated?.rows).toBeNull();
      // Stamped as never fetched, so the first poll walks the log at once.
      expect(migrated?.fetchedAtMs).toBe(0);
    });
  });
});
