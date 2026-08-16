import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ClaudeUsageError,
  createClaudeLimitsSource,
  parseClaudeUsage,
  readClaudeUsage,
} from "../../../src/data/real/claude-usage";
import {
  createStubExecutable,
  stubEnvironment,
} from "./stub-executable";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const NOW_MS = Date.now();

function usageStub() {
  const stub = createStubExecutable(`
if [ -n "$STUB_STARTED_FILE" ]; then printf started > "$STUB_STARTED_FILE"; fi
case "$STUB_MODE" in
  invalid) printf 'not-json' ;;
  nonzero) exit 19 ;;
  hang)
    trap '' TERM
    printf '%s' "$$" > "$STUB_PID_FILE"
    while :; do sleep 1; done
    ;;
  env)
    if /usr/bin/env | /usr/bin/grep '^OPEN_USAGE_' >/dev/null; then state=leaked; else state=clean; fi
    printf '{"result":"Current session: 12%% used · resets %s\\\\nCurrent week (all models): 34%% used · resets tomorrow"}' "$state"
    ;;
  *) printf '{"result":"Current session: 12%% used · resets soon\\\\nCurrent week (all models): 34%% used · resets tomorrow"}' ;;
esac`);
  cleanups.push(stub.cleanup);
  return stub;
}

describe("readClaudeUsage subprocess adapter", () => {
  test("parses a successful real child response", async () => {
    const { executable } = usageStub();
    await expect(readClaudeUsage(new Date(NOW_MS), {
      executable,
      env: stubEnvironment(),
    })).resolves.toEqual({
      session: { percent: 12, reset: "resets soon" },
      weekly: { percent: 34, reset: "resets tomorrow" },
      fetchedAtMs: NOW_MS,
    });
  });

  test("classifies invalid JSON and a non-zero exit", async () => {
    const { executable } = usageStub();
    await expect(readClaudeUsage(new Date(NOW_MS), {
      executable,
      env: stubEnvironment({ STUB_MODE: "invalid" }),
    })).rejects.toMatchObject({ kind: "protocol" });
    await expect(readClaudeUsage(new Date(NOW_MS), {
      executable,
      env: stubEnvironment({ STUB_MODE: "nonzero" }),
    })).rejects.toMatchObject({ kind: "not-logged-in" });
  });

  test("settles on timeout and SIGKILLs a TERM-ignoring child", async () => {
    const { executable, root } = usageStub();
    const pidFile = join(root, "pid");
    const started = Date.now();
    await expect(readClaudeUsage(new Date(NOW_MS), {
      executable,
      timeoutMs: 1_000,
      killGraceMs: 20,
      env: stubEnvironment({ STUB_MODE: "hang", STUB_PID_FILE: pidFile }),
    })).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_800);
    await Bun.sleep(80);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("honors a pre-aborted signal without starting the executable", async () => {
    const { executable, root } = usageStub();
    const marker = join(root, "started");
    const reason = new Error("already cancelled");
    const controller = new AbortController();
    controller.abort(reason);
    await expect(readClaudeUsage(new Date(NOW_MS), {
      executable,
      signal: controller.signal,
      env: stubEnvironment({ STUB_STARTED_FILE: marker }),
    })).rejects.toBe(reason);
    expect(existsSync(marker)).toBe(false);
  });

  test("scrubs every OPEN_USAGE variable from the child environment", async () => {
    const { executable } = usageStub();
    const usage = await readClaudeUsage(new Date(NOW_MS), {
      executable,
      env: stubEnvironment({
        STUB_MODE: "env",
        OPEN_USAGE_SECRET: "nope",
        OPEN_USAGE_FUTURE_TOKEN: "also-nope",
      }),
    });
    expect(usage.session.reset).toBe("resets clean");
  });
});

function result(session = 10, weekly = 95): unknown {
  return {
    result: [
      "You are currently using your subscription to power your Claude Code usage",
      "",
      `Current session: ${session}% used · resets Aug 4 at 3:20am (Asia/Dhaka)`,
      `Current week (all models): ${weekly}% used · resets Aug 5 at 6am (Asia/Dhaka)`,
      "Current week (Fable): 65% used · resets Aug 5 at 6am (Asia/Dhaka)",
    ].join("\n"),
  };
}

describe("parseClaudeUsage", () => {
  test("reads the live session, all-model weekly, and Fable windows", () => {
    expect(parseClaudeUsage(result(), NOW_MS)).toEqual({
      session: { percent: 10, reset: "resets Aug 4 at 3:20am (Asia/Dhaka)" },
      weekly: { percent: 95, reset: "resets Aug 5 at 6am (Asia/Dhaka)" },
      fable: { percent: 65, reset: "resets Aug 5 at 6am (Asia/Dhaka)" },
      fetchedAtMs: NOW_MS,
    });
  });

  test("accepts the current CLI format without a session reset", () => {
    expect(
      parseClaudeUsage(
        {
          result: [
            "You are currently using your subscription to power your Claude Code usage",
            "",
            "Current session: 0% used",
            "Current week (all models): 96% used · resets Aug 5 at 6am (Asia/Dhaka)",
            "Current week (Fable): 65% used · resets Aug 5 at 6am (Asia/Dhaka)",
          ].join("\n"),
        },
        NOW_MS,
      ),
    ).toEqual({
      session: { percent: 0, reset: "starts when a message is sent" },
      weekly: { percent: 96, reset: "resets Aug 5 at 6am (Asia/Dhaka)" },
      fable: { percent: 65, reset: "resets Aug 5 at 6am (Asia/Dhaka)" },
      fetchedAtMs: NOW_MS,
    });
  });

  test("keeps an unused Fable window that the CLI reports without a reset", () => {
    expect(
      parseClaudeUsage(
        {
          result: [
            "Current session: 7% used · resets Aug 6 at 6:50am (Asia/Dhaka)",
            "Current week (all models): 21% used · resets Aug 12 at 6am (Asia/Dhaka)",
            "Current week (Fable): 0% used",
          ].join("\n"),
        },
        NOW_MS,
      ),
    ).toEqual({
      session: { percent: 7, reset: "resets Aug 6 at 6:50am (Asia/Dhaka)" },
      weekly: { percent: 21, reset: "resets Aug 12 at 6am (Asia/Dhaka)" },
      fable: { percent: 0, reset: "no usage yet" },
      fetchedAtMs: NOW_MS,
    });
  });

  test("keeps Fable optional for plans that do not publish it", () => {
    expect(
      parseClaudeUsage(
        {
          result: [
            "Current session: 10% used · resets Aug 4 at 3:20am (Asia/Dhaka)",
            "Current week (all models): 50% used · resets Aug 5 at 6am (Asia/Dhaka)",
          ].join("\n"),
        },
        NOW_MS,
      ),
    ).toEqual({
      session: { percent: 10, reset: "resets Aug 4 at 3:20am (Asia/Dhaka)" },
      weekly: { percent: 50, reset: "resets Aug 5 at 6am (Asia/Dhaka)" },
      fetchedAtMs: NOW_MS,
    });
  });

  test("rejects missing resets outside an unused current session", () => {
    expect(
      parseClaudeUsage(
        {
          result: [
            "Current session: 12% used",
            "Current week (all models): 50% used · resets Aug 5 at 6am (Asia/Dhaka)",
          ].join("\n"),
        },
        NOW_MS,
      ),
    ).toBeNull();
    expect(
      parseClaudeUsage(
        {
          result: [
            "Current session: 0% used",
            "Current week (all models): 50% used",
          ].join("\n"),
        },
        NOW_MS,
      ),
    ).toBeNull();
  });

  test("subtracts Claude's own cache age from the fetch time", () => {
    const base = result() as { result: string };
    const withMarker = (ageLine: string) =>
      parseClaudeUsage({ result: [ageLine, base.result].join("\n") }, NOW_MS);
    expect(withMarker("Showing last-known usage (23m old)")).toEqual({
      session: { percent: 10, reset: "resets Aug 4 at 3:20am (Asia/Dhaka)" },
      weekly: { percent: 95, reset: "resets Aug 5 at 6am (Asia/Dhaka)" },
      fable: { percent: 65, reset: "resets Aug 5 at 6am (Asia/Dhaka)" },
      fetchedAtMs: NOW_MS - 23 * 60_000,
    });
    expect(withMarker("Showing last-known usage (1h 5m old)")).toEqual({
      session: { percent: 10, reset: "resets Aug 4 at 3:20am (Asia/Dhaka)" },
      weekly: { percent: 95, reset: "resets Aug 5 at 6am (Asia/Dhaka)" },
      fable: { percent: 65, reset: "resets Aug 5 at 6am (Asia/Dhaka)" },
      fetchedAtMs: NOW_MS - 65 * 60_000,
    });
    // An unparseable age fails closed: stale bars must not be re-stamped.
    expect(withMarker("Showing last-known usage (just now)")).toBeNull();
  });

  test("rejects partial or changed output rather than guessing", () => {
    expect(parseClaudeUsage({ result: "Current session: 10% used" }, NOW_MS)).toBeNull();
    expect(parseClaudeUsage({ result: "no limits" }, NOW_MS)).toBeNull();
    expect(parseClaudeUsage(null, NOW_MS)).toBeNull();
  });
});

describe("createClaudeLimitsSource", () => {
  test("caches a successful first-party reading", async () => {
    const source = createClaudeLimitsSource((now) => {
      const parsed = parseClaudeUsage(result(), now.getTime());
      if (!parsed) throw new Error("fixture failed");
      return Promise.resolve(parsed);
    });

    await source.poll(new Date());
    expect(source.read()?.weekly.percent).toBe(95);
    expect(source.read()?.fable?.percent).toBe(65);
    expect(source.note()).toBeNull();
  });

  test("keeps old values visible when a live refresh fails", async () => {
    let calls = 0;
    const source = createClaudeLimitsSource((now) => {
      calls += 1;
      if (calls === 1) {
        const parsed = parseClaudeUsage(result(), now.getTime());
        if (parsed) return Promise.resolve(parsed);
      }
      return Promise.reject(new ClaudeUsageError("protocol", "changed"));
    });

    const start = new Date();
    await source.poll(start);
    await source.poll(new Date(start.getTime() + 4 * 60_000));
    expect(source.read()?.weekly.percent).toBe(95);
    expect(source.note()).toContain("format changed");
  });

  test("manual refresh bypasses the normal poll throttle but not the api floor", async () => {
    let calls = 0;
    const source = createClaudeLimitsSource((now) => {
      calls += 1;
      const parsed = parseClaudeUsage(result(), now.getTime());
      if (!parsed) throw new Error("fixture failed");
      return Promise.resolve(parsed);
    });
    const start = new Date();
    await source.poll(start);

    // Every poll is a real request against the account, so a held `r` must not
    // turn into one call per keypress.
    await source.poll(new Date(start.getTime() + 1_000), { force: true });
    await source.poll(new Date(start.getTime() + 14_000), { force: true });
    expect(calls).toBe(1);

    await source.poll(new Date(start.getTime() + 16_000), { force: true });
    expect(calls).toBe(2);
  });
});
