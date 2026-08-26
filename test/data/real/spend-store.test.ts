import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptySpendStore,
  openCycleTotal,
  parseSpendStore,
  recordDayTokens,
  recordSpendReading,
  recordsBeganMs,
  sumWindow,
  updateSpendStore,
  type SpendStore,
} from "../../../src/data/real/spend-store";
import type { Money } from "../../../src/data/types";
import type { TokenUsage } from "../../../src/data/real/pricing";

function usd(amountMinor: number): Money {
  return { amountMinor, currency: "USD", exponent: 2 };
}

function tokens(partial: Partial<TokenUsage> = {}): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...partial };
}

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date(2026, 7, 1, 9).getTime();

describe("recordSpendReading", () => {
  test("keeps the maximum rather than summing repeated readings", () => {
    // The bug this guards: `used_credits` is cumulative, so adding each poll's
    // reading would multiply the real figure by the number of polls.
    let store = emptySpendStore();
    for (const amount of [410, 410, 410, 410, 410]) {
      store = recordSpendReading(store, usd(amount), T0);
    }

    expect(openCycleTotal(store)).toEqual(usd(410));
  });

  test("raises the maximum as the odometer climbs", () => {
    let store = emptySpendStore();
    store = recordSpendReading(store, usd(410), T0);
    store = recordSpendReading(store, usd(1187), T0 + DAY);
    store = recordSpendReading(store, usd(1842), T0 + 2 * DAY);

    expect(openCycleTotal(store)).toEqual(usd(1842));
    expect(store.completedCycles).toHaveLength(0);
  });

  test("a drop banks the previous peak and opens a new cycle", () => {
    let store = emptySpendStore();
    store = recordSpendReading(store, usd(1842), T0);
    store = recordSpendReading(store, usd(4712), T0 + 10 * DAY);
    // The cycle reset: the counter restarts near zero.
    store = recordSpendReading(store, usd(31), T0 + 31 * DAY);

    expect(store.completedCycles).toHaveLength(1);
    expect(store.completedCycles[0]?.totalMinor).toBe(4712);
    expect(store.completedCycles[0]?.startedMs).toBe(T0);
    expect(store.completedCycles[0]?.endedMs).toBe(T0 + 10 * DAY);
    expect(openCycleTotal(store)).toEqual(usd(31));
  });

  test("a currency change starts a new cycle rather than comparing totals", () => {
    let store = emptySpendStore();
    store = recordSpendReading(store, usd(4712), T0);
    store = recordSpendReading(
      store,
      { amountMinor: 100, currency: "EUR", exponent: 2 },
      T0 + DAY,
    );

    expect(store.completedCycles).toHaveLength(1);
    expect(store.completedCycles[0]?.currency).toBe("USD");
    expect(openCycleTotal(store)?.currency).toBe("EUR");
  });

  test("an equal reading does not close the cycle", () => {
    let store = emptySpendStore();
    store = recordSpendReading(store, usd(500), T0);
    store = recordSpendReading(store, usd(500), T0 + DAY);

    expect(store.completedCycles).toHaveLength(0);
    expect(store.openCycle?.lastReadingMs).toBe(T0 + DAY);
  });
});

describe("recordDayTokens", () => {
  const measured = { "2026-08-01": { "claude-opus-5": tokens({ input: 100, output: 20 }) } };

  test("replaces a fully covered day", () => {
    const banked: SpendStore = {
      ...emptySpendStore(),
      days: { "2026-08-01": { models: { "claude-opus-5": tokens({ input: 999, output: 999 }) } } },
    };
    const next = recordDayTokens(banked, measured, new Date(2026, 6, 1).getTime());

    expect(next.days["2026-08-01"]?.models["claude-opus-5"]?.input).toBe(100);
  });

  test("keeps the larger figure for a day the transcript window only partly covers", () => {
    // Claude pruned the start of this day, so the fresh measurement is smaller
    // than what we already banked. Replacing it would erase real usage.
    const banked: SpendStore = {
      ...emptySpendStore(),
      days: { "2026-08-01": { models: { "claude-opus-5": tokens({ input: 999, output: 5 }) } } },
    };
    const next = recordDayTokens(banked, measured, new Date(2026, 7, 1, 14).getTime());

    expect(next.days["2026-08-01"]?.models["claude-opus-5"]?.input).toBe(999);
    expect(next.days["2026-08-01"]?.models["claude-opus-5"]?.output).toBe(20);
  });

  test("leaves days outside the measurement untouched", () => {
    const banked: SpendStore = {
      ...emptySpendStore(),
      days: { "2026-06-11": { models: { "claude-opus-5": tokens({ input: 42 }) } } },
    };
    const next = recordDayTokens(banked, measured, new Date(2026, 6, 1).getTime());

    expect(next.days["2026-06-11"]?.models["claude-opus-5"]?.input).toBe(42);
  });
});

describe("sumWindow", () => {
  const store: SpendStore = {
    ...emptySpendStore(),
    days: {
      "2026-07-31": { models: { a: tokens({ input: 1 }) } },
      "2026-08-01": { models: { a: tokens({ input: 10 }), b: tokens({ output: 5 }) } },
      "2026-08-02": { models: { a: tokens({ input: 100 }) } },
    },
  };

  test("sums only the days inside the window", () => {
    const totals = sumWindow(store, new Date(2026, 7, 1).getTime(), new Date(2026, 7, 2).getTime());

    expect(totals.a?.input).toBe(10);
    expect(totals.b?.output).toBe(5);
  });

  test("spans an arbitrary window, which is what a billing cycle needs", () => {
    const totals = sumWindow(store, new Date(2026, 6, 31).getTime(), new Date(2026, 7, 3).getTime());

    expect(totals.a?.input).toBe(111);
  });

  test("reports where our own records begin", () => {
    expect(recordsBeganMs(store)).toBe(new Date(2026, 6, 31).getTime());
    expect(recordsBeganMs(emptySpendStore())).toBeNull();
  });
});

describe("parseSpendStore", () => {
  test("round-trips a written store", () => {
    let store = emptySpendStore();
    store = recordSpendReading(store, usd(1842), T0);
    store = recordDayTokens(store, { "2026-08-01": { a: tokens({ input: 7 }) } }, null);

    const parsed = parseSpendStore(JSON.parse(JSON.stringify({ version: 1, ...store })));

    expect(parsed.openCycle?.maxMinor).toBe(1842);
    expect(parsed.days["2026-08-01"]?.models.a?.input).toBe(7);
  });

  test("an unknown version reads as empty rather than throwing", () => {
    expect(parseSpendStore({ version: 99, days: { x: 1 } })).toEqual(emptySpendStore());
    expect(parseSpendStore("nonsense")).toEqual(emptySpendStore());
  });
});

describe("updateSpendStore round trip", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function storePath(): string {
    const root = mkdtempSync(join(tmpdir(), "open-usage-spend-store-"));
    roots.push(root);
    return join(root, "spend-history.json");
  }

  test("reads back the day tokens it wrote", () => {
    // Banking days past Claude's 30-day pruning is the whole point of the file;
    // a write the reader cannot see silently discards every older day.
    const path = storePath();
    const day = { "2026-08-01": { "claude-opus-5": tokens({ output: 500 }) } };
    updateSpendStore(path, (store) => recordDayTokens(store, day, T0));

    const reloaded = updateSpendStore(path, (store) => store);

    expect(reloaded.days["2026-08-01"]?.models["claude-opus-5"]?.output).toBe(500);
  });

  test("recovers day tokens banked under the older `months` key", () => {
    const path = storePath();
    Bun.write(
      path,
      JSON.stringify({
        version: 1,
        openCycle: null,
        completedCycles: [],
        months: { "2026-07-04": { models: { "claude-opus-5": tokens({ output: 900 }) } } },
      }),
    );

    const reloaded = updateSpendStore(path, (store) => store);

    expect(reloaded.days["2026-07-04"]?.models["claude-opus-5"]?.output).toBe(900);
  });
});
