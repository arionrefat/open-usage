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
});
