import { describe, expect, test } from "bun:test";
import { createGoHistorySource, dormantGoHistorySource } from "../../../src/data/real/go-history-source";
import type { GoUsageHistory } from "../../../src/data/real/opencode-server";

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
