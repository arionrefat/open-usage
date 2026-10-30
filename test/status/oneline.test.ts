import { describe, expect, test } from "bun:test";
import { mockUsageProvider } from "../../src/data/mock-provider";
import type { ProviderConnection, ProviderId, UsageLimit, UsageSnapshot } from "../../src/data/types";
import { PROVIDER_IDS } from "../../src/data/types";
import { formatOneLine } from "../../src/status/oneline";

const NOW = new Date(2026, 0, 15, 12);
const NOW_MS = NOW.getTime();
const HOUR_MS = 3_600_000;

function limit(id: string, percent: number | null, overrides: Partial<UsageLimit> = {}): UsageLimit {
  return { id, label: id, percent, reset: "resets soon", ...overrides };
}

const SESSION = limit("session", 27, { windowMinutes: 300, resetsAtMs: NOW_MS + HOUR_MS });
const WEEKLY = limit("weekly", 73, { windowMinutes: 10_080, resetsAtMs: NOW_MS + 24 * HOUR_MS });

function snapshot(limits: Partial<Record<ProviderId, UsageLimit[]>> = {}): UsageSnapshot {
  const base = structuredClone(mockUsageProvider.readSnapshot());
  for (const id of PROVIDER_IDS) base.providers[id].limits = limits[id] ?? [SESSION, WEEKLY];
  return base;
}

function connections(overrides: Partial<Record<ProviderId, Partial<ProviderConnection>>> = {}) {
  const base = mockUsageProvider.initialConnections();
  for (const id of PROVIDER_IDS) base[id] = { ...base[id], status: "active", ...overrides[id] };
  return base;
}

function format(input: UsageSnapshot, isColored = false, isSampleData = false, links = connections()) {
  return formatOneLine(input, links, NOW, { warnThreshold: 85, isColored, isSampleData });
}

function onlyClaude(limits: UsageLimit[]): string {
  const links = connections({ cx: { isEnabled: false }, go: { isEnabled: false } });
  return format(snapshot({ cl: limits }), false, false, links);
}

describe("formatOneLine", () => {
  test("joins every shown provider on one line", () => {
    expect(format(snapshot())).toBe("claude 5h 27% wk 73% │ codex 5h 27% wk 73% │ go 5h 27% wk 73%");
  });

  test("leaves out a provider the dashboard would not show", () => {
    const links = connections({ cx: { isAvailable: false }, go: { isEnabled: false } });

    expect(format(snapshot(), false, false, links)).toBe("claude 5h 27% wk 73%");
  });

  test("names a window by the length the provider reports", () => {
    const twoHours = limit("session", 5, { windowMinutes: 120 });
    const threeDays = limit("weekly", 6, { windowMinutes: 4_320 });

    expect(onlyClaude([twoHours, threeDays])).toBe("claude 2h 5% 3d 6%");
    expect(onlyClaude([limit("session", 5, { windowMinutes: 90 })])).toBe("claude 90m 5%");
    expect(onlyClaude([limit("session", 5), limit("weekly", 6)])).toBe("claude session 5% wk 6%");
  });

  test("omits a line with no cap", () => {
    expect(onlyClaude([limit("session", null), WEEKLY])).toBe("claude wk 73%");
  });

  test("says n/a when a provider has nothing to show", () => {
    expect(onlyClaude([limit("usage", null)])).toBe("claude n/a");
  });

  test("marks a window that has reset rather than repeat its old percent", () => {
    const passed = { ...SESSION, resetsAtMs: NOW_MS - 1 };

    expect(onlyClaude([passed, WEEKLY])).toBe("claude 5h ↺ wk 73%");
  });

  test("shows a tighter lane beside session and weekly", () => {
    expect(onlyClaude([SESSION, WEEKLY, limit("monthly", 91)])).toBe("claude 5h 27% wk 73% mo 91%");
    expect(onlyClaude([SESSION, WEEKLY, limit("monthly-credit", 91)])).toBe("claude 5h 27% wk 73% credits 91%");
    expect(onlyClaude([SESSION, WEEKLY, limit("fable", 91)])).toBe("claude 5h 27% wk 73% fable 91%");
    expect(onlyClaude([SESSION, WEEKLY, limit("surface-design", 91)])).toBe("claude 5h 27% wk 73% design 91%");
  });

  test("keeps a quieter lane off the line", () => {
    expect(onlyClaude([SESSION, WEEKLY, limit("fable", 8)])).toBe("claude 5h 27% wk 73%");
  });

  test("shows only the tightest of several extra lanes", () => {
    expect(onlyClaude([SESSION, WEEKLY, limit("fable", 80), limit("monthly", 91)])).toBe("claude 5h 27% wk 73% mo 91%");
  });

  test("does not let an old extra lane onto the line", () => {
    expect(onlyClaude([SESSION, WEEKLY, limit("fable", 99, { resetsAtMs: NOW_MS - 1 })])).toBe("claude 5h 27% wk 73%");
  });

  test("leaves out a card-only line", () => {
    expect(onlyClaude([SESSION, WEEKLY, limit("review", 99, { isCardOnly: true })])).toBe("claude 5h 27% wk 73%");
  });

  test("says blocked in place of percentages that cannot explain the refusal", () => {
    const input = snapshot();
    input.providers.cx.usageBlock = { isBlocked: true, reason: "spend control reached" };

    expect(format(input)).toContain("│ codex blocked │");
  });

  test("marks a failed read, whose figures are only cached", () => {
    expect(format(snapshot(), false, false, connections({ cx: { status: "expired" } }))).toContain("│ codex! 5h 27%");
  });

  test("labels sample figures", () => {
    expect(format(snapshot(), false, true)).toStartWith("(sample) claude");
  });

  test("is empty when no provider is shown", () => {
    const links = connections({ cl: { isEnabled: false }, cx: { isEnabled: false }, go: { isEnabled: false } });

    expect(format(snapshot(), false, false, links)).toBe("");
  });

  test("colours by the same steps as the dashboard", () => {
    const line = onlyColoured([limit("session", 69), limit("weekly", 70), limit("monthly", 85)]);

    expect(line).toBe("claude session \x1b[32m69%\x1b[0m wk \x1b[33m70%\x1b[0m mo \x1b[31m85%\x1b[0m");
  });

  test("adds no escape codes unless asked", () => {
    expect(format(snapshot())).not.toContain("\x1b[");
  });
});

function onlyColoured(limits: UsageLimit[]): string {
  const links = connections({ cx: { isEnabled: false }, go: { isEnabled: false } });
  return format(snapshot({ cl: limits }), true, false, links);
}
