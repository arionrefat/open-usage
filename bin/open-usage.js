#!/usr/bin/env node
// Resolves the compiled binary published for this platform and hands off to it.
// The binary embeds Bun, so nothing needs to be installed alongside it.
// Deliberately dependency-free and syntax-conservative so it runs on any Node.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const PLATFORM_PACKAGES = {
  "darwin-arm64": "@open-usage/darwin-arm64",
  "darwin-x64": "@open-usage/darwin-x64",
  "linux-arm64": "@open-usage/linux-arm64",
  "linux-x64": "@open-usage/linux-x64",
  "win32-x64": "@open-usage/win32-x64",
};

function fail(...lines) {
  console.error(`open-usage: ${lines.join("\n")}`);
  process.exit(1);
}

function resolvePlatformBinary() {
  const target = `${process.platform}-${process.arch}`;
  const packageName = PLATFORM_PACKAGES[target];

  if (!packageName) {
    fail(
      `no prebuilt binary for ${target}.`,
      `Supported: ${Object.keys(PLATFORM_PACKAGES).join(", ")}`,
      `On other platforms, run from source with Bun:`,
      `  https://github.com/arionrefat/open-usage#development`,
    );
  }

  const executable = process.platform === "win32" ? "open-usage.exe" : "open-usage";
  try {
    return createRequire(import.meta.url).resolve(`${packageName}/bin/${executable}`);
  } catch {
    fail(
      `the ${packageName} package is missing.`,
      `This usually means the install ran with --no-optional or the optional`,
      `dependency failed to download. Reinstall with:`,
      `  bun install -g open-usage`,
    );
  }
}

const result = spawnSync(resolvePlatformBinary(), process.argv.slice(2), { stdio: "inherit" });

if (result.error) {
  fail("failed to start the platform binary", result.error.message);
}
// Mirror the child's termination so shells and CI see the real outcome.
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
