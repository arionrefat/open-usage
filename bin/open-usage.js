#!/usr/bin/env node
// Resolves the compiled binary published for this platform and hands off to it.
// The binary embeds Bun, so nothing needs to be installed alongside it.
// Deliberately dependency-free and syntax-conservative so it runs on any Node.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PLATFORM_PACKAGES = {
  "darwin-arm64": "@open-usage/darwin-arm64",
  "linux-arm64": "@open-usage/linux-arm64",
  "linux-x64": "@open-usage/linux-x64",
  "win32-arm64": "@open-usage/win32-arm64",
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

export function launch(binary = resolvePlatformBinary(), args = process.argv.slice(2)) {
  const child = spawn(binary, args, { stdio: "inherit" });
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
  const handlers = new Map();

  function cleanup() {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }

  for (const signal of signals) {
    const handler = () => {
      try {
        child.kill(signal);
      } catch {
        // The child may already be exiting; its exit event remains authoritative.
      }
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  child.once("error", (error) => {
    cleanup();
    fail("failed to start the platform binary", error.message);
  });
  child.once("exit", (code, signal) => {
    cleanup();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) launch();
