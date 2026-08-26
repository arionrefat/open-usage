import { describe, expect, test } from "bun:test";
import { createGoHistorySource, dormantGoHistorySource } from "../../../src/data/real/go-history-source";
import type { GoUsageHistory } from "../../../src/data/real/opencode-server";
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

const NOW = new Date("2026-08-18T12:00:00Z");

describe("createGoHistorySource", () => {
  test("stays dormant without a cookie and never calls the server", async () => {
    let calls = 0;
    const source = createGoHistorySource(() => null, {
      fetchHistory: async () => {
        calls += 1;
        return history("2026-08", 10);
      },
    });
    await source.poll(NOW);
    expect(calls).toBe(0);
    expect(source.read()).toBeNull();
  });

  test("reads three months and reuses the workspace id after the first", async () => {
    const seen: Array<string | undefined> = [];
    const source = createGoHistorySource(() => "auth=tok", {
      fetchHistory: async (_cookie, _now, options = {}) => {
        seen.push(options.workspaceId);
        return history(`2026-0${8 - (options.monthsAgo ?? 0)}`, 10);
      },
    });
    await source.poll(NOW);
    expect(seen).toEqual([undefined, "wrk_1", "wrk_1"]);
    expect(source.read()?.current.label).toBe("august 2026");
    expect(source.billing()?.hasLiteSubscription).toBe(true);
  });

  test("a failure keeps the last good copy rather than blanking the screen", async () => {
    let shouldFail = false;
    const source = createGoHistorySource(() => "auth=tok", {
      fetchHistory: async (_cookie, _now, options = {}) => {
        if (shouldFail) throw new Error("network");
        return history(`2026-0${8 - (options.monthsAgo ?? 0)}`, 10);
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
      fetchHistory: async (_cookie, _now, options = {}) => {
        calls += 1;
        return history(`2026-0${8 - (options.monthsAgo ?? 0)}`, 10);
      },
    });
    await source.poll(NOW);
    await source.poll(new Date(NOW.getTime() + 60_000));
    expect(calls).toBe(3);
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
  function usageRow(atMs: number, outputTokens: number): GoUsageRow {
    return {
      sessionId: "ses_1", keyId: null, atMs, model: "kimi-k3",
      inputTokens: 0, outputTokens, reasoningTokens: 0, cacheReadTokens: 0,
      cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, usd: 0, plan: "lite", isByok: false,
    };
  }

  test("reads activity from the dashboard, which a cookie alone can reach", async () => {
    // opencode.db does not exist until opencode has been installed and used, so
    // without this the cookie path shows limits and no history at all.
    const source = createGoHistorySource(() => "auth=x", {
      fetchHistory: async () => history("2026-08", 1),
      fetchRows: async () => [usageRow(NOW.getTime() - 3_600_000, 500)],
    });

    await source.poll(NOW);

    expect(source.activity()?.stats.tokens).toBe(500);
  });

  test("asks only for the window the charts show", async () => {
    let sinceMs = 0;
    const source = createGoHistorySource(() => "auth=x", {
      fetchHistory: async () => history("2026-08", 1),
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
      fetchHistory: async () => history("2026-08", 1),
      fetchRows: async () => {
        if (shouldFail) throw new Error("network");
        return [usageRow(NOW.getTime() - 3_600_000, 700)];
      },
    });
    await source.poll(NOW);

    shouldFail = true;
    await source.poll(new Date(NOW.getTime() + 60 * 60_000));

    // Blanking the chart on a blip would read as "you used nothing".
    expect(source.activity()?.stats.tokens).toBe(700);
  });

  test("still reports the month when the usage table is unreachable from the first poll", async () => {
    const source = createGoHistorySource(() => "auth=x", {
      fetchHistory: async () => history("2026-08", 1),
      fetchRows: async () => {
        throw new Error("network");
      },
    });

    await source.poll(NOW);

    expect(source.read()).not.toBeNull();
    expect(source.activity()).toBeNull();
  });
});
