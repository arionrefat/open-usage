import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readClaudeAuth } from "../../../src/data/real/claude-auth";
import {
  createStubExecutable,
  stubEnvironment,
} from "./stub-executable";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const NOW = new Date("2026-08-16T12:00:00.000Z");

function authStub() {
  const stub = createStubExecutable(`
if [ -n "$STUB_STARTED_FILE" ]; then printf started > "$STUB_STARTED_FILE"; fi
case "$STUB_MODE" in
  invalid) printf 'not-json' ;;
  nonzero) exit 23 ;;
  hang)
    trap '' TERM
    printf '%s' "$$" > "$STUB_PID_FILE"
    while :; do sleep 1; done
    ;;
  env)
    if /usr/bin/env | /usr/bin/grep '^OPEN_USAGE_' >/dev/null; then state=leaked; else state=clean; fi
    printf '{"loggedIn":true,"subscriptionType":"%s"}' "$state"
    ;;
  *) printf '{"loggedIn":true,"subscriptionType":"max"}' ;;
esac`);
  cleanups.push(stub.cleanup);
  return stub;
}

describe("readClaudeAuth subprocess adapter", () => {
  test("parses a successful real child response", async () => {
    const { executable } = authStub();
    await expect(readClaudeAuth(NOW, { executable, env: stubEnvironment() })).resolves.toEqual({
      loggedIn: true,
      subscriptionType: "max",
      fetchedAtMs: NOW.getTime(),
    });
  });

  test("rejects invalid JSON and a non-zero exit", async () => {
    const { executable } = authStub();
    await expect(readClaudeAuth(NOW, {
      executable,
      env: stubEnvironment({ STUB_MODE: "invalid" }),
    })).rejects.toBeInstanceOf(SyntaxError);
    await expect(readClaudeAuth(NOW, {
      executable,
      env: stubEnvironment({ STUB_MODE: "nonzero" }),
    })).rejects.toThrow("exited with code 23");
  });

  test("settles on timeout and SIGKILLs a TERM-ignoring child", async () => {
    const { executable, root } = authStub();
    const pidFile = join(root, "pid");
    const started = Date.now();
    await expect(readClaudeAuth(NOW, {
      executable,
      timeoutMs: 1_000,
      killGraceMs: 20,
      env: stubEnvironment({ STUB_MODE: "hang", STUB_PID_FILE: pidFile }),
    })).rejects.toThrow("timeout");
    expect(Date.now() - started).toBeLessThan(1_800);
    await Bun.sleep(80);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("honors a pre-aborted signal without starting the executable", async () => {
    const { executable, root } = authStub();
    const marker = join(root, "started");
    const reason = new Error("stop before spawn");
    const controller = new AbortController();
    controller.abort(reason);
    await expect(readClaudeAuth(NOW, {
      executable,
      signal: controller.signal,
      env: stubEnvironment({ STUB_STARTED_FILE: marker }),
    })).rejects.toBe(reason);
    expect(existsSync(marker)).toBe(false);
  });

  test("scrubs every OPEN_USAGE variable from the child environment", async () => {
    const { executable } = authStub();
    const result = await readClaudeAuth(NOW, {
      executable,
      env: stubEnvironment({
        STUB_MODE: "env",
        OPEN_USAGE_SECRET: "nope",
        OPEN_USAGE_FUTURE_TOKEN: "also-nope",
      }),
    });
    expect(result.subscriptionType).toBe("clean");
  });
});
