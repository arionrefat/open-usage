import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseAccount,
  parseRateLimits,
  parseUsageHistory,
  readCodexLimits,
  runRequests,
} from "../../../src/data/real/codex-app-server";
import { createStubExecutable, stubEnvironment } from "./stub-executable";

/** Shape generated from `codex app-server generate-json-schema` on codex-cli 0.146.0. */
const LIVE_RESPONSE = {
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1786212362 },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null,
    spendControlReached: false,
    planType: "plus",
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1786212362 },
      secondary: null,
    },
    "codex-mini-latest": {
      limitId: "codex-mini-latest",
      limitName: "codex mini",
      primary: { usedPercent: 37.4, windowDurationMins: 10080, resetsAt: 1786212362 },
      secondary: null,
    },
  },
  rateLimitResetCredits: {
    availableCount: 1,
    credits: [
      { id: "x", resetType: "codexRateLimits", status: "available", grantedAt: 1, expiresAt: 1_789_947_975 },
    ],
  },
};

/**
 * codex-cli 0.149.1 dropped `untrusted` from `--ask-for-approval`; clap rejects
 * an unknown value with a usage error on stderr and exit code 2.
 */
const APPROVAL_POLICY_GUARD = `
approval=
while [ $# -gt 0 ]; do
  case "$1" in
    -a) approval="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "$approval" in
  on-request|never) ;;
  *)
    printf "error: invalid value '%s' for '--ask-for-approval <APPROVAL_POLICY>'\\n" "$approval" >&2
    printf '  [possible values: on-request, never]\\n' >&2
    exit 2
    ;;
esac`;

const NOW_MS = 1_786_000_000_000;

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function appServerStub() {
  const rateLimits = JSON.stringify(LIVE_RESPONSE);
  const account = JSON.stringify({ account: { type: "chatgpt", planType: "plus" } });
  const usage = JSON.stringify({
    summary: {
      lifetimeTokens: 100,
      peakDailyTokens: 80,
      longestRunningTurnSec: 9,
      currentStreakDays: 2,
      longestStreakDays: 4,
    },
    dailyUsageBuckets: [{ startDate: "2026-08-16", tokens: 100 }],
  });
  const stub = createStubExecutable(`
${APPROVAL_POLICY_GUARD}
if [ "$STUB_MODE" = timeout ] || [ "$STUB_MODE" = abort ]; then
  trap '' TERM
  while :; do sleep 1; done
fi
IFS= read -r initialize
if [ -n "$STUB_LOG" ]; then printf '%s\\n' "$initialize" >> "$STUB_LOG"; fi
if [ "$STUB_MODE" = invalid ]; then printf 'noise\\n'; exit 0; fi
printf '{"jsonrpc":"2.0","id":'
sleep 0.01
printf '0,"result":{}}\\n'
IFS= read -r initialized
IFS= read -r request1
if [ -n "$STUB_LOG" ]; then printf '%s\\n%s\\n' "$initialized" "$request1" >> "$STUB_LOG"; fi
case "$STUB_MODE" in
  logged-out|unsupported)
    printf '{"jsonrpc":"2.0","id":1,"error":{"message":"authentication login required"}}\\n'
    ;;
  rpc-error)
    printf '{"jsonrpc":"2.0","id":1,"error":{"message":"unexpected server failure"}}\\n'
    ;;
  env)
    if /usr/bin/env | /usr/bin/grep '^OPEN_USAGE_' >/dev/null; then state=leaked; else state=clean; fi
    printf '{"jsonrpc":"2.0","id":1,"result":{"rateLimits":{"primary":{"usedPercent":12,"windowDurationMins":10080},"planType":"%s"}}}\\n' "$state"
    ;;
  *) printf '%s\\n' '${rateLimits}' | /usr/bin/sed 's/^/{"jsonrpc":"2.0","id":1,"result":/; s/$/}/' ;;
esac
IFS= read -r request2
if [ -n "$STUB_LOG" ]; then printf '%s\\n' "$request2" >> "$STUB_LOG"; fi
if [ "$STUB_MODE" = unsupported ]; then
  printf '{"jsonrpc":"2.0","id":2,"result":{"account":{"type":"apiKey","planType":null}}}\\n'
else
  printf '%s\\n' '${account}' | /usr/bin/sed 's/^/{"jsonrpc":"2.0","id":2,"result":/; s/$/}/'
fi
IFS= read -r request3
if [ -n "$STUB_LOG" ]; then printf '%s\\n' "$request3" >> "$STUB_LOG"; fi
printf '%s\\n' '${usage}' | /usr/bin/sed 's/^/{"jsonrpc":"2.0","id":3,"result":/; s/$/}/'`);
  cleanups.push(stub.cleanup);
  return stub;
}

describe("Codex app-server transport", () => {
  test("performs initialize/initialized ordering and parses streamed frames", async () => {
    const { executable, root } = appServerStub();
    const log = join(root, "requests.jsonl");
    const outcome = await runRequests(
      [
        { id: 1, method: "account/rateLimits/read" },
        { id: 2, method: "account/read" },
        { id: 3, method: "account/usage/read" },
      ],
      { executable, env: stubEnvironment({ STUB_LOG: log }) },
    );

    expect(outcome.errors.size).toBe(0);
    expect(outcome.results.has(1)).toBe(true);
    expect(outcome.results.has(2)).toBe(true);
    expect(outcome.results.has(3)).toBe(true);
    const sent = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(sent.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "account/rateLimits/read",
      "account/read",
      "account/usage/read",
    ]);
  });

  test("readCodexLimits assembles limits, account, and usage replies", async () => {
    const { executable } = appServerStub();
    const limits = await readCodexLimits(new Date(NOW_MS), {
      executable,
      env: stubEnvironment(),
    });
    expect(limits.planType).toBe("plus");
    expect(limits.weekly?.usedPercent).toBe(0);
    expect(limits.additionalRateLimits[0]?.name).toBe("codex mini");
    expect(limits.usage?.dailyTokens.get("2026-08-16")).toBe(100);
  });

  test("times out a silent server and settles even when it ignores SIGTERM", async () => {
    const { executable } = appServerStub();
    const started = Date.now();
    await expect(readCodexLimits(new Date(NOW_MS), {
      executable,
      timeoutMs: 1_000,
      killGraceMs: 20,
      env: stubEnvironment({ STUB_MODE: "timeout" }),
    })).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_800);
  });

  test("propagates abort reasons from an active request", async () => {
    const { executable } = appServerStub();
    const controller = new AbortController();
    const reason = new Error("refresh superseded");
    const pending = readCodexLimits(new Date(NOW_MS), {
      executable,
      signal: controller.signal,
      env: stubEnvironment({ STUB_MODE: "abort" }),
    });
    setTimeout(() => controller.abort(reason), 50);
    await expect(pending).rejects.toBe(reason);
  });

  test("classifies missing executables, unusable frames, and RPC errors", async () => {
    await expect(readCodexLimits(new Date(NOW_MS), {
      executable: "/definitely/not/a/codex",
      env: stubEnvironment(),
    })).rejects.toMatchObject({ kind: "not-installed" });

    const invalid = appServerStub();
    await expect(readCodexLimits(new Date(NOW_MS), {
      executable: invalid.executable,
      env: stubEnvironment({ STUB_MODE: "invalid" }),
    })).rejects.toMatchObject({ kind: "protocol" });

    for (const [mode, kind] of [
      ["logged-out", "not-logged-in"],
      ["unsupported", "unsupported-auth"],
      ["rpc-error", "protocol"],
    ] as const) {
      const stub = appServerStub();
      await expect(readCodexLimits(new Date(NOW_MS), {
        executable: stub.executable,
        env: stubEnvironment({ STUB_MODE: mode }),
      })).rejects.toMatchObject({ kind });
    }
  });

  test("surfaces the cli's own complaint when it refuses our arguments", async () => {
    const stub = createStubExecutable(`
printf "error: invalid value 'untrusted' for '--ask-for-approval <APPROVAL_POLICY>'\\n" >&2
exit 2`);
    cleanups.push(stub.cleanup);
    await expect(readCodexLimits(new Date(NOW_MS), {
      executable: stub.executable,
      env: stubEnvironment(),
    })).rejects.toMatchObject({
      kind: "incompatible",
      message: expect.stringContaining("--ask-for-approval"),
    });
  });

  test("scrubs OPEN_USAGE variables from the app-server environment", async () => {
    const { executable } = appServerStub();
    const limits = await readCodexLimits(new Date(NOW_MS), {
      executable,
      env: stubEnvironment({
        STUB_MODE: "env",
        OPEN_USAGE_SECRET: "nope",
        OPEN_USAGE_FUTURE_TOKEN: "also-nope",
      }),
    });
    expect(limits.planType).toBe("clean");
  });
});

describe("parseRateLimits", () => {
  test("reads the grant deadline and the spend-control flag the live reply carries", () => {
    const limits = parseRateLimits(LIVE_RESPONSE, NOW_MS);

    expect(limits?.resetCreditsExpireAtMs).toBe(1_789_947_975 * 1000);
    expect(limits?.isSpendControlReached).toBe(false);
    expect(
      parseRateLimits(
        { ...LIVE_RESPONSE, rateLimits: { ...LIVE_RESPONSE.rateLimits, spendControlReached: true } },
        NOW_MS,
      )?.isSpendControlReached,
    ).toBe(true);
  });

  test("takes the soonest deadline and ignores grants that are not available", () => {
    const limits = parseRateLimits(
      {
        ...LIVE_RESPONSE,
        rateLimitResetCredits: {
          availableCount: 2,
          credits: [
            { id: "a", status: "available", expiresAt: 3_000 },
            { id: "b", status: "available", expiresAt: 2_000 },
            { id: "c", status: "used", expiresAt: 1_000 },
          ],
        },
      },
      NOW_MS,
    );

    expect(limits?.resetCreditsExpireAtMs).toBe(2_000 * 1000);
  });

  test("a grant with no stated deadline reports none rather than zero", () => {
    const limits = parseRateLimits(
      {
        ...LIVE_RESPONSE,
        rateLimitResetCredits: { availableCount: 1, credits: [{ id: "a", status: "available" }] },
      },
      NOW_MS,
    );

    expect(limits?.resetCreditsExpireAtMs).toBeNull();
  });

  test("classifies a lone weekly primary window by its duration", () => {
    const limits = parseRateLimits(LIVE_RESPONSE, NOW_MS);
    // A positional mapping would have called this the session window.
    expect(limits?.session).toBeNull();
    expect(limits?.weekly).toEqual({
      usedPercent: 0,
      resetsAtMs: 1786212362 * 1000,
      windowMinutes: 10080,
    });
    expect(limits?.planType).toBe("plus");
    expect(limits?.resetCredits).toBe(1);
    expect(limits?.additionalRateLimits).toEqual([
      {
        name: "codex mini",
        usedPercent: 37.4,
        resetsAtMs: 1786212362 * 1000,
        windowMinutes: 10080,
      },
    ]);
    expect(limits?.credits).toEqual({ balance: 0, unlimited: false });
  });

  test("keeps both windows for an additional model limit", () => {
    const limits = parseRateLimits(
      {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 10, windowDurationMins: 300 },
        },
        rateLimitsByLimitId: {
          codex: { primary: { usedPercent: 10, windowDurationMins: 300 } },
          spark: {
            limitName: "Codex Spark",
            primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 2_000 },
            secondary: { usedPercent: 70, windowDurationMins: 10_080, resetsAt: 3_000 },
          },
        },
      },
      NOW_MS,
    );

    expect(limits?.additionalRateLimits).toEqual([
      { name: "Codex Spark · 5h", usedPercent: 20, resetsAtMs: 2_000_000, windowMinutes: 300 },
      { name: "Codex Spark · 1w", usedPercent: 70, resetsAtMs: 3_000_000, windowMinutes: 10_080 },
    ]);
  });

  test("reads the monthly spend control and backend reached classification", () => {
    const limits = parseRateLimits(
      {
        rateLimits: {
          primary: { usedPercent: 40, windowDurationMins: 300 },
          rateLimitReachedType: "workspace_member_credits_depleted",
          individualLimit: {
            limit: "50",
            used: "12.5",
            remainingPercent: 75,
            resetsAt: 1_800_000_000,
          },
        },
      },
      NOW_MS,
    );

    expect(limits?.rateLimitReachedType).toBe("workspace_member_credits_depleted");
    expect(limits?.spendControl).toEqual({
      limit: 50,
      used: 12.5,
      usedPercent: 25,
      resetsAtMs: 1_800_000_000_000,
    });
  });

  test("drops a spend control that reports a cap but no consumption", () => {
    const limits = parseRateLimits(
      {
        rateLimits: {
          primary: { usedPercent: 40, windowDurationMins: 300 },
          individualLimit: { limit: 50 },
        },
      },
      NOW_MS,
    );

    // Rendering this as "$0.00 of $50.00" would present a guess as a reading.
    expect(limits?.spendControl).toBeNull();
  });

  test("splits a short and a long window into the right scopes", () => {
    const limits = parseRateLimits(
      {
        rateLimits: {
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_786_000_600 },
          secondary: { usedPercent: 88, windowDurationMins: 10080, resetsAt: 1_786_100_000 },
          planType: "pro",
        },
      },
      NOW_MS,
    );
    expect(limits?.session?.usedPercent).toBe(42);
    expect(limits?.weekly?.usedPercent).toBe(88);
  });

  test("falls back to position when a duration is missing", () => {
    const limits = parseRateLimits(
      {
        rateLimits: {
          primary: { usedPercent: 10 },
          secondary: { usedPercent: 20 },
        },
      },
      NOW_MS,
    );
    expect(limits?.session?.usedPercent).toBe(10);
    expect(limits?.weekly?.usedPercent).toBe(20);
  });

  test("treats a lone undated window as the weekly one", () => {
    const limits = parseRateLimits({ rateLimits: { primary: { usedPercent: 10 } } }, NOW_MS);
    expect(limits?.session).toBeNull();
    expect(limits?.weekly?.usedPercent).toBe(10);
  });

  test("survives nulls, clamps percentages and defaults the credit count", () => {
    const limits = parseRateLimits(
      { rateLimits: { primary: { usedPercent: 150 }, secondary: null } },
      NOW_MS,
    );
    expect(limits?.weekly?.usedPercent).toBe(100);
    expect(limits?.weekly?.resetsAtMs).toBeNull();
    expect(limits?.resetCredits).toBe(0);
    expect(limits?.planType).toBeNull();
    expect(limits?.additionalRateLimits).toEqual([]);
    expect(limits?.credits).toBeNull();
  });

  test("rejects replies without a rate limit snapshot", () => {
    expect(parseRateLimits(null, NOW_MS)).toBeNull();
    expect(parseRateLimits({}, NOW_MS)).toBeNull();
    expect(parseRateLimits({ rateLimits: "nope" }, NOW_MS)).toBeNull();
  });
});

describe("parseUsageHistory", () => {
  /** Captured verbatim from `account/usage/read`. */
  const LIVE_USAGE = {
    summary: {
      lifetimeTokens: 401496457,
      peakDailyTokens: 110289890,
      longestRunningTurnSec: 1802,
      currentStreakDays: 0,
      longestStreakDays: 3,
    },
    dailyUsageBuckets: [
      { startDate: "2026-07-05", tokens: 18094581 },
      { startDate: "2026-07-29", tokens: 28885042 },
    ],
  };

  test("reads sparse daily buckets and the summary", () => {
    const usage = parseUsageHistory(LIVE_USAGE);
    expect(usage?.dailyTokens.get("2026-07-05")).toBe(18094581);
    expect(usage?.dailyTokens.get("2026-07-29")).toBe(28885042);
    // Idle days are simply absent rather than zero-filled.
    expect(usage?.dailyTokens.has("2026-07-06")).toBe(false);
    expect(usage?.summary?.lifetimeTokens).toBe(401496457);
    expect(usage?.summary?.longestRunningTurnSec).toBe(1802);
    expect(usage?.summary?.currentStreakDays).toBe(0);
    expect(usage?.summary?.longestStreakDays).toBe(3);
  });

  test("drops malformed buckets and sums duplicate dates", () => {
    const usage = parseUsageHistory({
      dailyUsageBuckets: [
        { startDate: "2026-07-05", tokens: 10 },
        { startDate: "2026-07-05", tokens: 5 },
        { startDate: "2026-07-06", tokens: -3 },
        { startDate: 7, tokens: 10 },
        null,
      ],
    });
    expect(usage?.dailyTokens.get("2026-07-05")).toBe(15);
    expect(usage?.dailyTokens.has("2026-07-06")).toBe(false);
    expect(usage?.summary).toBeNull();
  });

  test("returns null when there is nothing usable", () => {
    expect(parseUsageHistory(null)).toBeNull();
    expect(parseUsageHistory({})).toBeNull();
    expect(parseUsageHistory({ dailyUsageBuckets: [] })).toBeNull();
    // An all-zero summary is malformed, not a real account record.
    expect(
      parseUsageHistory({
        summary: {
          lifetimeTokens: 0,
          peakDailyTokens: 0,
          longestRunningTurnSec: 0,
          currentStreakDays: 0,
          longestStreakDays: 0,
        },
      }),
    ).toBeNull();
  });
});

describe("parseAccount", () => {
  test("reads the plan and auth type from an account reply", () => {
    expect(parseAccount({ account: { type: "chatgpt", planType: "plus" } })).toEqual({
      planType: "plus",
      type: "chatgpt",
    });
    expect(parseAccount({ account: {} })).toEqual({ planType: null, type: null });
    expect(parseAccount(null)).toEqual({ planType: null, type: null });
  });
});

describe("legacy additional limits", () => {
  test("falls back to the array shape when the map is absent", () => {
    const limits = parseRateLimits(
      {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 1, windowDurationMins: 10080 },
          additionalRateLimits: [
            { limitId: "codex-mini-latest", limitName: "codex mini", usedPercent: 37.4 },
          ],
        },
      },
      NOW_MS,
    );
    expect(limits?.additionalRateLimits).toEqual([
      { name: "codex mini", usedPercent: 37.4, resetsAtMs: null, windowMinutes: null },
    ]);
  });
});

/**
 * The stub above encodes codex-cli 0.149.1's argument grammar, which catches a
 * regression but not the next upstream change. Only the installed binary can.
 * Skipped wherever codex is absent, so CI stays hermetic. `initialize` needs no
 * account, so this stays an argument check rather than an auth check - and it
 * must spawn the real server, because `--help` short-circuits clap's validation
 * and would pass even with arguments the CLI rejects.
 */
const installedCodex = Bun.which("codex");

describe.skipIf(installedCodex === null)("against the installed codex cli", () => {
  test("accepts the arguments we spawn it with", async () => {
    const outcome = await runRequests([], { timeoutMs: 20_000 });

    expect(outcome.errors.size).toBe(0);
  });
});
