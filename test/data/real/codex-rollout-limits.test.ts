import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAY_MS, HOUR_MS } from "../../../src/data/real/aggregate";
import {
  createCodexRolloutLimitsSource,
  readRolloutLimits,
} from "../../../src/data/real/codex-rollout-limits";

const NOW = new Date("2026-10-27T12:00:00Z");
const NOW_MS = NOW.getTime();
const WEEK_RESET_S = (NOW_MS + 5 * DAY_MS) / 1000;

function tokenCount(atMs: number, rateLimits: unknown): string {
  return JSON.stringify({
    timestamp: new Date(atMs).toISOString(),
    type: "event_msg",
    payload: { type: "token_count", info: null, rate_limits: rateLimits },
  });
}

/** The shape a Pro 100 account writes: one weekly window, reported as primary. */
function weeklySnapshot(usedPercent: number, resetsAtS = WEEK_RESET_S): Record<string, unknown> {
  return {
    limit_id: "codex",
    primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: resetsAtS },
    secondary: null,
    credits: { has_credits: false, unlimited: false, balance: "0" },
    plan_type: "prolite",
    spend_control_reached: null,
    rate_limit_reached_type: null,
  };
}

function seedRollout(home: string, name: string, lines: string[], mtimeMs: number): void {
  const dir = join(home, "sessions", "2026", "10", name.slice(8, 10));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-10-${name}.jsonl`);
  writeFileSync(path, lines.join("\n"));
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

function withTempHome(run: (home: string) => void | Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "open-usage-codex-rollout-"));
  return Promise.resolve(run(home)).finally(() => rmSync(home, { recursive: true, force: true }));
}

describe("readRolloutLimits", () => {
  test("reads the newest snapshot as the account's plan and weekly window", () =>
    withTempHome((home) => {
      seedRollout(home, "27T09-00-00-a", [
        tokenCount(NOW_MS - 3 * HOUR_MS, weeklySnapshot(1)),
        tokenCount(NOW_MS - 2 * HOUR_MS, weeklySnapshot(2)),
        // openai/codex#14880: a later event can carry no snapshot at all.
        tokenCount(NOW_MS - HOUR_MS, null),
      ], NOW_MS - HOUR_MS);

      const limits = readRolloutLimits(home, NOW);

      expect(limits?.planType).toBe("prolite");
      expect(limits?.session).toBeNull();
      expect(limits?.weekly).toEqual({ usedPercent: 2, resetsAtMs: WEEK_RESET_S * 1000, windowMinutes: 10080 });
      expect(limits?.fetchedAtMs).toBe(NOW_MS - 2 * HOUR_MS);
    }));

  test("prefers the newest rollout and steps past one without a snapshot", () =>
    withTempHome((home) => {
      seedRollout(home, "26T09-00-00-a", [tokenCount(NOW_MS - DAY_MS, weeklySnapshot(40))], NOW_MS - DAY_MS);
      seedRollout(home, "27T08-00-00-b", [tokenCount(NOW_MS - 3 * HOUR_MS, weeklySnapshot(45))], NOW_MS - 3 * HOUR_MS);
      seedRollout(home, "27T10-00-00-c", [tokenCount(NOW_MS - HOUR_MS, null)], NOW_MS - HOUR_MS);

      expect(readRolloutLimits(home, NOW)?.weekly?.usedPercent).toBe(45);
    }));

  test("drops a window whose reset has already passed", () =>
    withTempHome((home) => {
      seedRollout(home, "27T09-00-00-a", [
        tokenCount(NOW_MS - HOUR_MS, weeklySnapshot(80, (NOW_MS - 1000) / 1000)),
      ], NOW_MS - HOUR_MS);

      const limits = readRolloutLimits(home, NOW);

      expect(limits?.planType).toBe("prolite");
      expect(limits?.weekly).toBeNull();
    }));

  test("ignores rollouts untouched for over a week", () =>
    withTempHome((home) => {
      seedRollout(home, "18T09-00-00-a", [tokenCount(NOW_MS - 9 * DAY_MS, weeklySnapshot(10))], NOW_MS - 9 * DAY_MS);

      expect(readRolloutLimits(home, NOW)).toBeNull();
    }));

  test("returns null without a sessions directory", () =>
    withTempHome((home) => {
      expect(readRolloutLimits(home, NOW)).toBeNull();
    }));
});

describe("createCodexRolloutLimitsSource", () => {
  test("reports a reading as cached, with its age in the note", () =>
    withTempHome(async (home) => {
      seedRollout(home, "27T09-00-00-a", [tokenCount(NOW_MS - 2 * HOUR_MS, weeklySnapshot(2))], NOW_MS - HOUR_MS);
      const source = createCodexRolloutLimitsSource(home);

      await source.poll(NOW);

      expect(source.read()?.weekly?.usedPercent).toBe(2);
      expect(source.status?.()).toBe("cached");
      expect(source.note()).toStartWith("from the last codex session, ");
    }));

  test("explains the missing CLI when no session carries a snapshot", () =>
    withTempHome(async (home) => {
      const source = createCodexRolloutLimitsSource(home);

      await source.poll(NOW);

      expect(source.read()).toBeNull();
      expect(source.status?.()).toBe("expired");
      expect(source.note()).toBe("no codex cli - limits appear after a codex session");
    }));
});
