import { afterAll, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { daemonHelpText, rotateOwnLog, runDaemonCommand, selfCommand } from "../../src/daemon/cli";
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

const logRoots: string[] = [];

afterAll(() => {
  for (const root of logRoots) rmSync(root, { recursive: true, force: true });
});

function logFile(): string {
  const root = mkdtempSync(join(tmpdir(), "open-usage-log-"));
  logRoots.push(root);
  return join(root, "daemon.log");
}

/** Past the 1 MiB threshold that triggers a rotation. */
const OVER_LIMIT = `${"x".repeat(1024 * 1024 + 1024)}\n`;

describe("rotateOwnLog", () => {
  test("copies the log aside and truncates it so the inherited fd keeps writing", () => {
    const path = logFile();
    writeFileSync(path, OVER_LIMIT);
    const fd = openSync(path, "a");
    try {
      rotateOwnLog(path, fd);

      expect(statSync(path).size).toBe(0);
      expect(statSync(`${path}.1`).size).toBe(OVER_LIMIT.length);

      // The daemon holds this fd for months: an append must land at the new
      // start rather than at the offset the truncated bytes used to occupy.
      writeSync(fd, "after rotation\n");
      expect(readFileSync(path, "utf8")).toBe("after rotation\n");
    } finally {
      closeSync(fd);
    }
  });

  test("leaves a log that is still small alone", () => {
    const path = logFile();
    writeFileSync(path, "one line\n");
    const fd = openSync(path, "a");
    try {
      rotateOwnLog(path, fd);

      expect(readFileSync(path, "utf8")).toBe("one line\n");
      expect(existsSync(`${path}.1`)).toBe(false);
    } finally {
      closeSync(fd);
    }
  });

  test("leaves a file that is not the daemon's own log alone", () => {
    // `daemon run > mine.txt`, or a supervisor's pipe: not ours to rotate.
    const path = logFile();
    const redirected = join(dirname(path), "mine.txt");
    writeFileSync(path, "");
    writeFileSync(redirected, OVER_LIMIT);
    const fd = openSync(redirected, "a");
    try {
      rotateOwnLog(path, fd);

      expect(statSync(redirected).size).toBe(OVER_LIMIT.length);
      expect(existsSync(`${redirected}.1`)).toBe(false);
    } finally {
      closeSync(fd);
    }
  });
});
