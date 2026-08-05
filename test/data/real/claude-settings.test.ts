import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasStatuslineConfigured } from "../../../src/data/real/claude-settings";

function settingsFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "open-usage-settings-"));
  const path = join(dir, "settings.json");
  writeFileSync(path, contents);
  return path;
}

describe("hasStatuslineConfigured", () => {
  test("accepts a statusline with a command", () => {
    const path = settingsFile(
      JSON.stringify({ statusLine: { type: "command", command: "~/.claude/line.sh" } }),
    );
    expect(hasStatuslineConfigured(path)).toBe(true);
  });

  test("rejects a statusline that would never write a snapshot", () => {
    expect(hasStatuslineConfigured(settingsFile(JSON.stringify({})))).toBe(false);
    expect(hasStatuslineConfigured(settingsFile(JSON.stringify({ statusLine: {} })))).toBe(false);
    // A blank command is configured in name only.
    expect(
      hasStatuslineConfigured(settingsFile(JSON.stringify({ statusLine: { command: "  " } }))),
    ).toBe(false);
  });

  test("treats a missing or malformed file as unconfigured", () => {
    expect(hasStatuslineConfigured("/nonexistent/settings.json")).toBe(false);
    expect(hasStatuslineConfigured(settingsFile("{ not json"))).toBe(false);
  });
});
