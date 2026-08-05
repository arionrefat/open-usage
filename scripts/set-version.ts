#!/usr/bin/env bun
/**
 * Sets the release version. The platform packages inherit it at publish time,
 * so this is the only place a version is written by hand.
 *
 *   bun scripts/set-version.ts 0.4.0
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: bun scripts/set-version.ts <semver>");
  process.exit(1);
}

const manifestPath = resolve("package.json");
const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));

if (typeof manifest !== "object" || manifest === null) {
  throw new Error("package.json is not an object");
}

const draft: Record<string, unknown> = { ...manifest };
draft.version = version;

writeFileSync(manifestPath, `${JSON.stringify(draft, null, 2)}\n`);
console.log(`version set to ${version}`);
