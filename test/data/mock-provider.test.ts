import { describe, expect, test } from "bun:test";
import { mockUsageProvider } from "../../src/data/mock-provider";
import { dailyDateKeys } from "../../src/data/real/aggregate";

describe("mock usage provider", () => {
  test("dates its deterministic 30-day series to the snapshot fetch time", () => {
    const snapshot = mockUsageProvider.readSnapshot();
    expect(snapshot.dailyDates).toEqual(dailyDateKeys(new Date(snapshot.fetchedAt)));
    for (const provider of Object.values(snapshot.providers)) {
      expect(provider.series.daily).toHaveLength(snapshot.dailyDates.length);
    }
  });

  test("rejects immediately when refresh starts with an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(
      mockUsageProvider.refresh({
        reason: "manual",
        providerIds: ["cl", "cx", "go"],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
