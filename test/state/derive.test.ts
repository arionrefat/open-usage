import { describe, expect, test } from "bun:test";
import { mockUsageProvider } from "../../src/data/mock-provider";
import type { ProviderId } from "../../src/data/types";
import { createInitialState, type AppState } from "../../src/state/app-state";
import { deriveState } from "../../src/state/derive";

const FILTER_CASES: [string, ProviderId[]][] = [
  ["claude", ["cl"]],
  ["CODEX", ["cx"]],
  ["go", ["go"]],
];

function initialState(): AppState {
  return createInitialState({ connections: mockUsageProvider.initialConnections() });
}

describe("derived state", () => {
  test("alerts count only the current scope", () => {
    const snapshot = mockUsageProvider.readSnapshot();

    const weekly = deriveState(initialState(), snapshot);
    expect(weekly.hotIds).toEqual(["cl"]);
    expect(weekly.alertText).toBe("▲ 2 issues");

    const session = deriveState({ ...initialState(), scope: "session" }, snapshot);
    expect(session.hotIds).toEqual([]);
    expect(session.alertText).toBe("▲ 1 issue");
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
