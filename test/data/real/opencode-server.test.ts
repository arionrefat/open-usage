import { describe, expect, spyOn, test } from "bun:test";
import {
  OpencodeRateLimitError,
  SERVER_FUNCTION_IDS,
  fetchGoServerLimits,
  filterCookieHeader,
  isSignedOut,
  parseSubscription,
  parseWorkspaceId,
  retryAfterMs,
} from "../../../src/data/real/opencode-server";

/** Verbatim response shapes from CodexBar's parser fixtures. */
const WORKSPACE_JS =
  ';0x00000089;((self.$R=self.$R||{})["codexbar"]=[],' +
  '($R=>$R[0]=[$R[1]={id:"wrk_01K6AR1ZET89H8NB691FQ2C2VB",name:"Default",slug:null}])' +
  '($R["codexbar"]))';

const SUBSCRIPTION_JS =
  "$R[16]($R[30],$R[41]={" +
  'rollingUsage:$R[42]={status:"ok",resetInSec:5944,usagePercent:17},' +
  'weeklyUsage:$R[43]={status:"ok",resetInSec:278201,usagePercent:75},' +
  'monthlyUsage:$R[44]={status:"ok",resetInSec:90061,usagePercent:99},useBalance:true' +
  "});";

describe("parseWorkspaceId", () => {
  test("finds the workspace id in serialized javascript", () => {
    expect(parseWorkspaceId(WORKSPACE_JS)).toBe("wrk_01K6AR1ZET89H8NB691FQ2C2VB");
  });

  test("returns null when no workspace is present", () => {
    expect(parseWorkspaceId('{"workspaces":[]}')).toBeNull();
  });
});

describe("parseSubscription", () => {
  test("reads all windows out of serialized javascript, including $R[n]= bindings", () => {
    const parsed = parseSubscription(SUBSCRIPTION_JS);
    expect(parsed?.rolling).toEqual({ percent: 17, resetInSec: 5944 });
    expect(parsed?.weekly).toEqual({ percent: 75, resetInSec: 278201 });
    expect(parsed?.monthly).toEqual({ percent: 99, resetInSec: 90061 });
    expect(parsed?.useBalance).toBe(true);
  });

  test("reads the json form too", () => {
    const parsed = parseSubscription(
      JSON.stringify({
        rollingUsage: { usagePercent: 17, resetInSec: 5944 },
        weeklyUsage: { usagePercent: 75, resetInSec: 278201 },
        monthlyUsage: { usagePercent: 99, resetInSec: 90061 },
        useBalance: false,
      }),
    );
    expect(parsed?.rolling.percent).toBe(17);
    expect(parsed?.weekly?.percent).toBe(75);
    expect(parsed?.monthly?.percent).toBe(99);
    expect(parsed?.useBalance).toBe(false);
  });

  test("reads small percentages literally instead of rescaling them", () => {
    // usagePercent is a 0-100 field, so 1 means 1%. Treating values at or under
    // 1 as fractions would show a just-reset account as fully capped.
    const parsed = parseSubscription(
      JSON.stringify({
        rollingUsage: { usagePercent: 1, resetInSec: 600 },
        weeklyUsage: { usagePercent: 0.5, resetInSec: 3600 },
      }),
    );
    expect(parsed?.rolling.percent).toBe(1);
    expect(parsed?.weekly?.percent).toBe(0.5);
  });

  test("clamps out-of-range percentages", () => {
    const parsed = parseSubscription(
      JSON.stringify({ rollingUsage: { usagePercent: 140, resetInSec: 600 } }),
    );
    expect(parsed?.rolling.percent).toBe(100);
  });

  test("computes a percent from used and limit when none is published", () => {
    const parsed = parseSubscription(
      JSON.stringify({ rollingUsage: { used: 25, limit: 100, resetInSec: 600 } }),
    );
    expect(parsed?.rolling.percent).toBe(25);
  });

  test("tolerates missing weekly and monthly windows but requires the rolling one", () => {
    const weeklyless = parseSubscription(
      JSON.stringify({ rollingUsage: { usagePercent: 17, resetInSec: 5944 } }),
    );
    expect(weeklyless?.weekly).toBeNull();
    expect(weeklyless?.monthly).toBeNull();
    expect(weeklyless?.useBalance).toBeNull();

    expect(parseSubscription(JSON.stringify({ weeklyUsage: { usagePercent: 5 } }))).toBeNull();
    expect(parseSubscription("null")).toBeNull();
    expect(parseSubscription("<html>login</html>")).toBeNull();
  });

  test("does not read one window's reset into the other", () => {
    // A bare `resetInSec` scan would hand the rolling value to weekly.
    const parsed = parseSubscription(
      "rollingUsage:{resetInSec:100,usagePercent:10},weeklyUsage:{usagePercent:20}",
    );
    expect(parsed?.rolling.resetInSec).toBe(100);
    expect(parsed?.weekly).toBeNull();
  });

  test("a back-referenced window does not absorb the next window's values", () => {
    // The serializer emits a repeated object as a bare `$R[n]` with no literal;
    // scanning onward would silently give rolling the weekly figures.
    const parsed = parseSubscription(
      "$R[16]($R[30],$R[41]={rollingUsage:$R[42]," +
        'weeklyUsage:$R[43]={status:"ok",resetInSec:278201,usagePercent:75}});',
    );
    expect(parsed).toBeNull();
  });

  test("still reads a window bound through $R[n]=", () => {
    const parsed = parseSubscription(
      'rollingUsage:$R[42]={status:"ok",resetInSec:5944,usagePercent:17}',
    );
    expect(parsed?.rolling).toEqual({ percent: 17, resetInSec: 5944 });
  });
});

describe("fetchGoServerLimits", () => {
  test("uses an id-only GET for workspaces and exact seroval args for subscription", async () => {
    const urls: URL[] = [];
    const methods: Array<string | undefined> = [];
    const headers: Headers[] = [];
    let call = 0;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit) => {
          urls.push(new URL(input.toString()));
          methods.push(init?.method);
          headers.push(new Headers(init?.headers));
          call += 1;
          const body =
            call === 1
              ? WORKSPACE_JS
              : JSON.stringify({
                  rollingUsage: { usagePercent: 0, resetInSec: 18_000 },
                  weeklyUsage: { usagePercent: 15, resetInSec: 100_800 },
                  monthlyUsage: { usagePercent: 99, resetInSec: 90_000 },
                });
          return Promise.resolve(
            new Response(body, { headers: { "Content-Type": "application/json" } }),
          );
        },
        { preconnect: (_url: string | URL) => undefined },
      ),
    );

    try {
      const now = new Date("2026-08-02T00:00:00Z");
      const limits = await fetchGoServerLimits("auth=secret", now);
      expect(methods).toEqual(["GET", "GET"]);
      expect(headers[0]?.get("X-Server-Id")).toBe(SERVER_FUNCTION_IDS.workspaces);
      expect(headers[1]?.get("X-Server-Id")).toBe(SERVER_FUNCTION_IDS.liteSubscription);
      for (const requestHeaders of headers) {
        expect(requestHeaders.get("X-Server-Instance")).toMatch(/^server-fn:[0-9a-f-]+$/);
      }
      expect(urls[0]?.searchParams.get("id")).toBe(SERVER_FUNCTION_IDS.workspaces);
      expect(urls[0]?.searchParams.has("args")).toBe(false);
      expect(urls[1]?.searchParams.get("id")).toBe(SERVER_FUNCTION_IDS.liteSubscription);
      expect(urls[1]?.searchParams.get("args")).toBe(
        '{"t":{"t":9,"i":0,"l":1,"a":[{"t":1,"s":"wrk_01K6AR1ZET89H8NB691FQ2C2VB"}],"o":0},"f":31,"m":[]}',
      );
      expect(limits.monthlyPercent).toBe(99);
      expect(limits.monthlyResetAtMs).toBe(now.getTime() + 90_000_000);
      expect(limits.workspaceId).toBe("wrk_01K6AR1ZET89H8NB691FQ2C2VB");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("retryAfterMs", () => {
  test("reads delta-seconds", () => {
    expect(retryAfterMs("120")).toBe(120_000);
    expect(retryAfterMs(" 30 ")).toBe(30_000);
  });

  test("reads an http date relative to now", () => {
    const nowMs = Date.parse("2026-08-02T00:00:00Z");
    expect(retryAfterMs("Sun, 02 Aug 2026 00:05:00 GMT", nowMs)).toBe(300_000);
  });

  test("never yields a negative or absurd wait", () => {
    const nowMs = Date.parse("2026-08-02T00:00:00Z");
    expect(retryAfterMs("Sun, 02 Aug 2026 00:00:00 GMT", nowMs)).toBe(0);
    // A past date must not read as an instruction to retry immediately forever.
    expect(retryAfterMs("Sat, 01 Aug 2026 00:00:00 GMT", nowMs)).toBe(0);
    // A wildly long wait is clamped so a bad header cannot wedge the provider.
    expect(retryAfterMs("999999")).toBe(60 * 60_000);
  });

  test("ignores an absent or unparseable header", () => {
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs("")).toBeNull();
    expect(retryAfterMs("soon")).toBeNull();
  });
});

describe("fetchGoServerLimits rate limiting", () => {
  test("a 429 surfaces as a rate limit carrying the server's Retry-After", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        () =>
          Promise.resolve(
            new Response("slow down", { status: 429, headers: { "Retry-After": "90" } }),
          ),
        { preconnect: (_url: string | URL) => undefined },
      ),
    );

    try {
      const failure = await fetchGoServerLimits("auth=secret", new Date()).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(OpencodeRateLimitError);
      expect((failure as OpencodeRateLimitError).retryAfterMs).toBe(90_000);
      expect((failure as OpencodeRateLimitError).kind).toBe("rate-limited");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("a 429 without a Retry-After still reports a rate limit", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(() => Promise.resolve(new Response("slow down", { status: 429 })), {
        preconnect: (_url: string | URL) => undefined,
      }),
    );

    try {
      const failure = await fetchGoServerLimits("auth=secret", new Date()).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(OpencodeRateLimitError);
      expect((failure as OpencodeRateLimitError).retryAfterMs).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("filterCookieHeader", () => {
  test("keeps only the auth cookies", () => {
    expect(filterCookieHeader("ph_session=abc; auth=tok123; _ga=x")).toBe("auth=tok123");
    expect(filterCookieHeader("__Host-auth=tok; other=1")).toBe("__Host-auth=tok");
  });

  test("returns null when nothing authenticates", () => {
    expect(filterCookieHeader("_ga=x; ph_session=abc")).toBeNull();
    expect(filterCookieHeader("")).toBeNull();
  });
});

describe("isSignedOut", () => {
  test("detects the lapsed-session responses", () => {
    expect(isSignedOut('actor of type "public"')).toBe(true);
    expect(isSignedOut("redirecting to /auth/authorize")).toBe(true);
    expect(isSignedOut(SUBSCRIPTION_JS)).toBe(false);
  });
});
