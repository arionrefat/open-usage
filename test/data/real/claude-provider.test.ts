import { describe, expect, test } from "bun:test";
import { HOUR_MS } from "../../../src/data/real/aggregate";
import { buildClaudeProvider, createClaudeMeta } from "../../../src/data/real/claude-provider";
import type { SnapshotFile, WeeklyTrend } from "../../../src/data/real/statusline-snapshot";

const NOW = new Date(2026, 0, 15, 12);
const NOW_MS = NOW.getTime();

function snapshot(ageMs: number, weeklyPercent = 40): SnapshotFile {
  return {
    ageMs,
    writtenAtMs: NOW_MS - ageMs,
    reading: {
      fiveHour: { percent: 25.4, resetsAtMs: NOW_MS + HOUR_MS },
      sevenDay: { percent: weeklyPercent, resetsAtMs: NOW_MS + 10 * HOUR_MS },
    },
  };
}

function trend(rate: number | null): WeeklyTrend {
  return { observe: () => rate };
}

function build(options: {
  snapshotFile?: SnapshotFile | null;
  hasStatusline?: boolean;
  trendRate?: number | null;
} = {}) {
  return buildClaudeProvider({
    meta: createClaudeMeta(),
    transcripts: { buckets: new Map(), latestMs: 0 },
    history: { prompts: 0, sessions: 0, latestMs: 0 },
    snapshotFile: options.snapshotFile ?? null,
    hasStatusline: options.hasStatusline ?? true,
    trend: trend(options.trendRate ?? null),
    dates: ["2026-01-15"],
    now: NOW,
  });
}

describe("buildClaudeProvider", () => {
  test("a fresh snapshot exposes session and weekly percentages without a notice", () => {
    const provider = build({ snapshotFile: snapshot(60_000) });

    expect(provider.scopes.session.percent).toBe(25);
    expect(provider.scopes.weekly.percent).toBe(40);
    expect(provider.notice).toBeUndefined();
  });

  test("a stale snapshot adds the stale footnote and notice", () => {
    const provider = build({ snapshotFile: snapshot(11 * 60_000) });

    expect(provider.limits[0]?.footnote).toContain("snapshot stale");
    expect(provider.notice?.segments[0]?.text).toContain("snapshot stale");
  });

  test("a missing snapshot yields capless session and weekly limits", () => {
    const provider = build({ snapshotFile: null });

    expect(provider.limits).toHaveLength(2);
    expect(provider.limits.every((limit) => limit.percent === null)).toBe(true);
    expect(provider.limits.every((limit) => limit.valueLabel === "n/a")).toBe(true);
  });

  test("adds a projection alert only when the projected weekly usage exceeds 100", () => {
    const safe = build({ snapshotFile: snapshot(60_000, 40), trendRate: 1 });
    const over = build({ snapshotFile: snapshot(60_000, 40), trendRate: 7 });

    expect(safe.limits[1]?.alert).toBeUndefined();
    expect(over.limits[1]?.alert?.text).toContain("projected 110% before reset");
  });
});
