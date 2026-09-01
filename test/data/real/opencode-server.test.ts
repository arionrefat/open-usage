import { describe, expect, spyOn, test } from "bun:test";
import {
  OpencodeRateLimitError,
  OpencodeServerError,
  SERVER_FUNCTION_IDS,
  fetchGoServerLimits,
  fetchGoUsageHistory,
  fetchGoUsageRows,
  filterCookieHeader,
  isSignedOut,
  parseSubscription,
  parseWorkspaceId,
  resetDiscoveredIds,
  retryAfterMs,
  timezoneOffsetLabel,
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

describe("server function id self-healing", () => {
  const ROTATED = "a".repeat(64);
  const COSTS = '{usage:[{date:"2026-08-01",model:"kimi-k3",totalCost:100000000,plan:"lite"}],keys:[]}';
  const BILLING = "{balance:0,reloadAmount:20,monthlyUsage:null,monthlyLimit:null}";
  const BUNDLE =
    'const q = createServerReference("' + ROTATED + '");' + 'const w = query(q, "workspaces");';

  /** Answers each function with a payload its own parser accepts. */
  function payloadFor(id: string): string {
    if (id === SERVER_FUNCTION_IDS.billing) return BILLING;
    if (id === SERVER_FUNCTION_IDS.usageCosts) return COSTS;
    return '[{id:"wrk_01ABC"}]';
  }

  function mockServer(handle: (url: URL, init?: RequestInit) => Response) {
    return spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit) =>
          Promise.resolve(handle(new URL(input.toString()), init as RequestInit)),
        { preconnect: (_url: string | URL) => undefined },
      ),
    );
  }

  test("re-derives a rotated id from the bundle and retries with it", async () => {
    resetDiscoveredIds();
    const idsTried: string[] = [];
    const fetchSpy = mockServer((url) => {
      if (url.pathname === "/") return new Response('"/_build/assets/entry-1.js"');
      if (url.pathname.startsWith("/_build/")) return new Response(BUNDLE);

      const id = url.searchParams.get("id") ?? "";
      idsTried.push(id);
      // The shipped workspaces id no longer resolves; the rotated one does.
      if (id === SERVER_FUNCTION_IDS.workspaces) return new Response("null");
      if (id === ROTATED) return new Response('[{id:"wrk_01ABC"}]');
      return new Response(payloadFor(id));
    });

    try {
      const history = await fetchGoUsageHistory("auth=secret", new Date("2026-08-18T00:00:00Z"));
      expect(idsTried[0]).toBe(SERVER_FUNCTION_IDS.workspaces);
      expect(idsTried).toContain(ROTATED);
      expect(history.workspaceId).toBe("wrk_01ABC");
      expect(history.costs.rows[0]?.usd).toBe(1);
    } finally {
      fetchSpy.mockRestore();
      resetDiscoveredIds();
    }
  });

  test("an expired session is reported, never chased with a fresh id", async () => {
    // A new id cannot fix bad credentials. Treating 401 as drift would crawl the
    // bundle on every poll and hide the real reason from the user.
    resetDiscoveredIds();
    let bundleFetches = 0;
    const fetchSpy = mockServer((url) => {
      if (url.pathname === "/" || url.pathname.startsWith("/_build/")) {
        bundleFetches += 1;
        return new Response(BUNDLE);
      }
      return new Response("nope", { status: 401 });
    });

    try {
      const failure = await fetchGoUsageHistory("auth=secret", new Date()).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(OpencodeServerError);
      expect((failure as OpencodeServerError).kind).toBe("credentials");
      expect(bundleFetches).toBe(0);
    } finally {
      fetchSpy.mockRestore();
      resetDiscoveredIds();
    }
  });

  test("does not touch the bundle while the shipped ids still parse", async () => {
    resetDiscoveredIds();
    let bundleFetches = 0;
    const fetchSpy = mockServer((url) => {
      if (url.pathname === "/" || url.pathname.startsWith("/_build/")) {
        bundleFetches += 1;
        return new Response(BUNDLE);
      }
      return new Response(payloadFor(url.searchParams.get("id") ?? ""));
    });

    try {
      await fetchGoUsageHistory("auth=secret", new Date("2026-08-18T00:00:00Z"));
      expect(bundleFetches).toBe(0);
    } finally {
      fetchSpy.mockRestore();
      resetDiscoveredIds();
    }
  });
});

describe("timezoneOffsetLabel", () => {
  test("formats the offset the cost query buckets days by", () => {
    expect(timezoneOffsetLabel(new Date())).toMatch(/^[+-]\d{2}:\d{2}$/);
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

describe("fetchGoUsageRows", () => {
  const WORKSPACE = "wrk_01ABC";
  /**
   * A full page, timestamped so the walk can be steered by the window. Full
   * because a short page legitimately means the end of the table.
   */
  function page(atMs: number, rows = 50): string {
    return JSON.stringify(
      Array.from({ length: rows }, (_, index) => ({
        id: `usg_${index}`,
        sessionID: "ses_1",
        timeCreated: new Date(atMs).toISOString(),
        model: "kimi-k3",
        inputTokens: 1,
        outputTokens: 1,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        cost: 0,
        plan: "lite",
      })),
    );
  }

  function mock(handle: (page: number) => Response) {
    return spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        (_input: string | URL | Request, init?: RequestInit | BunFetchRequestInit) => {
          const body = String((init as RequestInit)?.body ?? "");
          const requested = Number(/"s":(\d+)}\]/.exec(body)?.[1] ?? 0);
          return Promise.resolve(handle(requested));
        },
        { preconnect: (_url: string | URL) => undefined },
      ),
    );
  }

  test("stops walking once a page reaches past the window", async () => {
    const now = Date.parse("2026-08-20T00:00:00Z");
    const requested: number[] = [];
    const fetchSpy = mock((requestedPage) => {
      requested.push(requestedPage);
      // Page 6 is older than the cutoff, so the walk must end there.
      const atMs = requestedPage < 6 ? now - 60_000 : now - 10 * 24 * 60 * 60 * 1000;
      return new Response(page(atMs));
    });
    try {
      const rows = await fetchGoUsageRows("auth=secret", WORKSPACE, {
        sinceMs: now - 24 * 60 * 60 * 1000,
      });
      // The first page goes alone, then four at a time: the batch holding page
      // 6 is the last, and nothing beyond it is asked for.
      expect(requested).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      expect(rows).toHaveLength(6 * 50);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("a light month costs one request", async () => {
    const now = Date.parse("2026-08-20T00:00:00Z");
    const requested: number[] = [];
    const fetchSpy = mock((requestedPage) => {
      requested.push(requestedPage);
      return new Response(page(now - 60_000, 12));
    });
    try {
      const rows = await fetchGoUsageRows("auth=secret", WORKSPACE, { sinceMs: 0 });
      expect(requested).toEqual([0]);
      expect(rows).toHaveLength(12);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("a failed page inside a batch keeps the pages before it and drops the rest", async () => {
    const now = Date.parse("2026-08-20T00:00:00Z");
    const fetchSpy = mock((requestedPage) =>
      requestedPage === 2 ? new Response("", { status: 500 }) : new Response(page(now - 60_000)),
    );
    try {
      // Pages 3 and 4 came back fine, but the rows between them and page 1
      // were never seen, so keeping them would leave a hole in the series.
      const rows = await fetchGoUsageRows("auth=secret", WORKSPACE, { sinceMs: 0, maxPages: 5 });
      expect(rows).toHaveLength(2 * 50);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("keeps the pages it already walked when a later one fails", async () => {
    const now = Date.parse("2026-08-20T00:00:00Z");
    const fetchSpy = mock((requestedPage) =>
      requestedPage === 0 ? new Response(page(now - 60_000)) : new Response("", { status: 500 }),
    );
    try {
      // Losing a month of history to one bad page would read as no usage.
      const rows = await fetchGoUsageRows("auth=secret", WORKSPACE, { sinceMs: 0 });
      expect(rows).toHaveLength(50);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("throws rather than reporting an empty window when the first page fails", async () => {
    const fetchSpy = mock(() => new Response("", { status: 500 }));
    try {
      await expect(
        fetchGoUsageRows("auth=secret", WORKSPACE, { sinceMs: 0 }),
      ).rejects.toBeInstanceOf(OpencodeServerError);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("refuses to walk without an auth cookie", async () => {
    await expect(
      fetchGoUsageRows("theme=dark", WORKSPACE, { sinceMs: 0 }),
    ).rejects.toBeInstanceOf(OpencodeServerError);
  });
});
