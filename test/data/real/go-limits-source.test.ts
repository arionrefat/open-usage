import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API_KEY_ENV_VAR,
  COOKIE_ENV_VAR,
  cookieExpiryMs,
  createGoLimitsSource,
  readApiKey,
  readCookie,
} from "../../../src/data/real/go-limits-source";
import {
  OpencodeRateLimitError,
  OpencodeServerError,
  type GoServerLimits,
} from "../../../src/data/real/opencode-server";

function tempConfigFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "open-usage-config-"));
  const path = join(dir, "config.json");
  writeFileSync(path, contents);
  return path;
}

function configWithCookie(cookie: string): string {
  return tempConfigFile(JSON.stringify({ opencodeCookie: cookie }));
}

function reading(fetchedAtMs: number): GoServerLimits {
  return {
    rollingPercent: 17,
    rollingResetAtMs: fetchedAtMs + 5_944_000,
    weeklyPercent: 75,
    weeklyResetAtMs: fetchedAtMs + 278_201_000,
    monthlyPercent: 99,
    monthlyResetAtMs: fetchedAtMs + 90_000,
    fetchedAtMs,
    useBalance: null,
  };
}

describe("remote credentials", () => {
  test("reads an API key from the environment or config", () => {
    const path = tempConfigFile(JSON.stringify({ opencodeApiKey: " from-file " }));
    expect(readApiKey(path, {})).toBe("from-file");
    expect(readApiKey(path, { [API_KEY_ENV_VAR]: "from-env" })).toBe("from-env");
    expect(readApiKey(tempConfigFile("{}"), {})).toBeNull();
  });

  function countingSource(config: string, env: Record<string, string | undefined> = {}) {
    const calls = { api: 0, dashboard: 0 };
    const source = createGoLimitsSource(
      tempConfigFile(config),
      env,
      (_cookie, now) => {
        calls.dashboard += 1;
        return Promise.resolve({ ...reading(now.getTime()), source: "dashboard" as const });
      },
      {
        apiFetcher: (_key, now) => {
          calls.api += 1;
          return Promise.resolve({ ...reading(now.getTime()), source: "api" as const });
        },
      },
    );
    return { calls, source };
  }

  // The API route is still an unmerged proposal, so a stray key must never cost
  // a user the dashboard readings they already had.
  test("keeps using the dashboard when both credential types exist", async () => {
    const { calls, source } = countingSource(JSON.stringify({
      opencodeApiKey: "go_key",
      opencodeCookie: "auth=cookie",
    }));

    await source.poll(new Date());
    expect(source.credentialKind?.()).toBe("cookie");
    expect(source.read()?.source).toBe("dashboard");
    expect(calls).toEqual({ api: 0, dashboard: 1 });
  });

  test("uses the API only when it is the sole credential", async () => {
    const { calls, source } = countingSource(JSON.stringify({ opencodeApiKey: "go_key" }));

    await source.poll(new Date());
    expect(source.credentialKind?.()).toBe("api-key");
    expect(source.read()?.source).toBe("api");
    expect(calls).toEqual({ api: 1, dashboard: 0 });
    expect(source.cookieExpiresAtMs()).toBeNull();
  });

  test("prefers the cookie environment over the file", () => {
    const path = configWithCookie("auth=from-file");
    expect(readCookie(path, { [COOKIE_ENV_VAR]: "auth=from-env" })).toBe("auth=from-env");
  });

  test("falls back to the json config and trims the field", () => {
    const path = configWithCookie("  auth=from-file\n");
    expect(readCookie(path, {})).toBe("auth=from-file");
  });

  test("treats malformed or incomplete config as absent", () => {
    expect(readCookie(tempConfigFile("not json"), {})).toBeNull();
    expect(readCookie(tempConfigFile("{}"), {})).toBeNull();
    expect(readCookie(tempConfigFile('{"opencodeCookie":42}'), {})).toBeNull();
    expect(readCookie(configWithCookie("   "), {})).toBeNull();
    expect(readCookie("/nonexistent/config.json", {})).toBeNull();
    expect(readCookie("/nonexistent/config.json", { [COOKIE_ENV_VAR]: "   " })).toBeNull();
  });
});

describe("cookieExpiryMs", () => {
  test("reads the expiry from a real-shaped Iron seal", () => {
    const expiryMs = 1_814_553_561_725;
    expect(cookieExpiryMs(`auth=Fe26.2**macSalt*iv*payload*${expiryMs}*sealSalt*mac`)).toBe(
      expiryMs,
    );
  });

  test("rejects malformed or non-auth cookie values", () => {
    expect(cookieExpiryMs("")).toBeNull();
    expect(cookieExpiryMs("ph_session=value")).toBeNull();
    expect(cookieExpiryMs("auth=Fe26.2**too*few")).toBeNull();
    expect(cookieExpiryMs("auth=Fe26.2**macSalt*iv*payload*never*sealSalt*mac")).toBeNull();
    expect(cookieExpiryMs("auth=plain-value")).toBeNull();
  });
});

describe("createGoLimitsSource", () => {
  test("stays dormant and silent without a cookie", async () => {
    const source = createGoLimitsSource("/nonexistent/config.json", {});
    await source.poll(new Date());
    expect(source.read()).toBeNull();
    // No cookie is a normal unconfigured state, not an error worth showing.
    expect(source.note()).toBeNull();
  });

  test("caches a successful reading and respects the poll interval", async () => {
    const path = configWithCookie("auth=tok");
    let calls = 0;
    const source = createGoLimitsSource(path, {}, (_cookie, now) => {
      calls += 1;
      return Promise.resolve(reading(now.getTime()));
    });

    const start = new Date();
    await source.poll(start);
    expect(source.read()?.rollingPercent).toBe(17);
    expect(source.cookieExpiresAtMs()).toBeNull();
    expect(calls).toBe(1);

    // Ten seconds later the minimum interval has not elapsed.
    await source.poll(new Date(start.getTime() + 10_000));
    expect(calls).toBe(1);

    await source.poll(new Date(start.getTime() + 61_000));
    expect(calls).toBe(2);
  });

  test("reuses a discovered workspace id on later polls", async () => {
    const path = configWithCookie("auth=tok");
    const workspaceIds: Array<string | undefined> = [];
    const source = createGoLimitsSource(path, {}, (_cookie, now, options) => {
      workspaceIds.push(options?.workspaceId);
      return Promise.resolve({ ...reading(now.getTime()), workspaceId: "wrk_cached" });
    });
    const start = new Date();

    await source.poll(start);
    await source.poll(new Date(start.getTime() + 61_000));

    expect(workspaceIds).toEqual([undefined, "wrk_cached"]);
  });

  test("a reading older than the staleness window is retained but no longer displayed", async () => {
    const path = configWithCookie("auth=tok");
    const stale = Date.now() - 20 * 60_000;
    const source = createGoLimitsSource(path, {}, () => Promise.resolve(reading(stale)));

    await source.poll(new Date());
    expect(source.read()).toBeNull();
    expect(source.note()).toContain("cached limits stale");
  });

  test("removing the cookie immediately stops exposing a retained server reading", async () => {
    const path = configWithCookie("auth=tok");
    const start = new Date();
    const source = createGoLimitsSource(path, {}, (_cookie, now) =>
      Promise.resolve(reading(now.getTime())),
    );

    await source.poll(start);
    expect(source.read(start)?.rollingPercent).toBe(17);

    writeFileSync(path, "{}");
    expect(source.read(start)).toBeNull();
    expect(source.note(start)).toBeNull();
  });

  test("manual refresh bypasses the normal poll throttle but not the request floor", async () => {
    const path = configWithCookie("auth=tok");
    let calls = 0;
    const source = createGoLimitsSource(path, {}, (_cookie, now) => {
      calls += 1;
      return Promise.resolve(reading(now.getTime()));
    });
    const start = new Date();
    await source.poll(start);

    await source.poll(new Date(start.getTime() + 1_000), { force: true });
    expect(calls).toBe(1);

    // Past the floor but well inside the 60s interval: `r` still works.
    await source.poll(new Date(start.getTime() + 6_000), { force: true });
    expect(calls).toBe(2);
  });

  test("a network failure keeps the old reading and explains the failure", async () => {
    const path = configWithCookie("auth=tok");
    let calls = 0;
    const source = createGoLimitsSource(path, {}, (_cookie, now) => {
      calls += 1;
      if (calls === 1) return Promise.resolve(reading(now.getTime()));
      return Promise.reject(new OpencodeServerError("request failed", "network"));
    });

    const start = new Date();
    await source.poll(start);
    await source.poll(new Date(start.getTime() + 61_000));
    expect(calls).toBe(2);
    expect(source.read()?.rollingPercent).toBe(17);
    expect(source.note()).toBe("opencode unreachable");

    // The 5-minute backoff holds off the next attempt.
    await source.poll(new Date(start.getTime() + 122_000));
    expect(calls).toBe(2);
  });

  test("a rate limit is honored for as long as the server asked", async () => {
    const path = configWithCookie("auth=tok");
    let calls = 0;
    const source = createGoLimitsSource(path, {}, () => {
      calls += 1;
      return Promise.reject(new OpencodeRateLimitError(10 * 60_000));
    });

    const start = new Date();
    await source.poll(start);
    expect(calls).toBe(1);
    expect(source.note()).toContain("rate limiting");

    // Pressing `r` through a rate limit is how an account gets blocked outright.
    await source.poll(new Date(start.getTime() + 60_000), { force: true });
    await source.poll(new Date(start.getTime() + 9 * 60_000), { force: true });
    expect(calls).toBe(1);

    await source.poll(new Date(start.getTime() + 11 * 60_000), { force: true });
    expect(calls).toBe(2);
  });

  test("repeated failures widen the gap between attempts", async () => {
    const path = configWithCookie("auth=tok");
    let calls = 0;
    const source = createGoLimitsSource(path, {}, () => {
      calls += 1;
      return Promise.reject(new OpencodeServerError("request failed", "network"));
    });

    const startMs = Date.now();
    await source.poll(new Date(startMs));
    await source.poll(new Date(startMs + 6 * 60_000));
    expect(calls).toBe(2);

    // The second failure doubles the 5-minute backoff, so 6 more minutes is short.
    await source.poll(new Date(startMs + 12 * 60_000));
    expect(calls).toBe(2);
    await source.poll(new Date(startMs + 17 * 60_000));
    expect(calls).toBe(3);
  });

  test("an expired session clears the reading and says how to fix it", async () => {
    const path = configWithCookie("auth=tok");
    const source = createGoLimitsSource(path, {}, () =>
      Promise.reject(new OpencodeServerError("opencode session expired", "credentials")),
    );
    await source.poll(new Date());
    expect(source.read()).toBeNull();
    expect(source.note()).toContain("fresh cookie");
  });

  test("a cancelled poll neither backs off nor blames the network", async () => {
    const path = configWithCookie("auth=tok");
    let calls = 0;
    const controller = new AbortController();
    const source = createGoLimitsSource(path, {}, () => {
      calls += 1;
      controller.abort();
      return Promise.reject(new OpencodeServerError("request failed", "network"));
    });

    const start = new Date();
    let rejection: unknown;
    try {
      await source.poll(start, { signal: controller.signal });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(OpencodeServerError);
    expect(source.note()).toBeNull();

    // A cancel must not poison the next scheduled poll with the 5-minute backoff.
    await source.poll(new Date(start.getTime() + 61_000));
    expect(calls).toBe(2);
  });

  test("a lapsed plan names itself instead of blaming the dashboard", async () => {
    const path = configWithCookie("auth=tok");
    const source = createGoLimitsSource(path, {}, () =>
      Promise.reject(new OpencodeServerError("no opencode go subscription", "no-subscription")),
    );
    await source.poll(new Date());
    expect(source.read()).toBeNull();
    expect(source.note()).toBe("no opencode go subscription");
    // Nothing failed and nothing needs re-pasting, so the card must not be told
    // the read broke.
    expect(source.status?.()).toBe("none");
  });

  test("a lapsed plan stops exposing limits cached before the plan ended", async () => {
    const path = configWithCookie("auth=tok");
    let isSubscribed = true;
    const source = createGoLimitsSource(path, {}, (_cookie, now) => {
      if (isSubscribed) return Promise.resolve(reading(now.getTime()));
      return Promise.reject(
        new OpencodeServerError("no opencode go subscription", "no-subscription"),
      );
    });

    const startMs = Date.now();
    await source.poll(new Date(startMs));
    expect(source.read(new Date(startMs))?.rollingPercent).toBe(17);

    isSubscribed = false;
    const later = new Date(startMs + 60_000);
    await source.poll(later);
    expect(source.read(later)).toBeNull();
    expect(source.note(later)).toBe("no opencode go subscription");
    expect(source.status?.()).toBe("none");
  });

  test("an exhausted balance says to top up, not to replace the key", async () => {
    const path = tempConfigFile(JSON.stringify({ opencodeApiKey: "go_key" }));
    const source = createGoLimitsSource(path, {}, undefined, {
      apiFetcher: () =>
        Promise.reject(
          new OpencodeServerError("insufficient opencode balance", "insufficient-balance"),
        ),
    });
    await source.poll(new Date());
    expect(source.note()).toContain("balance spent");
    expect(source.note()).not.toContain(API_KEY_ENV_VAR);
    expect(source.status?.()).toBe("none");
  });

  test("a plan that comes back clears the lapsed state", async () => {
    const path = configWithCookie("auth=tok");
    let isSubscribed = false;
    const source = createGoLimitsSource(path, {}, (_cookie, now) => {
      if (!isSubscribed) {
        return Promise.reject(
          new OpencodeServerError("no opencode go subscription", "no-subscription"),
        );
      }
      return Promise.resolve(reading(now.getTime()));
    });

    const startMs = Date.now();
    await source.poll(new Date(startMs));
    expect(source.status?.()).toBe("none");

    isSubscribed = true;
    const laterMs = startMs + 60_000;
    await source.poll(new Date(laterMs), { force: true });
    expect(source.status?.()).toBe("active");
    expect(source.note(new Date(laterMs))).toBeNull();
  });

  test("a paste with no auth cookie says so instead of blaming the session", async () => {
    const source = createGoLimitsSource("/nonexistent/config.json", {
      [COOKIE_ENV_VAR]: "_ga=1; ph_session=abc",
    });
    await source.poll(new Date());
    expect(source.read()).toBeNull();
    expect(source.note()).toContain("no auth cookie found");
    expect(source.note()).not.toContain("expired");
  });
});
