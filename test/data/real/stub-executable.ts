import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createStubExecutable(body: string): {
  executable: string;
  root: string;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "open-usage-cli-stub-"));
  const executable = join(root, "vendor-stub");
  writeFileSync(executable, `#!/bin/sh\n${body}\n`);
  chmodSync(executable, 0o700);
  return {
    executable,
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function stubEnvironment(
  values: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return { PATH: "/usr/bin:/bin", ...values };
}
