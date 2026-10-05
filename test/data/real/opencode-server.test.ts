import { describe, expect, spyOn, test } from "bun:test";
import {
  OpencodeRateLimitError,
  OpencodeServerError,
  consoleTimestamp,
  fetchGoServerLimits,
  fetchGoUsageHistory,
  fetchGoUsageRows,
  filterCookieHeader,
  hasConsoleSessionCookie,
  isInsufficientBalance,
  isSignedOut,
  parseGoStatus,
  parseOrgId,
  retryAfterMs,
} from "../../../src/data/real/opencode-server";

const WORKSPACE_ID = "wrk_test";
const ORGS = [{ id: WORKSPACE_ID, name: "Default" }];

/** Verbatim in shape from a live `GET /console/api/go/status`. */
const GO_STATUS = {
  subscriberUserId: "acc_test",
  useBalance: false,
  renewalPending: false,
  access: {
    startsAt: "2026-09-08T15:04:50.000Z",
    endsAt: "2026-10-08T15:04:50.000Z",
    meters: {
      fiveHour: {
        startsAt: null,
        resetsAt: null,
        limitMicroCents: "1200000000",
        usedMicroCents: "0",
      },
      week: {
        startsAt: "2026-09-14T00:00:00.000Z",
        resetsAt: "2026-09-21T00:00:00.000Z",
        limitMicroCents: "3000000000",
        usedMicroCents: "1358460874",
      },
      month: { limitMicroCents: "6000000000", usedMicroCents: "2731836592" },
    },
  },
};

const NOW = new Date("2026-09-20T12:00:00.000Z");

type FetchHandler = (url: URL, init?: RequestInit) => Response;

function mockConsole(handle: FetchHandler) {
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit) =>
        Promise.resolve(handle(new URL(input.toString()), init as RequestInit)),
      { preconnect: (_url: string | URL) => undefined },
    ),
  );
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

describe("parseOrgId", () => {
  test("finds the workspace in the org listing", () => {
    expect(parseOrgId(ORGS)).toBe(WORKSPACE_ID);
    expect(parseOrgId([{ id: "org_01ABC" }])).toBe("org_01ABC");
  });

  test("returns null when no workspace is present", () => {
    expect(parseOrgId([])).toBeNull();
    expect(parseOrgId([{ id: "acc_01ABC" }])).toBeNull();
    expect(parseOrgId({ items: ORGS })).toBeNull();
  });
});

describe("parseGoStatus", () => {
  test("turns meter dollars into the percentages the card shows", () => {
    const limits = parseGoStatus(GO_STATUS, NOW);
    expect(limits?.rollingPercent).toBe(0);
    expect(limits?.weeklyPercent).toBeCloseTo(45.28, 2);
    expect(limits?.monthlyPercent).toBeCloseTo(45.53, 2);
    expect(limits?.weeklyUsd).toBeCloseTo(13.58, 2);
    expect(limits?.weeklyCapUsd).toBe(30);
    expect(limits?.useBalance).toBe(false);
    expect(limits?.source).toBe("dashboard");
  });

  test("the plan's renewal is the month's reset, which the meter omits", () => {
    const limits = parseGoStatus(GO_STATUS, NOW);
    expect(limits?.monthlyResetAtMs).toBe(Date.parse("2026-10-08T15:04:50.000Z"));
    expect(limits?.weeklyResetAtMs).toBe(Date.parse("2026-09-21T00:00:00.000Z"));
    // An unused rolling window has no reset yet, which the row says outright
    // rather than inventing one five hours out.
    expect(limits?.rollingResetAtMs).toBeNull();
  });

  test("clamps a meter that overshot its cap", () => {
    const limits = parseGoStatus(
      {
        access: {
          endsAt: "2026-10-08T15:04:50.000Z",
          meters: { fiveHour: { limitMicroCents: "100", usedMicroCents: "140" } },
        },
      },
      NOW,
    );
    expect(limits?.rollingPercent).toBe(100);
  });

  test("tolerates missing weekly and monthly meters but requires the rolling one", () => {
    const partial = parseGoStatus(
      {
        access: {
          endsAt: null,
          meters: { fiveHour: { limitMicroCents: "1200000000", usedMicroCents: "600000000" } },
        },
      },
      NOW,
    );
    expect(partial?.rollingPercent).toBe(50);
    expect(partial?.weeklyPercent).toBeNull();
    expect(partial?.monthlyPercent).toBeNull();

    expect(parseGoStatus({ access: { meters: { week: {} } } }, NOW)).toBeNull();
    expect(parseGoStatus({ access: null }, NOW)).toBeNull();
    expect(parseGoStatus("<html>login</html>", NOW)).toBeNull();
  });
});

describe("fetchGoServerLimits", () => {
  test("discovers the workspace, then names it in the org header", async () => {
    const urls: URL[] = [];
    const headers: Headers[] = [];
    const fetchSpy = mockConsole((url, init) => {
      urls.push(url);
      headers.push(new Headers(init?.headers));
      return json(url.pathname.endsWith("/orgs") ? ORGS : GO_STATUS);
    });

    try {
      const limits = await fetchGoServerLimits("auth=secret", NOW);
      expect(urls.map((url) => url.pathname)).toEqual([
        "/console/api/orgs",
        "/console/api/go/status",
      ]);
      expect(headers[0]?.get("Cookie")).toBe("auth=secret");
      expect(headers[0]?.has("x-org-id")).toBe(false);
      expect(headers[1]?.get("x-org-id")).toBe(WORKSPACE_ID);
      expect(limits.workspaceId).toBe(WORKSPACE_ID);
      expect(limits.monthlyPercent).toBeCloseTo(45.53, 2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("a known workspace saves the discovery round trip", async () => {
    const paths: string[] = [];
    const fetchSpy = mockConsole((url) => {
      paths.push(url.pathname);
      return json(GO_STATUS);
    });

    try {
      await fetchGoServerLimits("auth=secret", NOW, { workspaceId: WORKSPACE_ID });
      expect(paths).toEqual(["/console/api/go/status"]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("reports a lapsed plan rather than blaming the parser", async () => {
    const fetchSpy = mockConsole((url) =>
      json(url.pathname.endsWith("/orgs") ? ORGS : { useBalance: false, access: null }),
    );

    try {
      const failure = await fetchGoServerLimits("auth=secret", NOW).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(OpencodeServerError);
      expect((failure as OpencodeServerError).kind).toBe("no-subscription");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("a rejected query is drift, not a connection problem", async () => {
    // The console answers a query it no longer understands with 400. Calling
    // that a network failure would retry it forever instead of saying the API
    // moved.
    const fetchSpy = mockConsole((url) =>
      url.pathname.endsWith("/orgs")
        ? json(ORGS)
        : new Response('{"_tag":"BadRequest"}', { status: 400 }),
    );

    try {
      const failure = await fetchGoServerLimits("auth=secret", NOW).catch(
        (error: unknown) => error,
      );
      expect((failure as OpencodeServerError).kind).toBe("parse");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("an expired session is reported as credentials", async () => {
    const fetchSpy = mockConsole(() => new Response('{"_tag":"Unauthorized"}', { status: 401 }));

    try {
      const failure = await fetchGoServerLimits("auth=secret", NOW).catch(
        (error: unknown) => error,
      );
      expect((failure as OpencodeServerError).kind).toBe("credentials");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("a drained account is told to top up, not to re-paste its cookie", async () => {
    const fetchSpy = mockConsole(
      () =>
        new Response('{"type":"CreditsError","message":"Insufficient balance."}', { status: 401 }),
    );

    try {
      const failure = await fetchGoServerLimits("auth=secret", NOW).catch(
        (error: unknown) => error,
      );
      expect((failure as OpencodeServerError).kind).toBe("insufficient-balance");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("fetchGoUsageHistory", () => {
  const COST_DAYS = [
    { date: "2026-08-31", totalCostMicroCents: "100000000", totalTokens: "10", totalRequests: "1" },
    { date: "2026-09-01", totalCostMicroCents: "250000000", totalTokens: "20", totalRequests: "2" },
    { date: "2026-09-20", totalCostMicroCents: "50000000", totalTokens: "5", totalRequests: "1" },
  ];

  function handle(url: URL): Response {
    if (url.pathname.endsWith("/orgs")) return json(ORGS);
    if (url.pathname.endsWith("/usage/cost-by-day")) return json(COST_DAYS);
    if (url.pathname.endsWith("/go/status")) return json(GO_STATUS);
    if (url.pathname.endsWith("/billing/status")) return json({ balanceMicroCents: "0" });
    return json({ enabled: false, rechargeAmountDollars: 20 });
  }

  test("splits the day chart into months, newest first", async () => {
    const fetchSpy = mockConsole(handle);

    try {
      const months = await fetchGoUsageHistory("auth=secret", NOW, {
        workspaceId: WORKSPACE_ID,
        months: 3,
      });
      expect(months.map((month) => month.month)).toEqual(["2026-09", "2026-08", "2026-07"]);
      expect(months[0]?.costs.rows.map((row) => row.usd)).toEqual([2.5, 0.5]);
      expect(months[1]?.costs.rows.map((row) => row.usd)).toEqual([1]);
      expect(months[2]?.costs.rows).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("asks for the whole span once, from the oldest month's first day", async () => {
    const queries: string[] = [];
    const fetchSpy = mockConsole((url) => {
      if (url.pathname.endsWith("/usage/cost-by-day")) {
        queries.push(url.searchParams.get("since") ?? "");
      }
      return handle(url);
    });

    try {
      await fetchGoUsageHistory("auth=secret", NOW, { workspaceId: WORKSPACE_ID, months: 3 });
      expect(queries).toEqual([consoleTimestamp(new Date(2026, 6, 1).getTime())]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("a subscriber's days are allowance, and only the open month carries billing", async () => {
    const fetchSpy = mockConsole(handle);

    try {
      const months = await fetchGoUsageHistory("auth=secret", NOW, {
        workspaceId: WORKSPACE_ID,
        months: 2,
      });
      expect(months[0]?.costs.rows[0]?.plan).toBe("lite");
      expect(months[0]?.billing?.hasLiteSubscription).toBe(true);
      expect(months[1]?.billing).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("keeps the months when billing cannot be read", async () => {
    const fetchSpy = mockConsole((url) =>
      url.pathname.includes("/billing/") ? new Response("nope", { status: 500 }) : handle(url),
    );

    try {
      const months = await fetchGoUsageHistory("auth=secret", NOW, {
        workspaceId: WORKSPACE_ID,
        months: 1,
      });
      expect(months[0]?.costs.rows).toHaveLength(2);
      expect(months[0]?.billing).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("fetchGoUsageRows", () => {
  function rowAt(id: number, atMs: number) {
    return {
      id,
      model: "glm-5.3",
      inputTokens: 10,
      outputTokens: 1,
      costMicroCents: "100000000",
      billingSource: "go",
      createdAt: new Date(atMs).toISOString(),
    };
  }

  test("follows the cursor until the console stops sending one", async () => {
    const cursors: Array<string | null> = [];
    const fetchSpy = mockConsole((url) => {
      cursors.push(url.searchParams.get("cursor"));
      return cursors.length === 1
        ? json({ items: [rowAt(1, NOW.getTime())], nextCursor: "page_2" })
        : json({ items: [rowAt(2, NOW.getTime() - 60_000)], nextCursor: null });
    });

    try {
      const rows = await fetchGoUsageRows("auth=secret", WORKSPACE_ID, {
        sinceMs: NOW.getTime() - 86_400_000,
      });
      expect(cursors).toEqual([null, "page_2"]);
      expect(rows.map((row) => row.id)).toEqual(["1", "2"]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("names the window and the page size the console accepts", async () => {
    const sinceMs = Date.parse("2026-08-21T12:00:00.000Z");
    const seen: URL[] = [];
    const fetchSpy = mockConsole((url) => {
      seen.push(url);
      return json({ items: [], nextCursor: null });
    });

    try {
      await fetchGoUsageRows("auth=secret", WORKSPACE_ID, { sinceMs });
      expect(seen[0]?.searchParams.get("since")).toBe("2026-08-21T12:00:00Z");
      expect(seen[0]?.searchParams.get("pageSize")).toBe("100");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("drops rows the window does not cover", async () => {
    const sinceMs = NOW.getTime() - 3_600_000;
    const fetchSpy = mockConsole(() =>
      json({
        items: [rowAt(1, NOW.getTime()), rowAt(2, sinceMs - 60_000)],
        nextCursor: null,
      }),
    );

    try {
      const rows = await fetchGoUsageRows("auth=secret", WORKSPACE_ID, { sinceMs });
      expect(rows.map((row) => row.id)).toEqual(["1"]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("stops at the page cap rather than walking indefinitely", async () => {
    let pages = 0;
    const fetchSpy = mockConsole(() => {
      pages += 1;
      return json({ items: [rowAt(pages, NOW.getTime())], nextCursor: `page_${pages}` });
    });

    try {
      await fetchGoUsageRows("auth=secret", WORKSPACE_ID, {
        sinceMs: NOW.getTime() - 86_400_000,
        maxPages: 3,
      });
      expect(pages).toBe(3);
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
    const fetchSpy = mockConsole(
      () => new Response("slow down", { status: 429, headers: { "Retry-After": "90" } }),
    );

    try {
      const failure = await fetchGoServerLimits("auth=secret", NOW).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(OpencodeRateLimitError);
      expect((failure as OpencodeRateLimitError).retryAfterMs).toBe(90_000);
      expect((failure as OpencodeRateLimitError).kind).toBe("rate-limited");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("a 429 without a Retry-After still reports a rate limit", async () => {
    const fetchSpy = mockConsole(() => new Response("slow down", { status: 429 }));

    try {
      const failure = await fetchGoServerLimits("auth=secret", NOW).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(OpencodeRateLimitError);
      expect((failure as OpencodeRateLimitError).retryAfterMs).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("filterCookieHeader", () => {
  test("keeps only the session cookies", () => {
    expect(filterCookieHeader("ph_session=abc; auth=tok123; _ga=x")).toBe("auth=tok123");
    expect(filterCookieHeader("__Host-auth=tok; other=1")).toBe("__Host-auth=tok");
    // What a pasted console header looks like: the session id the API checks,
    // the older sealed cookie, and a pile of analytics that must not be sent.
    expect(
      filterCookieHeader(
        "oc_locale=en; auth=tok123; desktop_promo_dismissed=1; __Host-console_session=st_abc; __stripe_mid=x",
      ),
    ).toBe("auth=tok123; __Host-console_session=st_abc");
  });

  test("returns null when nothing authenticates", () => {
    expect(filterCookieHeader("_ga=x; ph_session=abc")).toBeNull();
    expect(filterCookieHeader("")).toBeNull();
  });
});

describe("hasConsoleSessionCookie", () => {
  test("tells the console's own cookie from the old dashboard's", () => {
    expect(hasConsoleSessionCookie("oc_locale=en; __Host-console_session=st_abc")).toBe(true);
    expect(hasConsoleSessionCookie("console_session=st_abc")).toBe(true);
    expect(hasConsoleSessionCookie("auth=Fe26.2**sealed; _ga=x")).toBe(false);
    expect(hasConsoleSessionCookie("_ga=x")).toBe(false);
  });
});

describe("consoleTimestamp", () => {
  test("drops the milliseconds the console's since filter rejects", () => {
    expect(consoleTimestamp(Date.parse("2026-09-20T11:22:44.776Z"))).toBe("2026-09-20T11:22:44Z");
  });
});

describe("isSignedOut", () => {
  test("detects the lapsed-session responses", () => {
    expect(isSignedOut('actor of type "public"')).toBe(true);
    expect(isSignedOut("redirecting to https://opencode.ai/console/login")).toBe(true);
    expect(isSignedOut(JSON.stringify(GO_STATUS))).toBe(false);
  });
});

describe("isInsufficientBalance", () => {
  test("recognizes the credits refusal opencode answers 401 with", () => {
    expect(isInsufficientBalance('{"type":"CreditsError","message":"Insufficient balance."}')).toBe(
      true,
    );
    expect(isInsufficientBalance('{"message":"Unauthorized"}')).toBe(false);
  });
});
