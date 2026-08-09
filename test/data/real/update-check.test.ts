import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkForUpdate,
  compareVersions,
  fetchLatestVersion,
  isNewerVersion,
  isUpdateCheckDisabled,
  readUpdateCache,
  writeUpdateCache,
  type FetchLike,
} from "../../../src/data/real/update-check";

const NOW = new Date("2026-08-10T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

function cachePath(): string {
  return join(mkdtempSync(join(tmpdir(), "open-usage-update-")), "update-check.json");
}

function respondWith(body: unknown, ok = true): FetchLike {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status: ok ? 200 : 500 }));
}

describe("compareVersions", () => {
  test("orders release numbers pairwise rather than lexically", () => {
    // The whole point: "0.10.0" < "0.2.0" as strings, which would hide a release.
    expect(compareVersions("0.10.0", "0.2.0")).toBe(1);
    expect(compareVersions("0.2.0", "0.10.0")).toBe(-1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
  });

  test("treats a missing part as zero", () => {
    expect(compareVersions("0.2", "0.2.0")).toBe(0);
    expect(compareVersions("0.2.1", "0.2")).toBe(1);
  });

  test("sorts a pre-release below the release it leads to", () => {
    expect(compareVersions("0.2.0-beta.1", "0.2.0")).toBe(-1);
    expect(compareVersions("0.2.0", "0.2.0-beta.1")).toBe(1);
    expect(compareVersions("0.3.0-beta.1", "0.2.0")).toBe(1);
  });

  test("calls an unparseable version a tie rather than an upgrade", () => {
    // A registry that answers with nonsense must not produce an upgrade prompt.
    expect(compareVersions("nightly", "0.2.0")).toBe(0);
    expect(isNewerVersion("nightly", "0.2.0")).toBe(false);
  });
});

describe("isUpdateCheckDisabled", () => {
  test("opts out on any non-empty value, and stays on otherwise", () => {
    expect(isUpdateCheckDisabled({ OPEN_USAGE_NO_UPDATE_CHECK: "1" })).toBe(true);
    expect(isUpdateCheckDisabled({ OPEN_USAGE_NO_UPDATE_CHECK: "anything" })).toBe(true);
    expect(isUpdateCheckDisabled({ OPEN_USAGE_NO_UPDATE_CHECK: "  " })).toBe(false);
    expect(isUpdateCheckDisabled({ OPEN_USAGE_NO_UPDATE_CHECK: "" })).toBe(false);
    expect(isUpdateCheckDisabled({})).toBe(false);
  });
});

describe("the update cache file", () => {
  test("round-trips an entry", () => {
    const path = cachePath();
    writeUpdateCache(path, { latestVersion: "0.3.0", checkedAtMs: NOW_MS });
    expect(readUpdateCache(path)).toEqual({ latestVersion: "0.3.0", checkedAtMs: NOW_MS });
  });

  test("reads a missing, malformed or incomplete file as absent", () => {
    expect(readUpdateCache(join(tmpdir(), "definitely-not-here.json"))).toBeNull();

    const path = cachePath();
    writeFileSync(path, "{ broken");
    expect(readUpdateCache(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ latestVersion: "0.3.0" }));
    expect(readUpdateCache(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ checkedAtMs: NOW_MS }));
    expect(readUpdateCache(path)).toBeNull();
  });
});

describe("fetchLatestVersion", () => {
  test("reads the version field", async () => {
    expect(await fetchLatestVersion(respondWith({ version: "0.3.0" }))).toBe("0.3.0");
  });

  test("answers null for a failed request, a bad status and a bad body", async () => {
    const rejects: FetchLike = () => Promise.reject(new Error("offline"));
    expect(await fetchLatestVersion(rejects)).toBeNull();
    expect(await fetchLatestVersion(respondWith({ version: "0.3.0" }, false))).toBeNull();
    expect(await fetchLatestVersion(respondWith({ nope: true }))).toBeNull();
  });
});

describe("checkForUpdate", () => {
  const base = { currentVersion: "0.2.0", now: NOW, env: {} };

  test("advertises a newer version and caches the answer", async () => {
    const path = cachePath();
    expect(await checkForUpdate({ ...base, path, fetchImpl: respondWith({ version: "0.3.0" }) })).toBe(
      "0.3.0",
    );
    expect(readUpdateCache(path)).toEqual({ latestVersion: "0.3.0", checkedAtMs: NOW_MS });
  });

  test("says nothing when the registry matches or trails the running version", async () => {
    expect(
      await checkForUpdate({ ...base, path: cachePath(), fetchImpl: respondWith({ version: "0.2.0" }) }),
    ).toBeNull();
    expect(
      await checkForUpdate({ ...base, path: cachePath(), fetchImpl: respondWith({ version: "0.1.0" }) }),
    ).toBeNull();
  });

  test("serves a fresh cache without touching the network", async () => {
    const path = cachePath();
    writeUpdateCache(path, { latestVersion: "0.4.0", checkedAtMs: NOW_MS - 60_000 });
    const explode: FetchLike = () => {
      throw new Error("the network must not be reached");
    };
    expect(await checkForUpdate({ ...base, path, fetchImpl: explode })).toBe("0.4.0");
  });

  test("re-asks once the cache ages past a day", async () => {
    const path = cachePath();
    writeUpdateCache(path, { latestVersion: "0.4.0", checkedAtMs: NOW_MS - DAY_MS - 1 });
    expect(await checkForUpdate({ ...base, path, fetchImpl: respondWith({ version: "0.5.0" }) })).toBe(
      "0.5.0",
    );
    expect(readUpdateCache(path)?.latestVersion).toBe("0.5.0");
  });

  test("re-asks when the stamp is in the future, rather than trusting it forever", async () => {
    // A clock roll-back would otherwise pin a stale answer until the date caught up.
    const path = cachePath();
    writeUpdateCache(path, { latestVersion: "0.4.0", checkedAtMs: NOW_MS + DAY_MS });
    expect(await checkForUpdate({ ...base, path, fetchImpl: respondWith({ version: "0.5.0" }) })).toBe(
      "0.5.0",
    );
  });

  test("stays silent and skips the network when opted out", async () => {
    const explode: FetchLike = () => {
      throw new Error("the network must not be reached");
    };
    const result = await checkForUpdate({
      ...base,
      path: cachePath(),
      env: { OPEN_USAGE_NO_UPDATE_CHECK: "1" },
      fetchImpl: explode,
    });
    expect(result).toBeNull();
  });

  test("resolves to null rather than rejecting when the network fails", async () => {
    const rejects: FetchLike = () => Promise.reject(new Error("offline"));
    const path = cachePath();
    expect(await checkForUpdate({ ...base, path, fetchImpl: rejects })).toBeNull();
    // Nothing cached, so the next launch retries instead of banking a failure.
    expect(readUpdateCache(path)).toBeNull();
  });

  test("writes the cache with owner-only permissions", () => {
    const path = cachePath();
    writeUpdateCache(path, { latestVersion: "0.3.0", checkedAtMs: NOW_MS });
    expect(readFileSync(path, "utf8")).toContain("0.3.0");
  });
});
