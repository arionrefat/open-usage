import { describe, expect, test } from "bun:test";
import { mockUsageProvider } from "../../src/data/mock-provider";
import {
  createAppReducer,
  createInitialState,
  type AppState,
} from "../../src/state/app-state";

const reducer = createAppReducer(mockUsageProvider.listMeta());

function initialState() {
  return createInitialState({ connections: mockUsageProvider.initialConnections() });
}

describe("app reducer", () => {
  test("simplified mode opens on the weekly window", () => {
    // The session window is nearly always 0% early in a session, so weekly is
    // the one that answers "how much have I got left".
    expect(initialState().scope).toBe("weekly");
    expect(reducer(initialState(), { type: "toggle-scope" }).scope).toBe("session");
  });

  test("initial selection starts on the first enabled provider", () => {
    const connections = mockUsageProvider.initialConnections();
    connections.cl.isEnabled = false;

    expect(createInitialState({ connections }).selection).toBe(1);
  });

  test("applies onboarding provider choices", () => {
    let state = reducer(initialState(), { type: "onboarding-pick", index: 0 });
    state = reducer(state, { type: "onboarding-begin-auth" });

    expect(state.connections.cl.isEnabled).toBe(false);
    expect(state.connections.cx.isEnabled).toBe(true);
    expect(state.connections.go.isEnabled).toBe(true);
  });

  test("onboarding continue is a no-op when nothing is picked", () => {
    let state = reducer(initialState(), { type: "onboarding-pick", index: 0 });
    state = reducer(state, { type: "onboarding-pick", index: 1 });
    state = reducer(state, { type: "onboarding-pick", index: 2 });
    const after = reducer(state, { type: "onboarding-begin-auth" });

    expect(after).toBe(state);
    expect(after.onboarding.step).toBe(0);
  });

  test("onboarding reaches the summary without asking for credentials", () => {
    let state = reducer(initialState(), { type: "open-onboarding" });
    state = reducer(state, { type: "onboarding-begin-auth" });

    expect(state.onboarding.step).toBe(1);
    expect(state.connections.cl).toEqual(initialState().connections.cl);
  });

  test("changing the default mode does not leave settings", () => {
    const state: AppState = { ...initialState(), view: "settings" };
    expect(reducer(state, { type: "set-mode", mode: "simple" }).view).toBe("settings");
  });

  test("cycles the configurable poll interval and warning threshold", () => {
    let state = initialState();
    expect(state.pollIntervalMinutes).toBe(1);
    expect(state.warnThreshold).toBe(85);

    state = reducer(state, { type: "cycle-poll-interval" });
    state = reducer(state, { type: "cycle-warn-threshold" });
    expect(state.pollIntervalMinutes).toBe(2);
    expect(state.warnThreshold).toBe(90);

    state = { ...state, pollIntervalMinutes: 5, warnThreshold: 90 };
    state = reducer(state, { type: "cycle-poll-interval" });
    state = reducer(state, { type: "cycle-warn-threshold" });
    expect(state.pollIntervalMinutes).toBe(1);
    expect(state.warnThreshold).toBe(80);
  });

  test("cycles only distinct activity ranges", () => {
    let state = initialState();
    const ranges: AppState["range"][] = [];

    for (let index = 0; index < 4; index += 1) {
      state = reducer(state, { type: "cycle-range" });
      ranges.push(state.range);
    }

    expect(ranges).toEqual(["month", "today", "7d", "30d"]);
  });

  test("selects exact poll interval and warning threshold options", () => {
    let state = initialState();
    state = reducer(state, { type: "set-poll-interval", minutes: 4 });
    state = reducer(state, { type: "set-warn-threshold", percent: 90 });
    expect(state.pollIntervalMinutes).toBe(4);
    expect(state.warnThreshold).toBe(90);
  });

  test("cancelling onboarding returns to its originating view", () => {
    const state: AppState = { ...initialState(), view: "settings", screen: "onboarding" };
    const cancelled = reducer(state, { type: "onboarding-cancel" });

    expect(cancelled.screen).toBe("app");
    expect(cancelled.view).toBe("settings");
  });

  test("selection follows enabled providers matching the filter", () => {
    let state = reducer(initialState(), { type: "start-filter" });
    state = reducer(state, { type: "filter-append", text: "codex" });
    state = reducer(state, { type: "filter-commit" });
    state = reducer(state, { type: "open-selected" });

    expect(state.view).toBe("codex");
  });

  test("disabling the selected provider moves selection to the first visible card", () => {
    let state = reducer(initialState(), { type: "select-provider", id: "cx" });
    state = reducer(state, { type: "settings-toggle-enabled", id: "cx" });

    expect(state.selection).toBe(0);
    expect(reducer(state, { type: "open-selected" }).view).toBe("claude");
  });

  test("onboarding choices normalize a selection that becomes hidden", () => {
    let state = reducer(initialState(), { type: "select-provider", id: "cl" });
    state = reducer(state, { type: "open-onboarding" });
    state = reducer(state, { type: "onboarding-pick", index: 0 });
    state = reducer(state, { type: "onboarding-begin-auth" });

    expect(state.selection).toBe(1);
  });

  test("refresh reconciles credential state without overriding visibility settings", () => {
    let state = reducer(initialState(), { type: "settings-toggle-enabled", id: "go" });
    const connections = mockUsageProvider.initialConnections();
    connections.cx = {
      ...connections.cx,
      status: "active",
      credential: "oauth · codex cli",
      note: "live account data",
    };
    connections.go.isEnabled = true;

    state = reducer(state, { type: "refresh-success", connections });

    expect(state.connections.cx).toMatchObject({
      status: "active",
      credential: "oauth · codex cli",
      note: "live account data",
    });
    expect(state.connections.go.isEnabled).toBe(false);
  });
});
