import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { App, pollIntervalMilliseconds, providerIdsForRefresh } from "../src/app";
import { mockUsageProvider } from "../src/data/mock-provider";
import type { RefreshRequest, UsageProvider, UsageSnapshot } from "../src/data/types";

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

interface ControlledRefresh {
  request: RefreshRequest;
  resolve(snapshot: UsageSnapshot): void;
  reject(error: unknown): void;
}

function snapshotWithReset(reset: string): UsageSnapshot {
  const snapshot = structuredClone(mockUsageProvider.readSnapshot());
  snapshot.providers.cl.limits[1] = {
    ...snapshot.providers.cl.limits[1]!,
    reset,
    resetLong: reset,
  };
  snapshot.providers.cl.scopes.weekly = {
    ...snapshot.providers.cl.scopes.weekly,
    reset,
  };
  return snapshot;
}

function controlledProvider(initial: UsageSnapshot) {
  const refreshes: ControlledRefresh[] = [];
  let connectionReads = 0;
  const provider: UsageProvider = {
    ...mockUsageProvider,
    initialConnections: () => {
      connectionReads += 1;
      return mockUsageProvider.initialConnections();
    },
    readSnapshot: () => initial,
    refresh: (request) => new Promise((resolve, reject) => {
      refreshes.push({ request, resolve, reject });
    }),
  };
  return { provider, refreshes, connectionReads: () => connectionReads };
}

async function letRefreshAdvance(setup: Awaited<ReturnType<typeof testRender>>): Promise<void> {
  await act(async () => {
    await Bun.sleep(20);
  });
  await setup.flush();
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

  test("keeps failed and unverified providers in automatic refreshes", () => {
    const connections = {
      cl: { isEnabled: true, status: "active", credential: "", note: "" },
      cx: { isEnabled: true, status: "expired", credential: "", note: "" },
      go: { isEnabled: true, status: "active", credential: "", note: "" },
    } as const;

    expect(providerIdsForRefresh(connections, "interval")).toEqual(["cl", "cx", "go"]);
    expect(providerIdsForRefresh(connections, "startup")).toEqual(["cl", "cx", "go"]);
    expect(providerIdsForRefresh(connections, "manual")).toEqual(["cl", "cx", "go"]);

    const missing = { ...connections, cx: { ...connections.cx, status: "none" as const } };
    expect(providerIdsForRefresh(missing, "interval")).toEqual(["cl", "cx", "go"]);
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

  test("a successful refresh replaces the rendered snapshot", async () => {
    const controlled = controlledProvider(snapshotWithReset("INITIAL SNAPSHOT"));
    const setup = await testRender(
      <App
        provider={controlled.provider}
        startup={{ screen: "app", view: "claude", mode: "detailed" }}
        isPollingEnabled={false}
      />,
      { width: 100, height: 40 },
    );
    try {
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("INITIAL SNAPSHOT");
      act(() => setup.renderer.stdin.emit("data", Buffer.from("r")));
      await letRefreshAdvance(setup);
      expect(controlled.refreshes).toHaveLength(1);
      controlled.refreshes[0]!.resolve(snapshotWithReset("REPLACED SNAPSHOT"));
      await letRefreshAdvance(setup);
      expect(setup.captureCharFrame()).toContain("REPLACED SNAPSHOT");
      expect(setup.captureCharFrame()).not.toContain("INITIAL SNAPSHOT");
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test("a rejected refresh renders the refresh error state", async () => {
    const controlled = controlledProvider(snapshotWithReset("UNCHANGED SNAPSHOT"));
    const setup = await testRender(
      <App
        provider={controlled.provider}
        startup={{ screen: "app", view: "overview", mode: "detailed" }}
        isPollingEnabled={false}
      />,
      { width: 100, height: 40 },
    );
    try {
      act(() => setup.renderer.stdin.emit("data", Buffer.from("r")));
      await letRefreshAdvance(setup);
      controlled.refreshes[0]!.reject(new Error("provider exploded"));
      await letRefreshAdvance(setup);
      expect(setup.captureCharFrame()).toContain("▲ refresh failed");
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test("queues one manual refresh and completes it after the active refresh", async () => {
    const controlled = controlledProvider(snapshotWithReset("INITIAL SNAPSHOT"));
    const setup = await testRender(
      <App
        provider={controlled.provider}
        startup={{ screen: "app", view: "claude", mode: "detailed" }}
        isPollingEnabled={false}
      />,
      { width: 100, height: 40 },
    );
    try {
      act(() => {
        setup.renderer.stdin.emit("data", Buffer.from("r"));
        setup.renderer.stdin.emit("data", Buffer.from("r"));
      });
      await letRefreshAdvance(setup);
      expect(controlled.refreshes).toHaveLength(1);

      controlled.refreshes[0]!.resolve(snapshotWithReset("FIRST REFRESH"));
      await letRefreshAdvance(setup);
      expect(controlled.refreshes).toHaveLength(2);
      expect(controlled.refreshes[1]?.request.reason).toBe("manual");

      controlled.refreshes[1]!.resolve(snapshotWithReset("QUEUED REFRESH"));
      await letRefreshAdvance(setup);
      expect(setup.captureCharFrame()).toContain("QUEUED REFRESH");
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test("aborts on unmount and ignores a late provider resolution", async () => {
    const controlled = controlledProvider(snapshotWithReset("INITIAL SNAPSHOT"));
    const setup = await testRender(
      <App
        provider={controlled.provider}
        startup={{ screen: "app", view: "claude", mode: "detailed" }}
        isPollingEnabled={false}
      />,
      { width: 100, height: 40 },
    );
    act(() => setup.renderer.stdin.emit("data", Buffer.from("r")));
    await letRefreshAdvance(setup);
    expect(controlled.refreshes).toHaveLength(1);
    expect(controlled.connectionReads()).toBe(1);

    act(() => setup.renderer.destroy());
    expect(controlled.refreshes[0]?.request.signal?.aborted).toBe(true);
    controlled.refreshes[0]!.resolve(snapshotWithReset("MUST NOT LAND"));
    await Bun.sleep(20);
    expect(controlled.connectionReads()).toBe(1);
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

  test("settings reconnects one provider without re-probing the others", async () => {
    const requests: RefreshRequest[] = [];
    const provider: UsageProvider = {
      ...mockUsageProvider,
      refresh: (request) => {
        requests.push(request);
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
      expect(setup.captureCharFrame()).toContain("reconnect");
      await act(async () => {
        setup.renderer.stdin.emit("data", Buffer.from("\u001b[B"));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      await act(async () => {
        setup.renderer.stdin.emit("data", Buffer.from("\r"));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      await setup.flush();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.providerIds).toEqual(["cx"]);
      expect(requests[0]?.reason).toBe("manual");
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test("settings renders live, cache, and local connection states truthfully", async () => {
    const connections = mockUsageProvider.initialConnections();
    connections.cl.status = "cached";
    connections.cx.status = "none";
    connections.go.status = "local";
    const provider: UsageProvider = {
      ...mockUsageProvider,
      initialConnections: () => structuredClone(connections),
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
      const frame = setup.captureCharFrame();
      expect(frame).toContain("cached");
      expect(frame).toContain("not connected");
      expect(frame).toContain("local");
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

  test("shows and clears a preference save failure in the status bar", async () => {
    let succeeds = false;
    const setup = await testRender(
      <App
        provider={pendingProvider()}
        startup={{ screen: "app", view: "settings", mode: "detailed" }}
        isPollingEnabled={false}
        onPreferencesChange={() => succeeds}
      />,
      { width: 100, height: 40 },
    );

    try {
      act(() => setup.renderer.stdin.emit("data", Buffer.from("p")));
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("▲ save failed");

      succeeds = true;
      act(() => setup.renderer.stdin.emit("data", Buffer.from("p")));
      await setup.flush();
      expect(setup.captureCharFrame()).not.toContain("▲ save failed");
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test("turns a thrown preference save error into the same status", async () => {
    const setup = await testRender(
      <App
        provider={pendingProvider()}
        startup={{ screen: "app", view: "settings", mode: "detailed" }}
        isPollingEnabled={false}
        onPreferencesChange={() => {
          throw new Error("lock timeout");
        }}
      />,
      { width: 100, height: 40 },
    );

    try {
      act(() => setup.renderer.stdin.emit("data", Buffer.from("p")));
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("▲ save failed");
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
