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
    session: { percent: 24, reset: "resets in 2h", resetsAtMs: fetchedAtMs + 2 * HOUR_MS },
    weekly: { percent: 61, reset: "resets in 4d" },
    scoped: [
      {
        id: "fable",
        scope: "model",
        name: "Fable",
        percent: 35,
        reset: "resets in 4d",
        resetsAtMs: fetchedAtMs + 4 * DAY_MS,
      },
      { id: "surface-claude-code", scope: "surface", name: "Claude Code", percent: 5, reset: "no usage yet" },
    ],
    extraUsage: {
      used: { amountMinor: 1234, currency: "USD", exponent: 2 },
      monthlyLimit: null,
      utilization: null,
    },
    fetchedAtMs,
  },
  codex: {
    session: null,
    weekly: { usedPercent: 38, resetsAtMs: fetchedAtMs + DAY_MS, windowMinutes: 10080 },
    planType: "plus",
    resetCredits: 1,
    resetCreditsExpireAtMs: null,
    isSpendControlReached: false,
    isOrdinaryUsageAllowed: false,
    rateLimitReachedType: null,
    spendControl: null,
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
        codex: { ...codex, session: null, isOrdinaryUsageAllowed: "no" },
        go: null,
      }));
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
        claude: { ...cache.claude, scoped: [{ id: "fable", percent: "bad", reset: "resets in 4d" }] },
        codex: null,
        go: null,
      }));
      expect(readUsageCache(path).claude).toBeNull();

      writeFileSync(path, JSON.stringify({
        version: 1,
        claude: { ...cache.claude, session: { percent: 24, reset: "resets in 2h", resetsAtMs: "soon" } },
        codex: null,
        go: null,
      }));
      expect(readUsageCache(path).claude).toBeNull();
    });
  });

  test("reads Claude entries cached before scoped lanes, keeping Fable on its id", () => {
    const legacy = {
      session: { percent: 24, reset: "resets in 2h" },
      weekly: { percent: 61, reset: "resets in 4d" },
      fetchedAtMs,
    };
    const write = (path: string, claude: unknown) =>
      writeFileSync(path, JSON.stringify({ version: 1, claude, codex: null, go: null }));
    tempCache((path) => {
      write(path, { ...legacy, fable: { percent: 35, reset: "resets in 4d" } });
      expect(readUsageCache(path).claude).toEqual({
        ...legacy,
        scoped: [{ id: "fable", scope: "model", name: "Fable", percent: 35, reset: "resets in 4d" }],
      });

      write(path, legacy);
      expect(readUsageCache(path).claude).toEqual({ ...legacy, scoped: [] });

      write(path, { ...legacy, fable: { percent: "bad", reset: "resets in 4d" } });
      expect(readUsageCache(path).claude).toBeNull();
    });
  });

  test("accepts older Codex cache entries without the grant deadline", () => {
    tempCache((path) => {
      const {
        resetCreditsExpireAtMs: _expiry,
        isSpendControlReached: _blocked,
        isOrdinaryUsageAllowed: _ordinaryUsage,
        rateLimitReachedType: _reachedType,
        spendControl: _spendControl,
        ...codexBeforeTheFields
      } = cache.codex!;
      writeFileSync(path, JSON.stringify({
        version: 1,
        claude: null,
        codex: { ...codexBeforeTheFields, usage: { dailyTokens: [["2026-08-15", 1200]], summary: null } },
        go: null,
      }));

      // Rejecting the entry would show "not connected" for a provider that is.
      const restored = readUsageCache(path).codex;
      expect(restored?.weekly?.usedPercent).toBe(38);
      expect(restored?.resetCreditsExpireAtMs).toBeNull();
      expect(restored?.isSpendControlReached).toBe(false);
      expect(restored?.isOrdinaryUsageAllowed).toBeNull();
      expect(restored?.rateLimitReachedType).toBeNull();
      expect(restored?.spendControl).toBeNull();
    });
  });

  test("drops the money from a spend control cached when it still carried one", () => {
    tempCache((path) => {
      writeFileSync(path, JSON.stringify({
        version: 1,
        claude: null,
        go: null,
        codex: {
          ...cache.codex,
          usage: { dailyTokens: [["2026-08-15", 1200]], summary: null },
          spendControl: { limit: 50, used: 12.5, usedPercent: 25, resetsAtMs: null },
        },
      }));

      // Rejecting the entry over keys we stopped reading would blank a
      // connected provider on the first launch after an upgrade.
      expect(readUsageCache(path).codex?.spendControl).toEqual({
        usedPercent: 25,
        resetsAtMs: null,
      });
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

describe("go workspace", () => {
  test("round-trips the workspace a limits reading came from", () => {
    tempCache((path) => {
      const withWorkspace: UsageCache = { ...cache, go: { ...cache.go!, workspaceId: "wrk_1" } };
      writeUsageCache(path, withWorkspace);
      expect(readUsageCache(path)).toEqual(withWorkspace);
    });
  });

  test("round-trips a plan set to end at its period", () => {
    tempCache((path) => {
      const cancelling: UsageCache = { ...cache, go: { ...cache.go!, isCancelling: true } };
      writeUsageCache(path, cancelling);
      expect(readUsageCache(path)).toEqual(cancelling);
    });
  });
});
