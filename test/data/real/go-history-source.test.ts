import { describe, expect, test } from "bun:test";
import {
  createGoHistorySource,
  dormantGoHistorySource,
  readRowsSince,
  type GoHistoryReading,
} from "../../../src/data/real/go-history-source";
import { OpencodeServerError, type GoUsageHistory } from "../../../src/data/real/opencode-server";
import type { GoUsageRow } from "../../../src/data/real/opencode-usage";

function history(month: string, usd: number): GoUsageHistory {
  return {
    costs: {
      rows: [{ date: `${month}-01`, model: "kimi-k3", usd, keyId: null, plan: "lite" }],
      keys: [],
    },
    billing: {
      balanceUsd: 0,
      monthlyUsageUsd: null,
      monthlyLimitUsd: null,
      isAutoReloadOn: false,
      reloadAmountUsd: 20,
      hasLiteSubscription: true,
      hasSubscription: false,
    },
    workspaceId: "wrk_1",
    month,
  };
}

/** The three months one console call now answers with, newest first. */
function months(usd = 10): GoUsageHistory[] {
  return ["2026-08", "2026-07", "2026-06"].map((month) => history(month, usd));
}

const NOW = new Date("2026-08-18T12:00:00Z");

describe("createGoHistorySource", () => {
  test("stays dormant without a cookie and never calls the server", async () => {
    let calls = 0;
    const source = createGoHistorySource(() => null, {
      fetchHistory: async () => {
        calls += 1;
        return months();
      },
    });
    await source.poll(NOW);
    expect(calls).toBe(0);
    expect(source.read()).toBeNull();
  });

  test("reads the months in one call and keeps the workspace it discovered", async () => {
    const asked: Array<{ workspaceId?: string; months?: number }> = [];
    const source = createGoHistorySource(() => "auth=tok", {
      fetchHistory: async (_cookie, _now, options = {}) => {
        asked.push({ ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }), months: options.months });
        return months();
      },
    });
    await source.poll(NOW);
    expect(asked).toEqual([{ months: 3 }]);
    expect(source.read()?.current.label).toBe("august 2026");
    expect(source.billing()?.hasLiteSubscription).toBe(true);

    // The id the first walk discovered spares the next one the lookup.
    await source.poll(new Date(NOW.getTime() + 31 * 60_000), { force: true });
    expect(asked[1]).toEqual({ workspaceId: "wrk_1", months: 3 });
  });

  test("a failure keeps the last good copy rather than blanking the screen", async () => {
    let shouldFail = false;
    const source = createGoHistorySource(() => "auth=tok", {
      fetchHistory: async () => {
        if (shouldFail) throw new Error("network");
        return months();
      },
    });
    await source.poll(NOW);
    const before = source.read();
    expect(before).not.toBeNull();

    shouldFail = true;
    await source.poll(new Date(NOW.getTime() + 60 * 60_000), { force: true });
    expect(source.read()).toBe(before);
  });

  test("does not re-poll inside the interval", async () => {
    let calls = 0;
    const source = createGoHistorySource(() => "auth=tok", {
      fetchHistory: async () => {
        calls += 1;
        return months();
      },
    });
    await source.poll(NOW);
    await source.poll(new Date(NOW.getTime() + 60_000));
    expect(calls).toBe(1);
  });
});

describe("dormantGoHistorySource", () => {
  test("reads as absent", async () => {
    await dormantGoHistorySource.poll(NOW);
    expect(dormantGoHistorySource.read()).toBeNull();
    expect(dormantGoHistorySource.billing()).toBeNull();
  });
});

describe("workspace activity", () => {
  test("reads activity from the dashboard, which a cookie alone can reach", async () => {
    // opencode.db does not exist until opencode has been installed and used, so
    // without this the cookie path shows limits and no history at all.
    const source = createGoHistorySource(() => "auth=x", {
      fetchHistory: async () => [history("2026-08", 1)],
      fetchRows: async () => [rowAt("rlg_test1", NOW.getTime() - 3_600_000, 500)],
    });

    await source.poll(NOW);

    expect(source.activity()?.stats.tokens).toBe(500);
  });

  test("asks only for the window the charts show", async () => {
    let sinceMs = 0;
    const source = createGoHistorySource(() => "auth=x", {
      fetchHistory: async () => [history("2026-08", 1)],
      fetchRows: async (_cookie, _workspace, options) => {
        sinceMs = options.sinceMs;
        return [];
      },
    });

    await source.poll(NOW);

    expect(NOW.getTime() - sinceMs).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test("keeps the last good activity when a later poll cannot reach the table", async () => {
    let shouldFail = false;
    const source = createGoHistorySource(() => "auth=x", {
      fetchHistory: async () => [history("2026-08", 1)],
      fetchRows: async () => {
        if (shouldFail) throw new Error("network");
        return [rowAt("rlg_test1", NOW.getTime() - 3_600_000, 700)];
      },
    });
    await source.poll(NOW);

    shouldFail = true;
    await source.poll(new Date(NOW.getTime() + 60 * 60_000));

    // Blanking the chart on a blip would read as "you used nothing".
    expect(source.activity()?.stats.tokens).toBe(700);
    // A blip says nothing about the route, so nothing is flagged.
    expect(source.note()).toBeNull();
  });

  test("a request log that changed shape keeps the last rows and says so", async () => {
    let hasMoved = false;
    const published: GoHistoryReading[] = [];
    const source = createGoHistorySource(() => "auth=x", {
      fetchHistory: async () => [history("2026-08", 1)],
      fetchRows: async () => {
        // What the retired usage table started answering: 404, which the
        // client reports as drift.
        if (hasMoved) throw new OpencodeServerError("HTTP 404", "parse");
        return [rowAt("rlg_test1", NOW.getTime() - 3_600_000, 700)];
      },
      onUpdate: (reading) => published.push(reading),
    });
    await source.poll(NOW);
    expect(source.note()).toBeNull();

    hasMoved = true;
    await source.poll(new Date(NOW.getTime() + 60 * 60_000));

    expect(source.activity()?.stats.tokens).toBe(700);
    expect(source.note()).toContain("request log changed");
    // Persisted, so a dashboard that adopts this reading from the daemon says so too.
    expect(published.at(-1)?.hasRequestLogDrift).toBe(true);

    hasMoved = false;
    await source.poll(new Date(NOW.getTime() + 120 * 60_000));
    expect(source.note()).toBeNull();
  });

  test("a cost chart that changed shape is flagged until a reading succeeds", async () => {
    let hasMoved = false;
    const source = createGoHistorySource(() => "auth=x", {
      fetchHistory: async () => {
        if (hasMoved) throw new OpencodeServerError("no usage in response", "parse");
        return [history("2026-08", 1)];
      },
      fetchRows: async () => [],
    });
    await source.poll(NOW);
    const before = source.read();

    hasMoved = true;
    await source.poll(new Date(NOW.getTime() + 60 * 60_000));

    expect(source.read()).toBe(before);
    expect(source.note()).toContain("cost history changed");
  });

  test("a failure the limits already report adds no note of its own", async () => {
    let shouldFail = false;
    const source = createGoHistorySource(() => "auth=x", {
      fetchHistory: async () => {
        if (shouldFail) throw new OpencodeServerError("opencode session expired", "credentials");
        return [history("2026-08", 1)];
      },
      fetchRows: async () => [],
    });
    await source.poll(NOW);

    shouldFail = true;
    await source.poll(new Date(NOW.getTime() + 60 * 60_000));

    expect(source.note()).toBeNull();
  });

  test("still reports the month when the usage table is unreachable from the first poll", async () => {
    const source = createGoHistorySource(() => "auth=x", {
      fetchHistory: async () => [history("2026-08", 1)],
      fetchRows: async () => {
        throw new Error("network");
      },
    });

    await source.poll(NOW);

    expect(source.read()).not.toBeNull();
    expect(source.activity()).toBeNull();
  });
});

function rowAt(id: string, atMs: number, outputTokens = 1): GoUsageRow {
  return {
    id, sessionId: "ses_test1", atMs, model: "kimi-k3", isRejected: false,
    inputTokens: 0, outputTokens, reasoningTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, usd: 0, plan: "lite",
  };
}

describe("history walk economy", () => {
  test("reads every month in one call and keeps the closed ones as history", async () => {
    let calls = 0;
    const source = createGoHistorySource(() => "auth=tok", {
      fetchHistory: async () => {
        calls += 1;
        return months();
      },
      fetchRows: async () => [],
    });

    await source.poll(NOW);

    expect(calls).toBe(1);
    expect(source.read()?.history).toHaveLength(2);
  });

  test("skips workspace discovery when another source already knows it", async () => {
    const seen: Array<string | undefined> = [];
    let inFlight = 0;
    let peak = 0;
    const source = createGoHistorySource(() => "auth=tok", {
      knownWorkspaceId: () => "wrk_known",
      fetchHistory: async (_cookie, _now, options = {}) => {
        seen.push(options.workspaceId);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Bun.sleep(5);
        inFlight -= 1;
        return months();
      },
      fetchRows: async (_cookie, workspace) => {
        seen.push(workspace);
        return [];
      },
    });

    await source.poll(NOW);

    // The months and the rows walk go out together against the known workspace.
    expect(seen).toEqual(["wrk_known", "wrk_known"]);
    expect(peak).toBe(1);
  });

  test("a seeded reading is served at once and defers the walk, even for a press", async () => {
    let calls = 0;
    const source = createGoHistorySource(() => "auth=tok", {
      initial: {
        months: [history("2026-08", 4)],
        rows: [rowAt("rlg_test1", NOW.getTime() - 3_600_000, 500)],
        hasRequestLogDrift: false,
        fetchedAtMs: NOW.getTime() - 60_000,
      },
      fetchHistory: async () => {
        calls += 1;
        return months();
      },
      fetchRows: async () => [],
    });

    expect(source.read()?.current.label).toBe("august 2026");
    expect(source.activity()?.stats.tokens).toBe(500);
    await source.poll(NOW);
    expect(calls).toBe(0);
    // Thirty requests are not worth repeating for a reading a minute old.
    await source.poll(NOW, { force: true });
    expect(calls).toBe(0);

    await source.poll(new Date(NOW.getTime() + 6 * 60_000), { force: true });
    expect(calls).toBe(1);
  });

  test("publishes each reading it makes and adopts one persisted by another process", async () => {
    const published: GoHistoryReading[] = [];
    let persisted: GoHistoryReading | null = null;
    let calls = 0;
    const source = createGoHistorySource(() => "auth=tok", {
      fetchHistory: async () => {
        calls += 1;
        return months();
      },
      fetchRows: async () => [],
      onUpdate: (reading) => published.push(reading),
      readPersisted: () => persisted,
    });
    await source.poll(NOW);
    expect(published).toHaveLength(1);
    expect(calls).toBe(1);
    expect(source.activity()).not.toBeNull();

    // The daemon walked the table since; the dashboard takes its reading as its own.
    persisted = {
      months: [history("2026-08", 99)],
      rows: null,
      hasRequestLogDrift: false,
      fetchedAtMs: NOW.getTime() + 40 * 60_000,
    };
    await source.poll(new Date(NOW.getTime() + 41 * 60_000));

    expect(calls).toBe(1);
    expect(published).toHaveLength(1);
    expect(source.activity()).toBeNull();
  });

  test("walks only back to the rows it already holds", async () => {
    const asked: number[] = [];
    const source = createGoHistorySource(() => "auth=tok", {
      initial: {
        months: [history("2026-08", 4)],
        rows: [rowAt("rlg_b", NOW.getTime() - 10 * 60_000), rowAt("rlg_a", NOW.getTime() - 20 * 60_000)],
        hasRequestLogDrift: false,
        fetchedAtMs: NOW.getTime() - 40 * 60_000,
      },
      fetchHistory: async () => months(),
      fetchRows: async (_cookie, _workspace, options) => {
        asked.push(options.sinceMs);
        return [rowAt("rlg_c", NOW.getTime() - 60_000, 7), rowAt("rlg_b", NOW.getTime() - 10 * 60_000)];
      },
    });

    await source.poll(NOW);

    expect(asked).toEqual([NOW.getTime() - 10 * 60_000]);
    expect(source.activity()?.stats.tokens).toBe(9);
  });
});

describe("readRowsSince", () => {
  const minutesAgo = (minutes: number) => NOW.getTime() - minutes * 60_000;
  const windowStartMs = minutesAgo(60);

  test("walks the whole window when nothing is held", async () => {
    const asked: number[] = [];
    const rows = await readRowsSince(null, windowStartMs, async (sinceMs) => {
      asked.push(sinceMs);
      return [rowAt("a", minutesAgo(1))];
    });

    expect(asked).toEqual([windowStartMs]);
    expect(rows.map((row) => row.id)).toEqual(["a"]);
  });

  test("asks only for what arrived since the newest held row and joins by id", async () => {
    const held = [rowAt("b", minutesAgo(10)), rowAt("a", minutesAgo(20)), rowAt("old", minutesAgo(90))];
    const asked: number[] = [];

    const rows = await readRowsSince(held, windowStartMs, async (sinceMs) => {
      asked.push(sinceMs);
      // The walk re-reads the second `b` landed in, so `b` comes back too.
      return [rowAt("c", minutesAgo(2)), rowAt("b", minutesAgo(10))];
    });

    expect(asked).toEqual([minutesAgo(10)]);
    // `old` aged out of the window; `b` is not counted twice.
    expect(rows.map((row) => row.id)).toEqual(["c", "b", "a"]);
  });

  test("a request that started in the same millisecond as the newest held one is still new", async () => {
    const held = [rowAt("b", minutesAgo(10))];

    const rows = await readRowsSince(held, windowStartMs, async () => [
      rowAt("b", minutesAgo(10)),
      rowAt("b2", minutesAgo(10)),
    ]);

    expect(rows.map((row) => row.id)).toEqual(["b2", "b"]);
  });
});
