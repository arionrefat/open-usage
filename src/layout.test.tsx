import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { App } from "./app";
import { mockUsageProvider } from "./data/mock-provider";
import { VIEW_KEYS, type OverviewMode, type ViewKey } from "./state/app-state";

/** 60 is the narrowest width the chrome is expected to stay legible at. */
const WIDTHS = [60, 80, 100, 140];
const HEIGHT = 44;

async function renderRows(width: number, view: ViewKey, mode: OverviewMode): Promise<string[]> {
  const setup = await testRender(
    <App
      provider={mockUsageProvider}
      startup={{ screen: "app", view, mode, useSeverityColors: false, isDailySplitVisible: true }}
    />,
    { width, height: HEIGHT },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await setup.flush();
    // The captured frame ends with a trailing newline; drop the empty row it leaves.
    return setup.captureCharFrame().replace(/\n$/, "").split("\n");
  } finally {
    act(() => setup.renderer.destroy());
  }
}

function rowContaining(rows: string[], needle: string): string {
  return rows.find((row) => row.includes(needle)) ?? "";
}

describe("chrome stays on one row", () => {
  for (const width of WIDTHS) {
    test(`header does not wrap at ${width} columns`, async () => {
      const rows = await renderRows(width, "overview", "detailed");
      const header = rowContaining(rows, "limits");
      // Both groups on one row means the line never overflowed into a second.
      expect(header).toContain("updated");
    });

    test(`header keeps a gap before the alert group at ${width} columns`, async () => {
      const rows = await renderRows(width, "overview", "detailed");
      expect(rowContaining(rows, "limits")).toMatch(/\s▲/);
    });

    test(`tab strip does not wrap at ${width} columns`, async () => {
      const rows = await renderRows(width, "overview", "detailed");
      expect(rowContaining(rows, "1 overview")).toContain("range");
    });
  }
});

describe("no adjacent groups collide", () => {
  /** Exact collisions observed before the overflow guard existed. */
  const COLLISIONS = ["providers▲", "codexPlus", "opencode goGo", "claude codeMax", "models88%"];

  for (const width of WIDTHS) {
    for (const mode of ["detailed", "simple"] as const) {
      test(`${mode} overview at ${width} columns`, async () => {
        const frame = (await renderRows(width, "overview", mode)).join("\n");
        for (const collision of COLLISIONS) expect(frame).not.toContain(collision);
      });
    }
  }
});

test("simple overview uses the fixed-geometry plan chart", async () => {
  const frame = (await renderRows(140, "overview", "simple")).join("\n");
  expect(frame).toContain("plan usage");
  expect(frame).toContain("100 │");
  expect(frame).toContain(" 50 │");
  expect(frame).toContain(`  0 └${"─".repeat(34)}`);
  expect(frame).toContain("share of limit consumed across providers");
  expect(frame).toContain("of all consumption");
  expect(frame).toContain("went to claude code");
  expect(frame).not.toContain("largest share");
});

test("simple overview keeps all three providers in the legend", async () => {
  const rows = await renderRows(140, "overview", "simple");
  // codex ships expired in the mock, so its off-state legend must still render.
  expect(rowContaining(rows, "▎codex")).toContain("of all consumption");
  expect(rows.join("\n")).toContain("subscription ended");
});

test("detailed overview shows sessions in the usage share block", async () => {
  const frame = (await renderRows(140, "overview", "detailed")).join("\n");
  expect(frame).toMatch(/\d+ sessions/);
});

describe("every view renders at every width", () => {
  for (const width of WIDTHS) {
    for (const view of VIEW_KEYS) {
      test(`${view} at ${width} columns`, async () => {
        const rows = await renderRows(width, view, "detailed");
        expect(rows.length).toBe(HEIGHT);
        for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
      });
    }
  }
});
