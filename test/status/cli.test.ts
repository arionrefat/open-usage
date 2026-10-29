import { describe, expect, mock, test } from "bun:test";
import { mockUsageProvider } from "../../src/data/mock-provider";
import type { UsageProvider } from "../../src/data/types";
import { readFlags, type ProviderMode } from "../../src/lib/args";
import { STATUS_EXIT_NO_SOURCES, runStatusCommand, wantsStatusOutput } from "../../src/status/cli";

const NOW = new Date(2026, 0, 15, 12);

/** The mock's figures, presented as a real machine's. */
const REAL_PROVIDER: UsageProvider = { ...mockUsageProvider, isSampleData: false };

describe("wantsStatusOutput", () => {
  test("is switched on by --json alone", () => {
    expect(wantsStatusOutput(readFlags(["--json"]))).toBe(true);
    expect(wantsStatusOutput(readFlags(["--json=false"]))).toBe(false);
    expect(wantsStatusOutput(readFlags(["--pretty"]))).toBe(false);
  });
});

describe("runStatusCommand", () => {
  test("prints the report as one line of JSON", () => {
    const result = runStatusCommand(readFlags(["--json"]), () => REAL_PROVIDER, NOW);

    expect(result.exitCode).toBe(0);
    expect(result.message).not.toContain("\n");
    expect(JSON.parse(result.message)).toMatchObject({ generatedAt: NOW.toISOString(), isSampleData: false });
  });

  test("indents with --pretty", () => {
    const result = runStatusCommand(readFlags(["--json", "--pretty"]), () => REAL_PROVIDER, NOW);

    expect(result.message).toContain('\n  "providers"');
  });

  test("reads the real sources unless --mock is passed", () => {
    const modes: ProviderMode[] = [];
    const select = (mode: ProviderMode) => {
      modes.push(mode);
      return REAL_PROVIDER;
    };
    runStatusCommand(readFlags(["--json"]), select, NOW);
    runStatusCommand(readFlags(["--json", "--mock"]), select, NOW);

    expect(modes).toEqual(["real", "mock"]);
  });

  test("never polls, so a statusline can run it as often as it likes", () => {
    const refresh = mock(REAL_PROVIDER.refresh);
    runStatusCommand(readFlags(["--json"]), () => ({ ...REAL_PROVIDER, refresh }), NOW);

    expect(refresh).not.toHaveBeenCalled();
  });

  test("refuses to pass sample figures off as real when nothing is found", () => {
    const result = runStatusCommand(readFlags(["--json"]), () => mockUsageProvider, NOW);

    expect(result.exitCode).toBe(STATUS_EXIT_NO_SOURCES);
    expect(result.message).toContain("no usage sources found");
  });

  test("labels sample figures when they were asked for", () => {
    const result = runStatusCommand(readFlags(["--json", "--mock"]), () => mockUsageProvider, NOW);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.message)).toMatchObject({ isSampleData: true });
  });
});
