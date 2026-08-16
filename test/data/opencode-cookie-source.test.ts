import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubCodexLimitsSource } from "../../src/data/real/codex-limits";
import { dormantGoLimitsSource } from "../../src/data/real/go-limits-source";
import { dormantClaudeLimitsSource } from "../../src/data/real/claude-usage";
import { dormantClaudeAuthSource } from "../../src/data/real/claude-auth";
import {
  createRealUsageProvider,
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

function goConnectionFor(paths: RealProviderPaths, env: Record<string, string | undefined>) {
  return createRealUsageProvider({ paths, env, ...OFFLINE }).initialConnections().go;
}

describe("opencode cookie as a go source", () => {
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
        status: "active",
        credential: "cookie · opencode.ai",
        note: "exact limits via cookie; no local history",
      });
    });
  });

  test("keeps the local note when a cookie joins an opencode install", () => {
    withRoot((paths) => {
      writeFileSync(paths.opencodeDb, "");
      writeCookieConfig(paths, COOKIE);

      expect(goConnectionFor(paths, NO_ENV)).toMatchObject({
        isEnabled: true,
        isAgentInstalled: true,
        status: "active",
        note: "exact limits via dashboard cookie",
      });
    });
  });

  test("leaves the cookie-less install untouched", () => {
    withRoot((paths) => {
      writeFileSync(paths.opencodeDb, "");

      expect(goConnectionFor(paths, NO_ENV)).toMatchObject({
        isEnabled: true,
        isAgentInstalled: true,
        credential: "local · opencode.db",
        note: "local estimate; dashboard cookie is optional",
      });
    });
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
