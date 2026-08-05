import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../../src/lib/file-lock";

test("serializes updates across processes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "open-usage-lock-"));
  const target = join(directory, "counter.txt");
  const lockModule = new URL("../../src/lib/file-lock.ts", import.meta.url).href;
  writeFileSync(target, "0");

  const workerSource = `
    import { readFileSync, writeFileSync } from "node:fs";
    import { withFileLock } from ${JSON.stringify(lockModule)};
    const target = process.env.OPEN_USAGE_LOCK_TARGET;
    if (!target) throw new Error("missing lock target");
    withFileLock(target, () => {
      const value = Number(readFileSync(target, "utf8"));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      writeFileSync(target, String(value + 1));
    });
  `;

  try {
    const workers = Array.from({ length: 12 }, () =>
      Bun.spawn([process.execPath, "-e", workerSource], {
        env: { ...process.env, OPEN_USAGE_LOCK_TARGET: target },
        stdout: "ignore",
        stderr: "pipe",
      }),
    );
    const results = await Promise.all(
      workers.map(async (worker) => ({
        exitCode: await worker.exited,
        stderr: await new Response(worker.stderr).text(),
      })),
    );

    expect(results).toEqual(Array.from({ length: 12 }, () => ({ exitCode: 0, stderr: "" })));
    expect(readFileSync(target, "utf8")).toBe("12");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("releases the lock when an update throws", () => {
  const directory = mkdtempSync(join(tmpdir(), "open-usage-lock-"));
  const target = join(directory, "preferences.json");
  try {
    expect(() =>
      withFileLock(target, () => {
        throw new Error("failed update");
      }),
    ).toThrow("failed update");
    expect(withFileLock(target, () => "updated")).toBe("updated");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
