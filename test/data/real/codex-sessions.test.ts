import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAY_MS, HOUR_MS } from "../../../src/data/real/aggregate";
import { readCodexSessions } from "../../../src/data/real/codex-sessions";

const NOW = new Date("2026-08-15T12:00:00Z");
const NOW_MS = NOW.getTime();

function turnContext(model: string): string {
  return JSON.stringify({ timestamp: new Date(NOW_MS - HOUR_MS).toISOString(), type: "turn_context", payload: { model } });
}

function tokenCount(atMs: number, tokens: number): string {
  return JSON.stringify({
    timestamp: new Date(atMs).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: { total_tokens: tokens } },
    },
  });
}

function seedRollout(home: string, dir: string, name: string, lines: string[]): void {
  const target = join(home, dir, "2026", "08", "15");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, name), lines.join("\n"));
}

function withTempHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "limitless-codex-"));
  try {
    run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("readCodexSessions", () => {
  test("returns null when no rollout directories exist", () => {
    withTempHome((home) => {
      expect(readCodexSessions(home, NOW)).toBeNull();
    });
  });

  test("sums token deltas into hour buckets across sessions and archives", () => {
    withTempHome((home) => {
      seedRollout(home, "sessions", "rollout-a.jsonl", [
        turnContext("gpt-5.6-sol"),
        tokenCount(NOW_MS - HOUR_MS, 1_000),
        tokenCount(NOW_MS - HOUR_MS, 500),
      ]);
      seedRollout(home, "archived_sessions", "rollout-b.jsonl", [
        tokenCount(NOW_MS - 2 * HOUR_MS, 250),
      ]);

      const usage = readCodexSessions(home, NOW);
      expect(usage?.sessions).toBe(2);
      expect(usage?.tokens).toBe(1_750);
      expect(usage?.latestMs).toBe(NOW_MS - HOUR_MS);
      expect(usage?.topModel).toBe("gpt-5.6-sol");
      expect(usage?.buckets.get(Math.floor((NOW_MS - HOUR_MS) / HOUR_MS))).toBe(1_500);
    });
  });

  test("attributes tokens to the current turn's model and windows stats to 30d", () => {
    withTempHome((home) => {
      seedRollout(home, "sessions", "rollout-a.jsonl", [
        turnContext("model-a"),
        tokenCount(NOW_MS - HOUR_MS, 100),
        turnContext("model-b"),
        tokenCount(NOW_MS - HOUR_MS, 300),
        // Older than the 30d stats window: charted, but not in stats.
        tokenCount(NOW_MS - 31 * DAY_MS, 10_000),
      ]);

      const usage = readCodexSessions(home, NOW);
      expect(usage?.tokens).toBe(400);
      expect(usage?.topModel).toBe("model-b");
      expect(usage?.sessions).toBe(1);
      // The old event still lands in the all-time chart buckets.
      expect(usage?.buckets.get(Math.floor((NOW_MS - 31 * DAY_MS) / HOUR_MS))).toBe(10_000);
    });
  });

  test("skips malformed lines and non-positive totals", () => {
    withTempHome((home) => {
      seedRollout(home, "sessions", "rollout-a.jsonl", [
        "not json",
        tokenCount(NOW_MS - HOUR_MS, 0),
        tokenCount(NOW_MS - HOUR_MS, -5),
        JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {} } }),
        tokenCount(NOW_MS - HOUR_MS, 42),
      ]);

      const usage = readCodexSessions(home, NOW);
      expect(usage?.tokens).toBe(42);
    });
  });
});
