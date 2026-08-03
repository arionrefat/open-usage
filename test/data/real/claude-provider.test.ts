import { describe, expect, test } from "bun:test";
import { HOUR_MS } from "../../../src/data/real/aggregate";
import { buildClaudeProvider, createClaudeMeta } from "../../../src/data/real/claude-provider";
import type { SnapshotFile, WeeklyTrend } from "../../../src/data/real/statusline-snapshot";
import { dormantClaudeLimitsSource } from "../../../src/data/real/claude-usage";

const NOW = new Date(2026, 0, 15, 12);
const NOW_MS = NOW.getTime();

function snapshot(ageMs: number, weeklyPercent = 40): SnapshotFile {
  return {
    ageMs,
    writtenAtMs: NOW_MS - ageMs,
    reading: {
      fiveHour: { percent: 25.4, resetsAtMs: NOW_MS + HOUR_MS },
      sevenDay: { percent: weeklyPercent, resetsAtMs: NOW_MS + 10 * HOUR_MS },
      model: { id: "claude-sonnet-4-5", displayName: "Sonnet 4.5" },
      effort: "high",
      cost: {
        totalCostUsd: 2.6,
        totalDurationMs: 120_000,
        totalLinesAdded: 0,
        totalLinesRemoved: 1,
      },
      contextWindow: {
        totalInputTokens: 120_000,
        totalOutputTokens: 5_000,
        contextWindowSize: 1_000_000,
        usedPercentage: 12.5,
        currentUsage: null,
      },
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
    transcripts: {
      buckets: new Map(),
      latestMs: 0,
      modelTokens: new Map([
        ["sonnet", 700],
        ["opus", 300],
      ]),
      tokenSplit: { input: 100, output: 200, cacheRead: 600, cacheWrite: 100 },
    },
    history: { prompts: 0, sessions: 0, latestMs: 0 },
    snapshotFile: options.snapshotFile ?? null,
    limitsSource: dormantClaudeLimitsSource,
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

  test("a stale snapshot is never exposed as current usage", () => {
    const provider = build({ snapshotFile: snapshot(11 * 60_000) });

    expect(provider.limits.every((limit) => limit.percent === null)).toBe(true);
    expect(provider.scopes.session.percent).toBeNull();
    expect(provider.scopes.weekly.percent).toBeNull();
    expect(provider.limits[0]?.footnote).toContain("snapshot stale");
    expect(provider.limits[1]?.footnote).toContain("snapshot stale");
    expect(provider.notice?.segments[0]?.text).toContain("stale statusline ignored");
  });

  test("live cli usage replaces a stale statusline snapshot", () => {
    const provider = buildClaudeProvider({
      meta: createClaudeMeta(),
      transcripts: {
        buckets: new Map(),
        latestMs: 0,
        modelTokens: new Map(),
        tokenSplit: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      history: { prompts: 0, sessions: 0, latestMs: 0 },
      snapshotFile: snapshot(11 * 60_000),
      limitsSource: {
        read: () => ({
          session: { percent: 10, reset: "resets Aug 4 at 3:20am (Asia/Dhaka)" },
          weekly: { percent: 95, reset: "resets Aug 5 at 6am (Asia/Dhaka)" },
          fetchedAtMs: NOW_MS,
        }),
        note: () => null,
        poll: () => Promise.resolve(),
      },
      hasStatusline: true,
      trend: trend(null),
      dates: ["2026-01-15"],
      now: NOW,
    });

    expect(provider.scopes.session.percent).toBe(10);
    expect(provider.scopes.weekly.percent).toBe(95);
    expect(provider.limits[1]?.reset).toBe("resets Aug 5 at 6am (Asia/Dhaka)");
    expect(provider.notice).toBeUndefined();
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

  test("adds session, model, and token detail sections for fresh data", () => {
    const provider = build({ snapshotFile: snapshot(60_000) });

    expect(provider.details?.map((section) => section.title)).toEqual([
      "session",
      "models 30d",
      "tokens 30d",
    ]);
    expect(provider.details?.[0]?.rows).toEqual([
      { label: "model", value: "Sonnet 4.5" },
      { label: "context used", value: "120K of 1.0M", percent: 12.5 },
      { label: "session cost", value: "$2.60" },
      { label: "lines", value: "+0 / -1" },
      { label: "effort", value: "high" },
    ]);
    expect(provider.details?.[1]?.rows[0]).toEqual({ label: "sonnet", value: "700", percent: 70 });
  });

  test("skips the session section without a fresh snapshot", () => {
    expect(build({ snapshotFile: null }).details?.[0]?.title).toBe("models 30d");
    expect(build({ snapshotFile: snapshot(11 * 60_000) }).details?.[0]?.title).toBe("models 30d");
  });

  test("omits absent session rows", () => {
    const partial = snapshot(60_000);
    partial.reading.model = null;
    partial.reading.cost = null;
    partial.reading.effort = null;
    expect(build({ snapshotFile: partial }).details?.[0]?.rows).toEqual([
      { label: "context used", value: "120K of 1.0M", percent: 12.5 },
    ]);
  });
});
