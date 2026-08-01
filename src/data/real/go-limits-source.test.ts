import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COOKIE_ENV_VAR, createGoLimitsSource, readCookie } from "./go-limits-source";
import { OpencodeServerError, type GoServerLimits } from "./opencode-server";

function tempCookieFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "limitless-cookie-"));
  const path = join(dir, "opencode-cookie");
  writeFileSync(path, contents);
  return path;
}

function reading(fetchedAtMs: number): GoServerLimits {
  return {
    rollingPercent: 17,
    rollingResetAtMs: fetchedAtMs + 5_944_000,
    weeklyPercent: 75,
    weeklyResetAtMs: fetchedAtMs + 278_201_000,
    fetchedAtMs,
  };
}

describe("readCookie", () => {
  test("prefers the environment over the file", () => {
    const path = tempCookieFile("auth=from-file");
    expect(readCookie(path, { [COOKIE_ENV_VAR]: "auth=from-env" })).toBe("auth=from-env");
  });

  test("falls back to the file and trims it", () => {
    const path = tempCookieFile("  auth=from-file\n");
    expect(readCookie(path, {})).toBe("auth=from-file");
  });

  test("treats blank and missing sources as absent", () => {
    expect(readCookie(tempCookieFile("   \n"), {})).toBeNull();
    expect(readCookie("/nonexistent/cookie", {})).toBeNull();
    expect(readCookie("/nonexistent/cookie", { [COOKIE_ENV_VAR]: "   " })).toBeNull();
  });
});

describe("createGoLimitsSource", () => {
  test("stays dormant and silent without a cookie", async () => {
    const source = createGoLimitsSource("/nonexistent/cookie", {});
    await source.poll(new Date());
    expect(source.read()).toBeNull();
    // No cookie is a normal unconfigured state, not an error worth showing.
    expect(source.note()).toBeNull();
  });

  test("caches a successful reading and respects the poll interval", async () => {
    const path = tempCookieFile("auth=tok");
    let calls = 0;
    const source = createGoLimitsSource(path, {}, (_cookie, now) => {
      calls += 1;
      return Promise.resolve(reading(now.getTime()));
    });

    const start = new Date();
    await source.poll(start);
    expect(source.read()?.rollingPercent).toBe(17);
    expect(calls).toBe(1);

    // Ten seconds later the minimum interval has not elapsed.
    await source.poll(new Date(start.getTime() + 10_000));
    expect(calls).toBe(1);

    await source.poll(new Date(start.getTime() + 61_000));
    expect(calls).toBe(2);
  });

  test("a reading older than the staleness window stops counting as server truth", async () => {
    const path = tempCookieFile("auth=tok");
    const stale = Date.now() - 20 * 60_000;
    const source = createGoLimitsSource(path, {}, () => Promise.resolve(reading(stale)));

    await source.poll(new Date());
    // An offline machine keeps the old value cached; it must not be served as
    // current, so the UI falls back to the local estimate instead.
    expect(source.read()).toBeNull();
  });

  test("a network failure backs off without discarding a fresh reading", async () => {
    const path = tempCookieFile("auth=tok");
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

    // The 5-minute backoff holds off the next attempt.
    await source.poll(new Date(start.getTime() + 122_000));
    expect(calls).toBe(2);
  });

  test("an expired session clears the reading and says how to fix it", async () => {
    const path = tempCookieFile("auth=tok");
    const source = createGoLimitsSource(path, {}, () =>
      Promise.reject(new OpencodeServerError("opencode session expired", "credentials")),
    );
    await source.poll(new Date());
    expect(source.read()).toBeNull();
    expect(source.note()).toContain("fresh cookie");
  });

  test("a cancelled poll neither backs off nor blames the network", async () => {
    const path = tempCookieFile("auth=tok");
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
      await source.poll(start, controller.signal);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(OpencodeServerError);
    expect(source.note()).toBeNull();

    // A cancel must not poison the next scheduled poll with the 5-minute backoff.
    await source.poll(new Date(start.getTime() + 61_000));
    expect(calls).toBe(2);
  });

  test("a paste with no auth cookie says so instead of blaming the session", async () => {
    const source = createGoLimitsSource("/nonexistent/cookie", {
      [COOKIE_ENV_VAR]: "_ga=1; ph_session=abc",
    });
    await source.poll(new Date());
    expect(source.read()).toBeNull();
    expect(source.note()).toContain("no auth cookie found");
    expect(source.note()).not.toContain("expired");
  });
});
