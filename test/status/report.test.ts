import { describe, expect, test } from "bun:test";
import { mockUsageProvider } from "../../src/data/mock-provider";
import { PROVIDER_IDS, type ProviderConnection, type ProviderId, type UsageSnapshot } from "../../src/data/types";
import { STATUS_SCHEMA_VERSION, buildStatusReport, formatStatusJson } from "../../src/status/report";

const NOW = new Date(2026, 0, 15, 12);
const NOW_MS = NOW.getTime();
const HOUR_MS = 3_600_000;

function snapshot(): UsageSnapshot {
  const base = structuredClone(mockUsageProvider.readSnapshot());
  base.providers.cl.limits = [
    { id: "session", label: "current session", percent: 40, reset: "resets in 1h", resetsAtMs: NOW_MS + HOUR_MS, windowMinutes: 300 },
    { id: "extra", label: "extra", percent: null, reset: "no cap", valueLabel: "n/a" },
  ];
  base.providers.cl.limitsFetchedAtMs = NOW_MS - 60_000;
  return base;
}

function connections(overrides: Partial<Record<ProviderId, Partial<ProviderConnection>>> = {}) {
  const base = mockUsageProvider.initialConnections();
  for (const id of PROVIDER_IDS) base[id] = { ...base[id], ...overrides[id] };
  return base;
}

describe("buildStatusReport", () => {
  test("names the schema and stamps the time of the report", () => {
    const report = buildStatusReport(snapshot(), connections(), NOW, false);

    expect(report.schemaVersion).toBe(STATUS_SCHEMA_VERSION);
    expect(report.generatedAt).toBe(NOW.toISOString());
    expect(report.isSampleData).toBe(false);
  });

  test("uses the public provider names the --view flag takes", () => {
    const report = buildStatusReport(snapshot(), connections(), NOW, false);

    expect(report.providers.map((provider) => provider.id)).toEqual(["claude", "codex", "go"]);
  });

  test("reports used and remaining percent, the window, and an ISO reset time", () => {
    const [claude] = buildStatusReport(snapshot(), connections(), NOW, false).providers;

    expect(claude?.updatedAt).toBe(new Date(NOW_MS - 60_000).toISOString());
    expect(claude?.limits[0]).toEqual({
      id: "session",
      label: "current session",
      usedPercent: 40,
      remainingPercent: 60,
      windowMinutes: 300,
      resetsAt: new Date(NOW_MS + HOUR_MS).toISOString(),
      hasResetSinceRead: false,
      reset: "resets in 1h",
    });
  });

  test("leaves a line with no cap as null rather than as zero", () => {
    const [claude] = buildStatusReport(snapshot(), connections(), NOW, false).providers;

    expect(claude?.limits[1]).toMatchObject({
      usedPercent: null,
      remainingPercent: null,
      windowMinutes: null,
      resetsAt: null,
      hasResetSinceRead: false,
    });
  });

  test("flags a reading whose window has reset since it was taken", () => {
    const later = new Date(NOW_MS + 2 * HOUR_MS);
    const [claude] = buildStatusReport(snapshot(), connections(), later, false).providers;

    expect(claude?.limits[0]?.hasResetSinceRead).toBe(true);
    expect(claude?.limits[0]?.usedPercent).toBe(40);
  });

  test("never reports more than 100 percent remaining or less than none", () => {
    const capped = snapshot();
    capped.providers.cl.limits = [{ id: "session", label: "session", percent: 104, reset: "resets in 1h" }];
    const [claude] = buildStatusReport(capped, connections(), NOW, false).providers;

    expect(claude?.limits[0]?.remainingPercent).toBe(0);
  });

  test("leaves out card-only lines, which repeat others", () => {
    const codex = buildStatusReport(snapshot(), connections(), NOW, false).providers[1];

    expect(codex?.limits.map((limit) => limit.id)).toEqual(["weekly", "credits"]);
  });

  test("shows only the providers the dashboard shows", () => {
    const report = buildStatusReport(
      snapshot(),
      connections({ cx: { isAvailable: false }, go: { isEnabled: false } }),
      NOW,
      false,
    );

    expect(report.providers.map((provider) => provider.id)).toEqual(["claude"]);
  });

  test("lists a failed provider as an error and still returns its cached figures", () => {
    const report = buildStatusReport(snapshot(), connections({ cx: { status: "expired", note: "token expired" } }), NOW, false);

    expect(report.errors).toEqual([{ provider: "codex", message: "token expired" }]);
    expect(report.providers.find((provider) => provider.id === "codex")?.limits).not.toHaveLength(0);
  });

  test("reports no error for a provider that is merely not connected", () => {
    const report = buildStatusReport(
      snapshot(),
      connections({ cl: { status: "none" }, cx: { status: "cached" }, go: { status: "local" } }),
      NOW,
      false,
    );

    expect(report.errors).toEqual([]);
  });

  test("states the provider's own refusal of usage", () => {
    const blocked = snapshot();
    blocked.providers.cx.usageBlock = { isBlocked: true, reason: "spend control reached" };
    blocked.providers.go.usageBlock = { isBlocked: false };
    const report = buildStatusReport(blocked, connections(), NOW, false);

    expect(report.providers.map((provider) => provider.blockedReason)).toEqual([null, "spend control reached", null]);
  });
});

describe("formatStatusJson", () => {
  test("prints one line by default and indents on request", () => {
    const report = buildStatusReport(snapshot(), connections(), NOW, false);

    expect(formatStatusJson(report, false)).not.toContain("\n");
    expect(formatStatusJson(report, true)).toContain('\n  "schemaVersion"');
    expect(JSON.parse(formatStatusJson(report, true))).toEqual(JSON.parse(formatStatusJson(report, false)));
  });
});
