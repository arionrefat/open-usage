import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  REPO_LICENSE_PATH,
  REPO_MANIFEST_PATH as BUILD_MANIFEST_PATH,
} from "../scripts/build-npm-packages";
import {
  REPO_MANIFEST_PATH as PREPUBLISH_MANIFEST_PATH,
  prepublishProblem,
} from "../scripts/check-prepublish";
import { isSemVer, writeJsonAtomically } from "../scripts/release-utils";
import { REPO_MANIFEST_PATH as VERSION_MANIFEST_PATH } from "../scripts/set-version";

describe("release scripts", () => {
  test("resolve repository inputs from their own directory", () => {
    const root = resolve(import.meta.dir, "..");
    expect(VERSION_MANIFEST_PATH).toBe(join(root, "package.json"));
    expect(BUILD_MANIFEST_PATH).toBe(join(root, "package.json"));
    expect(PREPUBLISH_MANIFEST_PATH).toBe(join(root, "package.json"));
    expect(REPO_LICENSE_PATH).toBe(join(root, "LICENSE"));
  });

  test("run from another cwd without reading or writing that directory's manifest or license", () => {
    const project = mkdtempSync(join(tmpdir(), "open-usage-release-project-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "open-usage-release-cwd-"));
    const scripts = join(project, "scripts");
    const binaries = join(project, "binaries");
    const out = join(project, "npm");
    mkdirSync(scripts);
    mkdirSync(binaries);
    for (const file of [
      "set-version.ts",
      "build-npm-packages.ts",
      "check-prepublish.ts",
      "release-utils.ts",
    ]) {
      copyFileSync(resolve(import.meta.dir, "..", "scripts", file), join(scripts, file));
    }
    writeFileSync(join(project, "package.json"), JSON.stringify({
      name: "fixture",
      version: "0.0.1",
      license: "GPL-3.0-only",
      repository: "fixture/repo",
      homepage: "https://example.test",
    }));
    writeFileSync(join(project, "LICENSE"), "project license\n");
    writeFileSync(join(elsewhere, "package.json"), '{"version":"leave-me"}\n');
    writeFileSync(join(elsewhere, "LICENSE"), "wrong license\n");
    for (const target of ["darwin-arm64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]) {
      writeFileSync(
        join(binaries, `open-usage-${target}${target.startsWith("win32") ? ".exe" : ""}`),
        "binary",
      );
    }

    const unsafePublish = Bun.spawnSync({
      cmd: [process.execPath, join(scripts, "check-prepublish.ts")],
      cwd: elsewhere,
      stderr: "pipe",
    });
    expect(unsafePublish.exitCode).toBe(1);
    expect(unsafePublish.stderr.toString()).toContain(
      "Refusing to publish launcher-only open-usage package",
    );

    const setResult = Bun.spawnSync({
      cmd: [process.execPath, join(scripts, "set-version.ts"), "1.2.3-rc.1+build.5"],
      cwd: elsewhere,
      stderr: "pipe",
    });
    expect(setResult.exitCode).toBe(0);
    const buildResult = Bun.spawnSync({
      cmd: [
        process.execPath,
        join(scripts, "build-npm-packages.ts"),
        "--binaries",
        binaries,
        "--out",
        out,
      ],
      cwd: elsewhere,
      stderr: "pipe",
    });
    expect(buildResult.exitCode).toBe(0);
    const preparedPublish = Bun.spawnSync({
      cmd: [process.execPath, join(scripts, "check-prepublish.ts")],
      cwd: elsewhere,
      stderr: "pipe",
    });
    expect(preparedPublish.exitCode).toBe(0);

    const projectManifest = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
    expect(projectManifest.version).toBe("1.2.3-rc.1+build.5");
    expect(Object.keys(projectManifest.optionalDependencies)).toHaveLength(5);
    expect(readFileSync(join(out, "linux-x64", "LICENSE"), "utf8")).toBe("project license\n");
    expect(JSON.parse(readFileSync(join(elsewhere, "package.json"), "utf8"))).toEqual({
      version: "leave-me",
    });
  });

  test("requires exactly the supported platform pins at the root version", () => {
    const prepared = {
      version: "1.2.3",
      optionalDependencies: {
        "@open-usage/darwin-arm64": "1.2.3",
        "@open-usage/linux-arm64": "1.2.3",
        "@open-usage/linux-x64": "1.2.3",
        "@open-usage/win32-arm64": "1.2.3",
        "@open-usage/win32-x64": "1.2.3",
      },
    };

    expect(prepublishProblem(prepared)).toBeNull();
    expect(prepublishProblem({ version: "1.2.3" })).toContain("platform packages");
    expect(
      prepublishProblem({
        ...prepared,
        optionalDependencies: {
          ...prepared.optionalDependencies,
          "@open-usage/linux-x64": "1.2.2",
        },
      }),
    ).toContain("root package version");
    expect(
      prepublishProblem({
        ...prepared,
        optionalDependencies: {
          ...prepared.optionalDependencies,
          "@open-usage/darwin-x64": "1.2.3",
        },
      }),
    ).toContain("platform packages");
  });

  test("validates the full SemVer 2.0.0 grammar", () => {
    for (const version of ["0.0.0", "1.2.3", "1.2.3-alpha.1", "1.2.3+build.5", "1.2.3-rc.1+sha-abc"]) {
      expect(isSemVer(version)).toBe(true);
    }
    for (const version of ["01.2.3", "1.02.3", "1.2", "1.2.3-01", "1.2.3-", "v1.2.3", "1.2.3+"]) {
      expect(isSemVer(version)).toBe(false);
    }
  });

  test("atomically replaces JSON and cleans up its same-directory temporary", () => {
    const dir = mkdtempSync(join(tmpdir(), "open-usage-release-"));
    const path = join(dir, "package.json");
    writeFileSync(path, '{"version":"old"}\n');

    writeJsonAtomically(path, { version: "1.2.3" });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: "1.2.3" });
    expect(readdirSync(dir)).toEqual(["package.json"]);
  });
});

describe("preview dimensions", () => {
  test.each([
    ["preview", ["scripts/preview.tsx", "--width=0"]],
    ["preview", ["scripts/preview.tsx", "--height", "NaN"]],
    ["shot", ["scripts/shot.tsx", join(tmpdir(), "invalid-shot.html"), "bad:--height=1.5"]],
    ["shot", ["scripts/shot.tsx", join(tmpdir(), "missing-shot.html"), "bad:--width"]],
  ])("%s exits with a usage error for invalid dimensions", (_name, args) => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, ...args],
      cwd: resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("usage:");
  });
});
