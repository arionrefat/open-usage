#!/usr/bin/env bun
/**
 * Assembles the per-platform npm packages that `open-usage` depends on
 * optionally. Each wraps one binary built by the release workflow.
 *
 *   bun scripts/build-npm-packages.ts --binaries dist --out dist/npm
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pkg from "../package.json";

interface PlatformTarget {
  /** npm package name suffix, also the artifact suffix produced by CI. */
  slug: string;
  os: string;
  cpu: string;
}

const TARGETS: PlatformTarget[] = [
  { slug: "darwin-arm64", os: "darwin", cpu: "arm64" },
  { slug: "darwin-x64", os: "darwin", cpu: "x64" },
  { slug: "linux-arm64", os: "linux", cpu: "arm64" },
  { slug: "linux-x64", os: "linux", cpu: "x64" },
  { slug: "win32-x64", os: "win32", cpu: "x64" },
];

function flagValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const binariesDir = resolve(flagValue("binaries", "dist"));
const outDir = resolve(flagValue("out", "dist/npm"));

function buildPackage(target: PlatformTarget): string {
  const isWindows = target.os === "win32";
  const executable = isWindows ? "open-usage.exe" : "open-usage";
  const artifact = join(binariesDir, `open-usage-${target.slug}${isWindows ? ".exe" : ""}`);

  if (!existsSync(artifact)) {
    throw new Error(`missing binary for ${target.slug}: ${artifact}`);
  }

  const packageDir = join(outDir, target.slug);
  const packageBinDir = join(packageDir, "bin");
  mkdirSync(packageBinDir, { recursive: true });

  const destination = join(packageBinDir, executable);
  copyFileSync(artifact, destination);
  if (!isWindows) chmodSync(destination, 0o755);

  // No "exports" field on purpose: the launcher resolves the binary by subpath.
  const manifest = {
    name: `@open-usage/${target.slug}`,
    version: pkg.version,
    description: `${target.slug} binary for open-usage`,
    license: pkg.license,
    repository: pkg.repository,
    homepage: pkg.homepage,
    os: [target.os],
    cpu: [target.cpu],
    files: ["bin"],
    // Keeps Yarn PnP from zipping the executable, which would break exec.
    preferUnplugged: true,
    publishConfig: { access: "public" },
  };

  writeFileSync(join(packageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(packageDir, "README.md"),
    `# @open-usage/${target.slug}\n\n` +
      `The ${target.slug} binary for [open-usage](${pkg.homepage}).\n\n` +
      `Installed automatically as an optional dependency of \`open-usage\`.\n` +
      `You do not need to depend on this package directly.\n`,
  );
  copyFileSync(resolve("LICENSE"), join(packageDir, "LICENSE"));

  return packageDir;
}

/**
 * The platform packages are pinned into the root manifest here rather than
 * committed, because they do not exist in the registry until this release
 * publishes them - a committed pin would break `install --frozen-lockfile`.
 */
function pinPlatformPackagesIntoRoot(): void {
  const manifestPath = resolve("package.json");
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof manifest !== "object" || manifest === null) {
    throw new Error("package.json is not an object");
  }

  const draft: Record<string, unknown> = { ...manifest };
  draft.optionalDependencies = Object.fromEntries(
    TARGETS.map((target) => [`@open-usage/${target.slug}`, pkg.version]),
  );

  writeFileSync(manifestPath, `${JSON.stringify(draft, null, 2)}\n`);
}

const built = TARGETS.map(buildPackage);
pinPlatformPackagesIntoRoot();

console.log(`built ${built.length} platform packages at v${pkg.version}:`);
for (const dir of built) console.log(`  ${dir}`);
console.log(`pinned @open-usage/* ${pkg.version} into package.json`);
