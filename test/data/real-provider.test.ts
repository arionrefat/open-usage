import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLORS } from "../../src/theme";
import { DAY_MS, HOUR_MS } from "../../src/data/real/aggregate";
import { createCodexLimitsSource, stubCodexLimitsSource } from "../../src/data/real/codex-limits";
import { createGoLimitsSource, dormantGoLimitsSource } from "../../src/data/real/go-limits-source";
import { createClaudeLimitsSource, dormantClaudeLimitsSource } from "../../src/data/real/claude-usage";
import { PROVIDER_IDS } from "../../src/data/types";
import {
  createRealUsageProvider,
  hasRealSources,
  selectUsageProvider,
  type RealProviderPaths,
} from "../../src/data/real-provider";
import { mockUsageProvider } from "../../src/data/mock-provider";
import { readUsageCache, writeUsageCache } from "../../src/data/real/usage-cache";

const MISSING_PATHS: RealProviderPaths = {
  opencodeDb: "/nonexistent/opencode.db",
  opencodeAuth: "/nonexistent/auth.json",
  configFile: "/nonexistent/config.json",
  claudeProjects: "/nonexistent/projects",
  claudeHistory: "/nonexistent/history.jsonl",
  claudeSettings: "/nonexistent/settings.json",
  usageSnapshot: "/nonexistent/usage-snapshot.json",
  usageCache: "/nonexistent/usage-cache.json",
  codexHome: "/nonexistent/codex",
};

/** Keeps the suite off the network and away from a real codex process. */
const OFFLINE = {
  claudeLimits: dormantClaudeLimitsSource,
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

  test("claude limits direct the user to the live cli when no snapshot exists", () => {
    const [session] = snapshot.providers.cl.limits;
    expect(session?.percent).toBeNull();
    expect(session?.footnote).toContain("query claude cli");
    expect(session?.footnote).not.toContain("open a claude code session");
  });

  test("a configured statusline still directs refresh through the live cli", () => {
    const dir = mkdtempSync(join(tmpdir(), "limitless-settings-"));
    const settings = join(dir, "settings.json");
    writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "x.sh" } }));

    const provider = createRealUsageProvider({
      paths: { ...MISSING_PATHS, claudeSettings: settings },
      ...OFFLINE,
    });
    const [session] = provider.readSnapshot().providers.cl.limits;
    expect(session?.footnote).toContain("press r for live limits");
  });

  test("codex and go publish cap-less lines", () => {
    expect(snapshot.providers.cx.limits[0]?.percent).toBeNull();
    expect(snapshot.providers.cx.limits[0]?.reset).toBe("codex limits not connected");
    expect(snapshot.providers.go.limits[0]?.percent).toBeNull();
    expect(snapshot.providers.go.limits[0]?.footnote).toContain("cookie unlocks exact %");
  });

  test("refresh resolves and honors an already-aborted signal", async () => {
    const next = await provider.refresh({ reason: "manual", providerIds: PROVIDER_IDS });
    expect(next.dailyDates).toHaveLength(30);

    const controller = new AbortController();
    controller.abort();
    let rejection: unknown;
    try {
      await provider.refresh({
        reason: "manual",
        providerIds: PROVIDER_IDS,
        signal: controller.signal,
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeDefined();
  });

  test("refresh polls only requested providers", async () => {
    const calls = { cl: 0, cx: 0, go: 0 };
    const provider = createRealUsageProvider({
      paths: MISSING_PATHS,
      claudeLimits: {
        read: () => null,
        note: () => null,
        poll: () => {
          calls.cl += 1;
          return Promise.resolve();
        },
      },
      codexLimits: {
        read: () => null,
        note: () => null,
        poll: () => {
          calls.cx += 1;
          return Promise.resolve();
        },
      },
      goLimits: {
        read: () => null,
        note: () => null,
        cookieExpiresAtMs: () => null,
        poll: () => {
          calls.go += 1;
          return Promise.resolve();
        },
      },
    });

    await provider.refresh({ reason: "interval", providerIds: ["cl", "go"] });
    expect(calls).toEqual({ cl: 1, cx: 0, go: 1 });
    await provider.refresh({ reason: "manual", providerIds: ["cx"] });
    expect(calls).toEqual({ cl: 1, cx: 1, go: 1 });
  });
});

describe("persisted limit cache", () => {
  test("hydrates previous provider values before the first refresh", () => {
    const dir = mkdtempSync(join(tmpdir(), "limitless-cache-"));
    const cachePath = join(dir, "usage-cache.json");
    const fetchedAtMs = Date.now() - 20 * 60_000;
    writeUsageCache(cachePath, {
      claude: {
        session: { percent: 24, reset: "resets in 2h" },
        weekly: { percent: 61, reset: "resets in 4d" },
        fable: { percent: 35, reset: "resets in 4d" },
        fetchedAtMs,
      },
      codex: {
        session: null,
        weekly: { usedPercent: 38, resetsAtMs: fetchedAtMs + DAY_MS, windowMinutes: 10080 },
        planType: "plus",
        resetCredits: 0,
        additionalRateLimits: [],
        credits: null,
        usage: null,
        fetchedAtMs,
      },
      go: {
        rollingPercent: 17,
        rollingResetAtMs: fetchedAtMs + HOUR_MS,
        weeklyPercent: 42,
        weeklyResetAtMs: fetchedAtMs + DAY_MS,
        monthlyPercent: 55,
        monthlyResetAtMs: fetchedAtMs + 30 * DAY_MS,
        fetchedAtMs,
      },
    });

    try {
      expect(readUsageCache(cachePath).claude?.session.percent).toBe(24);
      const provider = createRealUsageProvider({
        paths: { ...MISSING_PATHS, usageCache: cachePath },
      });
      const snapshot = provider.readSnapshot();
      expect(snapshot.providers.cl.limits[0]?.percent).toBe(24);
      expect(snapshot.providers.cl.limits[2]).toMatchObject({
        id: "fable",
        percent: 35,
        reset: "resets in 4d",
      });
      expect(snapshot.providers.cx.limits[0]?.percent).toBe(38);
      expect(snapshot.providers.go.limits[0]?.percent).toBe(17);
      expect(snapshot.providers.cl.notice?.segments[0]?.text).toContain("cached live limits stale");
      expect(snapshot.providers.cx.notice?.segments[0]?.text).toContain("cached limits stale");
      expect(snapshot.providers.go.notice?.segments[0]?.text).toContain("cached limits stale");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("refresh pressure on the upstream providers", () => {
  /** Counts every call each provider would actually make to its upstream. */
  function countingProvider(cachePath: string) {
    const calls = { cl: 0, cx: 0, go: 0 };
    const nowMs = Date.now();
    const configPath = join(mkdtempSync(join(tmpdir(), "limitless-cookie-")), "config.json");
    writeFileSync(configPath, JSON.stringify({ opencodeCookie: "auth=tok" }));

    const provider = createRealUsageProvider({
      paths: { ...MISSING_PATHS, usageCache: cachePath },
      claudeLimits: createClaudeLimitsSource((now) => {
        calls.cl += 1;
        return Promise.resolve({
          session: { percent: 5, reset: "resets soon" },
          weekly: { percent: 5, reset: "resets soon" },
          fetchedAtMs: now.getTime(),
        });
      }),
      codexLimits: createCodexLimitsSource((now) => {
        calls.cx += 1;
        return Promise.resolve({
          session: null,
          weekly: { usedPercent: 5, resetsAtMs: nowMs + HOUR_MS, windowMinutes: 10080 },
          planType: "plus",
          resetCredits: 0,
          additionalRateLimits: [],
          credits: null,
          usage: null,
          fetchedAtMs: now.getTime(),
        });
      }),
      goLimits: createGoLimitsSource(configPath, {}, (_cookie, now) => {
        calls.go += 1;
        return Promise.resolve({
          rollingPercent: 5,
          rollingResetAtMs: nowMs + HOUR_MS,
          weeklyPercent: null,
          weeklyResetAtMs: null,
          monthlyPercent: null,
          monthlyResetAtMs: null,
          fetchedAtMs: now.getTime(),
        });
      }),
    });
    return { provider, calls };
  }

  test("a held refresh key cannot turn into one upstream call per keypress", async () => {
    const dir = mkdtempSync(join(tmpdir(), "limitless-pressure-"));
    try {
      const { provider, calls } = countingProvider(join(dir, "usage-cache.json"));
      // The app re-fires a queued manual refresh the moment the previous one
      // settles, so a held `r` arrives as a burst of back-to-back refreshes.
      for (let press = 0; press < 40; press += 1) {
        await provider.refresh({ reason: "manual", providerIds: ["cl", "cx", "go"] });
      }
      // One call each: the burst lands well inside every provider's floor.
      expect(calls).toEqual({ cl: 1, cx: 1, go: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("concurrent refreshes share one upstream call per provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "limitless-concurrent-"));
    try {
      const { provider, calls } = countingProvider(join(dir, "usage-cache.json"));
      await Promise.all(
        Array.from({ length: 8 }, () =>
          provider.refresh({ reason: "manual", providerIds: ["cl", "cx", "go"] }),
        ),
      );
      expect(calls).toEqual({ cl: 1, cx: 1, go: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fresh statusline snapshot slows the claude cli poll without silencing it", async () => {
    let calls = 0;
    const claudeLimits = createClaudeLimitsSource(
      (now) => {
        calls += 1;
        return Promise.resolve({
          session: { percent: 5, reset: "resets soon" },
          weekly: { percent: 5, reset: "resets soon" },
          fable: { percent: 0, reset: "no usage yet" },
          fetchedAtMs: now.getTime(),
        });
      },
      // Claude Code is writing the snapshot, so it covers session and weekly.
      { isCoveredBySnapshot: () => true },
    );

    const startMs = Date.now();
    // Ten minutes of the one-minute poll timer.
    for (let tick = 0; tick <= 10; tick += 1) {
      await claudeLimits.poll(new Date(startMs + tick * 60_000));
    }
    // The old 3-minute cadence would have spent four requests here.
    expect(calls).toBe(1);

    // Fable still refreshes, just on the slower cadence.
    await claudeLimits.poll(new Date(startMs + 21 * 60_000));
    expect(calls).toBe(2);
  });

  test("a stale statusline snapshot puts the claude cli back on the tight cadence", async () => {
    let calls = 0;
    let isCovered = true;
    const claudeLimits = createClaudeLimitsSource(
      (now) => {
        calls += 1;
        return Promise.resolve({
          session: { percent: 5, reset: "resets soon" },
          weekly: { percent: 5, reset: "resets soon" },
          fetchedAtMs: now.getTime(),
        });
      },
      { isCoveredBySnapshot: () => isCovered },
    );

    const startMs = Date.now();
    await claudeLimits.poll(new Date(startMs));
    expect(calls).toBe(1);

    await claudeLimits.poll(new Date(startMs + 4 * 60_000));
    expect(calls).toBe(1);

    // Claude Code stopped writing the snapshot, so the CLI is the only source of
    // the session and weekly windows again and must resume polling for them.
    isCovered = false;
    await claudeLimits.poll(new Date(startMs + 4 * 60_000 + 1));
    expect(calls).toBe(2);
  });

  test("an automatic refresh respects each provider's own interval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "limitless-interval-"));
    try {
      const { provider, calls } = countingProvider(join(dir, "usage-cache.json"));
      // Ten minutes of the default one-minute poll timer.
      for (let tick = 0; tick < 10; tick += 1) {
        await provider.refresh({ reason: "interval", providerIds: ["cl", "cx", "go"] });
      }
      // Every tick lands in the same instant, so the floors admit exactly one.
      expect(calls).toEqual({ cl: 1, cx: 1, go: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      expect(go.limits[0]?.footnote).toBe("model-weighted local estimate - cookie unlocks exact %");

      const serverWithoutMonthly = {
        rollingPercent: 17,
        rollingResetAtMs: nowMs + 5_944_000,
        weeklyPercent: 75,
        weeklyResetAtMs: nowMs + 278_201_000,
        monthlyPercent: null,
        monthlyResetAtMs: null,
        fetchedAtMs: nowMs,
      };
      const serverProvider = createRealUsageProvider({
        paths: { ...MISSING_PATHS, opencodeDb: dbPath },
        ...OFFLINE,
        goLimits: {
          read: () => serverWithoutMonthly,
          note: () => null,
          cookieExpiresAtMs: () => null,
          poll: () => Promise.resolve(),
        },
      });
      const monthly = serverProvider.readSnapshot().providers.go.limits.find(
        (limit) => limit.id === "monthly",
      );
      expect(monthly?.detailValueLabel).toContain("of $60");
      expect(monthly?.footnote).toBe("model-weighted local estimate - cookie unlocks exact %");
      expect(serverProvider.readSnapshot().providers.go.meta.planDetail).toContain("estimate");

      const expiredProvider = createRealUsageProvider({
        paths: { ...MISSING_PATHS, opencodeDb: dbPath },
        ...OFFLINE,
        goLimits: {
          read: () => null,
          note: () => "opencode session expired - paste a fresh cookie",
          cookieExpiresAtMs: () => null,
          poll: () => Promise.resolve(),
        },
      });
      const expiredGo = expiredProvider.readSnapshot().providers.go;
      expect(expiredGo.limits[0]?.detailValueLabel).toBe("$3.00 of $12");
      expect(expiredGo.notice?.segments[0]?.text).toContain("session expired");
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
    monthlyPercent: 99,
    monthlyResetAtMs: Date.now() + 90_061_000,
    fetchedAtMs: Date.now(),
  };

  test("server percentages replace the local estimate", () => {
    const provider = createRealUsageProvider({
      paths: MISSING_PATHS,
      ...OFFLINE,
      goLimits: {
        read: () => serverLimits,
        note: () => null,
        cookieExpiresAtMs: () => null,
        poll: () => Promise.resolve(),
      },
    });
    const go = provider.readSnapshot().providers.go;

    expect(go.scopes.session.percent).toBe(17);
    expect(go.scopes.weekly.percent).toBe(75);
    expect(go.scopes.weekly.window).toContain("opencode");
    // The estimate's hedging language must not survive alongside server truth.
    expect(go.scopes.weekly.window).not.toContain("estimate");
    const monthly = go.limits.find((limit) => limit.id === "monthly");
    expect(monthly?.percent).toBe(99);
    expect(monthly?.reset).toContain("resets in");
    expect(monthly?.detailValueLabel).toBeUndefined();
    expect(monthly?.footnote).toBeUndefined();
    expect(go.meta.planDetail).toBe("Go");
  });

  test("a source note surfaces when there are no limits at all", () => {
    const provider = createRealUsageProvider({
      paths: MISSING_PATHS,
      ...OFFLINE,
      goLimits: {
        read: () => null,
        note: () => "opencode session expired - paste a fresh cookie",
        cookieExpiresAtMs: () => null,
        poll: () => Promise.resolve(),
      },
    });
    const go = provider.readSnapshot().providers.go;
    expect(go.limits[0]?.reset).toContain("session expired");
    expect(go.notice).toEqual({
      icon: "▲",
      iconColor: COLORS.warn,
      segments: [{ text: "opencode session expired - paste a fresh cookie" }],
    });
  });

  test("every source degradation becomes a warning notice", () => {
    const notes = [
      "opencode session expired - paste a fresh cookie",
      "no auth cookie found - re-copy the opencode.ai cookie header",
      "opencode dashboard changed - showing local estimate",
      "opencode unreachable - showing local estimate",
    ];
    for (const note of notes) {
      const provider = createRealUsageProvider({
        paths: MISSING_PATHS,
        ...OFFLINE,
        goLimits: {
          read: () => null,
          note: () => note,
          cookieExpiresAtMs: () => null,
          poll: () => Promise.resolve(),
        },
      });
      expect(provider.readSnapshot().providers.go.notice?.segments[0]?.text).toBe(note);
    }
  });

  test("warns when the cookie expires within seven days", () => {
    const provider = createRealUsageProvider({
      paths: MISSING_PATHS,
      ...OFFLINE,
      goLimits: {
        read: () => serverLimits,
        note: () => null,
        cookieExpiresAtMs: () => Date.now() + 2 * DAY_MS,
        poll: () => Promise.resolve(),
      },
    });
    const notice = provider.readSnapshot().providers.go.notice;
    expect(notice?.iconColor).toBe(COLORS.warn);
    expect(notice?.segments[0]?.text).toContain("opencode cookie expires in");
    expect(notice?.segments[0]?.text).toContain("paste a fresh one");
  });

  test("a failure note wins over an expiry warning", () => {
    const provider = createRealUsageProvider({
      paths: MISSING_PATHS,
      ...OFFLINE,
      goLimits: {
        read: () => null,
        note: () => "opencode unreachable - showing local estimate",
        cookieExpiresAtMs: () => Date.now() - DAY_MS,
        poll: () => Promise.resolve(),
      },
    });
    expect(provider.readSnapshot().providers.go.notice?.segments[0]?.text).toBe(
      "opencode unreachable - showing local estimate",
    );
  });

  test("an already-expired cookie uses the expired wording", () => {
    const provider = createRealUsageProvider({
      paths: MISSING_PATHS,
      ...OFFLINE,
      goLimits: {
        read: () => serverLimits,
        note: () => null,
        cookieExpiresAtMs: () => Date.now() - DAY_MS,
        poll: () => Promise.resolve(),
      },
    });
    expect(provider.readSnapshot().providers.go.notice?.segments[0]?.text).toBe(
      "opencode cookie expired - paste a fresh one",
    );
  });

  test("a healthy far-future cookie has no notice", () => {
    const provider = createRealUsageProvider({
      paths: MISSING_PATHS,
      ...OFFLINE,
      goLimits: {
        read: () => serverLimits,
        note: () => null,
        cookieExpiresAtMs: () => Date.now() + 30 * DAY_MS,
        poll: () => Promise.resolve(),
      },
    });
    expect(provider.readSnapshot().providers.go.notice).toBeUndefined();
  });

  test("a failing poll leaves the local snapshot intact", async () => {
    const provider = createRealUsageProvider({
      paths: MISSING_PATHS,
      ...OFFLINE,
      goLimits: {
        read: () => null,
        note: () => null,
        cookieExpiresAtMs: () => null,
        poll: () => Promise.reject(new Error("network down")),
      },
    });
    const next = await provider.refresh({ reason: "manual", providerIds: ["go"] });
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

  test("does not treat a malformed cache as a real usage source", () => {
    const dir = mkdtempSync(join(tmpdir(), "limitless-invalid-cache-"));
    const cachePath = join(dir, "usage-cache.json");
    writeFileSync(cachePath, JSON.stringify({ version: 1, claude: { percent: "bad" } }));
    try {
      expect(hasRealSources({ ...MISSING_PATHS, usageCache: cachePath })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a Codex-only installation selects the real provider", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "limitless-codex-"));
    const paths = { ...MISSING_PATHS, codexHome };
    expect(hasRealSources(paths)).toBe(true);
    expect(selectUsageProvider("real", paths)).not.toBe(mockUsageProvider);
  });
});
