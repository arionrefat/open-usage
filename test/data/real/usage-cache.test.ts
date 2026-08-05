import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAY_MS, HOUR_MS } from "../../../src/data/real/aggregate";
import {
  readUsageCache,
  updateUsageCache,
  writeUsageCache,
  type UsageCache,
} from "../../../src/data/real/usage-cache";

function tempCache(run: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "open-usage-usage-cache-"));
  try {
    run(join(directory, "usage-cache.json"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const fetchedAtMs = Date.now();
const cache: UsageCache = {
  claude: {
    session: { percent: 24, reset: "resets in 2h" },
    weekly: { percent: 61, reset: "resets in 4d" },
    fable: { percent: 35, reset: "resets in 4d" },
    fetchedAtMs,
  },
  codex: {
    session: null,
    weekly: { usedPercent: 38, resetsAtMs: fetchedAtMs + DAY_MS, windowMinutes: 10080 },
    planType: "plus",
    resetCredits: 1,
    additionalRateLimits: [],
    credits: null,
    usage: {
      dailyTokens: new Map([["2026-08-15", 1200]]),
      summary: null,
    },
    fetchedAtMs,
  },
  go: {
    rollingPercent: 17,
    rollingResetAtMs: fetchedAtMs + HOUR_MS,
    weeklyPercent: 42,
    weeklyResetAtMs: fetchedAtMs + DAY_MS,
    monthlyPercent: 55,
    monthlyResetAtMs: fetchedAtMs + 30 * DAY_MS,
    fetchedAtMs,
    useBalance: null,
  },
};

describe("usage cache", () => {
  test("round-trips every provider, including Codex history", () => {
    tempCache((path) => {
      writeUsageCache(path, cache);
      expect(readUsageCache(path)).toEqual(cache);
    });
  });

  test("ignores malformed cache data without making it a real source", () => {
    tempCache((path) => {
      writeFileSync(path, JSON.stringify({ version: 1, claude: { percent: "bad" } }));
      expect(readUsageCache(path)).toEqual({ claude: null, codex: null, go: null });
    });
  });

  test("rejects malformed nullable provider fields", () => {
    tempCache((path) => {
      const codex = {
        ...cache.codex,
        session: { usedPercent: "bad" },
        usage: null,
      };
      writeFileSync(path, JSON.stringify({ version: 1, claude: null, codex, go: null }));
      expect(readUsageCache(path).codex).toBeNull();

      writeFileSync(path, JSON.stringify({
        version: 1,
        claude: null,
        codex: null,
        go: { ...cache.go, useBalance: "yes" },
      }));
      expect(readUsageCache(path).go).toBeNull();

      writeFileSync(path, JSON.stringify({
        version: 1,
        claude: { ...cache.claude, fable: { percent: "bad", reset: "resets in 4d" } },
        codex: null,
        go: null,
      }));
      expect(readUsageCache(path).claude).toBeNull();
    });
  });

  test("accepts older Claude cache entries without Fable", () => {
    tempCache((path) => {
      const { fable: _fable, ...claudeWithoutFable } = cache.claude!;
      writeFileSync(path, JSON.stringify({
        version: 1,
        claude: claudeWithoutFable,
        codex: null,
        go: null,
      }));
      expect(readUsageCache(path).claude).toEqual(claudeWithoutFable);
    });
  });

  test("merges provider updates with the latest on-disk cache", () => {
    tempCache((path) => {
      writeUsageCache(path, { claude: null, codex: null, go: null });
      updateUsageCache(path, "claude", cache.claude);
      updateUsageCache(path, "go", cache.go);

      expect(readUsageCache(path)).toEqual({ claude: cache.claude, codex: null, go: cache.go });
    });
  });
});
