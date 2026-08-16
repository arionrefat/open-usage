import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { App, pollIntervalMilliseconds, providerIdsForRefresh } from "../src/app";
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
  test("converts the configured poll interval to milliseconds", () => {
    expect(pollIntervalMilliseconds(1)).toBe(60_000);
    expect(pollIntervalMilliseconds(5)).toBe(300_000);
  });

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

  test("reconciles a provider signed in after startup when refresh succeeds", async () => {
    let isSignedIn = false;
    const provider: UsageProvider = {
      ...mockUsageProvider,
      initialConnections: () => {
        const connections = mockUsageProvider.initialConnections();
        connections.cx = {
          ...connections.cx,
          status: isSignedIn ? "active" : "none",
          credential: isSignedIn ? "oauth · codex cli" : "",
          note: isSignedIn ? "live account data" : "codex found; sign in with its CLI",
        };
        return connections;
      },
      refresh: () => {
        isSignedIn = true;
        return Promise.resolve(mockUsageProvider.readSnapshot());
      },
    };
    const setup = await testRender(
      <App
        provider={provider}
        startup={{ screen: "app", view: "settings", mode: "detailed" }}
        isPollingEnabled={false}
      />,
      { width: 100, height: 40 },
    );

    try {
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("codex found; sign in with its CLI");
      await act(async () => {
        setup.renderer.stdin.emit("data", Buffer.from("r"));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      await setup.flush();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("oauth · codex cli");
      expect(frame).toContain("live account data");
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test("persists the final settings after batched shortcuts", async () => {
    const patches: Array<Record<string, unknown>> = [];
    const setup = await testRender(
      <App
        provider={pendingProvider()}
        startup={{
          screen: "app",
          view: "settings",
          mode: "detailed",
          pollIntervalMinutes: 1,
          warnThreshold: 80,
        }}
        isPollingEnabled={false}
        onPreferencesChange={(patch) => patches.push(patch)}
      />,
      { width: 100, height: 40 },
    );

    try {
      act(() => {
        setup.renderer.stdin.emit("data", Buffer.from("p"));
        setup.renderer.stdin.emit("data", Buffer.from("p"));
        setup.renderer.stdin.emit("data", Buffer.from("w"));
        setup.renderer.stdin.emit("data", Buffer.from("w"));
        setup.renderer.stdin.emit("data", Buffer.from("m"));
      });
      expect(Object.assign({}, ...patches)).toEqual({
        defaultOverviewMode: "simple",
        pollIntervalMinutes: 3,
        warnThreshold: 90,
      });
      await setup.flush();
      expect(patches).toEqual([
        { pollIntervalMinutes: 2 },
        { pollIntervalMinutes: 3 },
        { warnThreshold: 85 },
        { warnThreshold: 90 },
        { defaultOverviewMode: "simple" },
      ]);
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test("renders poll and alert choices as segmented controls with separate hints", async () => {
    const setup = await testRender(
      <App
        provider={pendingProvider()}
        startup={{
          screen: "app",
          view: "settings",
          mode: "detailed",
          pollIntervalMinutes: 2,
          warnThreshold: 90,
        }}
        isPollingEnabled={false}
      />,
      { width: 100, height: 44 },
    );

    try {
      await setup.flush();
      const frame = setup.captureCharFrame();
      expect(frame).toMatch(/poll interval\s+1m\s+2m\s+3m\s+4m\s+5m/);
      expect(frame).toMatch(/alert threshold\s+80%\s+85%\s+90%/);
      expect(frame).toContain("[p] cycle options  ·  [r] force a refresh");
      expect(frame).toContain("[w] cycle options  ·  red at this level");
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test("selects exact settings options with the mouse", async () => {
    const patches: Array<Record<string, unknown>> = [];
    const setup = await testRender(
      <App
        provider={pendingProvider()}
        startup={{
          screen: "app",
          view: "settings",
          mode: "simple",
          pollIntervalMinutes: 2,
          warnThreshold: 80,
        }}
        isPollingEnabled={false}
        onPreferencesChange={(patch) => patches.push(patch)}
      />,
      { width: 110, height: 44 },
    );

    try {
      await setup.flush();
      await act(async () => setup.mockMouse.click(28, 25));
      await act(async () => setup.mockMouse.click(40, 26));
      await act(async () => setup.mockMouse.click(38, 28));
      await setup.flush();
      expect(patches).toEqual([
        { defaultOverviewMode: "simple" },
        { pollIntervalMinutes: 4 },
        { warnThreshold: 90 },
      ]);
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test("changing the poll interval does not abort or restart an active refresh", async () => {
    const requests: RefreshRequest[] = [];
    const setup = await testRender(
      <App
        provider={pendingProvider((request) => requests.push(request))}
        startup={{
          screen: "app",
          view: "settings",
          mode: "detailed",
          pollIntervalMinutes: 1,
        }}
      />,
      { width: 100, height: 40 },
    );

    try {
      expect(requests).toHaveLength(1);
      act(() => setup.renderer.stdin.emit("data", Buffer.from("p")));
      await setup.flush();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.signal?.aborted).toBe(false);
    } finally {
      act(() => setup.renderer.destroy());
    }
    expect(requests[0]?.signal?.aborted).toBe(true);
  });

  test("keeps mode persistence aligned after changing the simplified scope", async () => {
    const patches: Array<Record<string, unknown>> = [];
    const setup = await testRender(
      <App
        provider={pendingProvider()}
        startup={{ screen: "app", view: "overview", mode: "detailed" }}
        isPollingEnabled={false}
        onPreferencesChange={(patch) => patches.push(patch)}
      />,
      { width: 100, height: 40 },
    );

    try {
      act(() => {
        setup.renderer.stdin.emit("data", Buffer.from("w"));
        setup.renderer.stdin.emit("data", Buffer.from("m"));
      });
      expect(patches).toEqual([{ defaultOverviewMode: "detailed" }]);
      await setup.flush();
      expect(setup.captureCharFrame()).not.toContain("window  session");
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test("simplified summary ranks every rendered provider despite a filter", async () => {
    const setup = await testRender(
      <App
        provider={pendingProvider()}
        startup={{ screen: "app", view: "overview", mode: "simple" }}
        isPollingEnabled={false}
      />,
      { width: 110, height: 40 },
    );

    try {
      for (const input of ["/", "g", "o", "\r"]) {
        await act(async () => {
          setup.renderer.stdin.emit("data", Buffer.from(input));
          await new Promise((resolve) => setTimeout(resolve, 5));
        });
        await setup.flush();
      }
      await setup.flush();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("claude code 88% closest to cap");
      expect(frame).toContain("opencode go");
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
      const help = setup.captureCharFrame();
      expect(help).toContain("keymap");
      expect(help).toContain("today / 7d / 30d / cal month");
      expect(help).not.toContain("month / all");

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
      expect(summary).toContain("Claude and Codex reuse CLI logins");
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
