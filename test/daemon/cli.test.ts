import { describe, expect, test } from "bun:test";
import { daemonHelpText, runDaemonCommand, selfCommand } from "../../src/daemon/cli";
import {
  DAEMON_MAX_INTERVAL_MINUTES,
  DAEMON_MIN_INTERVAL_MINUTES,
  parseDaemonIntervalMinutes,
} from "../../src/config";

describe("selfCommand", () => {
  test("re-invokes a compiled binary directly", () => {
    expect(selfCommand("/$bunfs/root/open-usage", "/usr/local/bin/open-usage")).toEqual([
      "/usr/local/bin/open-usage",
    ]);
  });

  test("re-invokes a Windows compiled binary directly", () => {
    expect(selfCommand("B:\\~BUN\\root\\open-usage.exe", "C:\\bin\\open-usage.exe")).toEqual([
      "C:\\bin\\open-usage.exe",
    ]);
  });

  test("runs the entry script through Bun when running from source", () => {
    expect(selfCommand("/repo/src/index.tsx", "/opt/bun")).toEqual(["/opt/bun", "/repo/src/index.tsx"]);
  });
});

describe("parseDaemonIntervalMinutes", () => {
  test("accepts whole minutes inside the supported range", () => {
    expect(parseDaemonIntervalMinutes("5")).toBe(5);
    expect(parseDaemonIntervalMinutes(String(DAEMON_MIN_INTERVAL_MINUTES))).toBe(
      DAEMON_MIN_INTERVAL_MINUTES,
    );
    expect(parseDaemonIntervalMinutes(String(DAEMON_MAX_INTERVAL_MINUTES))).toBe(
      DAEMON_MAX_INTERVAL_MINUTES,
    );
  });

  test("rejects anything a cadence cannot be", () => {
    for (const raw of ["", "  ", "0", "-5", "2.5", "soon", String(DAEMON_MAX_INTERVAL_MINUTES + 1)]) {
      expect(parseDaemonIntervalMinutes(raw)).toBeNull();
    }
    expect(parseDaemonIntervalMinutes(undefined)).toBeNull();
  });
});

describe("runDaemonCommand", () => {
  test("documents the daemon rather than the dashboard", async () => {
    const result = await runDaemonCommand(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.message).toBe(daemonHelpText());
    expect(result.message).toContain("--interval");
  });

  test("names the command it did not recognise and shows the help", async () => {
    const result = await runDaemonCommand(["frobnicate"]);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('unknown daemon command "frobnicate"');
    expect(result.message).toContain("COMMANDS");
  });
});
