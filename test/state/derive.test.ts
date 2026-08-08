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
    expect(weekly.hotIds).toEqual(["cl"]);
    expect(weekly.alertText).toBe("▲ warning");
    expect(weekly.alertColor).toBe(COLORS.danger);

    const session = deriveState({ ...initialState(), scope: "session" }, snapshot);
    expect(session.hotIds).toEqual([]);
    expect(session.alertText).toBe("▲ warning");
    expect(session.alertColor).toBe(COLORS.danger);
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
    expect(at("today")).toEqual(at("all"));
    expect(at("month")).toEqual(at("30d"));
  });

  test("reports no week-over-week comparison without 14 days of history", () => {
    const snapshot = mockUsageProvider.readSnapshot();
    const short = { ...snapshot, dailyDates: snapshot.dailyDates.slice(-13) };

    expect(deriveState(initialState(), short).weekOverWeek).toEqual({
      cl: null,
      cx: null,
      go: null,
    });
  });

  test("names the all range 'all time'", () => {
    const snapshot = mockUsageProvider.readSnapshot();

    expect(deriveState({ ...initialState(), range: "all" }, snapshot).rangeName).toBe(
      "all time",
    );
  });

  test.each(FILTER_CASES)("filter query %s selects the matching provider", (filterQuery, visibleIds) => {
    const state = { ...initialState(), filterQuery };

    expect(deriveState(state, mockUsageProvider.readSnapshot()).visibleIds).toEqual(
      visibleIds,
    );
  });

  test("lists disconnected providers with their status labels", () => {
    const state = initialState();
    state.connections.go.status = "none";
    const derived = deriveState(state, mockUsageProvider.readSnapshot());

    expect(derived.disconnectedIds).toEqual(["cx", "go"]);
    expect(derived.windowNote).toContain("codex - subscription ended");
    expect(derived.windowNote).toContain("opencode go - not connected");
  });

  test("marks only providers at the danger threshold in the current scope as hot", () => {
    const snapshot = structuredClone(mockUsageProvider.readSnapshot());
    snapshot.providers.cl.scopes.weekly.percent = 84;
    snapshot.providers.go.scopes.weekly.percent = 85;
    snapshot.providers.cl.scopes.session.percent = 85;
    snapshot.providers.go.scopes.session.percent = 84;

    expect(deriveState(initialState(), snapshot).hotIds).toEqual(["go"]);
    expect(
      deriveState({ ...initialState(), scope: "session" }, snapshot).hotIds,
    ).toEqual(["cl"]);
  });
});
