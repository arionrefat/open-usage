import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { App } from "../src/app";
import { Chart } from "../src/components/primitives";
import { mockUsageProvider } from "../src/data/mock-provider";
import type { DetailSection, UsageProvider } from "../src/data/types";
import { barLabels, bars } from "../src/lib/chart";
import { COLORS } from "../src/theme";

const WIDTH = 60;
const HEIGHT = 60;

function providerWith(details: DetailSection[] | undefined): UsageProvider {
  const snapshot = structuredClone(mockUsageProvider.readSnapshot());
  snapshot.providers.cl.details = details;
  snapshot.providers.cl.notice = undefined;
  return {
    ...mockUsageProvider,
    readSnapshot: () => snapshot,
    refresh: async () => snapshot,
  };
}

async function renderDetails(
  details: DetailSection[] | undefined,
  width = WIDTH,
): Promise<string> {
  const setup = await testRender(
    <App
      provider={providerWith(details)}
      startup={{ screen: "app", view: "claude", mode: "detailed", useSeverityColors: false }}
    />,
    { width, height: HEIGHT },
  );
  try {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setup.flush();
    });
    return setup.captureCharFrame();
  } finally {
    act(() => setup.renderer.destroy());
  }
}

test("provider detail renders populated sections and skips empty ones", async () => {
  const frame = await renderDetails([
    { title: "model share", rows: [{ label: "Fable", value: "72%", percent: 72 }] },
    { title: "empty records", rows: [] },
    { title: "records", rows: [{ label: "sessions", value: "41" }] },
  ]);

  expect(frame).toContain("model share");
  expect(frame).toContain("Fable");
  expect(frame).toContain("72%");
  expect(frame).toContain("records");
  expect(frame).toContain("sessions");
  expect(frame).not.toContain("empty records");
});

test("absent details render the same as empty sections", async () => {
  expect(await renderDetails(undefined)).toBe(
    await renderDetails([{ title: "not rendered", rows: [] }]),
  );
});

test("long detail labels truncate without wrapping", async () => {
  const label = "a very long provider detail label that cannot fit on one terminal row";
  const frame = await renderDetails([
    { title: "records", rows: [{ label, value: "123", percent: 50 }] },
  ]);
  const rows = frame.split("\n");
  const valueRow = rows.find((row) => row.includes("123"));

  expect(frame).not.toContain(label);
  expect(valueRow).toContain("…");
  expect(valueRow).toContain("123");
  for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(WIDTH);
});

test("aligns detail bars when values have different widths", async () => {
  const frame = await renderDetails([
    {
      title: "tokens",
      rows: [
        { label: "input", value: "17M", percent: 72 },
        { label: "output", value: "8.4M", percent: 31 },
        { label: "reasoning", value: "5.3M", percent: 19 },
      ],
    },
  ]);
  const rows = frame.split("\n");
  const barStarts = ["input", "output", "reasoning"].map(
    (label) => rows.find((row) => row.includes(label))?.indexOf("█"),
  );

  expect(barStarts[0]).toBeGreaterThanOrEqual(0);
  expect(barStarts).toEqual([barStarts[0], barStarts[0], barStarts[0]]);
});

test("frames the token chart with embedded labels and all three dates", async () => {
  const frame = await renderDetails(undefined);
  const rows = frame.split("\n");
  const dates = mockUsageProvider.readSnapshot().dailyDates;
  const axisLabel = (date: string | undefined) =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  const first = axisLabel(dates[0]);
  const middle = axisLabel(dates[Math.floor((dates.length - 1) / 2)]);
  const last = axisLabel(dates.at(-1));
  const top = rows.find((row) => row.includes("tokens last 30 days"));
  const bottom = rows.find((row) => row.includes(first));

  expect(top?.trim()).toMatch(/^┌─ tokens last 30 days · \S+ total · \d+\/30 active ─+┐$/);
  expect(top).not.toContain("peak");
  expect(bottom?.trim()).toStartWith(`└─ ${first} `);
  expect(bottom).toContain(` ${middle} `);
  // Centred within the footer's own width. Comparing the gaps keeps this from
  // tracking today's date: a 6-character label rounds the other way to a 5.
  const footer = bottom?.trimEnd() ?? "";
  const gapBefore = footer.indexOf(middle);
  const gapAfter = Bun.stringWidth(footer) - gapBefore - Bun.stringWidth(middle);
  expect(Math.abs(gapBefore - gapAfter)).toBeLessThanOrEqual(1);
  expect(bottom?.trim()).toEndWith(` ${last} ─┘`);
  const topIndex = rows.findIndex((row) => row.includes("tokens last 30 days"));
  expect(rows.slice(topIndex + 1, topIndex + 9).every((row) => row.trim().startsWith("│"))).toBe(true);
  expect(rows.slice(topIndex + 1, topIndex + 9).every((row) => row.trimEnd().endsWith("│"))).toBe(true);
});

test("drops the midpoint date when the chart is too narrow", async () => {
  const frame = await renderDetails(undefined, 28);
  const dates = mockUsageProvider.readSnapshot().dailyDates;
  const middle = new Date(`${dates[Math.floor((dates.length - 1) / 2)]}T00:00:00Z`).toLocaleDateString(
    "en-US",
    { month: "short", day: "numeric", timeZone: "UTC" },
  );
  const bottom = frame.split("\n").find((row) => row.includes("└─"));

  expect(bottom).not.toContain(` ${middle} `);
});

test("keeps every embedded-label chart row at the exact frame width", async () => {
  const plotWidth = 11;
  const frameWidth = plotWidth + 2;
  const chartHeight = 4;
  const rows = bars([10, 7, 1], plotWidth, chartHeight, "red").map((row) => ({
    segments: [
      { text: "│", color: COLORS.borderPanel },
      ...row.segments,
      { text: "│", color: COLORS.borderPanel },
    ],
  }));
  const labels = barLabels([10, 7, 1], plotWidth, chartHeight, String, COLORS.text).map(
    (label) => ({ ...label, offset: label.offset + 1 }),
  );
  const setup = await testRender(
    <Chart
      rows={rows}
      labels={labels}
      labelWidth={frameWidth}
      labelBorderColor={COLORS.borderPanel}
    />,
    { width: 20, height: 10 },
  );
  try {
    await act(async () => {
      await setup.flush();
    });
    const chartRows = setup.captureCharFrame().split("\n").slice(0, chartHeight + 1);
    expect(chartRows).toHaveLength(chartHeight + 1);
    for (const row of chartRows) {
      expect(row[0]).toBe("│");
      expect(row[frameWidth - 1]).toBe("│");
      expect(Bun.stringWidth(row.slice(0, frameWidth))).toBe(frameWidth);
      expect(row.slice(frameWidth).trim()).toBe("");
    }
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("renders guide-row labels with breathing room without overwriting frame borders", async () => {
  const width = 13;
  const guideRow = {
    segments: [
      { text: "│", color: COLORS.borderPanel },
      { text: "┄".repeat(width - 2), color: COLORS.borderSoft },
      { text: "│", color: COLORS.borderPanel },
    ],
  };
  const setup = await testRender(
    <Chart
      rows={[guideRow, guideRow]}
      labels={[
        { offset: 5, row: 1, text: "13M", color: COLORS.text },
        { offset: 0, row: 2, text: "X", color: COLORS.text },
        { offset: width - 1, row: 2, text: "Y", color: COLORS.text },
      ]}
      labelWidth={width}
      labelBorderColor={COLORS.borderPanel}
    />,
    { width: 20, height: 5 },
  );
  try {
    await act(async () => {
      await setup.flush();
    });
    const rendered = setup.captureCharFrame().split("\n");
    expect(rendered[1]?.slice(0, width)).toBe("│┄┄┄ 13M ┄┄┄│");
    expect(rendered[2]?.[0]).toBe("│");
    expect(rendered[2]?.[width - 1]).toBe("│");
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("labels the token chart plainly, since every series is now local", async () => {
  const frame = await renderDetails(undefined, WIDTH);
  expect(frame).toContain("tokens last 30 days");
  expect(frame).not.toContain("account tokens");
});

test("lays up to three detail sections in a band and wraps the fourth", async () => {
  const frame = await renderDetails([
    { title: "first", rows: [{ label: "one", value: "1" }] },
    { title: "second", rows: [{ label: "two", value: "2" }] },
    { title: "third", rows: [{ label: "three", value: "3" }] },
    { title: "fourth", rows: [{ label: "four", value: "4" }] },
  ], 140);
  const rows = frame.split("\n");
  const firstBand = rows.find((row) => row.includes("first"));

  expect(firstBand).toContain("second");
  expect(firstBand).toContain("third");
  expect(firstBand).not.toContain("fourth");
  expect(rows.findIndex((row) => row.includes("fourth"))).toBeGreaterThan(
    rows.findIndex((row) => row.includes("first")),
  );
});

test("caps stacked detail rows on narrow screens", async () => {
  const frame = await renderDetails([
    { title: "records", rows: [{ label: "sessions", value: "41" }] },
  ], 100);
  const row = frame.split("\n").find((line) => line.includes("sessions"));

  expect(row?.indexOf("41")).toBeLessThan(65);
});

async function renderSpend(
  mutate: (snapshot: ReturnType<UsageProvider["readSnapshot"]>) => void,
  width = 100,
): Promise<string> {
  const snapshot = structuredClone(mockUsageProvider.readSnapshot());
  snapshot.providers.cl.notice = undefined;
  mutate(snapshot);
  const provider: UsageProvider = {
    ...mockUsageProvider,
    readSnapshot: () => snapshot,
    refresh: async () => snapshot,
  };
  const setup = await testRender(
    <App
      provider={provider}
      startup={{ screen: "app", view: "claude", mode: "detailed", useSeverityColors: false }}
    />,
    { width, height: HEIGHT },
  );
  try {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setup.flush();
    });
    return setup.captureCharFrame();
  } finally {
    act(() => setup.renderer.destroy());
  }
}

test("spend renders the exact total, its cap, and the per-model split", async () => {
  const frame = await renderSpend(() => {});

  expect(frame).toContain("spend · cycle since aug 3");
  expect(frame).toContain("exact");
  expect(frame).toContain("$18.42");
  expect(frame).toContain("of $50.00");
  expect(frame).toContain("opus 5");
  expect(frame).toContain("$14.02");
  // A period from before we kept records must not read as a measured zero.
  expect(frame).toContain("not recorded");
});

test("an estimated period is labelled with the price date rather than passing as a bill", async () => {
  const frame = await renderSpend((snapshot) => {
    const spend = snapshot.providers.cl.spend;
    if (!spend) throw new Error("mock provider lost its spend summary");
    spend.current.exactness = "estimated";
    spend.current.limit = null;
    for (const model of spend.current.models) model.exactness = "estimated";
  });

  expect(frame).toContain("est · api rates");
  expect(frame).not.toContain("of $50.00");
});

test("a model with no published price is shown as unpriced, not as free", async () => {
  const frame = await renderSpend((snapshot) => {
    const spend = snapshot.providers.cl.spend;
    if (!spend) throw new Error("mock provider lost its spend summary");
    spend.unpricedModels = ["claude-brand-new"];
    spend.current.models[0]!.cost = null;
    spend.current.models[0]!.exactness = "unavailable";
  });

  expect(frame).toContain("unpriced");
  expect(frame).toContain("brand-new");
});

test("allowance drawn on a prepaid plan is never labelled spend", async () => {
  // A Go subscriber burns allowance and is billed nothing. Calling it spend
  // overstates what they paid by the entire amount.
  const frame = await renderSpend((snapshot) => {
    const spend = snapshot.providers.cl.spend;
    if (!spend) throw new Error("mock provider lost its spend summary");
    spend.current.label = "august 2026";
    spend.current.allowanceUsed = { amountMinor: 1_016_290_000, currency: "USD", exponent: 8 };
    spend.current.total = { amountMinor: 0, currency: "USD", exponent: 8 };
    spend.current.limit = null;
    spend.history = [];
  });

  expect(frame).toContain("allowance used · august 2026");
  expect(frame).not.toContain("spend · august 2026");
  expect(frame).toContain("$10.16");
  // The zero charge must not be shown as the headline figure.
  expect(frame).not.toContain("$0.00");
});

test("a token split of all zeros is omitted rather than shown as measured zero", async () => {
  const frame = await renderSpend((snapshot) => {
    const spend = snapshot.providers.cl.spend;
    if (!spend) throw new Error("mock provider lost its spend summary");
    for (const model of spend.current.models) {
      model.tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    }
  });

  expect(frame).not.toContain("cache-w");
});

test("providers without spend render no spend section", async () => {
  const frame = await renderSpend((snapshot) => {
    snapshot.providers.cl.spend = undefined;
  });

  expect(frame).not.toContain("spend ·");
});
