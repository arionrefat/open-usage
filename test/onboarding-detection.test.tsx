import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { App } from "../src/app";
import { mockUsageProvider } from "../src/data/mock-provider";
import type { ProviderConnection, ProviderId, UsageProvider } from "../src/data/types";

function providerWithInstallations(
  installations: Record<ProviderId, boolean>,
): UsageProvider {
  const connections = mockUsageProvider.initialConnections();
  for (const id of Object.keys(installations) as ProviderId[]) {
    const installed = installations[id];
    connections[id] = {
      ...connections[id],
      isEnabled: installed,
      isAgentInstalled: installed,
      status: installed ? "active" : "none",
      credential: installed ? connections[id].credential : "",
    } satisfies ProviderConnection;
  }
  return {
    ...mockUsageProvider,
    initialConnections: () => structuredClone(connections),
  };
}

describe("agent-aware onboarding", () => {
  test("detects and preselects only installed coding agents", async () => {
    const setup = await testRender(
      <App
        provider={providerWithInstallations({ cl: true, cx: true, go: false })}
        startup={{ screen: "onboarding", view: "overview", mode: "detailed" }}
        isPollingEnabled={false}
      />,
      { width: 100, height: 32 },
    );

    try {
      await setup.flush();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("we found 2 coding agents on this device");
      expect(frame).toMatch(/\[×\]\s+claude code\s+installed/);
      expect(frame).toMatch(/\[×\]\s+codex\s+installed/);
      expect(frame).toMatch(/\[ \]\s+opencode\s+not found/);
      expect(frame).toContain("2 selected · 2 detected");
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test("explains that the OpenCode cookie is optional", async () => {
    const setup = await testRender(
      <App
        provider={providerWithInstallations({ cl: false, cx: false, go: true })}
        startup={{ screen: "onboarding", view: "overview", mode: "detailed" }}
        isPollingEnabled={false}
      />,
      { width: 100, height: 32 },
    );

    try {
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("Go estimates work locally · cookie optional");
      act(() => setup.mockInput.pressEnter());
      await setup.flush();
      const summary = setup.captureCharFrame();
      expect(summary).toContain("dashboard cookie is optional");
      expect(summary).toContain("no API key or cookie is required to finish setup");
      expect(summary).not.toContain("paste");
    } finally {
      act(() => setup.renderer.destroy());
    }
  });
});
