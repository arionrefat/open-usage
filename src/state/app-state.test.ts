import { describe, expect, test } from "bun:test";
import { mockUsageProvider } from "../data/mock-provider";
import { createAppReducer, createInitialState, type AppState } from "./app-state";
import { deriveState } from "./derive";

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

  test("onboarding continue is a no-op when nothing is picked", () => {
    let state = reducer(initialState(), { type: "onboarding-pick", index: 0 });
    state = reducer(state, { type: "onboarding-pick", index: 1 });
    state = reducer(state, { type: "onboarding-pick", index: 2 });
    const after = reducer(state, { type: "onboarding-begin-auth" });

    expect(after).toBe(state);
    expect(after.onboarding.step).toBe(0);
  });

  test("skipping credential replacement preserves the existing connection", () => {
    let state = reducer(initialState(), { type: "open-onboarding" });
    state = reducer(state, { type: "onboarding-begin-auth" });
    state = reducer(state, { type: "onboarding-commit", maskedCredential: null });

    expect(state.connections.cl).toEqual(initialState().connections.cl);
  });

  test("skipping credential replacement does not unhide a provider", () => {
    const original = initialState();
    original.connections.cl.isEnabled = false;
    const state = reducer(
      {
        ...original,
        screen: "onboarding",
        onboarding: {
          ...original.onboarding,
          step: 1,
          picks: { cl: true, cx: false, go: false },
        },
      },
      { type: "onboarding-commit", maskedCredential: null },
    );

    expect(state.connections.cl).toEqual(original.connections.cl);
  });

  test("enter cycles the connection status in place", () => {
    let state: AppState = { ...initialState(), view: "settings" };

    state = reducer(state, { type: "settings-cycle-status", id: "cl" });
    expect(state.view).toBe("settings");
    expect(state.screen).toBe("app");
    expect(state.connections.cl.status).toBe("expired");
    expect(state.connections.cl.credential).toBe("oauth · claude-max");
    expect(state.connections.cl.note).toBe("renewal needed");

    state = reducer(state, { type: "settings-cycle-status", id: "cl" });
    expect(state.connections.cl.status).toBe("none");
    expect(state.connections.cl.credential).toBe("");
    expect(state.connections.cl.note).toBe("credential removed");

    state = reducer(state, { type: "settings-cycle-status", id: "cl" });
    expect(state.view).toBe("settings");
    expect(state.connections.cl.status).toBe("active");
    expect(state.connections.cl.credential).toBe("sk-ant-api03-•••••••••7b31");
    expect(state.connections.cl.note).toBe("reconnected just now");
  });

  test("cycling status targets the settings cursor row by default", () => {
    let state = reducer(initialState(), { type: "settings-move", delta: 1 });
    state = reducer(state, { type: "settings-cycle-status" });

    expect(state.connections.cx.status).toBe("none");
    expect(state.connections.cx.credential).toBe("");
    expect(state.connections.cx.note).toBe("credential removed");
    expect(state.connections.cl).toEqual(initialState().connections.cl);
  });

  test("pasting a key connects the provider instantly", () => {
    const original = initialState();
    original.connections.cx.isEnabled = false;
    const state = reducer(original, { type: "settings-paste-key", id: "cx" });

    expect(state.view).toBe(original.view);
    expect(state.screen).toBe("app");
    expect(state.connections.cx).toEqual({
      isEnabled: true,
      status: "active",
      credential: "sk-proj-•••••••••••4f2a",
      note: "pasted just now",
    });
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

describe("derived state", () => {
  test("alerts count only the current scope", () => {
    const snapshot = mockUsageProvider.readSnapshot();

    const weekly = deriveState(initialState(), snapshot);
    expect(weekly.hotIds).toEqual(["cl"]);
    expect(weekly.alertText).toBe("▲ 2 issues");

    const session = deriveState({ ...initialState(), scope: "session" as const }, snapshot);
    expect(session.hotIds).toEqual([]);
    expect(session.alertText).toBe("▲ 1 issue");
  });

  test("names the all range 'all time'", () => {
    const snapshot = mockUsageProvider.readSnapshot();
    expect(deriveState({ ...initialState(), range: "all" as const }, snapshot).rangeName).toBe(
      "all time",
    );
  });
});
