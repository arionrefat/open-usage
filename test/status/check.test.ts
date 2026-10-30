import { describe, expect, test } from "bun:test";
import { mockUsageProvider } from "../../src/data/mock-provider";
import { PROVIDER_IDS, type ProviderConnection, type ProviderId, type UsageLimit, type UsageSnapshot } from "../../src/data/types";
import {
  CHECK_EXIT_CAPPED,
  CHECK_EXIT_NEAR_LIMIT,
  CHECK_EXIT_NO_DATA,
  CHECK_EXIT_OK,
  checkExitCode,
} from "../../src/status/check";

const NOW = new Date(2026, 0, 15, 12);
const NOW_MS = NOW.getTime();
const WARN_THRESHOLD = 85;

function limit(percent: number | null, overrides: Partial<UsageLimit> = {}): UsageLimit {
  return { id: "weekly", label: "weekly", percent, reset: "resets soon", ...overrides };
}

function snapshot(claudeLimits: UsageLimit[]): UsageSnapshot {
  const base = structuredClone(mockUsageProvider.readSnapshot());
  for (const id of PROVIDER_IDS) base.providers[id].limits = [];
  base.providers.cl.limits = claudeLimits;
  return base;
}

function connections(overrides: Partial<Record<ProviderId, Partial<ProviderConnection>>> = {}) {
  const base = mockUsageProvider.initialConnections();
  for (const id of PROVIDER_IDS) base[id] = { ...base[id], ...overrides[id] };
  return base;
}

function check(input: UsageSnapshot, links = connections()): number {
  return checkExitCode(input, links, NOW, WARN_THRESHOLD);
}

describe("checkExitCode", () => {
  test("is zero while every limit is under the threshold", () => {
    expect(check(snapshot([limit(84)]))).toBe(CHECK_EXIT_OK);
  });

  test("warns from the threshold up", () => {
    expect(check(snapshot([limit(85)]))).toBe(CHECK_EXIT_NEAR_LIMIT);
    expect(check(snapshot([limit(99)]))).toBe(CHECK_EXIT_NEAR_LIMIT);
  });

  test("reports a cap at 100 percent and past it", () => {
    expect(check(snapshot([limit(100)]))).toBe(CHECK_EXIT_CAPPED);
    expect(check(snapshot([limit(104)]))).toBe(CHECK_EXIT_CAPPED);
  });

  test("judges the tightest limit, whichever lane it is", () => {
    expect(check(snapshot([limit(10), limit(100, { id: "fable" })]))).toBe(CHECK_EXIT_CAPPED);
  });

  test("reports a block below every cap", () => {
    const input = snapshot([limit(5)]);
    input.providers.cl.usageBlock = { isBlocked: true, reason: "spend control reached" };

    expect(check(input)).toBe(CHECK_EXIT_CAPPED);
  });

  test("does not count a provider that says it is not blocked", () => {
    const input = snapshot([limit(5)]);
    input.providers.cl.usageBlock = { isBlocked: false };

    expect(check(input)).toBe(CHECK_EXIT_OK);
  });

  test("does not hold a reading against a window that has since reset", () => {
    const passed = limit(100, { resetsAtMs: NOW_MS - 1 });

    expect(check(snapshot([passed, limit(10, { id: "session" })]))).toBe(CHECK_EXIT_OK);
  });

  test("has nothing to judge when every reading is old or uncapped", () => {
    expect(check(snapshot([limit(100, { resetsAtMs: NOW_MS - 1 }), limit(null, { id: "session" })]))).toBe(CHECK_EXIT_NO_DATA);
    expect(check(snapshot([]))).toBe(CHECK_EXIT_NO_DATA);
  });

  test("ignores card-only lines and providers the dashboard would not show", () => {
    expect(check(snapshot([limit(10), limit(100, { id: "review", isCardOnly: true })]))).toBe(CHECK_EXIT_OK);
    expect(check(snapshot([limit(100)]), connections({ cl: { isEnabled: false } }))).toBe(CHECK_EXIT_NO_DATA);
  });
});
