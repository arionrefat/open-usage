import { describe, expect, test } from "bun:test";
import { HOUR_MS } from "../../../src/data/real/aggregate";
import type { GoLimitsSource } from "../../../src/data/real/go-limits-source";
import { buildGoProvider, createGoMeta } from "../../../src/data/real/go-provider";
import { goSpendFrom } from "../../../src/data/real/opencode-go-spend";
import type { GoServerLimits } from "../../../src/data/real/opencode-server";

const NOW = new Date(2026, 0, 15, 12);
const NOW_MS = NOW.getTime();
const META = createGoMeta({ openai: null, opencodeGo: { maskedKey: "••••" } });

function limitsSource(options: {
  server?: GoServerLimits | null;
  note?: string | null;
  expiresAtMs?: number | null;
} = {}): GoLimitsSource {
  return {
    read: () => options.server ?? null,
    note: () => options.note ?? null,
    cookieExpiresAtMs: () => options.expiresAtMs ?? null,
    poll: () => Promise.resolve(),
  };
}

function build(options: {
  server?: GoServerLimits | null;
  spend?: ReturnType<typeof goSpendFrom> | null;
  note?: string | null;
  expiresAtMs?: number | null;
  stats?: Parameters<typeof buildGoProvider>[0]["stats"];
} = {}) {
  return buildGoProvider({
    meta: META,
    buckets: new Map(),
    stats: options.stats,
    spend: options.spend ?? null,
    limitsSource: limitsSource(options),
    dates: ["2026-01-15"],
    now: NOW,
  });
}

const SERVER: GoServerLimits = {
  rollingPercent: 11,
  rollingResetAtMs: NOW_MS + HOUR_MS,
  weeklyPercent: 22,
  weeklyResetAtMs: NOW_MS + 2 * HOUR_MS,
  monthlyPercent: 33,
  monthlyResetAtMs: NOW_MS + 3 * HOUR_MS,
  fetchedAtMs: NOW_MS,
  useBalance: null,
};

describe("buildGoProvider details", () => {
  const stats: NonNullable<Parameters<typeof buildGoProvider>[0]["stats"]> = {
    sessions: 2,
    tokens: 1000,
    latestMs: NOW_MS,
    topModel: "sonnet",
    modelTokens30d: { sonnet: 1_500_000, haiku: 500_000, opus: 250_000, tiny: 10 },
    tokenSplit30d: { input: 1000, output: 500, reasoning: 250, cacheRead: 0, cacheWrite: 250 },
    cost30d: { totalUsd: 3.91, peakDayUsd: 1.25 },
  };

  test("renders top models, nonzero token splits, and spend figures", () => {
    const details = build({ stats }).provider.details;
    expect(details?.[0]?.rows.map((row) => [row.label, row.value])).toEqual([
      ["sonnet", "1.5M"], ["haiku", "500K"], ["opus", "250K"],
    ]);
    expect(details?.[1]?.rows.map((row) => row.label)).toEqual([
      "input", "output", "reasoning", "cache write",
    ]);
    expect(details?.[2]?.rows).toEqual([
      { label: "total", value: "$3.91" },
      { label: "avg per day", value: "$0.13" },
      { label: "peak day", value: "$1.25" },
    ]);
  });

  test("shows the server balance fallback flag", () => {
    const on = build({ stats, server: { ...SERVER, useBalance: true } }).provider.details;
    const off = build({ stats, server: { ...SERVER, useBalance: false } }).provider.details;
    expect(on?.[2]?.rows.at(-1)).toEqual({ label: "balance fallback", value: "on" });
    expect(off?.[2]?.rows.at(-1)).toEqual({ label: "balance fallback", value: "off" });
  });
});

describe("buildGoProvider limits", () => {
  test("uses all three server windows and identifies the Go plan without estimate footnotes", () => {
    const result = build({ server: SERVER });

    expect(result.usesEstimate).toBe(false);
    expect(result.provider.meta.plan).toBe("Go");
    expect(result.provider.limits.map((limit) => limit.percent)).toEqual([11, 22, 33]);
    expect(result.provider.limits.every((limit) => limit.footnote === undefined)).toBe(true);
  });

  test("renders all three local spend rows with estimate footnotes", () => {
    const spend = goSpendFrom([{ atMs: NOW_MS - HOUR_MS, usd: 3 }], NOW);
    const result = build({ spend });

    expect(result.usesEstimate).toBe(true);
    expect(result.provider.limits.map((limit) => limit.id)).toEqual([
      "session",
      "weekly",
      "monthly",
    ]);
    expect(result.provider.limits.every((limit) => limit.footnote?.includes("local estimate"))).toBe(true);
  });

  test("renders one capless row when neither server nor spend data exists", () => {
    const result = build();

    expect(result.provider.limits).toHaveLength(1);
    expect(result.provider.limits[0]).toMatchObject({ id: "usage", percent: null });
  });
});

describe("buildGoProvider cookie notices", () => {
  test("shows a failure note instead of a near-expiry warning", () => {
    const result = build({ note: "server failed", expiresAtMs: NOW_MS + HOUR_MS });
    expect(result.provider.notice?.segments[0]?.text).toBe("server failed");
  });

  test("counts down a cookie that is near expiry", () => {
    const result = build({ expiresAtMs: NOW_MS + 2 * HOUR_MS });
    expect(result.provider.notice?.segments[0]?.text).toBe(
      "opencode cookie expires in 2h 0m - paste a fresh one",
    );
  });

  test("reports an expired cookie", () => {
    const result = build({ expiresAtMs: NOW_MS - 1 });
    expect(result.provider.notice?.segments[0]?.text).toBe(
      "opencode cookie expired - paste a fresh one",
    );
  });

  test("omits notices for a healthy far-future cookie", () => {
    const result = build({ expiresAtMs: NOW_MS + 8 * 24 * HOUR_MS });
    expect(result.provider.notice).toBeUndefined();
  });
});
