import { describe, expect, test } from "bun:test";
import {
  createSubprocessGuard,
  subprocessEnvironment,
} from "../../../src/data/real/subprocess";

describe("vendor subprocess isolation", () => {
  test("keeps the parent environment except for all OPEN_USAGE variables", () => {
    expect(
      subprocessEnvironment({
        PATH: "/usr/bin",
        HOME: "/tmp/example",
        OPEN_USAGE_OPENCODE_COOKIE: "secret-cookie",
        OPEN_USAGE_FUTURE_SECRET: "secret-too",
      }),
    ).toEqual({ PATH: "/usr/bin", HOME: "/tmp/example" });
  });

  test("settles at the timeout and escalates from SIGTERM to SIGKILL", async () => {
    const signals: Array<number | NodeJS.Signals | undefined> = [];
    const guard = createSubprocessGuard(
      { kill: (signal) => signals.push(signal) },
      {
        timeoutMs: 5,
        killGraceMs: 5,
        timeoutError: () => new Error("hard deadline"),
      },
    );

    try {
      await expect(guard.waitFor(new Promise<never>(() => {}))).rejects.toThrow(
        "hard deadline",
      );
    } finally {
      guard.dispose();
    }
    expect(signals).toEqual(["SIGTERM"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
