import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { abbreviateHome, APP_NAME, configDir, configPath } from "../src/config";

const originalXdg = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
});

describe("configDir", () => {
  test("defaults to ~/.config under the app name", () => {
    delete process.env.XDG_CONFIG_HOME;

    expect(configDir()).toBe(join(homedir(), ".config", APP_NAME));
  });

  test("honors XDG_CONFIG_HOME", () => {
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-root";

    expect(configDir()).toBe(join("/tmp/xdg-root", APP_NAME));
  });

  test("ignores a blank XDG_CONFIG_HOME", () => {
    process.env.XDG_CONFIG_HOME = "   ";

    expect(configDir()).toBe(join(homedir(), ".config", APP_NAME));
  });
});

test("configPath joins onto the config directory", () => {
  delete process.env.XDG_CONFIG_HOME;

  expect(configPath("preferences.json")).toBe(
    join(homedir(), ".config", APP_NAME, "preferences.json"),
  );
});

describe("abbreviateHome", () => {
  test("shortens paths inside the home directory", () => {
    expect(abbreviateHome(join(homedir(), ".config", "x"))).toBe("~/.config/x");
  });

  test("leaves outside paths alone", () => {
    expect(abbreviateHome("/etc/hosts")).toBe("/etc/hosts");
  });

  test("does not shorten a sibling directory that merely shares the prefix", () => {
    expect(abbreviateHome(`${homedir()}-backup/notes`)).toBe(`${homedir()}-backup/notes`);
  });
});
