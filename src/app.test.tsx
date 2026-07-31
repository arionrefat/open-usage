import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { App } from "./app";
import { mockUsageProvider } from "./data/mock-provider";
import type { UsageProvider } from "./data/types";

function pendingProvider(onRefresh?: (signal?: AbortSignal) => void): UsageProvider {
  return {
    ...mockUsageProvider,
    refresh: (signal) => {
      onRefresh?.(signal);
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
}

describe("App interactions", () => {
  test("starts provider polling immediately", async () => {
    let refreshCount = 0;
    let refreshSignal: AbortSignal | undefined;
    const setup = await testRender(
      <App
        provider={pendingProvider((signal) => {
          refreshCount += 1;
          refreshSignal = signal;
        })}
        startup={{ screen: "app", view: "overview", mode: "detailed" }}
      />,
      { width: 80, height: 30 },
    );

    try {
      expect(refreshCount).toBe(1);
    } finally {
      act(() => setup.renderer.destroy());
    }
    expect(refreshSignal?.aborted).toBe(true);
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

  test("accepts bracketed paste without displaying the raw credential", async () => {
    const setup = await testRender(
      <App
        provider={pendingProvider()}
        startup={{ screen: "onboarding", view: "overview", mode: "detailed" }}
      />,
      { width: 80, height: 30 },
    );

    try {
      expect(setup.renderer.keyInput.listenerCount("paste")).toBeGreaterThan(0);
      act(() => setup.mockInput.pressEnter());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await setup.flush();
      });
      expect(setup.captureCharFrame()).toContain("connect claude code");
      act(() => {
        setup.renderer.stdin.emit(
          "data",
          Buffer.from("\x1b[200~sk-secret-value-1234\x1b[201~"),
        );
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setup.flush();

      const entryFrame = setup.captureCharFrame();
      expect(entryFrame).toContain("••••");
      expect(entryFrame).not.toContain("sk-secret-value-1234");
    } finally {
      act(() => setup.renderer.destroy());
    }
  });
});
