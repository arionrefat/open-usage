import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { App } from "../src/app";
import { mockUsageProvider } from "../src/data/mock-provider";
import type { RefreshRequest, UsageProvider } from "../src/data/types";

function pendingProvider(onRefresh?: (request: RefreshRequest) => void): UsageProvider {
  return {
    ...mockUsageProvider,
    refresh: (request) => {
      onRefresh?.(request);
      return new Promise((_, reject) => {
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
      });
    },
  };
}

describe("App interactions", () => {
  test("starts polling without spawning codex by default", async () => {
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
      expect(refreshRequest?.providerIds).toEqual(["cl", "go"]);
    } finally {
      act(() => setup.renderer.destroy());
    }
    expect(refreshRequest?.signal?.aborted).toBe(true);
  });

  test("includes codex at startup only after explicit opt-in", async () => {
    let refreshRequest: RefreshRequest | undefined;
    const setup = await testRender(
      <App
        provider={pendingProvider((request) => {
          refreshRequest = request;
        })}
        startup={{
          screen: "app",
          view: "overview",
          mode: "detailed",
          refreshCodexOnStartup: true,
        }}
      />,
      { width: 80, height: 30 },
    );

    try {
      expect(refreshRequest?.providerIds).toEqual(["cl", "cx", "go"]);
    } finally {
      act(() => setup.renderer.destroy());
    }
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

  test("onboarding toggles and persists the codex startup choice without credentials", async () => {
    const persisted: boolean[] = [];
    let completed = 0;
    let refreshRequest: RefreshRequest | undefined;
    const setup = await testRender(
      <App
        provider={pendingProvider((request) => {
          refreshRequest = request;
        })}
        startup={{ screen: "onboarding", view: "overview", mode: "detailed" }}
        onRefreshCodexOnStartupChange={(enabled) => persisted.push(enabled)}
        onOnboardingFinish={() => {
          completed += 1;
        }}
      />,
      { width: 80, height: 30 },
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("refresh codex on startup");
      expect(refreshRequest).toBeUndefined();
      act(() => setup.mockInput.pressKey("c"));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await setup.flush();
      });
      expect(persisted).toEqual([true]);
      act(() => setup.mockInput.pressEnter());
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setup.flush();
      const summary = setup.captureCharFrame();
      expect(summary).toContain("codex startup refresh");
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
