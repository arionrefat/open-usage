import { describe, expect, test } from "bun:test";
import { mockUsageProvider } from "../../src/data/mock-provider";
import type { ProviderId } from "../../src/data/types";
import { createInitialState, type AppState } from "../../src/state/app-state";
import { deriveState } from "../../src/state/derive";
import { COLORS } from "../../src/theme";

const FILTER_CASES: [string, ProviderId[]][] = [
  ["claude", ["cl"]],
  ["CODEX", ["cx"]],
  ["go", ["go"]],
];

function initialState(): AppState {
  return createInitialState({ connections: mockUsageProvider.initialConnections() });
}

describe("derived state", () => {
  test("shows a red warning for limit or connection problems", () => {
    const snapshot = mockUsageProvider.readSnapshot();

    const weekly = deriveState(initialState(), snapshot);
    // go is hot on its monthly limit (91%), which sits in no scope at all.
    expect(weekly.hotIds).toEqual(["cl", "go"]);
    expect(weekly.alertText).toBe("▲ warning");
    expect(weekly.alertColor).toBe(COLORS.danger);

    const session = deriveState({ ...initialState(), scope: "session" }, snapshot);
    expect(session.hotIds).toEqual(["cl", "go"]);
    expect(session.alertText).toBe("▲ warning");
    expect(session.alertColor).toBe(COLORS.danger);
  });

  test("measures pressure against the tightest capped limit, whatever its window", () => {
    const derived = deriveState(initialState(), mockUsageProvider.readSnapshot());

    // cl max(21, 88, 60) · cx max(34) with two uncapped rows · go max(12, 41, 91)
    expect(derived.pressure.cl).toMatchObject({ percent: 88, label: "weekly · all models" });
    expect(derived.pressure.cx).toMatchObject({ percent: 34, label: "weekly limit" });
    expect(derived.pressure.go).toMatchObject({ percent: 91, label: "monthly" });
  });

  test("ranks on pressure, so a limit outside the scopes still decides the headline", () => {
    const derived = deriveState(initialState(), mockUsageProvider.readSnapshot());

    // Ranking by the weekly scope alone put cl worst and never saw go's monthly.
    // codex is expired in the mock, so the live field is cl and go only.
    expect(derived.worstId).toBe("go");
    expect(derived.bestId).toBe("cl");
  });

  test("holds the ranking still as the scope toggles", () => {
    const snapshot = mockUsageProvider.readSnapshot();
    const weekly = deriveState(initialState(), snapshot);
    const session = deriveState({ ...initialState(), scope: "session" }, snapshot);

    expect(session.worstId).toBe(weekly.worstId);
    expect(session.bestId).toBe(weekly.bestId);
  });

  test("shows the disconnected warning when every enabled provider is offline", () => {
    const state = initialState();
    for (const connection of Object.values(state.connections)) connection.status = "none";

    const derived = deriveState(state, mockUsageProvider.readSnapshot());
    expect(derived.liveIds).toEqual([]);
    expect(derived.disconnectedIds).toEqual(["cl", "cx", "go"]);
    expect(derived.alertText).toBe("▲ warning");
    expect(derived.alertColor).toBe(COLORS.danger);
  });

  test("splits the last 14 days into two comparable 7-day halves", () => {
    const snapshot = mockUsageProvider.readSnapshot();
    const daily = snapshot.providers.cl.series.daily;
    const week = deriveState(initialState(), snapshot).weekOverWeek.cl;

    expect(week).not.toBeNull();
    expect(week?.recent).toBeCloseTo(daily.slice(-7).reduce((a, b) => a + b, 0), 6);
    expect(week?.prior).toBeCloseTo(daily.slice(-14, -7).reduce((a, b) => a + b, 0), 6);
  });

  test("holds the week-over-week windows fixed as the range cycles", () => {
    const snapshot = mockUsageProvider.readSnapshot();
    const at = (range: AppState["range"]) =>
      deriveState({ ...initialState(), range }, snapshot).weekOverWeek.cl;

    expect(at("7d")).toEqual(at("30d"));
    expect(at("today")).toEqual(at("7d"));
    expect(at("month")).toEqual(at("30d"));
  });

  test("reports no week-over-week comparison without 14 days of history", () => {
    const snapshot = mockUsageProvider.readSnapshot();
    const short = structuredClone(snapshot);
    short.dailyDates = short.dailyDates.slice(-13);
    for (const provider of Object.values(short.providers)) {
      provider.series.daily = provider.series.daily.slice(-13);
    }

    expect(deriveState(initialState(), short).weekOverWeek).toEqual({
      cl: null,
      cx: null,
      go: null,
    });
  });

  test("labels the latest calendar month honestly and compactly", () => {
    const snapshot = mockUsageProvider.readSnapshot();
    const derived = deriveState({ ...initialState(), range: "month" }, snapshot);

    expect(derived.rangeName).toBe("calendar month");
    expect(derived.rangeLabel).toBe("cal month");
  });

  test.each(FILTER_CASES)("filter query %s selects the matching provider", (filterQuery, visibleIds) => {
    const state = { ...initialState(), filterQuery };

    expect(deriveState(state, mockUsageProvider.readSnapshot()).visibleIds).toEqual(
      visibleIds,
    );
  });

  test("keeps an unfiltered ranking for simplified mode's all-provider legend", () => {
    const state = { ...initialState(), mode: "simple" as const, filterQuery: "go" };
    const derived = deriveState(state, mockUsageProvider.readSnapshot());

    expect(derived.ranked).toEqual(["go"]);
    // go leads on its 91% monthly, ahead of cl's 88% weekly.
    expect(derived.unfilteredRanked).toEqual(["go", "cl"]);
  });

  test("lists disconnected providers with their status labels", () => {
    const state = initialState();
    state.connections.go.status = "none";
    const derived = deriveState(state, mockUsageProvider.readSnapshot());

    expect(derived.disconnectedIds).toEqual(["cx", "go"]);
    expect(derived.windowNote).toContain("codex - failed");
    expect(derived.windowNote).toContain("opencode go - not connected");
  });

  test("marks only providers at the danger threshold on their tightest limit as hot", () => {
    const snapshot = structuredClone(mockUsageProvider.readSnapshot());
    for (const limit of snapshot.providers.cl.limits) limit.percent = 84;
    for (const limit of snapshot.providers.go.limits) limit.percent = 84;
    // One row over the line is enough, wherever it sits in the list.
    snapshot.providers.go.limits[2]!.percent = 85;

    expect(deriveState(initialState(), snapshot).hotIds).toEqual(["go"]);
  });

  test("ignores uncapped rows when reading a provider's pressure", () => {
    const snapshot = structuredClone(mockUsageProvider.readSnapshot());
    // codex carries two rows with no cap at all; they must not read as zero.
    expect(snapshot.providers.cx.limits.filter((limit) => limit.percent === null)).toHaveLength(2);

    expect(deriveState(initialState(), snapshot).pressure.cx).toMatchObject({
      percent: 34,
      label: "weekly limit",
    });
  });
});
