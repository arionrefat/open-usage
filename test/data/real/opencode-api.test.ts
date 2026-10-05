import { describe, expect, test } from "bun:test";
import { fetchGoApiLimits, parseGoApiLimits } from "../../../src/data/real/opencode-api";
import { OpencodeRateLimitError } from "../../../src/data/real/opencode-server";

const NOW = new Date("2026-08-12T00:00:00.000Z");

/** The shape `formatUsage` builds in the merged route. */
const USAGE = {
  usage: {
    rolling: { status: "ok", percent: 12, resetsAt: "2026-08-12T02:00:00.000Z" },
    weekly: { status: "ok", percent: 8, resetsAt: "2026-08-17T00:00:00.000Z" },
    monthly: { status: "ok", percent: 35, resetsAt: "2026-09-01T00:00:00.000Z" },
  },
};

describe("parseGoApiLimits", () => {
  test("reads the merged route's three windows and their resets", () => {
    expect(parseGoApiLimits(USAGE, NOW)).toMatchObject({
      rollingPercent: 12,
      rollingResetAtMs: Date.parse("2026-08-12T02:00:00.000Z"),
      weeklyPercent: 8,
      weeklyResetAtMs: Date.parse("2026-08-17T00:00:00.000Z"),
      monthlyPercent: 35,
      monthlyResetAtMs: Date.parse("2026-09-01T00:00:00.000Z"),
      source: "api",
    });
  });

  test("a rate-limited window is spent, whatever its floored percent says", () => {
    const limits = parseGoApiLimits(
      { usage: { ...USAGE.usage, rolling: { status: "rate-limited", percent: 99, resetsAt: null } } },
      NOW,
    );
    expect(limits?.rollingPercent).toBe(100);
    expect(limits?.rollingResetAtMs).toBeNull();
  });

  test("carries no dollar figures, which the route does not publish", () => {
    const limits = parseGoApiLimits(USAGE, NOW);
    expect(limits?.rollingUsd).toBeUndefined();
    expect(limits?.rollingCapUsd).toBeUndefined();
  });

  test("tolerates a missing weekly or monthly window but requires the rolling one", () => {
    const limits = parseGoApiLimits({ usage: { rolling: USAGE.usage.rolling } }, NOW);
    expect(limits?.weeklyPercent).toBeNull();
    expect(limits?.monthlyPercent).toBeNull();

    expect(parseGoApiLimits({ usage: { weekly: USAGE.usage.weekly } }, NOW)).toBeNull();
    expect(parseGoApiLimits({ usage: { rolling: { status: "ok", resetsAt: null } } }, NOW)).toBeNull();
  });

  test("names guessed before the route merged are no longer read", () => {
    expect(parseGoApiLimits({ rolling5h: { usagePercent: 19.5, resetInSec: 7200 } }, NOW)).toBeNull();
    expect(parseGoApiLimits(USAGE.usage, NOW)).toBeNull();
  });
});

function respond(response: () => Response): typeof fetch {
  return (() => Promise.resolve(response())) as unknown as typeof fetch;
}

describe("fetchGoApiLimits", () => {
  test("sends the API key only to the fixed HTTPS endpoint", async () => {
    let request: Request | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      request = new Request(String(input), init);
      return Promise.resolve(new Response(JSON.stringify(USAGE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }) as typeof fetch;
    try {
      const limits = await fetchGoApiLimits("go_secret", NOW);
      const seenRequest = request as unknown as Request;
      expect(seenRequest.url).toBe("https://opencode.ai/zen/go/v1/usage");
      expect(seenRequest.headers.get("Authorization")).toBe("Bearer go_secret");
      expect(seenRequest.redirect).toBe("error");
      expect(limits.rollingPercent).toBe(12);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("classifies rejected credentials, rate limits, and malformed bodies", async () => {
    const originalFetch = globalThis.fetch;
    try {
      // Verbatim from production with no key, 2026-10-06.
      globalThis.fetch = respond(() => new Response(
        '{"type":"error","error":{"type":"AuthError","message":"Missing API key."}}',
        { status: 401 },
      ));
      await expect(fetchGoApiLimits("bad", NOW)).rejects.toMatchObject({ kind: "credentials" });

      globalThis.fetch = respond(() => new Response("{}", {
        status: 429,
        headers: { "Retry-After": "120" },
      }));
      await expect(fetchGoApiLimits("key", NOW)).rejects.toBeInstanceOf(OpencodeRateLimitError);

      globalThis.fetch = respond(() => new Response("{}", { status: 200 }));
      await expect(fetchGoApiLimits("key", NOW)).rejects.toEqual(
        expect.objectContaining({ kind: "parse" }),
      );

      // A route that moves is drift, not an outage to retry on schedule.
      globalThis.fetch = respond(() => new Response("", { status: 404 }));
      await expect(fetchGoApiLimits("key", NOW)).rejects.toMatchObject({ kind: "parse" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a key on a workspace with no Go plan is not called rejected", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = respond(() => new Response(
        '{"type":"error","error":{"type":"EntitlementError","message":"OpenCode Go subscription required."}}',
        { status: 403 },
      ));
      await expect(fetchGoApiLimits("key", NOW)).rejects.toMatchObject({ kind: "no-subscription" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a drained account is told apart from a rejected key", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = respond(() => new Response(
        JSON.stringify({
          type: "CreditsError",
          message: "Insufficient balance. Manage your billing here: https://opencode.ai/",
        }),
        { status: 401 },
      ));
      await expect(fetchGoApiLimits("key", NOW)).rejects.toMatchObject({
        kind: "insufficient-balance",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
