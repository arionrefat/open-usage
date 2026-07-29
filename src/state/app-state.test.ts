import { describe, expect, test } from "bun:test";
import { mockUsageProvider } from "../data/mock-provider";
import { createAppReducer, createInitialState } from "./app-state";

const reducer = createAppReducer(mockUsageProvider.listMeta());

function initialState() {
  return createInitialState({ connections: mockUsageProvider.initialConnections() });
}

describe("app reducer", () => {
  test("fully masks short credentials", () => {
    expect(mockUsageProvider.maskCredential("secret123")).toBe("•••••••••");
  });

  test("applies onboarding provider choices", () => {
    let state = reducer(initialState(), { type: "onboarding-pick", index: 0 });
    state = reducer(state, { type: "onboarding-begin-auth" });

    expect(state.connections.cl.isEnabled).toBe(false);
    expect(state.connections.cx.isEnabled).toBe(true);
    expect(state.connections.go.isEnabled).toBe(true);
  });

  test("skipping credential replacement preserves the existing connection", () => {
    let state = reducer(initialState(), { type: "settings-connect", id: "cl" });
    state = reducer(state, { type: "onboarding-commit", maskedCredential: null });

    expect(state.connections.cl).toEqual(initialState().connections.cl);
  });

  test("skipping credential replacement does not unhide a provider", () => {
    const original = initialState();
    original.connections.cl.isEnabled = false;
    let state = reducer(original, { type: "settings-connect", id: "cl" });
    state = reducer(state, { type: "onboarding-commit", maskedCredential: null });

    expect(state.connections.cl).toEqual(original.connections.cl);
  });

  test("changing the default mode does not leave settings", () => {
    const state = { ...initialState(), view: "settings" as const };
    expect(reducer(state, { type: "set-mode", mode: "simple" }).view).toBe("settings");
  });

  test("cancelling onboarding returns to its originating view", () => {
    const state = { ...initialState(), view: "settings" as const, screen: "onboarding" as const };
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
