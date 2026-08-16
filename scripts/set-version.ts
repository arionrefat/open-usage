#!/usr/bin/env bun
/**
 * Sets the release version. The platform packages inherit it at publish time,
 * so this is the only place a version is written by hand.
 *
 *   bun scripts/set-version.ts 0.4.0
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isSemVer, writeJsonAtomically } from "./release-utils";

export const REPO_MANIFEST_PATH = resolve(import.meta.dir, "..", "package.json");

export function setVersion(version: string | undefined): void {
  if (!version || !isSemVer(version)) {
    console.error("usage: bun scripts/set-version.ts <semver>");
    process.exit(1);
  }

  const manifest: unknown = JSON.parse(readFileSync(REPO_MANIFEST_PATH, "utf8"));

  if (typeof manifest !== "object" || manifest === null) {
    throw new Error("package.json is not an object");
  }

  const draft: Record<string, unknown> = { ...manifest };
  draft.version = version;

  writeJsonAtomically(REPO_MANIFEST_PATH, draft);
  console.log(`version set to ${version}`);
}

if (import.meta.main) setVersion(process.argv[2]);
