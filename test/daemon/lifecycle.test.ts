import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimDaemonState,
  restartDaemon,
  startDaemon,
  statusDaemon,
  stopDaemon,
  type DaemonHost,
} from "../../src/daemon/lifecycle";
import { readDaemonState, writeDaemonState } from "../../src/daemon/state";

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

interface FakeHost extends DaemonHost {
  livePids: Set<number>;
  spawned: number[];
  terminated: number[];
  /** Set to have a spawned child publish its record, the way a real run does. */
  isChildHealthy: boolean;
  nowMs: number;
}

function fakeHost(overrides: Partial<FakeHost> = {}): FakeHost {
  const root = mkdtempSync(join(tmpdir(), "open-usage-lifecycle-"));
  tempRoots.push(root);
  const statePath = join(root, "daemon.json");
  const logPath = join(root, "daemon.log");
  let nextPid = 5000;

  const host: FakeHost = {
    statePath,
    logPath,
    livePids: new Set<number>(),
    spawned: [],
    terminated: [],
    isChildHealthy: true,
    nowMs: 1_000_000,
    now: () => new Date(host.nowMs),
    // Booted long enough ago that every record a test writes belongs to it.
    bootedAtMs: () => 0,
    isAlive: (pid) => host.livePids.has(pid),
    terminate: (pid) => {
      host.terminated.push(pid);
      host.livePids.delete(pid);
    },
    spawn: (intervalMinutes) => {
      const pid = nextPid++;
      host.spawned.push(pid);
      host.livePids.add(pid);
      if (host.isChildHealthy) {
        claimDaemonState(statePath, {
          pid,
          startedAtMs: host.nowMs,
          intervalMinutes,
          logPath,
        });
      }
      return pid;
    },
    // Time only moves when something waits, which keeps the timeouts deterministic.
    sleep: (ms) => {
      host.nowMs += ms;
      return Promise.resolve();
    },
    hasRealSources: () => true,
    ...overrides,
  };
  return host;
}

describe("daemon lifecycle", () => {
  test("start spawns a daemon and waits for it to publish its record", async () => {
    const host = fakeHost();

    const result = await startDaemon(host, 5);

    expect(result.exitCode).toBe(0);
    expect(result.message).toContain(`pid ${host.spawned[0]}`);
    expect(result.message).toContain("every 5m");
    expect(readDaemonState(host.statePath)?.intervalMinutes).toBe(5);
  });

  test("start refuses when a daemon is already running", async () => {
    const host = fakeHost();
    await startDaemon(host, 5);

    const again = await startDaemon(host, 10);

    expect(again.exitCode).toBe(0);
    expect(again.message).toContain("already running");
    expect(host.spawned).toHaveLength(1);
  });

  test("start refuses when there is nothing local to poll", async () => {
    const host = fakeHost({ hasRealSources: () => false });

    const result = await startDaemon(host, 5);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("nothing to poll");
    expect(host.spawned).toHaveLength(0);
  });

  test("start reports a child that died before publishing its record", async () => {
    const host = fakeHost({ isChildHealthy: false });
    host.spawn = (intervalMinutes) => {
      const pid = 6000 + intervalMinutes;
      host.spawned.push(pid);
      return pid;
    };

    const result = await startDaemon(host, 5);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("exited immediately");
  });

  test("start replaces a record left behind by a crashed daemon", async () => {
    const host = fakeHost();
    writeDaemonState(host.statePath, {
      pid: 4242,
      startedAtMs: 1,
      intervalMinutes: 5,
      lastPollAtMs: null,
      lastSuccessAtMs: null,
      lastError: null,
      logPath: host.logPath,
    });

    const result = await startDaemon(host, 5);

    expect(result.exitCode).toBe(0);
    expect(readDaemonState(host.statePath)?.pid).toBe(host.spawned[0]);
  });

  test("stop signals the daemon and clears its record", async () => {
    const host = fakeHost();
    await startDaemon(host, 5);
    const pid = host.spawned[0]!;

    const result = await stopDaemon(host);

    expect(result.exitCode).toBe(0);
    expect(host.terminated).toEqual([pid]);
    expect(readDaemonState(host.statePath)).toBeNull();
  });

  test("stop is quiet when nothing is running", async () => {
    const host = fakeHost();

    const result = await stopDaemon(host);

    expect(result).toEqual({ exitCode: 0, message: "daemon not running" });
  });

  test("stop fails loudly when the process outlives its signal", async () => {
    const host = fakeHost();
    await startDaemon(host, 5);
    host.terminate = (pid) => host.terminated.push(pid);

    const result = await stopDaemon(host);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("did not stop");
  });

  /** A record from a boot that has already ended, whose pid something else now holds. */
  function recycledPidHost(): { host: FakeHost; strangerPid: number } {
    const host = fakeHost({ bootedAtMs: () => 900_000 });
    const strangerPid = 4321;
    writeDaemonState(host.statePath, {
      pid: strangerPid,
      startedAtMs: 100_000,
      intervalMinutes: 5,
      lastPollAtMs: null,
      lastSuccessAtMs: null,
      lastError: null,
      logPath: host.logPath,
    });
    host.livePids.add(strangerPid);
    return { host, strangerPid };
  }

  test("stop leaves a stranger holding a recycled pid unsignalled", async () => {
    const { host } = recycledPidHost();

    const result = await stopDaemon(host);

    expect(host.terminated).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("stale record");
    expect(readDaemonState(host.statePath)).toBeNull();
  });

  test("status does not call a stranger's pid a running daemon", () => {
    const { host } = recycledPidHost();

    const result = statusDaemon(host);

    expect(result.message).toContain("stale record");
    expect(readDaemonState(host.statePath)).toBeNull();
  });

  test("start replaces a record left behind by a previous boot", async () => {
    const { host } = recycledPidHost();

    const result = await startDaemon(host, 5);

    expect(result.exitCode).toBe(0);
    expect(host.spawned).toHaveLength(1);
    expect(host.terminated).toEqual([]);
  });

  /**
   * A pid recycled within one boot: the record postdates the boot, so the boot
   * guard passes it and only the stalled heartbeat gives the stranger away.
   */
  function stalledHeartbeatHost(): FakeHost {
    const host = fakeHost({ nowMs: 3_000_000_000, bootedAtMs: () => 0 });
    const strangerPid = 4321;
    writeDaemonState(host.statePath, {
      pid: strangerPid,
      startedAtMs: host.nowMs - 7_200_000,
      intervalMinutes: 5,
      // Four intervals is 20 minutes; this daemon last wrote an hour ago.
      lastPollAtMs: host.nowMs - 3_600_000,
      lastSuccessAtMs: host.nowMs - 3_600_000,
      lastError: null,
      logPath: host.logPath,
    });
    host.livePids.add(strangerPid);
    return host;
  }

  test("stop does not signal a live pid whose heartbeat stopped moving", async () => {
    const host = stalledHeartbeatHost();

    const result = await stopDaemon(host);

    expect(host.terminated).toEqual([]);
    expect(result.message).toContain("stale record");
    expect(readDaemonState(host.statePath)).toBeNull();
  });

  test("status treats a stalled heartbeat as a record nobody is keeping", () => {
    const host = stalledHeartbeatHost();

    expect(statusDaemon(host).message).toContain("stale record");
  });

  test("a daemon polling on time keeps its record however long it has run", () => {
    // A month of uptime, so only the heartbeat can decide this one.
    const host = fakeHost({ nowMs: 3_000_000_000, bootedAtMs: () => 0 });
    const pid = 4321;
    writeDaemonState(host.statePath, {
      pid,
      startedAtMs: host.nowMs - 30 * 24 * 3_600_000,
      intervalMinutes: 5,
      lastPollAtMs: host.nowMs - 60_000,
      lastSuccessAtMs: host.nowMs - 60_000,
      lastError: null,
      logPath: host.logPath,
    });
    host.livePids.add(pid);

    expect(statusDaemon(host).message).toContain(`running · pid ${pid}`);
  });

  test("a daemon that has not finished its first poll is not yet stale", () => {
    const host = fakeHost();
    const pid = 4321;
    writeDaemonState(host.statePath, {
      pid,
      startedAtMs: host.nowMs,
      intervalMinutes: 5,
      lastPollAtMs: null,
      lastSuccessAtMs: null,
      lastError: null,
      logPath: host.logPath,
    });
    host.livePids.add(pid);

    expect(statusDaemon(host).message).toContain("last poll never");
  });

  test("uptime rounding does not condemn a daemon started at boot", async () => {
    // The inferred boot time can land slightly after a daemon that booted with it.
    const host = fakeHost({ bootedAtMs: () => 1_030_000 });
    await startDaemon(host, 5);

    const result = statusDaemon(host);

    expect(result.message).toContain("running · pid");
  });

  test("status reports the cadence, the last poll, and the log", async () => {
    const host = fakeHost();
    await startDaemon(host, 5);
    const pid = host.spawned[0]!;
    writeDaemonState(host.statePath, {
      pid,
      startedAtMs: host.nowMs - 600_000,
      intervalMinutes: 5,
      lastPollAtMs: host.nowMs - 120_000,
      lastSuccessAtMs: host.nowMs - 120_000,
      lastError: null,
      logPath: host.logPath,
    });

    const result = statusDaemon(host);

    expect(result.message).toContain(`running · pid ${pid} · every 5m · last poll 2m ago`);
    expect(result.message).toContain(host.logPath);
  });

  test("status surfaces a failing daemon and when it last worked", async () => {
    const host = fakeHost();
    await startDaemon(host, 5);
    writeDaemonState(host.statePath, {
      pid: host.spawned[0]!,
      startedAtMs: host.nowMs - 600_000,
      intervalMinutes: 5,
      lastPollAtMs: host.nowMs,
      lastSuccessAtMs: host.nowMs - 3_600_000,
      lastError: "codex cli did not respond",
      logPath: host.logPath,
    });

    const result = statusDaemon(host);

    expect(result.message).toContain("last error: codex cli did not respond");
    expect(result.message).toContain("last success 1h 0m ago");
  });

  test("status clears a record whose process is gone", async () => {
    const host = fakeHost();
    await startDaemon(host, 5);
    host.livePids.clear();

    const result = statusDaemon(host);

    expect(result.message).toContain("stale record");
    expect(readDaemonState(host.statePath)).toBeNull();
  });

  test("restart stops the old daemon before starting the new one", async () => {
    const host = fakeHost();
    await startDaemon(host, 5);
    const first = host.spawned[0]!;

    const result = await restartDaemon(host, 10);

    expect(result.exitCode).toBe(0);
    expect(host.terminated).toEqual([first]);
    expect(host.spawned).toHaveLength(2);
    expect(readDaemonState(host.statePath)?.intervalMinutes).toBe(10);
  });
});
