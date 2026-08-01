import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COOKIE_ENV_VAR, createGoLimitsSource, readCookie } from "./go-limits-source";

function tempCookieFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "limitless-cookie-"));
  const path = join(dir, "opencode-cookie");
  writeFileSync(path, contents);
  return path;
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
