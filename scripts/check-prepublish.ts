#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TARGETS } from "./build-npm-packages";

export const REPO_MANIFEST_PATH = resolve(import.meta.dir, "..", "package.json");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function prepublishProblem(manifest: unknown): string | null {
  if (!isRecord(manifest) || typeof manifest.version !== "string") {
    return "package.json must contain a version";
  }

  const expected = Object.fromEntries(
    TARGETS.map((target) => [`@open-usage/${target.slug}`, manifest.version]),
  );
  const actual = manifest.optionalDependencies;
  if (
    isRecord(actual) &&
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([name, version]) => actual[name] === version)
  ) {
    return null;
  }

  return (
    "platform packages are not pinned at the root package version; " +
    "run `bun run build:npm --binaries dist --out dist/npm` before publishing"
  );
}

export function checkPrepublish(manifestPath = REPO_MANIFEST_PATH): void {
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  const problem = prepublishProblem(manifest);
  if (!problem) return;

  console.error(`Refusing to publish launcher-only open-usage package: ${problem}.`);
  process.exitCode = 1;
}

if (import.meta.main) checkPrepublish();
