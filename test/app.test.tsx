import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { App, providerIdsForRefresh } from "../src/app";
import { mockUsageProvider } from "../src/data/mock-provider";
import type { RefreshRequest, UsageProvider } from "../src/data/types";

function pendingProvider(onRefresh?: (request: RefreshRequest) => void): UsageProvider {
  const connections = mockUsageProvider.initialConnections();
  connections.cx = { ...connections.cx, status: "active" };
  return {
    ...mockUsageProvider,
    initialConnections: () => structuredClone(connections),
    refresh: (request) => {
      onRefresh?.(request);
      return new Promise((_, reject) => {
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
      });
    },
  };
}

describe("App interactions", () => {
  test("includes Codex in interval polling", () => {
    expect(
      providerIdsForRefresh(
        {
          cl: { isEnabled: true, status: "active", credential: "", note: "" },
          cx: { isEnabled: true, status: "active", credential: "", note: "" },
          go: { isEnabled: true, status: "active", credential: "", note: "" },
        },
        "interval",
      ),
    ).toEqual(["cl", "cx", "go"]);
  });

  test("skips unavailable Codex during automatic refresh but keeps manual probing", () => {
    const connections = {
      cl: { isEnabled: true, status: "active", credential: "", note: "" },
      cx: { isEnabled: true, status: "expired", credential: "", note: "" },
      go: { isEnabled: true, status: "active", credential: "", note: "" },
    } as const;

    expect(providerIdsForRefresh(connections, "interval")).toEqual(["cl", "go"]);
    expect(providerIdsForRefresh(connections, "startup")).toEqual(["cl", "go"]);
    expect(providerIdsForRefresh(connections, "manual")).toEqual(["cl", "cx", "go"]);

    const missing = { ...connections, cx: { ...connections.cx, status: "none" as const } };
    expect(providerIdsForRefresh(missing, "interval")).toEqual(["cl", "go"]);
  });

  test("starts polling all enabled providers", async () => {
    let refreshRequest: RefreshRequest | undefined;
    const setup = await testRender(
      <App
        provider={pendingProvider((request) => {
          refreshRequest = request;
        })}
        startup={{ screen: "app", view: "overview", mode: "detailed" }}
      />,
      { width: 80, height: 30 },
    );

    try {
      expect(refreshRequest?.reason).toBe("startup");
      expect(refreshRequest?.providerIds).toEqual(["cl", "cx", "go"]);
    } finally {
      act(() => setup.renderer.destroy());
    }
    expect(refreshRequest?.signal?.aborted).toBe(true);
  });

  test("--no-poll mode never calls refresh, but r still does", async () => {
    let refreshCount = 0;
    const setup = await testRender(
      <App
        provider={pendingProvider(() => {
          refreshCount += 1;
        })}
        startup={{ screen: "app", view: "overview", mode: "detailed" }}
        isPollingEnabled={false}
      />,
      { width: 80, height: 30 },
    );

    try {
      expect(refreshCount).toBe(0);
      act(() => setup.renderer.stdin.emit("data", Buffer.from("r")));
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setup.flush();
      expect(refreshCount).toBe(1);
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test("any key closes the help overlay", async () => {
    const setup = await testRender(
      <App
        provider={pendingProvider()}
        startup={{ screen: "app", view: "overview", mode: "detailed" }}
      />,
      { width: 100, height: 40 },
    );

    try {
      act(() => setup.renderer.stdin.emit("data", Buffer.from("?")));
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("keymap");

      act(() => setup.renderer.stdin.emit("data", Buffer.from("j")));
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setup.flush();
      expect(setup.captureCharFrame()).not.toContain("keymap");
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test("onboarding completes without credentials", async () => {
    let completed = 0;
    let refreshRequest: RefreshRequest | undefined;
    const setup = await testRender(
      <App
        provider={pendingProvider((request) => {
          refreshRequest = request;
        })}
        startup={{ screen: "onboarding", view: "overview", mode: "detailed" }}
        onOnboardingFinish={() => {
          completed += 1;
        }}
      />,
      { width: 80, height: 30 },
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setup.flush();
      expect(refreshRequest).toBeUndefined();
      act(() => setup.mockInput.pressEnter());
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setup.flush();
      const summary = setup.captureCharFrame();
      expect(summary).toContain("provider logins stay in their own CLIs");
      expect(summary).not.toContain("paste credential");
      act(() => setup.mockInput.pressEnter());
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setup.flush();
      expect(completed).toBe(1);
      expect(refreshRequest?.reason).toBe("startup");
      expect(refreshRequest?.providerIds).toEqual(["cl", "cx", "go"]);
    } finally {
      act(() => setup.renderer.destroy());
    }
  });
});
