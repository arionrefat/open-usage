import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abortableSleep, runDaemonLoop } from "../../src/daemon/runtime";
import { readDaemonState, writeDaemonState } from "../../src/daemon/state";
import { mockUsageProvider } from "../../src/data/mock-provider";
import { createRealUsageProvider, type RealProviderPaths } from "../../src/data/real-provider";
import { createClaudeLimitsSource } from "../../src/data/real/claude-usage";
import { createCodexLimitsSource } from "../../src/data/real/codex-limits";
import { dormantClaudeAuthSource } from "../../src/data/real/claude-auth";
import { dormantGoLimitsSource } from "../../src/data/real/go-limits-source";
import type {
  ConnectionStatus,
  ProviderConnection,
  ProviderId,
  RefreshRequest,
  UsageProvider,
  UsageSnapshot,
} from "../../src/data/types";

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

const OWNER_PID = 4821;

/** Nothing on disk, so only the injected sources decide what the daemon sees. */
const MISSING_PATHS: RealProviderPaths = {
  opencodeDb: "/nonexistent/opencode.db",
  opencodeAuth: "/nonexistent/auth.json",
  configFile: "/nonexistent/config.json",
  claudeProjects: "/nonexistent/projects",
  claudeHistory: "/nonexistent/history.jsonl",
  claudeSettings: "/nonexistent/settings.json",
  usageSnapshot: "/nonexistent/usage-snapshot.json",
  usageCache: "/nonexistent/usage-cache.json",
  claudeConfig: "/nonexistent/.claude.json",
  spendHistory: "/nonexistent/spend-history.json",
  pricingOverrides: "/nonexistent/pricing.json",
  codexHome: "/nonexistent/codex",
};

function statePath(pid = OWNER_PID): string {
  const root = mkdtempSync(join(tmpdir(), "open-usage-runtime-"));
  tempRoots.push(root);
  const path = join(root, "daemon.json");
  writeDaemonState(path, {
    pid,
    startedAtMs: 0,
    intervalMinutes: 5,
    lastPollAtMs: null,
    lastSuccessAtMs: null,
    lastError: null,
    logPath: join(root, "daemon.log"),
  });
  return path;
}

/**
 * Connection health the daemon reads back after a refresh. Everything is
 * working unless a test says otherwise, which the sample fixture cannot stand in
 * for: it ships a permanently expired `cx` to give the UI something to draw.
 */
function connections(
  statuses: Partial<Record<ProviderId, ConnectionStatus>> = {},
): Record<ProviderId, ProviderConnection> {
  const one = (id: ProviderId): ProviderConnection => ({
    isEnabled: true,
    isAgentInstalled: true,
    status: statuses[id] ?? "active",
    credential: "",
    note: `${id} unavailable`,
  });
  return { cl: one("cl"), cx: one("cx"), go: one("go") };
}

/** A provider whose refresh outcome each call is scripted by the test. */
function scriptedProvider(
  outcomes: Array<"ok" | Error>,
  statuses: Partial<Record<ProviderId, ConnectionStatus>> = {},
): {
  provider: UsageProvider;
  requests: RefreshRequest[];
} {
  const requests: RefreshRequest[] = [];
  const snapshot = mockUsageProvider.readSnapshot();
  const provider: UsageProvider = {
    ...mockUsageProvider,
    initialConnections: () => connections(statuses),
    refresh: (request) => {
      requests.push(request);
      const outcome = outcomes[requests.length - 1] ?? "ok";
      return outcome === "ok"
        ? Promise.resolve<UsageSnapshot>(snapshot)
        : Promise.reject(outcome);
    },
  };
  return { provider, requests };
}

/** Stops the loop after `rounds` sleeps, standing in for a SIGTERM. */
function stopAfter(controller: AbortController, rounds: number) {
  let slept = 0;
  return () => {
    slept += 1;
    if (slept >= rounds) controller.abort();
    return Promise.resolve();
  };
}

describe("daemon runtime", () => {
  test("refreshes every provider on each pass and records the success", async () => {
    const path = statePath();
    const controller = new AbortController();
    const { provider, requests } = scriptedProvider(["ok", "ok"]);

    await runDaemonLoop({
      provider,
      statePath: path,
      intervalMs: 60_000,
      signal: controller.signal,
      ownerPid: OWNER_PID,
      now: () => new Date(5_000),
      log: () => {},
      sleep: stopAfter(controller, 2),
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.reason).toBe("interval");
    expect(requests[0]?.providerIds).toEqual(["cl", "cx", "go"]);
    expect(readDaemonState(path)?.lastSuccessAtMs).toBe(5_000);
    expect(readDaemonState(path)?.lastError).toBeNull();
  });

  test("a later success clears the failure it recorded", async () => {
    const path = statePath();
    const controller = new AbortController();
    const { provider, requests } = scriptedProvider([new Error("codex cli did not respond")]);

    await runDaemonLoop({
      provider,
      statePath: path,
      intervalMs: 60_000,
      signal: controller.signal,
      ownerPid: OWNER_PID,
      now: () => new Date(5_000),
      log: () => {},
      sleep: stopAfter(controller, 2),
    });

    expect(requests).toHaveLength(2);
    const state = readDaemonState(path);
    expect(state?.lastError).toBeNull();
    expect(state?.lastSuccessAtMs).toBe(5_000);
  });

  test("a failing provider leaves the error on the record", async () => {
    const path = statePath();
    const controller = new AbortController();
    const { provider } = scriptedProvider([new Error("offline"), new Error("offline")]);

    await runDaemonLoop({
      provider,
      statePath: path,
      intervalMs: 60_000,
      signal: controller.signal,
      ownerPid: OWNER_PID,
      now: () => new Date(5_000),
      log: () => {},
      sleep: stopAfter(controller, 1),
    });

    const state = readDaemonState(path);
    expect(state?.lastError).toBe("offline");
    expect(state?.lastSuccessAtMs).toBeNull();
    expect(state?.lastPollAtMs).toBe(5_000);
  });

  test("records a provider that failed inside a refresh that resolved", async () => {
    const path = statePath();
    const controller = new AbortController();
    // A resolved refresh says the pass ran, not that anything reached a server.
    const { provider } = scriptedProvider(["ok"], { cl: "expired" });

    await runDaemonLoop({
      provider,
      statePath: path,
      intervalMs: 60_000,
      signal: controller.signal,
      ownerPid: OWNER_PID,
      now: () => new Date(5_000),
      log: () => {},
      sleep: stopAfter(controller, 1),
    });

    const state = readDaemonState(path);
    expect(state?.lastError).toBe("cl: cl unavailable");
    expect(state?.lastSuccessAtMs).toBeNull();
    expect(state?.lastPollAtMs).toBe(5_000);
  });

  test("a provider that is merely absent is not a failure", async () => {
    const path = statePath();
    const controller = new AbortController();
    const { provider } = scriptedProvider(["ok"], { go: "none" });

    await runDaemonLoop({
      provider,
      statePath: path,
      intervalMs: 60_000,
      signal: controller.signal,
      ownerPid: OWNER_PID,
      now: () => new Date(5_000),
      log: () => {},
      sleep: stopAfter(controller, 1),
    });

    const state = readDaemonState(path);
    expect(state?.lastError).toBeNull();
    expect(state?.lastSuccessAtMs).toBe(5_000);
  });

  test("reports the real provider's failures rather than its resolved promise", async () => {
    const path = statePath();
    const controller = new AbortController();
    const lines: string[] = [];
    // The real provider swallows a source failure on purpose, so a daemon that
    // trusted `refresh` alone would log `poll ok` while an expired credential
    // refreshed nothing. This is the pass a fake provider cannot stand in for.
    const provider = createRealUsageProvider({
      paths: MISSING_PATHS,
      env: {},
      claudeAuth: dormantClaudeAuthSource,
      goLimits: dormantGoLimitsSource,
      claudeLimits: createClaudeLimitsSource(() =>
        Promise.reject(new Error("credentials expired")),
      ),
      codexLimits: createCodexLimitsSource(() =>
        Promise.reject(new Error("connection refused")),
      ),
    });

    await runDaemonLoop({
      provider,
      statePath: path,
      intervalMs: 60_000,
      signal: controller.signal,
      ownerPid: OWNER_PID,
      now: () => new Date(5_000),
      log: (line) => lines.push(line),
      sleep: stopAfter(controller, 1),
    });

    const state = readDaemonState(path);
    expect(state?.lastSuccessAtMs).toBeNull();
    expect(state?.lastError).toContain("cl:");
    expect(state?.lastError).toContain("cx:");
    expect(lines[0]).toContain("poll failed");
  });

  test("logs one line per pass", async () => {
    const path = statePath();
    const controller = new AbortController();
    const { provider } = scriptedProvider(["ok", new Error("offline")]);
    const lines: string[] = [];

    await runDaemonLoop({
      provider,
      statePath: path,
      intervalMs: 60_000,
      signal: controller.signal,
      ownerPid: OWNER_PID,
      now: () => new Date(0),
      log: (line) => lines.push(line),
      sleep: stopAfter(controller, 2),
    });

    expect(lines).toEqual([
      "1970-01-01T00:00:00.000Z poll ok",
      "1970-01-01T00:00:00.000Z poll failed: offline",
    ]);
  });

  test("stands down when another daemon owns the record", async () => {
    const path = statePath(9999);
    const controller = new AbortController();
    const { provider, requests } = scriptedProvider(["ok", "ok"]);
    const lines: string[] = [];

    await runDaemonLoop({
      provider,
      statePath: path,
      intervalMs: 60_000,
      signal: controller.signal,
      ownerPid: OWNER_PID,
      now: () => new Date(0),
      log: (line) => lines.push(line),
      sleep: stopAfter(controller, 5),
    });

    expect(requests).toHaveLength(1);
    expect(lines.at(-1)).toContain("standing down: pid 9999");
  });

  test("an abort during a poll ends the run without recording it", async () => {
    const path = statePath();
    const controller = new AbortController();
    const provider: UsageProvider = {
      ...mockUsageProvider,
      refresh: () => {
        controller.abort();
        return Promise.reject(new DOMException("Refresh aborted", "AbortError"));
      },
    };

    await runDaemonLoop({
      provider,
      statePath: path,
      intervalMs: 60_000,
      signal: controller.signal,
      ownerPid: OWNER_PID,
      log: () => {},
    });

    expect(readDaemonState(path)?.lastPollAtMs).toBeNull();
  });
});

describe("abortableSleep", () => {
  test("resolves at once when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const startedAt = Date.now();

    await abortableSleep(60_000, controller.signal);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("resolves as soon as the signal aborts", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const sleeping = abortableSleep(60_000, controller.signal);
    controller.abort();

    await sleeping;

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
