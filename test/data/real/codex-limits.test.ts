import { describe, expect, test } from "bun:test";
import { CodexProbeError, type CodexAccountLimits } from "../../../src/data/real/codex-app-server";
import { createCodexLimitsSource } from "../../../src/data/real/codex-limits";

function limits(fetchedAtMs: number): CodexAccountLimits {
  return {
    session: null,
    weekly: { usedPercent: 12, resetsAtMs: fetchedAtMs + 600_000, windowMinutes: 10080 },
    planType: "plus",
    resetCredits: 1,
    additionalRateLimits: [],
    credits: null,
    usage: null,
    fetchedAtMs,
  };
}

describe("createCodexLimitsSource", () => {
  test("caches a reading and holds off until the interval elapses", async () => {
    let calls = 0;
    const source = createCodexLimitsSource((now) => {
      calls += 1;
      return Promise.resolve(limits(now.getTime()));
    });

    const start = new Date();
    await source.poll(start);
    expect(source.read()?.weekly?.usedPercent).toBe(12);
    expect(source.note()).toBeNull();

    await source.poll(new Date(start.getTime() + 10_000));
    expect(calls).toBe(1);
    await source.poll(new Date(start.getTime() + 61_000));
    expect(calls).toBe(2);
  });

  test("a stale reading stops being served", async () => {
    const stale = Date.now() - 20 * 60_000;
    const source = createCodexLimitsSource(() => Promise.resolve(limits(stale)));
    await source.poll(new Date());
    expect(source.read()).toBeNull();
  });

  test("each failure explains itself and clears the reading", async () => {
    const cases: Array<[ConstructorParameters<typeof CodexProbeError>[0], string]> = [
      ["not-installed", "not installed"],
      ["not-logged-in", "codex login"],
      ["timeout", "did not respond"],
    ];
    for (const [kind, expected] of cases) {
      const source = createCodexLimitsSource(() =>
        Promise.reject(new CodexProbeError(kind, "failed")),
      );
      await source.poll(new Date());
      expect(source.read()).toBeNull();
      expect(source.note()).toContain(expected);
    }
  });

  test("a cancelled poll rethrows without setting a note", async () => {
    const controller = new AbortController();
    const source = createCodexLimitsSource(() => {
      controller.abort();
      return Promise.reject(new CodexProbeError("timeout", "cancelled"));
    });

    let rejection: unknown;
    try {
      await source.poll(new Date(), controller.signal);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(CodexProbeError);
    expect(source.note()).toBeNull();
  });
});
