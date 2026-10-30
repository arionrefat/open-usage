import { describe, expect, mock, test } from "bun:test";
import { mockUsageProvider } from "../../src/data/mock-provider";
import type { RefreshRequest, UsageProvider, UsageSnapshot } from "../../src/data/types";
import { readFlags, type ProviderMode } from "../../src/lib/args";
import { CHECK_EXIT_NEAR_LIMIT } from "../../src/status/check";
import { STATUS_EXIT_FAILURE, STATUS_EXIT_NO_SOURCES, runStatusCommand, wantsStatusOutput } from "../../src/status/cli";

const NOW = new Date(2026, 0, 15, 12);

/** The mock's figures, presented as a real machine's. */
const REAL_PROVIDER: UsageProvider = { ...mockUsageProvider, isSampleData: false };

function run(argv: string[], provider: UsageProvider = REAL_PROVIDER) {
  return runStatusCommand(readFlags(argv), {
    selectProvider: () => provider,
    now: () => NOW,
    readWarnThreshold: () => 85,
  });
}

describe("wantsStatusOutput", () => {
  test("is switched on by any output flag", () => {
    expect(wantsStatusOutput(readFlags(["--json"]))).toBe(true);
    expect(wantsStatusOutput(readFlags(["--oneline"]))).toBe(true);
    expect(wantsStatusOutput(readFlags(["--check"]))).toBe(true);
  });

  test("leaves the dashboard alone otherwise", () => {
    expect(wantsStatusOutput(readFlags(["--json=false"]))).toBe(false);
    expect(wantsStatusOutput(readFlags(["--pretty"]))).toBe(false);
    expect(wantsStatusOutput(readFlags(["--refresh"]))).toBe(false);
    expect(wantsStatusOutput(readFlags(["--color"]))).toBe(false);
  });
});

describe("runStatusCommand output", () => {
  test("prints the report as one line of JSON", async () => {
    const result = await run(["--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("\n");
    expect(JSON.parse(result.stdout)).toMatchObject({ generatedAt: NOW.toISOString(), isSampleData: false });
  });

  test("indents with --pretty", async () => {
    expect((await run(["--json", "--pretty"])).stdout).toContain('\n  "providers"');
  });

  test("prints one plain line with --oneline", async () => {
    const result = await run(["--oneline"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("claude 5h 21% wk 88%");
    expect(result.stdout).not.toContain("\n");
    expect(result.stdout).not.toContain("\x1b[");
  });

  test("colours the line only when asked", async () => {
    expect((await run(["--oneline", "--color"])).stdout).toContain("\x1b[");
  });

  test("refuses two formats at once", async () => {
    const result = await run(["--json", "--oneline"]);

    expect(result.exitCode).toBe(STATUS_EXIT_FAILURE);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("not both");
  });
});

describe("runStatusCommand sources", () => {
  test("reads the real sources unless --mock is passed", async () => {
    const modes: ProviderMode[] = [];
    const selectProvider = (mode: ProviderMode) => {
      modes.push(mode);
      return REAL_PROVIDER;
    };
    await runStatusCommand(readFlags(["--json"]), { selectProvider, now: () => NOW });
    await runStatusCommand(readFlags(["--json", "--mock"]), { selectProvider, now: () => NOW });

    expect(modes).toEqual(["real", "mock"]);
  });

  test("refuses to pass sample figures off as real when nothing is found", async () => {
    for (const flag of ["--json", "--oneline", "--check"]) {
      const result = await run([flag], mockUsageProvider);

      expect(result.exitCode).toBe(STATUS_EXIT_NO_SOURCES);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("no usage sources found");
    }
  });

  test("labels sample figures when they were asked for", async () => {
    expect(JSON.parse((await run(["--json", "--mock"], mockUsageProvider)).stdout)).toMatchObject({ isSampleData: true });
    expect((await run(["--oneline", "--mock"], mockUsageProvider)).stdout).toStartWith("(sample) ");
  });
});

describe("runStatusCommand --refresh", () => {
  function refreshing(snapshot: UsageSnapshot) {
    const refresh = mock((_request: RefreshRequest) => Promise.resolve(snapshot));
    return { refresh, provider: { ...REAL_PROVIDER, refresh } };
  }

  test("never polls without it, so a statusline can run as often as it likes", async () => {
    const { refresh, provider } = refreshing(REAL_PROVIDER.readSnapshot());
    await run(["--json"], provider);
    await run(["--oneline"], provider);
    await run(["--check"], provider);

    expect(refresh).not.toHaveBeenCalled();
  });

  test("polls as an automatic tick, which keeps every throttle", async () => {
    const { refresh, provider } = refreshing(REAL_PROVIDER.readSnapshot());
    await run(["--json", "--refresh"], provider);

    expect(refresh.mock.calls[0]?.[0]).toEqual({ reason: "interval", providerIds: ["cl", "cx", "go"] });
  });

  test("does not poll a provider the dashboard would not show", async () => {
    const { refresh, provider } = refreshing(REAL_PROVIDER.readSnapshot());
    const connections = REAL_PROVIDER.initialConnections();
    connections.cx.isEnabled = false;
    connections.go.isAvailable = false;
    await run(["--json", "--refresh"], { ...provider, initialConnections: () => connections });

    expect(refresh.mock.calls[0]?.[0].providerIds).toEqual(["cl"]);
  });

  test("prints what the refresh returned", async () => {
    const fresh = structuredClone(REAL_PROVIDER.readSnapshot());
    fresh.providers.cl.limits = [{ id: "session", label: "session", percent: 3, reset: "resets in 1h", windowMinutes: 300 }];
    const { provider } = refreshing(fresh);

    expect((await run(["--oneline", "--refresh"], provider)).stdout).toContain("claude 5h 3%");
  });

  test("reads connections after the poll, so a read that just failed is reported", async () => {
    const { provider } = refreshing(REAL_PROVIDER.readSnapshot());
    const healthy = { ...REAL_PROVIDER.initialConnections().cl, status: "active" as const };
    let isPolled = false;
    const result = await run(["--json", "--refresh"], {
      ...provider,
      refresh: () => {
        isPolled = true;
        return Promise.resolve(REAL_PROVIDER.readSnapshot());
      },
      initialConnections: () => ({
        ...REAL_PROVIDER.initialConnections(),
        cl: isPolled ? { ...healthy, status: "expired", note: "claude usage did not respond" } : healthy,
      }),
    });

    expect(JSON.parse(result.stdout).errors).toContainEqual({ provider: "claude", message: "claude usage did not respond" });
  });
});

describe("runStatusCommand --check", () => {
  test("alone prints nothing and answers through the exit code", async () => {
    const result = await run(["--check"]);

    expect(result.exitCode).toBe(CHECK_EXIT_NEAR_LIMIT);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("still prints the line it was asked for when the answer is not zero", async () => {
    const result = await run(["--oneline", "--check"]);

    expect(result.exitCode).toBe(CHECK_EXIT_NEAR_LIMIT);
    expect(result.stdout).toContain("claude");
  });

  test("leaves the exit code at zero without --check, whatever the limits say", async () => {
    expect((await run(["--oneline"])).exitCode).toBe(0);
  });

  test("uses the warning threshold from settings", async () => {
    const result = await runStatusCommand(readFlags(["--check"]), {
      selectProvider: () => REAL_PROVIDER,
      now: () => NOW,
      readWarnThreshold: () => 95,
    });

    expect(result.exitCode).toBe(0);
  });
});
