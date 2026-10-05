import { describe, expect, test } from "bun:test";
import { HOUR_MS } from "../../../src/data/real/aggregate";
import { buildClaudeProvider, createClaudeMeta } from "../../../src/data/real/claude-provider";
import type { ClaudeWeeklyBreakdown } from "../../../src/data/real/claude-account-usage";
import type { SnapshotFile, WeeklyTrend } from "../../../src/data/real/statusline-snapshot";
import {
  dormantClaudeLimitsSource,
  type ClaudeCliUsage,
  type ClaudeScopedWindow,
} from "../../../src/data/real/claude-usage";

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

function liveUsage(reset: string): ClaudeCliUsage {
  return {
    session: { percent: 25.4, reset },
    weekly: { percent: 40, reset },
    scoped: [],
    fetchedAtMs: NOW_MS,
  };
}

const FABLE: ClaudeScopedWindow = {
  id: "fable",
  scope: "model",
  name: "Fable",
  percent: 65,
  reset: "resets Aug 5 at 6am (Asia/Dhaka)",
};

function trend(rate: number | null): WeeklyTrend {
  return { observe: () => rate };
}

function build(options: {
  snapshotFile?: SnapshotFile | null;
  hasStatusline?: boolean;
  trendRate?: number | null;
  sessions?: number;
  historyAvailable?: boolean;
  live?: ClaudeCliUsage | null;
  subscriptionType?: string | null;
  weeklyBreakdown?: ClaudeWeeklyBreakdown | null;
  rateLimitTier?: string | null;
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
      dayModelTokens: new Map(),
      earliestMs: null,
    },
    history: {
      available: options.historyAvailable ?? true,
      prompts: 0,
      sessions: options.sessions ?? 0,
      latestMs: 0,
    },
    snapshotFile: options.snapshotFile ?? null,
    limitsSource:
      options.live === undefined
        ? dormantClaudeLimitsSource
        : {
            read: () => options.live ?? null,
            note: () => null,
            poll: () => Promise.resolve(),
          },
    hasStatusline: options.hasStatusline ?? true,
    trend: trend(options.trendRate ?? null),
    dates: ["2026-01-15"],
    now: NOW,
    weeklyBreakdown: options.weeklyBreakdown ?? null,
    rateLimitTier: options.rateLimitTier ?? null,
    ...(options.subscriptionType === undefined
      ? {}
      : {
          authSource: {
            read: () => ({
              loggedIn: true,
              subscriptionType: options.subscriptionType ?? null,
              fetchedAtMs: NOW_MS,
            }),
            poll: () => Promise.resolve(),
          },
        }),
  });
}

describe("buildClaudeProvider", () => {
  test("preserves the raw 30-day session count", () => {
    expect(build({ sessions: 7 }).sessions30d).toBe(7);
  });

  test("omits sessions when history is unavailable", () => {
    expect(build({ historyAvailable: false, sessions: 7 }).sessions30d).toBeUndefined();
  });

  test("carries cache reads in millions, apart from the token series", () => {
    // 600 raw cache-read tokens, and the series stays the blended figure.
    expect(build().cacheRead30d).toBeCloseTo(0.0006, 10);
  });

  test("a fresh snapshot exposes session and weekly percentages without a notice", () => {
    const provider = build({ snapshotFile: snapshot(60_000) });

    expect(provider.scopes.session.percent).toBe(25);
    expect(provider.scopes.weekly.percent).toBe(40);
    expect(provider.notice).toBeUndefined();
  });

  test("a stale snapshot remains visible while live limits are unavailable", () => {
    const provider = build({ snapshotFile: snapshot(11 * 60_000) });

    expect(provider.limits[0]?.percent).toBe(25);
    expect(provider.limits[1]?.percent).toBe(40);
    expect(provider.scopes.session.percent).toBe(25);
    expect(provider.scopes.weekly.percent).toBe(40);
    expect(provider.limits[0]?.footnote).toContain("snapshot stale");
    expect(provider.limits[1]?.footnote).toContain("snapshot stale");
    expect(provider.notice?.segments[0]?.text).toContain("cached statusline values shown");
  });

  test("live cli usage replaces a stale statusline snapshot", () => {
    const provider = buildClaudeProvider({
      meta: createClaudeMeta(),
      transcripts: {
        buckets: new Map(),
        latestMs: 0,
        modelTokens: new Map(),
        tokenSplit: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      dayModelTokens: new Map(),
      earliestMs: null,
      },
      history: { available: true, prompts: 0, sessions: 0, latestMs: 0 },
      snapshotFile: snapshot(11 * 60_000),
      limitsSource: {
        read: () => ({
          session: { percent: 10, reset: "resets Aug 4 at 3:20am (Asia/Dhaka)" },
          weekly: { percent: 95, reset: "resets Aug 5 at 6am (Asia/Dhaka)" },
          scoped: [FABLE],
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
    expect(provider.limits[1]?.reset).toBe("resets Aug 5 at 6am");
    expect(provider.limits[2]).toEqual({
      id: "fable",
      label: "weekly · Fable",
      percent: 65,
      reset: "resets Aug 5 at 6am",
    });
    expect(provider.notice).toBeUndefined();
  });

  test("when both limit sources are stale, uses the fresher timestamp", () => {
    const live = (ageMinutes: number): ClaudeCliUsage => ({
      session: { percent: 10, reset: "resets later" },
      weekly: { percent: 95, reset: "resets later" },
      scoped: [],
      fetchedAtMs: NOW_MS - ageMinutes * 60_000,
    });

    const fresherSnapshot = build({
      snapshotFile: snapshot(12 * 60_000, 40),
      live: live(20),
    });
    expect(fresherSnapshot.scopes.weekly.percent).toBe(40);
    expect(fresherSnapshot.limits[1]?.footnote).toContain("snapshot stale");

    const fresherCli = build({
      snapshotFile: snapshot(20 * 60_000, 40),
      live: live(12),
    });
    expect(fresherCli.scopes.weekly.percent).toBe(95);
    expect(fresherCli.limits[1]?.footnote).toContain("cached live limits stale");
  });

  test("keeps stale Fable usage when a fresh statusline replaces the shared windows", () => {
    const provider = buildClaudeProvider({
      meta: createClaudeMeta(),
      transcripts: {
        buckets: new Map(),
        latestMs: 0,
        modelTokens: new Map(),
        tokenSplit: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      dayModelTokens: new Map(),
      earliestMs: null,
      },
      history: { available: true, prompts: 0, sessions: 0, latestMs: 0 },
      snapshotFile: snapshot(60_000),
      limitsSource: {
        read: () => ({
          session: { percent: 10, reset: "resets later" },
          weekly: { percent: 20, reset: "resets later" },
          scoped: [FABLE],
          fetchedAtMs: NOW_MS - 40 * 60_000,
        }),
        note: () => null,
        poll: () => Promise.resolve(),
      },
      hasStatusline: true,
      trend: trend(null),
      dates: ["2026-01-15"],
      now: NOW,
    });

    expect(provider.scopes.session.percent).toBe(25);
    expect(provider.scopes.weekly.percent).toBe(40);
    expect(provider.limits[2]).toMatchObject({
      id: "fable",
      percent: 65,
      footnote: expect.stringContaining("cached live limits stale"),
    });
  });

  test("Fable is not called stale merely for outliving the shared windows", () => {
    const provider = buildClaudeProvider({
      meta: createClaudeMeta(),
      transcripts: {
        buckets: new Map(),
        latestMs: 0,
        modelTokens: new Map(),
        tokenSplit: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      dayModelTokens: new Map(),
      earliestMs: null,
      },
      history: { available: true, prompts: 0, sessions: 0, latestMs: 0 },
      snapshotFile: snapshot(60_000),
      limitsSource: {
        // Past the 10-minute window the session and weekly rows use, but well
        // inside the slower cadence the CLI runs at while the snapshot covers
        // those rows for free.
        read: () => ({
          session: { percent: 10, reset: "resets later" },
          weekly: { percent: 20, reset: "resets later" },
          scoped: [FABLE],
          fetchedAtMs: NOW_MS - 11 * 60_000,
        }),
        note: () => null,
        poll: () => Promise.resolve(),
      },
      hasStatusline: true,
      trend: trend(null),
      dates: ["2026-01-15"],
      now: NOW,
    });

    expect(provider.limits[2]).toMatchObject({ id: "fable", percent: 65 });
    expect(provider.limits[2]?.footnote).toBeUndefined();
  });

  test("the structured reset times drive the countdown and projection with no snapshot", () => {
    const provider = build({
      snapshotFile: null,
      trendRate: 7,
      live: {
        session: { percent: 25, reset: "resets 4am", resetsAtMs: NOW_MS + HOUR_MS },
        weekly: { percent: 40, reset: "resets Jan 16 at 10pm", resetsAtMs: NOW_MS + 10 * HOUR_MS },
        scoped: [{ ...FABLE, resetsAtMs: NOW_MS + 10 * HOUR_MS }],
        fetchedAtMs: NOW_MS,
      },
    });

    expect(provider.limits.map((limit) => limit.reset)).toEqual([
      "resets in 1h 0m",
      "resets in 10h 0m",
      "resets in 10h 0m",
    ]);
    expect(provider.limits[1]?.resetLong).toStartWith("resets in 10h 0m");
    expect(provider.limits[0]?.resetLong).toStartWith("resets in 1h 0m");
    expect(provider.limits[2]?.resetLong).toStartWith("resets in 10h 0m");
    expect(provider.burn.timeToReset).toBe("10h 0m to reset");
    expect(provider.burn.projectedPercent).toBe(110);
    expect(provider.limits[1]?.alert?.text).toContain("projected 110% before reset");
  });

  test("renders every scoped lane under an id taken from its scope", () => {
    const provider = build({
      live: {
        ...liveUsage("resets later"),
        scoped: [
          FABLE,
          { id: "surface-claude-code", scope: "surface", name: "Claude Code", percent: 12, reset: "resets later" },
        ],
      },
    });

    expect(provider.limits.map((limit) => [limit.id, limit.label])).toEqual([
      ["session", "current session"],
      ["weekly", "weekly · all models"],
      ["fable", "weekly · Fable"],
      ["surface-claude-code", "weekly · Claude Code"],
    ]);
  });

  test("shows extra usage only when the reading carries it and is current", () => {
    const withExtra: ClaudeCliUsage = {
      ...liveUsage("resets later"),
      extraUsage: {
        used: { amountMinor: 1234, currency: "USD", exponent: 2 },
        monthlyLimit: { amountMinor: 5000, currency: "USD", exponent: 2 },
        utilization: 24.68,
      },
    };
    const section = (live: ClaudeCliUsage) =>
      build({ live }).details?.find((candidate) => candidate.title === "extra usage");

    expect(section(withExtra)?.rows).toEqual([
      { label: "credits used", value: "$12.34 of $50.00", percent: 24.68 },
    ]);
    expect(section(liveUsage("resets later"))).toBeUndefined();
    expect(section({ ...withExtra, fetchedAtMs: NOW_MS - 2 * HOUR_MS })).toBeUndefined();
  });

  test("shows the week's share by surface until that week ends", () => {
    const breakdown = (windowStartedAtMs: number): ClaudeWeeklyBreakdown => ({
      asOfMs: NOW_MS - HOUR_MS,
      windowStartedAtMs,
      rows: [
        { key: "claude_code", label: "Claude Code", percent: 88 },
        { key: "chat", label: "Chats", percent: 7 },
      ],
    });
    const section = (value: ClaudeWeeklyBreakdown | null) =>
      build({ weeklyBreakdown: value }).details?.find(
        (candidate) => candidate.title === "weekly share by surface",
      );

    expect(section(breakdown(NOW_MS - 2 * 24 * HOUR_MS))?.rows).toEqual([
      { label: "Claude Code", value: "88%", percent: 88 },
      { label: "Chats", value: "7%", percent: 7 },
    ]);
    expect(section(breakdown(NOW_MS - 8 * 24 * HOUR_MS))).toBeUndefined();
    expect(section(null)).toBeUndefined();
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

  test("reports a clamped 100 percent reading as already capped", () => {
    expect(
      build({ snapshotFile: snapshot(60_000, 100), trendRate: null }).burn.outcome,
    ).toEqual({ kind: "capped" });
  });

  test("separates staying under the cap from the time a cap is hit", () => {
    // 40% with 10h to reset: 1%/h stays clear, 7%/h runs out first.
    expect(build({ snapshotFile: snapshot(60_000, 40), trendRate: 1 }).burn.outcome).toEqual({
      kind: "clear",
    });
    expect(build({ snapshotFile: snapshot(60_000, 40), trendRate: 7 }).burn.outcome).toMatchObject({
      kind: "caps-out",
    });
  });

  test("names the plan tier on every screen's label, not just settings", () => {
    const meta = build({ subscriptionType: "max" }).meta;

    expect(meta.plan).toBe("Max");
    expect(meta.planShort).toBe("Max");
    expect(meta.planDetail).toBe("Max");
  });

  test("names the Max multiplier when the account's tier is known", () => {
    const max20 = build({ subscriptionType: "max", rateLimitTier: "default_claude_max_20x" }).meta;
    const max5 = build({ subscriptionType: "max", rateLimitTier: "default_claude_max_5x" }).meta;

    expect([max20.plan, max20.planShort, max20.planDetail]).toEqual(["Max 20x", "Max 20x", "Max 20x"]);
    expect(max5.planShort).toBe("Max 5x");
  });

  test("an unknown tier, or a known one on another plan, keeps today's label", () => {
    expect(build({ subscriptionType: "max", rateLimitTier: "default_claude_max_50x" }).meta.plan).toBe("Max");
    // Team seats carry the same tier strings, so they never read as Max.
    expect(build({ subscriptionType: "team", rateLimitTier: "default_claude_max_5x" }).meta.plan).toBe("Team");
    expect(build({ subscriptionType: null, rateLimitTier: "default_claude_max_20x" }).meta.plan).toBe(
      "Claude subscription",
    );
  });

  test("keeps the generic label when the cli reports no tier", () => {
    expect(build({ subscriptionType: null }).meta.planShort).toBe("Claude subscription");
  });

  test("drops the timezone the cli appends to its own reset prose", () => {
    const provider = build({
      live: liveUsage("resets Aug 26 at 8:20am (Asia/Dhaka)"),
      snapshotFile: null,
    });

    expect(provider.limits[0]?.reset).toBe("resets Aug 26 at 8:20am");
  });

  test("gives the session line the same reset shape as the weekly line", () => {
    const provider = build({ snapshotFile: snapshot(60_000) });

    expect(provider.limits[0]?.resetLong).toBe("resets in 1h 0m · Thu 13:00");
    expect(provider.limits[1]?.resetLong).toBe("resets in 10h 0m · Thu 22:00");
  });

  test("counts down to the weekly reset rather than echoing the cli's date prose", () => {
    const provider = build({
      live: liveUsage("resets Aug 26 at 8:20am (Asia/Dhaka)"),
      snapshotFile: snapshot(60_000),
    });

    expect(provider.burn.timeToReset).toBe("10h 0m to reset");
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
