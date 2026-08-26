import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAY_MS, HOUR_MS } from "../../../src/data/real/aggregate";
import { readCodexSessions } from "../../../src/data/real/codex-sessions";

const NOW = new Date("2026-08-15T12:00:00Z");
const NOW_MS = NOW.getTime();

function turnContext(model: string): string {
  return JSON.stringify({ timestamp: new Date(NOW_MS - HOUR_MS).toISOString(), type: "turn_context", payload: { model } });
}

function tokenCount(atMs: number, tokens: number, usage: Record<string, number> = {}): string {
  return JSON.stringify({
    timestamp: new Date(atMs).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: tokens,
          cached_input_tokens: 0,
          output_tokens: 0,
          total_tokens: tokens,
          ...usage,
        },
      },
    },
  });
}

function seedRollout(home: string, dir: string, name: string, lines: string[]): void {
  const target = join(home, dir, "2026", "08", "15");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, name), lines.join("\n"));
}

function withTempHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "open-usage-codex-"));
  try {
    run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("readCodexSessions", () => {
  test("throws when a rollout path exists but is not a directory", () => {
    withTempHome((home) => {
      writeFileSync(join(home, "sessions"), "not a directory");
      expect(() => readCodexSessions(home, NOW)).toThrow();
    });
  });

  test("prunes cached files when the rollout tree disappears", () => {
    withTempHome((home) => {
      const path = join(home, "sessions", "rollout.jsonl");
      const fixedTime = new Date("2026-08-15T10:00:00Z");
      mkdirSync(join(home, "sessions"));
      writeFileSync(path, tokenCount(NOW_MS - HOUR_MS, 100));
      utimesSync(path, fixedTime, fixedTime);
      expect(readCodexSessions(home, NOW)?.tokens).toBe(100);

      rmSync(join(home, "sessions"), { recursive: true });
      expect(readCodexSessions(home, NOW)).toBeNull();
      mkdirSync(join(home, "sessions"));
      writeFileSync(path, tokenCount(NOW_MS - HOUR_MS, 900));
      utimesSync(path, fixedTime, fixedTime);
      expect(readCodexSessions(home, NOW)?.tokens).toBe(900);

      rmSync(join(home, "sessions"), { recursive: true });
      writeFileSync(join(home, "sessions"), "not a directory");
      expect(() => readCodexSessions(home, NOW)).toThrow();
      rmSync(join(home, "sessions"));
      mkdirSync(join(home, "sessions"));
      writeFileSync(path, tokenCount(NOW_MS - HOUR_MS, 800));
      utimesSync(path, fixedTime, fixedTime);
      expect(readCodexSessions(home, NOW)?.tokens).toBe(800);
    });
  });

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

describe("codex token basis", () => {
  test("counts non-cached input plus output, not codex's cache-inclusive total", () => {
    // total_tokens counts cached input, which on a long session is ~95% of it.
    // Charting that against Claude and OpenCode Go, both of which exclude cache
    // reads, once made codex look an order of magnitude larger than it was.
    withTempHome((home) => {
      seedRollout(home, "sessions", "rollout.jsonl", [
        turnContext("gpt-5.6-sol"),
        tokenCount(NOW_MS - HOUR_MS, 46_433, {
          input_tokens: 46_281,
          cached_input_tokens: 42_752,
          output_tokens: 152,
          total_tokens: 46_433,
        }),
      ]);

      expect(readCodexSessions(home, NOW)?.tokens).toBe(3_681); // 46,281 - 42,752 + 152
    });
  });

  test("falls back to total_tokens when a rollout carries no breakdown", () => {
    withTempHome((home) => {
      seedRollout(home, "sessions", "rollout.jsonl", [
        JSON.stringify({
          timestamp: new Date(NOW_MS - HOUR_MS).toISOString(),
          type: "event_msg",
          payload: { type: "token_count", info: { last_token_usage: { total_tokens: 900 } } },
        }),
      ]);

      expect(readCodexSessions(home, NOW)?.tokens).toBe(900);
    });
  });
});
