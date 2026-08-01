import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAY_MS, HOUR_MS } from "./real/aggregate";
import { stubCodexLimitsSource } from "./real/codex-limits";
import { dormantGoLimitsSource } from "./real/go-limits-source";
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
  opencodeCookie: "/nonexistent/opencode-cookie",
  claudeProjects: "/nonexistent/projects",
  claudeHistory: "/nonexistent/history.jsonl",
  claudeSettings: "/nonexistent/settings.json",
  usageSnapshot: "/nonexistent/usage-snapshot.json",
};

/** Keeps the suite off the network and away from a real codex process. */
const OFFLINE = {
  codexLimits: stubCodexLimitsSource,
  goLimits: dormantGoLimitsSource,
} as const;

describe("createRealUsageProvider with no sources", () => {
  const provider = createRealUsageProvider({ paths: MISSING_PATHS, ...OFFLINE });
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

  test("claude limits blame the unconfigured statusline, not the session", () => {
    const [session] = snapshot.providers.cl.limits;
    expect(session?.percent).toBeNull();
    // "open a session" would never produce a snapshot without a statusline.
    expect(session?.footnote).toContain("no statusline configured");
    expect(session?.footnote).not.toContain("open a claude code session");
  });

  test("a configured statusline changes the advice to opening a session", () => {
    const dir = mkdtempSync(join(tmpdir(), "limitless-settings-"));
    const settings = join(dir, "settings.json");
    writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "x.sh" } }));

    const provider = createRealUsageProvider({
      paths: { ...MISSING_PATHS, claudeSettings: settings },
      ...OFFLINE,
    });
    const [session] = provider.readSnapshot().providers.cl.limits;
    expect(session?.footnote).toContain("open a claude code session");
  });

  test("codex and go publish cap-less lines", () => {
    expect(snapshot.providers.cx.limits[0]?.percent).toBeNull();
    expect(snapshot.providers.cx.limits[0]?.reset).toBe("codex limits not connected");
    expect(snapshot.providers.go.limits[0]?.percent).toBeNull();
    expect(snapshot.providers.go.limits[0]?.footnote).toContain("no usage api");
  });

  test("refresh resolves and honors an already-aborted signal", async () => {
    const next = await provider.refresh();
    expect(next.dailyDates).toHaveLength(30);

    const controller = new AbortController();
    controller.abort();
    let rejection: unknown;
    try {
      await provider.refresh(controller.signal);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeDefined();
  });
});

describe("opencode go spend limits", () => {
  /** A throwaway db shaped like opencode's so the go path exercises real SQL. */
  function seedDb(path: string, rows: Array<{ atMs: number; usd: number }>): void {
    const db = new Database(path);
    db.run("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
    rows.forEach((row, index) => {
      const data = JSON.stringify({
        role: "assistant",
        providerID: "opencode-go",
        cost: row.usd,
        tokens: { input: 10, output: 10, reasoning: 0, cache: { write: 0, read: 0 } },
        time: { created: row.atMs },
      });
      db.run("INSERT INTO message VALUES (?1, ?2, ?3, ?4)", [
        `m${index}`,
        `s${index}`,
        row.atMs,
        data,
      ]);
    });
    db.close();
  }

  test("derives percent and dollar readouts from local spend", () => {
    const dbPath = join(tmpdir(), `limitless-go-${Date.now()}.db`);
    const nowMs = Date.now();
    seedDb(dbPath, [
      { atMs: nowMs - HOUR_MS, usd: 3 },
      { atMs: nowMs - 2 * DAY_MS, usd: 6 },
    ]);

    try {
      const provider = createRealUsageProvider({
        paths: { ...MISSING_PATHS, opencodeDb: dbPath },
        ...OFFLINE,
      });
      const go = provider.readSnapshot().providers.go;

      // $3 of the $12 rolling-5h cap, $9 of the $30 weekly cap.
      expect(go.scopes.session.percent).toBe(25);
      expect(go.scopes.weekly.percent).toBe(30);
      expect(go.limits[0]?.detailValueLabel).toBe("$3.00 of $12");
      expect(go.limits[0]?.footnote).toContain("estimated from local spend");
    } finally {
      rmSync(dbPath, { force: true });
    }
  });
});

describe("opencode go server limits", () => {
  const serverLimits = {
    rollingPercent: 17,
    rollingResetAtMs: Date.now() + 5_944_000,
    weeklyPercent: 75,
    weeklyResetAtMs: Date.now() + 278_201_000,
    fetchedAtMs: Date.now(),
  };

  test("server percentages replace the local estimate", () => {
    const provider = createRealUsageProvider({
      paths: MISSING_PATHS,
      ...OFFLINE,
      goLimits: { read: () => serverLimits, note: () => null, poll: () => Promise.resolve() },
    });
    const go = provider.readSnapshot().providers.go;

    expect(go.scopes.session.percent).toBe(17);
    expect(go.scopes.weekly.percent).toBe(75);
    expect(go.scopes.weekly.window).toContain("opencode");
    // The estimate's hedging language must not survive alongside server truth.
    expect(go.scopes.weekly.window).not.toContain("estimate");
  });

  test("a source note surfaces when there are no limits at all", () => {
    const provider = createRealUsageProvider({
      paths: MISSING_PATHS,
      ...OFFLINE,
      goLimits: {
        read: () => null,
        note: () => "opencode session expired - paste a fresh cookie",
        poll: () => Promise.resolve(),
      },
    });
    const go = provider.readSnapshot().providers.go;
    expect(go.limits[0]?.reset).toContain("session expired");
  });

  test("a failing poll leaves the local snapshot intact", async () => {
    const provider = createRealUsageProvider({
      paths: MISSING_PATHS,
      ...OFFLINE,
      goLimits: {
        read: () => null,
        note: () => null,
        poll: () => Promise.reject(new Error("network down")),
      },
    });
    const next = await provider.refresh();
    expect(next.dailyDates).toHaveLength(30);
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
