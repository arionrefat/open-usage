import { describe, expect, test } from "bun:test";
import { PROVIDER_IDS } from "./types";
import {
  createRealUsageProvider,
  hasRealSources,
  selectUsageProvider,
  type RealProviderPaths,
} from "./real-provider";
import { mockUsageProvider } from "./mock-provider";

const MISSING_PATHS: RealProviderPaths = {
  opencodeDb: "/nonexistent/opencode.db",
  opencodeAuth: "/nonexistent/auth.json",
  claudeProjects: "/nonexistent/projects",
  claudeHistory: "/nonexistent/history.jsonl",
  usageSnapshot: "/nonexistent/usage-snapshot.json",
};

describe("createRealUsageProvider with no sources", () => {
  const provider = createRealUsageProvider({ paths: MISSING_PATHS });
  const snapshot = provider.readSnapshot();

  test("keeps the full snapshot contract", () => {
    expect(snapshot.dailyDates).toHaveLength(30);
    for (const id of PROVIDER_IDS) {
      const usage = snapshot.providers[id];
      expect(usage.series.daily).toHaveLength(30);
      expect(usage.series.hourly).toHaveLength(24);
      expect(usage.limits.length).toBeGreaterThan(0);
      expect(usage.scopes.session.window.length).toBeGreaterThan(0);
      expect(usage.burn.rate.length).toBeGreaterThan(0);
    }
  });

  test("marks every connection as not connected", () => {
    const connections = provider.initialConnections();
    for (const id of PROVIDER_IDS) expect(connections[id].status).toBe("none");
  });

  test("claude limits explain the missing snapshot", () => {
    const [session] = snapshot.providers.cl.limits;
    expect(session?.percent).toBeNull();
    expect(session?.footnote).toContain("statusline snapshot missing");
  });

  test("codex and go publish cap-less lines", () => {
    expect(snapshot.providers.cx.limits[0]?.percent).toBeNull();
    expect(snapshot.providers.cx.limits[0]?.reset).toBe("limits api not yet connected");
    expect(snapshot.providers.go.limits[0]?.percent).toBeNull();
    expect(snapshot.providers.go.limits[0]?.footnote).toContain("opencode.ai dashboard");
  });

  test("refresh resolves and honors an already-aborted signal", async () => {
    const next = await provider.refresh();
    expect(next.dailyDates).toHaveLength(30);

    const controller = new AbortController();
    controller.abort();
    await expect(provider.refresh(controller.signal)).rejects.toBeDefined();
  });
});

describe("selectUsageProvider", () => {
  test("--mock always returns the mock", () => {
    expect(selectUsageProvider("mock", MISSING_PATHS)).toBe(mockUsageProvider);
  });

  test("real mode without sources falls back to mock with a visible note", () => {
    const provider = selectUsageProvider("real", MISSING_PATHS);
    expect(provider).not.toBe(mockUsageProvider);
    const snapshot = provider.readSnapshot();
    expect(snapshot.windowNote).toContain("no local usage sources found");
    expect(snapshot.providers.cl.notice?.segments[0]?.text).toContain("sample data");
  });

  test("hasRealSources is false for missing paths", () => {
    expect(hasRealSources(MISSING_PATHS)).toBe(false);
  });
});
