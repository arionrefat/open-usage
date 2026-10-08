import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { App } from "../src/app";
import { mockUsageProvider } from "../src/data/mock-provider";
import type { UsageProvider } from "../src/data/types";
import type { OverviewMode, ViewKey } from "../src/state/app-state";

function providerWithoutCodex(): UsageProvider {
  const connections = mockUsageProvider.initialConnections();
  connections.cx = {
    isAvailable: false,
    isEnabled: false,
    isAgentInstalled: false,
    status: "none",
    credential: "",
    note: "codex not found",
  };
  const snapshot = mockUsageProvider.readSnapshot();
  return {
    ...mockUsageProvider,
    initialConnections: () => structuredClone(connections),
    // The sample window note names codex, which is not what is under test here.
    readSnapshot: () => ({ ...snapshot, windowNote: "" }),
  };
}

async function renderWithoutCodex(view: ViewKey, mode: OverviewMode = "detailed") {
  return testRender(
    <App
      provider={providerWithoutCodex()}
      startup={{ screen: "app", view, mode }}
      isPollingEnabled={false}
    />,
    { width: 160, height: 60 },
  );
}

function press(setup: Awaited<ReturnType<typeof testRender>>, key: string) {
  act(() => setup.renderer.stdin.emit("data", Buffer.from(key)));
}

describe("a provider that is not installed", () => {
  test("has no tab, and the tabs after it renumber", async () => {
    const setup = await renderWithoutCodex("overview");
    try {
      await setup.flush();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("2 claude code");
      expect(frame).toContain("3 opencode go");
      expect(frame).toContain("4 settings");
      expect(frame).not.toContain("codex");
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test("number keys follow the renumbered tabs", async () => {
    const setup = await renderWithoutCodex("overview");
    try {
      press(setup, "4");
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("providers, connections, refresh");
      expect(setup.captureCharFrame()).not.toContain("codex");

      press(setup, "5");
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("providers, connections, refresh");
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test("is left out of the simplified overview", async () => {
    const setup = await renderWithoutCodex("overview", "simple");
    try {
      await setup.flush();
      expect(setup.captureCharFrame()).not.toContain("codex");
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test("cannot be opened from a startup flag", async () => {
    const setup = await renderWithoutCodex("codex");
    try {
      await setup.flush();
      expect(setup.captureCharFrame()).not.toContain("codex");
    } finally {
      act(() => setup.renderer.destroy());
    }
  });
});
