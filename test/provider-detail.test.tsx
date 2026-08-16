import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { App } from "../src/app";
import { mockUsageProvider } from "../src/data/mock-provider";
import type { DetailSection, UsageProvider } from "../src/data/types";

const WIDTH = 60;
const HEIGHT = 60;

function providerWith(details: DetailSection[] | undefined, activityScope?: "account" | "local"): UsageProvider {
  const snapshot = structuredClone(mockUsageProvider.readSnapshot());
  snapshot.providers.cl.details = details;
  snapshot.providers.cl.activityScope = activityScope;
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
  activityScope?: "account" | "local",
): Promise<string> {
  const setup = await testRender(
    <App
      provider={providerWith(details, activityScope)}
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

test("frames the token chart with peak and dates on its borders", async () => {
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
  const last = axisLabel(dates.at(-1));
  const top = rows.find((row) => row.includes("tokens last 30 days"));
  const bottom = rows.find((row) => row.includes(first));

  expect(top?.trim()).toMatch(/^┌─ tokens last 30 days .* peak \d+[MKB]? ─┐$/);
  expect(bottom?.trim()).toStartWith(`└─ ${first} `);
  expect(bottom?.trim()).toEndWith(` ${last} ─┘`);
  const topIndex = rows.findIndex((row) => row.includes("tokens last 30 days"));
  expect(rows.slice(topIndex + 1, topIndex + 9).every((row) => row.trim().startsWith("│"))).toBe(true);
  expect(rows.slice(topIndex + 1, topIndex + 9).every((row) => row.trimEnd().endsWith("│"))).toBe(true);
});

test("labels account-wide token charts explicitly", async () => {
  const frame = await renderDetails(undefined, WIDTH, "account");
  expect(frame).toContain("account tokens last 30 days");
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
