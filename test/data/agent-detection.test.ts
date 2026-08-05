import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRealUsageProvider,
  detectAgentInstallations,
  hasRealSources,
  type RealProviderPaths,
} from "../../src/data/real-provider";

function missingPaths(root: string): RealProviderPaths {
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

describe("coding agent detection", () => {
  test("uses executable paths even before an agent creates local data", () => {
    const paths = {
      ...missingPaths("/nonexistent/open-usage-agent-detection"),
      claudeExecutable: "/usr/local/bin/claude",
      codexExecutable: "/usr/local/bin/codex",
    };

    expect(detectAgentInstallations(paths)).toEqual({ cl: true, cx: true, go: false });
    expect(hasRealSources(paths)).toBe(true);
  });

  test("recognizes each agent from its local data", () => {
    const root = mkdtempSync(join(tmpdir(), "open-usage-agents-"));
    const paths = missingPaths(root);
    try {
      mkdirSync(paths.claudeProjects, { recursive: true });
      mkdirSync(paths.codexHome, { recursive: true });
      mkdirSync(join(root, "opencode"), { recursive: true });
      writeFileSync(paths.opencodeDb, "");

      expect(detectAgentInstallations(paths)).toEqual({ cl: true, cx: true, go: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("enables only detected agents in the initial connections", () => {
    const paths = {
      ...missingPaths("/nonexistent/open-usage-agent-connections"),
      codexExecutable: "/usr/local/bin/codex",
    };
    const connections = createRealUsageProvider({ paths }).initialConnections();

    expect(connections.cl).toMatchObject({ isEnabled: false, isAgentInstalled: false });
    expect(connections.cx).toMatchObject({ isEnabled: true, isAgentInstalled: true });
    expect(connections.go).toMatchObject({ isEnabled: false, isAgentInstalled: false });
  });
});
