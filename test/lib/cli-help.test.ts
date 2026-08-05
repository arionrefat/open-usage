import { describe, expect, test } from "bun:test";
import { APP_NAME, APP_VERSION } from "../../src/config";
import { helpText, versionText, wantsHelp, wantsVersion } from "../../src/lib/cli-help";

describe("wantsHelp", () => {
  test("matches both spellings", () => {
    expect(wantsHelp(["--help"])).toBe(true);
    expect(wantsHelp(["-h"])).toBe(true);
    expect(wantsHelp(["--view", "claude"])).toBe(false);
  });
});

describe("wantsVersion", () => {
  test("matches both spellings", () => {
    expect(wantsVersion(["--version"])).toBe(true);
    expect(wantsVersion(["-v"])).toBe(true);
    expect(wantsVersion(["--mock"])).toBe(false);
  });
});

test("versionText reports the package version", () => {
  expect(versionText()).toBe(`${APP_NAME} ${APP_VERSION}`);
});

describe("helpText", () => {
  test("documents every flag the parser understands", () => {
    const text = helpText();
    for (const flag of [
      "--view",
      "--mode",
      "--screen",
      "--severity-colors",
      "--no-daily-split",
      "--no-poll",
      "--mock",
      "--help",
      "--version",
    ]) {
      expect(text).toContain(flag);
    }
  });

  test("fits a standard 80-column terminal", () => {
    for (const line of helpText().split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });
});
