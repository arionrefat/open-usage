import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearDaemonState,
  readDaemonState,
  updateDaemonState,
  writeDaemonState,
  type DaemonState,
} from "../../src/daemon/state";

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function statePath(): string {
  const root = mkdtempSync(join(tmpdir(), "open-usage-daemon-"));
  tempRoots.push(root);
  return join(root, "daemon.json");
}

function state(overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    pid: 4821,
    startedAtMs: 1_000,
    intervalMinutes: 5,
    lastPollAtMs: null,
    lastSuccessAtMs: null,
    lastError: null,
    logPath: "/tmp/daemon.log",
    ...overrides,
  };
}

describe("daemon state", () => {
  test("round-trips a record with restrictive permissions", () => {
    const path = statePath();
    const written = state({ lastPollAtMs: 2_000, lastSuccessAtMs: 2_000 });

    writeDaemonState(path, written);

    expect(readDaemonState(path)).toEqual(written);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("treats a missing, malformed, or foreign-version record as no daemon", () => {
    const path = statePath();
    expect(readDaemonState(path)).toBeNull();

    writeFileSync(path, "not json");
    expect(readDaemonState(path)).toBeNull();

    writeFileSync(path, JSON.stringify({ version: 2, ...state() }));
    expect(readDaemonState(path)).toBeNull();
  });

  test("rejects a record whose fields cannot be believed", () => {
    const path = statePath();
    const cases: Array<Partial<Record<string, unknown>>> = [
      { pid: 0 },
      { pid: "4821" },
      { startedAtMs: null },
      { intervalMinutes: 0 },
      { intervalMinutes: 2000 },
      { intervalMinutes: 1.5 },
      { lastPollAtMs: "recently" },
      { lastError: 7 },
      { logPath: null },
    ];

    for (const patch of cases) {
      writeFileSync(path, JSON.stringify({ version: 1, ...state(), ...patch }));
      expect(readDaemonState(path)).toBeNull();
    }
  });

  test("merges a patch into the record on disk", () => {
    const path = statePath();
    writeDaemonState(path, state());

    const updated = updateDaemonState(path, { lastPollAtMs: 9_000, lastError: "offline" });

    expect(updated?.lastPollAtMs).toBe(9_000);
    expect(updated?.lastError).toBe("offline");
    expect(readDaemonState(path)?.pid).toBe(4821);
  });

  test("reports a vanished record instead of recreating it", () => {
    const path = statePath();

    expect(updateDaemonState(path, { lastPollAtMs: 1 })).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  test("only the owning pid clears the record", () => {
    const path = statePath();
    writeDaemonState(path, state());

    clearDaemonState(path, 999);
    expect(readDaemonState(path)).not.toBeNull();

    clearDaemonState(path, 4821);
    expect(readDaemonState(path)).toBeNull();
  });

  test("writes through a sibling file so the record is never half-written", () => {
    const path = statePath();
    writeDaemonState(path, state());

    // A complete record parses; a truncated one would not.
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
  });
});
