import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubCodexLimitsSource } from "../../src/data/real/codex-limits";
import { createGoLimitsSource, dormantGoLimitsSource } from "../../src/data/real/go-limits-source";
import { dormantClaudeLimitsSource } from "../../src/data/real/claude-usage";
import { dormantClaudeAuthSource } from "../../src/data/real/claude-auth";
import {
  createRealUsageProvider,
  hasOpencodeApiKey,
  hasOpencodeCookie,
  hasRealSources,
  type RealProviderPaths,
} from "../../src/data/real-provider";

const COOKIE = "auth=Fe26.2**abc*def*ghi*jkl*mno*1900000000000*pqr*stu";
const NO_ENV: Record<string, string | undefined> = {};

const OFFLINE = {
  claudeAuth: dormantClaudeAuthSource,
  claudeLimits: dormantClaudeLimitsSource,
  codexLimits: stubCodexLimitsSource,
  goLimits: dormantGoLimitsSource,
} as const;

function pathsIn(root: string): RealProviderPaths {
  return {
    opencodeDb: join(root, "opencode", "opencode.db"),
    opencodeAuth: join(root, "opencode", "auth.json"),
    configFile: join(root, "open-usage", "config.json"),
    claudeProjects: join(root, "claude", "projects"),
    claudeHistory: join(root, "claude", "history.jsonl"),
    claudeSettings: join(root, "claude", "settings.json"),
    usageSnapshot: join(root, "claude", "usage-snapshot.json"),
    usageCache: join(root, "open-usage", "usage-cache.json"),
    claudeConfig: join(root, "claude.json"),
    spendHistory: join(root, "open-usage", "spend-history.json"),
    pricingOverrides: join(root, "open-usage", "pricing.json"),
    codexHome: join(root, "codex"),
  };
}

function withRoot(run: (paths: RealProviderPaths, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "open-usage-cookie-"));
  try {
    mkdirSync(join(root, "open-usage"), { recursive: true });
    mkdirSync(join(root, "opencode"), { recursive: true });
    run(pathsIn(root), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeCookieConfig(paths: RealProviderPaths, cookie: string): void {
  writeFileSync(paths.configFile, JSON.stringify({ opencodeCookie: cookie }));
}

function writeEmptyUsageDb(path: string): void {
  const db = new Database(path);
  db.run("CREATE TABLE message (session_id TEXT, time_created INTEGER, data TEXT)");
  db.close();
}

function goConnectionFor(paths: RealProviderPaths, env: Record<string, string | undefined>) {
  return createRealUsageProvider({ paths, env, ...OFFLINE }).initialConnections().go;
}

describe("opencode remote credentials as a go source", () => {
  test("detects an API key and counts it as a real source", () => {
    withRoot((paths) => {
      expect(hasOpencodeApiKey(paths, NO_ENV)).toBe(false);
      writeFileSync(paths.configFile, JSON.stringify({ opencodeApiKey: "go_key" }));
      expect(hasOpencodeApiKey(paths, NO_ENV)).toBe(true);
      expect(hasRealSources(paths, NO_ENV)).toBe(true);
    });

    withRoot((paths) => {
      expect(hasOpencodeApiKey(paths, { OPEN_USAGE_OPENCODE_API_KEY: "go_env" })).toBe(true);
      // opencode's own variable must not opt a user into a network call.
      expect(hasOpencodeApiKey(paths, { OPENCODE_API_KEY: "go_env" })).toBe(false);
    });
  });
  test("detects a cookie from the config file and from the environment", () => {
    withRoot((paths) => {
      expect(hasOpencodeCookie(paths, NO_ENV)).toBe(false);

      writeCookieConfig(paths, COOKIE);
      expect(hasOpencodeCookie(paths, NO_ENV)).toBe(true);
    });

    withRoot((paths) => {
      expect(hasOpencodeCookie(paths, { OPEN_USAGE_OPENCODE_COOKIE: COOKIE })).toBe(true);
    });
  });

  test("ignores a blank cookie", () => {
    withRoot((paths) => {
      writeCookieConfig(paths, "   ");
      expect(hasOpencodeCookie(paths, NO_ENV)).toBe(false);
    });
  });

  test("a cookie alone counts as a real source with no agent installed", () => {
    withRoot((paths) => {
      expect(hasRealSources(paths, NO_ENV)).toBe(false);

      writeCookieConfig(paths, COOKIE);
      expect(hasRealSources(paths, NO_ENV)).toBe(true);
    });
  });

  test("shows go with the cookie credential when opencode is uninstalled", () => {
    withRoot((paths) => {
      writeCookieConfig(paths, COOKIE);

      expect(goConnectionFor(paths, NO_ENV)).toEqual({
        isEnabled: true,
        isAgentInstalled: false,
        status: "none",
        credential: "cookie · opencode.ai",
        note: "cookie ready",
      });
    });
  });

  test("keeps the local note when a cookie joins an opencode install", () => {
    withRoot((paths) => {
      writeEmptyUsageDb(paths.opencodeDb);
      writeCookieConfig(paths, COOKIE);

      expect(goConnectionFor(paths, NO_ENV)).toMatchObject({
        isEnabled: true,
        isAgentInstalled: true,
        status: "local",
        note: "local estimate",
      });
    });
  });

  test("leaves the cookie-less install untouched", () => {
    withRoot((paths) => {
      writeEmptyUsageDb(paths.opencodeDb);

      expect(goConnectionFor(paths, NO_ENV)).toMatchObject({
        isEnabled: true,
        isAgentInstalled: true,
        status: "local",
        credential: "local · opencode.db",
        note: "local estimate",
      });
    });
  });

  // The cookie is meant to be sufficient on its own: no opencode, no local
  // database, every figure fetched from the dashboard.
  test("serves exact limits from the website with opencode uninstalled", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-usage-cookie-"));
    try {
      mkdirSync(join(root, "open-usage"), { recursive: true });
      const paths = pathsIn(root);
      writeCookieConfig(paths, COOKIE);
      const now = new Date();
      const goLimits = createGoLimitsSource(paths.configFile, NO_ENV, (_cookie, at) =>
        Promise.resolve({
          rollingPercent: 17,
          rollingResetAtMs: at.getTime() + 3_600_000,
          weeklyPercent: 42,
          weeklyResetAtMs: at.getTime() + 86_400_000,
          monthlyPercent: 55,
          monthlyResetAtMs: at.getTime() + 5 * 86_400_000,
          fetchedAtMs: at.getTime(),
          source: "dashboard" as const,
        }));
      await goLimits.poll(now);

      const provider = createRealUsageProvider({ paths, env: NO_ENV, ...OFFLINE, goLimits });

      expect(provider.initialConnections().go).toMatchObject({
        isEnabled: true,
        isAgentInstalled: false,
        status: "active",
        credential: "cookie · opencode.ai",
      });

      const go = provider.readSnapshot().providers.go;
      expect(go.meta.source).toBe("opencode.ai dashboard");
      expect(go.meta.plan).toBe("Go");
      expect(go.limits.map((limit) => limit.percent)).toEqual([17, 42, 55]);
      // No opencode.db means no token chart, and the card has to say so.
      expect(go.detailFooter).toBe("no local history ▏ limits from dashboard");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("still reports go as missing with neither a cookie nor an install", () => {
    withRoot((paths) => {
      expect(goConnectionFor(paths, NO_ENV)).toEqual({
        isEnabled: false,
        isAgentInstalled: false,
        status: "none",
        credential: "",
        note: "opencode not found",
      });
    });
  });
});
