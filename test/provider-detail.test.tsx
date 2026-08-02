import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { App } from "../src/app";
import { mockUsageProvider } from "../src/data/mock-provider";
import type { DetailSection, UsageProvider } from "../src/data/types";

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

async function renderDetails(details: DetailSection[] | undefined): Promise<string> {
  const setup = await testRender(
    <App
      provider={providerWith(details)}
      startup={{ screen: "app", view: "claude", mode: "detailed", useSeverityColors: false }}
    />,
    { width: WIDTH, height: HEIGHT },
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
