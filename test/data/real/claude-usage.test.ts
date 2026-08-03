import { describe, expect, test } from "bun:test";
import {
  ClaudeUsageError,
  createClaudeLimitsSource,
  parseClaudeUsage,
} from "../../../src/data/real/claude-usage";

const NOW_MS = Date.now();

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

  test("manual refresh bypasses the normal poll throttle", async () => {
    let calls = 0;
    const source = createClaudeLimitsSource((now) => {
      calls += 1;
      const parsed = parseClaudeUsage(result(), now.getTime());
      if (!parsed) throw new Error("fixture failed");
      return Promise.resolve(parsed);
    });
    const start = new Date();
    await source.poll(start);
    await source.poll(new Date(start.getTime() + 1_000), { force: true });
    expect(calls).toBe(2);
  });
});
