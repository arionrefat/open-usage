import { describe, expect, test } from "bun:test";
import { createPolledSource, type PolledSourceConfig } from "../../../src/data/real/polled-source";

interface Reading {
  value: number;
  fetchedAtMs: number;
}

interface Harness {
  calls: number;
  resolveAll(value: number): void;
  rejectAll(error: unknown): void;
  pending: number;
}

/** A fetch whose completion the test controls, so overlap is observable. */
function deferredFetch(): {
  fetch: PolledSourceConfig<Reading>["fetch"];
  harness: Harness;
} {
  const waiters: Array<{
    resolve: (value: Reading) => void;
    reject: (error: unknown) => void;
  }> = [];
  const harness: Harness = {
    calls: 0,
    pending: 0,
    resolveAll(value) {
      const settled = waiters.splice(0);
      harness.pending = 0;
      for (const waiter of settled) waiter.resolve({ value, fetchedAtMs: 1_000 });
    },
    rejectAll(error) {
      const settled = waiters.splice(0);
      harness.pending = 0;
      for (const waiter of settled) waiter.reject(error);
    },
  };
  return {
    harness,
    fetch: () => {
      harness.calls += 1;
      harness.pending += 1;
      return new Promise<Reading>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
  };
}

function config(overrides: Partial<PolledSourceConfig<Reading>> = {}): PolledSourceConfig<Reading> {
  return {
    fetch: () => Promise.resolve({ value: 1, fetchedAtMs: Date.now() }),
    fetchedAtMs: (value) => value.fetchedAtMs,
    describeFailure: () => "unavailable",
    minPollMs: 60_000,
    minForcedPollMs: 5_000,
    backoffMs: 60_000,
    maxBackoffMs: 300_000,
    ...overrides,
  };
}

describe("createPolledSource", () => {
  test("a second caller joins the request already in flight", async () => {
    const { fetch, harness } = deferredFetch();
    const source = createPolledSource(config({ fetch }));
    const start = new Date();

    const first = source.poll(start);
    // A forced refresh arriving mid-request must not open a second connection.
    const second = source.poll(new Date(start.getTime() + 10_000), { force: true });
    expect(harness.calls).toBe(1);
    expect(harness.pending).toBe(1);

    harness.resolveAll(42);
    await Promise.all([first, second]);
    expect(source.read()?.value).toBe(42);
    expect(harness.calls).toBe(1);
  });

  test("the in-flight guard clears so later polls still run", async () => {
    const { fetch, harness } = deferredFetch();
    const source = createPolledSource(config({ fetch }));
    const start = new Date();

    const first = source.poll(start);
    harness.resolveAll(1);
    await first;

    const second = source.poll(new Date(start.getTime() + 61_000));
    harness.resolveAll(2);
    await second;
    expect(harness.calls).toBe(2);
    expect(source.read()?.value).toBe(2);
  });

  test("a forced poll cannot beat the manual floor", async () => {
    let calls = 0;
    const source = createPolledSource(
      config({
        fetch: () => {
          calls += 1;
          return Promise.resolve({ value: calls, fetchedAtMs: 0 });
        },
      }),
    );
    const start = new Date();
    await source.poll(start);

    for (const offsetMs of [100, 1_000, 4_999]) {
      await source.poll(new Date(start.getTime() + offsetMs), { force: true });
    }
    expect(calls).toBe(1);

    await source.poll(new Date(start.getTime() + 5_000), { force: true });
    expect(calls).toBe(2);
  });

  test("backoff widens while a provider keeps failing, then resets on success", async () => {
    let calls = 0;
    let shouldFail = true;
    const source = createPolledSource(
      config({
        fetch: () => {
          calls += 1;
          return shouldFail
            ? Promise.reject(new Error("down"))
            : Promise.resolve({ value: calls, fetchedAtMs: 0 });
        },
      }),
    );

    const start = 1_000_000;
    await source.poll(new Date(start));
    expect(calls).toBe(1);
    expect(source.note()).toBe("unavailable");

    // First failure: one backoff window, not the 60s interval.
    await source.poll(new Date(start + 59_000));
    expect(calls).toBe(1);
    await source.poll(new Date(start + 61_000));
    expect(calls).toBe(2);

    // Second consecutive failure doubles it: 120s, so 61s later is too soon.
    await source.poll(new Date(start + 122_000));
    expect(calls).toBe(2);
    await source.poll(new Date(start + 182_000));
    expect(calls).toBe(3);

    shouldFail = false;
    await source.poll(new Date(start + 600_000), { force: true });
    expect(calls).toBe(4);
    expect(source.note()).toBeNull();

    // Recovered: the next failure starts from the base delay again.
    shouldFail = true;
    await source.poll(new Date(start + 900_000));
    expect(calls).toBe(5);
    await source.poll(new Date(start + 961_000));
    expect(calls).toBe(6);
  });

  test("backoff never exceeds the cap", async () => {
    let calls = 0;
    const source = createPolledSource(
      config({
        backoffMs: 60_000,
        maxBackoffMs: 120_000,
        fetch: () => {
          calls += 1;
          return Promise.reject(new Error("down"));
        },
      }),
    );

    let clock = 1_000_000;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await source.poll(new Date(clock));
      clock += 121_000;
    }
    // Capped at 2 minutes, so every 121s tick gets through.
    expect(calls).toBe(8);
  });

  test("a cancelled poll neither widens the backoff nor blames the provider", async () => {
    const controller = new AbortController();
    let calls = 0;
    const source = createPolledSource(
      config({
        backoffMs: 300_000,
        fetch: () => {
          calls += 1;
          controller.abort();
          return Promise.reject(new DOMException("Refresh aborted", "AbortError"));
        },
      }),
    );

    const start = 1_000_000;
    let rejection: unknown;
    try {
      await source.poll(new Date(start), { signal: controller.signal });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(DOMException);
    expect(source.note()).toBeNull();
    expect(source.read()).toBeNull();

    // The request went out, so the routine interval applies - but the 5-minute
    // failure backoff does not, because nothing actually failed.
    await source.poll(new Date(start + 59_000));
    expect(calls).toBe(1);
    await source.poll(new Date(start + 61_000));
    expect(calls).toBe(2);
  });

  test("the poll interval can widen and tighten between ticks", async () => {
    let calls = 0;
    let isCovered = false;
    const source = createPolledSource(
      config({
        minPollMs: () => (isCovered ? 1_200_000 : 60_000),
        fetch: () => {
          calls += 1;
          return Promise.resolve({ value: calls, fetchedAtMs: 0 });
        },
      }),
    );

    const start = 1_000_000;
    await source.poll(new Date(start));
    expect(calls).toBe(1);

    // Covered elsewhere: the 60s cadence gives way to the 20-minute one.
    isCovered = true;
    await source.poll(new Date(start + 61_000));
    expect(calls).toBe(1);

    // Cover lapses: the very next tick is back on the tight cadence, with no
    // stale deadline left over from the relaxed one.
    isCovered = false;
    await source.poll(new Date(start + 62_000));
    expect(calls).toBe(2);
  });

  test("a cancelled poll still counts against the manual floor", async () => {
    const controller = new AbortController();
    let calls = 0;
    const source = createPolledSource(
      config({
        fetch: () => {
          calls += 1;
          controller.abort();
          return Promise.reject(new DOMException("Refresh aborted", "AbortError"));
        },
      }),
    );

    const start = 1_000_000;
    await source.poll(new Date(start), { signal: controller.signal }).catch(() => undefined);
    // The request did go out, so `r` is floored exactly as it is after a success.
    await source.poll(new Date(start + 2_000), { force: true });
    expect(calls).toBe(1);
  });

  test("a server's Retry-After outranks a manual refresh", async () => {
    let calls = 0;
    const source = createPolledSource(
      config({
        fetch: () => {
          calls += 1;
          return Promise.reject(new Error("429"));
        },
        describeFailure: () => "rate limited",
        retryDelayMs: () => 600_000,
      }),
    );

    const start = 1_000_000;
    await source.poll(new Date(start));
    expect(calls).toBe(1);
    expect(source.note()).toBe("rate limited");

    // Mashing `r` through a rate limit is exactly how an account gets blocked.
    for (const offsetMs of [10_000, 60_000, 300_000, 599_000]) {
      await source.poll(new Date(start + offsetMs), { force: true });
    }
    expect(calls).toBe(1);

    await source.poll(new Date(start + 601_000), { force: true });
    expect(calls).toBe(2);
  });

  test("a precheck can skip without consuming the schedule", async () => {
    let calls = 0;
    let isConfigured = false;
    const source = createPolledSource(
      config({
        precheck: () => (isConfigured ? null : { note: null, isThrottled: false }),
        fetch: () => {
          calls += 1;
          return Promise.resolve({ value: 1, fetchedAtMs: 0 });
        },
      }),
    );

    const start = 1_000_000;
    await source.poll(new Date(start));
    expect(calls).toBe(0);
    expect(source.note()).toBeNull();

    // Configured a second later: the skip left no throttle behind.
    isConfigured = true;
    await source.poll(new Date(start + 1_000));
    expect(calls).toBe(1);
  });

  test("a throttled precheck holds the schedule and surfaces its note", async () => {
    let calls = 0;
    const source = createPolledSource(
      config({
        precheck: () => ({ note: "fix your cookie", isThrottled: true }),
        fetch: () => {
          calls += 1;
          return Promise.resolve({ value: 1, fetchedAtMs: 0 });
        },
      }),
    );

    const start = 1_000_000;
    await source.poll(new Date(start));
    expect(source.note()).toBe("fix your cookie");
    await source.poll(new Date(start + 30_000));
    expect(calls).toBe(0);
  });

  test("stale readings are served with a notice, and failures outrank it", async () => {
    const oldMs = Date.now() - 20 * 60_000;
    const source = createPolledSource(
      config({
        fetch: () => Promise.resolve({ value: 7, fetchedAtMs: oldMs }),
        staleAfterMs: 15 * 60_000,
        staleNote: (ageMs) => `stale ${Math.round(ageMs / 60_000)}m`,
      }),
    );

    await source.poll(new Date());
    expect(source.read()?.value).toBe(7);
    expect(source.note()).toBe("stale 20m");
  });

  test("treats a reading timestamped after a backward clock correction as stale", async () => {
    const now = new Date(1_000_000);
    const source = createPolledSource(
      config({
        initial: { value: 7, fetchedAtMs: now.getTime() + 60_000 },
        staleAfterMs: 15 * 60_000,
        staleNote: () => "stale",
      }),
    );

    expect(source.isStale(now)).toBe(true);
    expect(source.note(now)).toBe("stale");
  });

  test("a backward clock correction expires the previous polling floor", async () => {
    let calls = 0;
    const source = createPolledSource(
      config({
        fetch: (_now) => Promise.resolve({ value: ++calls, fetchedAtMs: 0 }),
      }),
    );

    await source.poll(new Date(1_000_000));
    await source.poll(new Date(900_000));
    expect(calls).toBe(2);
  });

  test("a failure keeps the previous reading on screen", async () => {
    let shouldFail = false;
    const source = createPolledSource(
      config({
        fetch: () =>
          shouldFail
            ? Promise.reject(new Error("down"))
            : Promise.resolve({ value: 5, fetchedAtMs: Date.now() }),
      }),
    );

    const start = Date.now();
    await source.poll(new Date(start));
    shouldFail = true;
    await source.poll(new Date(start + 61_000));

    expect(source.read()?.value).toBe(5);
    expect(source.note()).toBe("unavailable");
  });
});
