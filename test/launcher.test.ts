import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LAUNCHER_URL = pathToFileURL(resolve(import.meta.dir, "..", "bin", "open-usage.js")).href;
const NODE = Bun.which("node") ?? "node";

function wrapperProgram(childPath: string): string {
  return `import(${JSON.stringify(LAUNCHER_URL)}).then(({ launch }) => launch(process.execPath, [${JSON.stringify(childPath)}]));`;
}

test("the Node launcher propagates the child's exit code", () => {
  const dir = mkdtempSync(join(tmpdir(), "open-usage-launcher-"));
  const childPath = join(dir, "child.mjs");
  writeFileSync(childPath, "process.exit(23);\n");

  const result = Bun.spawnSync({
    cmd: [NODE, "--input-type=module", "-e", wrapperProgram(childPath)],
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(23);
});

test.each(["SIGTERM", "SIGINT", "SIGHUP"] as const)("the Node launcher forwards %s to the child", async (signal) => {
  const dir = mkdtempSync(join(tmpdir(), "open-usage-launcher-signal-"));
  const childPath = join(dir, "child.mjs");
  const readyPath = join(dir, "ready");
  const signalPath = join(dir, "signal");
  writeFileSync(
    childPath,
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(readyPath)}, "ready");\n` +
      `process.on(${JSON.stringify(signal)}, () => { writeFileSync(${JSON.stringify(signalPath)}, ${JSON.stringify(signal)}); process.exit(42); });\n` +
      `setInterval(() => {}, 1000);\n`,
  );

  const wrapper = Bun.spawn({
    cmd: [NODE, "--input-type=module", "-e", wrapperProgram(childPath)],
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(readyPath) && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(existsSync(readyPath)).toBe(true);

    wrapper.kill(signal);
    const exitCode = await Promise.race([
      wrapper.exited,
      Bun.sleep(5_000).then(() => -1),
    ]);
    expect(exitCode).toBe(42);
    expect(existsSync(signalPath)).toBe(true);
  } finally {
    if (!wrapper.killed) wrapper.kill("SIGKILL");
  }
});
