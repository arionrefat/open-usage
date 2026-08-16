import { renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// SemVer 2.0.0: numeric identifiers cannot have leading zeroes, prerelease
// numeric identifiers follow the same rule, and build metadata is supported.
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isSemVer(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}

/** Replaces a JSON file without exposing readers to a partially-written draft. */
export function writeJsonAtomically(path: string, value: unknown): void {
  const temporary = join(
    dirname(path),
    `.${process.pid}.${crypto.randomUUID()}.${path.split(/[\\/]/).at(-1) ?? "package.json"}.tmp`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
