import { describe, expect, test } from "bun:test";
import { fetchGoApiLimits, parseGoApiLimits } from "../../../src/data/real/opencode-api";
import { OpencodeRateLimitError } from "../../../src/data/real/opencode-server";

const NOW = new Date("2026-08-12T00:00:00.000Z");

describe("parseGoApiLimits", () => {
  test("reads the proposed public API shape and its dollar fallback fields", () => {
    const limits = parseGoApiLimits(
      {
        rolling5h: { usageDollars: 2.34, limitDollars: 12, usagePercent: 19.5, resetInSec: 7200 },
        weekly: { usageDollars: 8.91, limitDollars: 30, resetInSec: 345600 },
        monthly: { usageDollars: 15, limitDollars: 60, usagePercent: 25, resetInSec: 1414800 },
      },
      NOW,
    );

    expect(limits).toMatchObject({
      rollingPercent: 19.5,
      weeklyPercent: 29.7,
      monthlyPercent: 25,
      rollingResetAtMs: NOW.getTime() + 7_200_000,
      weeklyResetAtMs: NOW.getTime() + 345_600_000,
      monthlyResetAtMs: NOW.getTime() + 1_414_800_000,
      source: "api",
    });
  });

  test("reads the public API usage envelope and absolute reset timestamps", () => {
    const limits = parseGoApiLimits(
      {
        usage: {
          rolling: { percent: 12, resetsAt: "2026-08-12T02:00:00.000Z" },
          weekly: { percent: 8, resetsAt: "2026-08-18T00:00:00.000Z" },
          monthly: { percent: 35, resetsAt: "2026-09-01T00:00:00.000Z" },
        },
      },
      NOW,
    );

    expect(limits).toMatchObject({
      rollingPercent: 12,
      rollingResetAtMs: Date.parse("2026-08-12T02:00:00.000Z"),
      weeklyPercent: 8,
      weeklyResetAtMs: Date.parse("2026-08-18T00:00:00.000Z"),
      monthlyPercent: 35,
      monthlyResetAtMs: Date.parse("2026-09-01T00:00:00.000Z"),
      source: "api",
    });
  });

  test("accepts relative resets and used-over-limit windows", () => {
    const limits = parseGoApiLimits(
      {
        rollingUsage: { usagePercent: 0.25, resetInSec: 600 },
        weeklyUsage: { used: 1, limit: 4, reset_in_sec: "3600" },
      },
      NOW,
    );

    // A percent field is a percent. Rescaling 0.25 to 25% would turn a barely
    // used window into a quarter-full bar, and 1% into a maxed-out one.
    expect(limits?.rollingPercent).toBe(0.25);
    expect(limits?.rollingResetAtMs).toBe(NOW.getTime() + 600_000);
    expect(limits?.weeklyPercent).toBe(25);
    expect(limits?.weeklyResetAtMs).toBe(NOW.getTime() + 3_600_000);
    expect(limits?.monthlyPercent).toBeNull();
  });

  test("keeps unit-agnostic amounts out of the dollar figures", () => {
    const limits = parseGoApiLimits(
      { rolling: { used: 1_240_000, tokenLimit: 2_000_000, resetInSec: 600 } },
      NOW,
    );

    expect(limits?.rollingPercent).toBe(62);
    expect(limits?.rollingUsd).toBeNull();
    expect(limits?.rollingCapUsd).toBeNull();
  });

  test("keeps a usable percentage when the reset field is unrecognized", () => {
    const limits = parseGoApiLimits({ usage: { rolling: { percent: 12, windowEnd: 999 } } }, NOW);

    expect(limits?.rollingPercent).toBe(12);
    expect(limits?.rollingResetAtMs).toBeNull();
  });

  test("fails closed without a rolling window", () => {
    expect(parseGoApiLimits({ usage: { weekly: { percent: 12, resetInSec: 1 } } }, NOW)).toBeNull();
    expect(parseGoApiLimits({ usage: { rolling: { resetInSec: 1 } } }, NOW)).toBeNull();
  });
});

describe("fetchGoApiLimits", () => {
  test("sends the API key only to the fixed HTTPS endpoint", async () => {
    let request: Request | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      request = new Request(String(input), init);
      return Promise.resolve(new Response(JSON.stringify({
        usage: { rolling: { percent: 12, resetsAt: "2026-08-12T02:00:00.000Z" } },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
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
      globalThis.fetch = (() => Promise.resolve(new Response("{}", { status: 401 }))) as unknown as typeof fetch;
      await expect(fetchGoApiLimits("bad", NOW)).rejects.toMatchObject({ kind: "credentials" });

      globalThis.fetch = (() => Promise.resolve(new Response("{}", {
        status: 429,
        headers: { "Retry-After": "120" },
      }))) as unknown as typeof fetch;
      await expect(fetchGoApiLimits("key", NOW)).rejects.toBeInstanceOf(OpencodeRateLimitError);

      globalThis.fetch = (() => Promise.resolve(new Response("{}", { status: 200 }))) as unknown as typeof fetch;
      await expect(fetchGoApiLimits("key", NOW)).rejects.toEqual(
        expect.objectContaining({ kind: "parse" }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a drained account is told apart from a rejected key", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              type: "CreditsError",
              message: "Insufficient balance. Manage your billing here: https://opencode.ai/",
            }),
            { status: 401 },
          ),
        )) as unknown as typeof fetch;
      await expect(fetchGoApiLimits("key", NOW)).rejects.toMatchObject({
        kind: "insufficient-balance",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
