import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ClaudeUsageError,
  createClaudeLimitsSource,
  parseClaudeUsage,
  parseClaudeUsageMessages,
  parseUsageReport,
  readClaudeUsage,
  scopedWindowId,
  type ClaudeScopedWindow,
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
/** A real `/usage` stream-json reply from Claude Code 2.1.289, scrubbed of identifiers. */
const FIXTURE_PATH = join(import.meta.dir, "fixtures", "claude-usage-stream.jsonl");

function fixtureMessages(): unknown[] {
  return readFileSync(FIXTURE_PATH, "utf8")
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line));
}

function fable(percent: number, reset: string, resetsAtMs?: number): ClaudeScopedWindow {
  return {
    id: "fable",
    scope: "model",
    name: "Fable",
    percent,
    reset,
    ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
  };
}

function usageStub() {
  const stub = createStubExecutable(`
if [ -n "$STUB_STARTED_FILE" ]; then printf started > "$STUB_STARTED_FILE"; fi
case "$STUB_MODE" in
  stream)
    case "$*" in
      *"--output-format stream-json --verbose"*) ;;
      *) exit 7 ;;
    esac
    # Blocks until EOF, so an open stdin pipe would run into the timeout.
    /bin/cat > /dev/null
    /bin/cat "$STUB_FIXTURE"
    ;;
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
      scoped: [],
      fetchedAtMs: NOW_MS,
    });
  });

  test("asks for stream-json with stdin closed and reads the structured report", async () => {
    const { executable } = usageStub();
    const usage = await readClaudeUsage(new Date(NOW_MS), {
      executable,
      timeoutMs: 2_000,
      env: stubEnvironment({ STUB_MODE: "stream", STUB_FIXTURE: FIXTURE_PATH }),
    });
    expect(usage.weekly).toEqual({
      percent: 59,
      reset: "resets Oct 7 at 6am (Asia/Dhaka)",
      resetsAtMs: Date.parse("2026-10-07T00:00:00.164059+00:00"),
    });
    expect(usage.scoped.map((window) => window.id)).toEqual(["fable"]);
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
      scoped: [fable(65, "resets Aug 5 at 6am (Asia/Dhaka)")],
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
      scoped: [fable(65, "resets Aug 5 at 6am (Asia/Dhaka)")],
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
      scoped: [fable(0, "no usage yet")],
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
      scoped: [],
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
      scoped: [fable(65, "resets Aug 5 at 6am (Asia/Dhaka)")],
      fetchedAtMs: NOW_MS - 23 * 60_000,
    });
    expect(withMarker("Showing last-known usage (1h 5m old)")).toEqual({
      session: { percent: 10, reset: "resets Aug 4 at 3:20am (Asia/Dhaka)" },
      weekly: { percent: 95, reset: "resets Aug 5 at 6am (Asia/Dhaka)" },
      scoped: [fable(65, "resets Aug 5 at 6am (Asia/Dhaka)")],
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

interface ReportRowFixture {
  kind: string;
  percent?: unknown;
  resets_at?: unknown;
  scope?: unknown;
}

function reportRow(row: ReportRowFixture): Record<string, unknown> {
  return {
    group: row.kind === "session" ? "session" : "weekly",
    percent: 10,
    resets_at: "2026-10-07T00:00:00+00:00",
    scope: null,
    severity: "normal",
    is_active: false,
    ...row,
  };
}

function report(limits: unknown, extraUsage: unknown = null): Record<string, unknown> {
  return { session: {}, rate_limits: { limits, extra_usage: extraUsage } };
}

const SESSION_ROW = reportRow({ kind: "session", percent: 36, resets_at: "2026-10-05T22:00:00+00:00" });
const WEEKLY_ROW = reportRow({ kind: "weekly_all", percent: 59 });

describe("parseUsageReport", () => {
  test("reads the real report, keeping the text's reset prose beside the timestamps", () => {
    expect(parseClaudeUsageMessages(fixtureMessages(), NOW_MS)).toEqual({
      session: {
        percent: 36,
        reset: "resets Oct 6 at 4am (Asia/Dhaka)",
        resetsAtMs: Date.parse("2026-10-05T22:00:00.164036+00:00"),
      },
      weekly: {
        percent: 59,
        reset: "resets Oct 7 at 6am (Asia/Dhaka)",
        resetsAtMs: Date.parse("2026-10-07T00:00:00.164059+00:00"),
      },
      scoped: [
        fable(18, "resets Oct 7 at 6am (Asia/Dhaka)", Date.parse("2026-10-07T00:00:00.164268+00:00")),
      ],
      fetchedAtMs: NOW_MS,
    });
  });

  test("captures every scoped lane, model or surface, by kind rather than label", () => {
    const usage = parseUsageReport(
      report([
        SESSION_ROW,
        WEEKLY_ROW,
        reportRow({ kind: "weekly_scoped", percent: 18, scope: { model: { display_name: "Fable" } } }),
        reportRow({ kind: "weekly_scoped", percent: 40, scope: { model: { display_name: "Opus" }, surface: null } }),
        reportRow({ kind: "weekly_scoped", percent: 5, scope: { model: null, surface: { display_name: "Claude Code" } } }),
      ]),
      null,
      NOW_MS,
    );
    expect(usage?.scoped.map(({ id, scope, name, percent }) => ({ id, scope, name, percent }))).toEqual([
      { id: "fable", scope: "model", name: "Fable", percent: 18 },
      { id: "opus", scope: "model", name: "Opus", percent: 40 },
      { id: "surface-claude-code", scope: "surface", name: "Claude Code", percent: 5 },
    ]);
    // Without a text twin the reset is still stated, from the timestamp.
    expect(usage?.scoped[1]?.reset).toStartWith("resets ");
    expect(usage?.scoped[1]?.resetsAtMs).toBe(Date.parse("2026-10-07T00:00:00+00:00"));
  });

  test("skips meters of kinds it does not render, however they are shaped", () => {
    const usage = parseUsageReport(
      report([SESSION_ROW, { kind: "monthly_future", percent: "n/a" }, WEEKLY_ROW]),
      null,
      NOW_MS,
    );
    expect(usage?.session.percent).toBe(36);
    expect(usage?.scoped).toEqual([]);
  });

  test("a window that has not started reads as unstarted, and one without a reset says so", () => {
    const usage = parseUsageReport(
      report([
        reportRow({ kind: "session", percent: 0, resets_at: null }),
        reportRow({ kind: "weekly_all", percent: 12, resets_at: null }),
      ]),
      null,
      NOW_MS,
    );
    expect(usage?.session).toEqual({ percent: 0, reset: "starts when a message is sent" });
    expect(usage?.weekly).toEqual({ percent: 12, reset: "reset unavailable" });
  });

  test("anything short of a well-formed session and weekly row reads as absent", () => {
    const malformed: unknown[] = [
      null,
      { rate_limits: null },
      report(null),
      report([SESSION_ROW]),
      report([WEEKLY_ROW]),
      report([SESSION_ROW, reportRow({ kind: "weekly_all", percent: "59" })]),
      report([SESSION_ROW, reportRow({ kind: "weekly_all", resets_at: "next tuesday" })]),
      report([SESSION_ROW, WEEKLY_ROW, reportRow({ kind: "weekly_scoped", scope: null })]),
      report([SESSION_ROW, WEEKLY_ROW, reportRow({ kind: "weekly_scoped", scope: { model: { name: "Fable" } } })]),
    ];
    for (const value of malformed) expect(parseUsageReport(value, null, NOW_MS)).toBeNull();
  });

  test("falls back to the text when the report is malformed or missing", () => {
    const [init, assistant, resultLine] = fixtureMessages();
    const broken = { ...(assistant as Record<string, unknown>), usage_report: report([SESSION_ROW]) };
    const expected = {
      session: { percent: 36, reset: "resets Oct 6 at 4am (Asia/Dhaka)" },
      weekly: { percent: 59, reset: "resets Oct 7 at 6am (Asia/Dhaka)" },
      scoped: [fable(18, "resets Oct 7 at 6am (Asia/Dhaka)")],
      fetchedAtMs: NOW_MS,
    };
    expect(parseClaudeUsageMessages([init, broken, resultLine], NOW_MS)).toEqual(expected);
    expect(parseClaudeUsageMessages([init, resultLine], NOW_MS)).toEqual(expected);
  });

  test("still reads the older single-object json reply", () => {
    expect(parseClaudeUsageMessages([result()], NOW_MS)?.weekly.percent).toBe(95);
  });

  test("a stale text twin still ages the structured reading", () => {
    const usage = parseUsageReport(
      report([SESSION_ROW, WEEKLY_ROW]),
      "Showing last-known usage (23m old)",
      NOW_MS,
    );
    expect(usage?.fetchedAtMs).toBe(NOW_MS - 23 * 60_000);
  });

  test("carries extra usage only while it is switched on", () => {
    const on = parseUsageReport(
      report([SESSION_ROW, WEEKLY_ROW], {
        is_enabled: true,
        monthly_limit: 5000,
        used_credits: 1234,
        utilization: 24.68,
        currency: "USD",
      }),
      null,
      NOW_MS,
    );
    expect(on?.extraUsage).toEqual({
      used: { amountMinor: 1234, currency: "USD", exponent: 2 },
      monthlyLimit: { amountMinor: 5000, currency: "USD", exponent: 2 },
      utilization: 24.68,
    });

    const fixture = parseClaudeUsageMessages(fixtureMessages(), NOW_MS);
    expect(fixture?.extraUsage).toBeUndefined();
    const noCurrency = parseUsageReport(
      report([SESSION_ROW, WEEKLY_ROW], { is_enabled: true, monthly_limit: null, used_credits: 10, utilization: null }),
      null,
      NOW_MS,
    );
    // An amount with no currency cannot be scaled, and the limits stand without it.
    expect(noCurrency?.extraUsage).toBeUndefined();
    expect(noCurrency?.weekly.percent).toBe(59);
  });
});

describe("scopedWindowId", () => {
  test("keeps the Fable lane on the id notifications have always used", () => {
    expect(scopedWindowId("model", "Fable")).toBe("fable");
  });

  test("derives other ids from the scope alone", () => {
    expect(scopedWindowId("model", "Opus 5.5")).toBe("opus-5-5");
    expect(scopedWindowId("surface", "Claude Code")).toBe("surface-claude-code");
    expect(scopedWindowId("model", "Session")).toBe("model-session");
    expect(scopedWindowId("model", "  ")).toBeNull();
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
    expect(source.read()?.scoped[0]?.percent).toBe(65);
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
