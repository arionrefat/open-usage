import { describe, expect, test } from "bun:test";
import {
  barLabels,
  bars,
  formatDelta,
  formatTokens,
  planChart,
  sparkline,
  stackedBar,
  type ChartRow,
  type ChartSegment,
} from "../../src/lib/chart";
import { buildMeter } from "../../src/lib/meter";
import { COLORS } from "../../src/theme";

function rowText(row: ChartRow): string {
  return row.segments.map((segment) => segment.text).join("");
}

describe("chart edge cases", () => {
  test("renders zero sparkline values on a visible baseline", () => {
    expect(sparkline([0, 0], 4)).toBe("▁▁▁▁");
  });

  test("keeps stacked bars at the requested width", () => {
    const segments = stackedBar(
      [
        { value: 1, color: "red" },
        { value: 1, color: "green" },
        { value: 0, color: "blue" },
      ],
      1,
    );
    expect(segments.map((segment) => segment.text).join("")).toHaveLength(1);
  });

  test("uses the track color when every stacked value is zero", () => {
    expect(stackedBar([{ value: 0, color: "red" }], 3)).toEqual([
      { text: "▀▀▀", color: COLORS.track },
    ]);
  });
});

describe("formatDelta", () => {
  test("states a modest change as a percentage in either direction", () => {
    expect(formatDelta(120, 100)).toEqual({ text: "20%", direction: "up" });
    expect(formatDelta(80, 100)).toEqual({ text: "20%", direction: "down" });
  });

  test("switches to a multiplier once growth outruns readable percentages", () => {
    expect(formatDelta(399, 100)).toEqual({ text: "299%", direction: "up" });
    expect(formatDelta(400, 100)).toEqual({ text: "4.0x", direction: "up" });
    expect(formatDelta(6130, 680)).toEqual({ text: "9.0x", direction: "up" });
    expect(formatDelta(20000, 100)).toEqual({ text: "200x", direction: "up" });
  });

  test("calls a silent prior window new rather than dividing by zero", () => {
    expect(formatDelta(50, 0)).toEqual({ text: "new", direction: "up" });
    expect(formatDelta(0, 0)).toBeNull();
  });

  test("returns nothing when there is no prior window to compare", () => {
    expect(formatDelta(50, null)).toBeNull();
  });

  test("reports a rounding-level change as flat, not a bogus 0%", () => {
    expect(formatDelta(100.2, 100)).toEqual({ text: "flat", direction: "flat" });
  });
});

describe("stackedBar seams", () => {
  const stackText = (segments: ChartSegment[]): string =>
    segments.map((segment) => segment.text).join("");

  test("blanks the seam between adjacent segments without changing the width", () => {
    const segments = stackedBar(
      [
        { value: 1, color: "red" },
        { value: 1, color: "green" },
      ],
      20,
      "▀",
      2,
    );
    expect(stackText(segments)).toBe(`${"▀".repeat(8)}  ${"▀".repeat(10)}`);
  });

  test("leaves a sole segment solid across the full width", () => {
    const segments = stackedBar(
      [
        { value: 0, color: "red" },
        { value: 5, color: "green" },
        { value: 0, color: "blue" },
      ],
      12,
      "▀",
      2,
    );
    expect(stackText(segments)).toBe("▀".repeat(12));
  });

  test("adds no seam after the last segment carrying a value", () => {
    const segments = stackedBar(
      [
        { value: 1, color: "red" },
        { value: 1, color: "green" },
        { value: 0, color: "blue" },
      ],
      10,
      "▀",
      2,
    );
    expect(stackText(segments)).toBe(`${"▀".repeat(3)}  ${"▀".repeat(5)}`);
    expect(segments.at(-1)?.color).toBe("green");
  });

  test("keeps one colored column when a segment is narrower than the seam", () => {
    const segments = stackedBar(
      [
        { value: 1, color: "red" },
        { value: 11, color: "green" },
      ],
      12,
      "▀",
      2,
    );
    // A 1-column share cannot fund a seam, so it stays visible instead of blanking.
    expect(stackText(segments)).toBe("▀".repeat(12));
    expect(segments[0]?.text).toBe("▀");
    expect(segments[0]?.color).toBe("red");
  });

  test("spans exactly the requested width for every seam and part count", () => {
    for (const width of [1, 2, 3, 7, 40, 111]) {
      // Fractional, negative and non-finite seams round down to whole columns
      // rather than overrunning the row a cell at a time.
      for (const gap of [0, 1, 2, 3, 1.5, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
        const segments = stackedBar(
          [
            { value: 3, color: "red" },
            { value: 4, color: "green" },
            { value: 5, color: "blue" },
          ],
          width,
          "▀",
          gap,
        );
        expect(stackText(segments)).toHaveLength(width);
      }
    }
  });

  test("preserves an over-limit value in the meter label", () => {
    const meter = buildMeter(118, 10, COLORS.info);
    expect(meter.fill).toHaveLength(10);
    expect(meter.percentLabel).toBe("118%");
  });
});

describe("bars", () => {
  test("every row spans exactly the requested width", () => {
    const rows = bars([3, 0, 7, 1, 5], 23, 8, "red");
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(rowText(row)).toHaveLength(23);
  });

  test("distributes leftover columns across integer bar widths", () => {
    // 5 values into 23 columns: base 4 plus 3 leftover columns spread evenly.
    const rows = bars([1, 1, 1, 1, 1], 23, 2, "red");
    const bottom = rowText(rows[1]!);
    expect(bottom).toBe("█".repeat(23));
  });

  test("scales the tallest bar to the full height and keeps blocks solid", () => {
    const rows = bars([10, 5], 4, 4, "red");
    const columnHeights = [0, 2].map(
      (col) => rows.filter((row) => rowText(row)[col] === "█").length,
    );
    expect(columnHeights).toEqual([4, 2]);
    const glyphs = new Set(rows.flatMap((row) => rowText(row).split("")));
    expect([...glyphs].every((glyph) => ["█", " ", "┄", "▁"].includes(glyph))).toBe(true);
  });

  test("gives tiny non-zero values one row and zero values a baseline marker", () => {
    const rows = bars([100, 1, 0], 3, 8, "red");
    const bottom = rowText(rows[7]!);
    expect(bottom).toBe("██▁");
  });

  test("resamples when there are more points than columns", () => {
    const rows = bars(Array.from({ length: 30 }, (_, i) => i + 1), 10, 4, "red");
    for (const row of rows) expect(rowText(row)).toHaveLength(10);
  });

  test("keeps a narrow-chart peak instead of interpolating it away", () => {
    const rows = bars([0, 100, 0, 0], 2, 4, "red");
    expect(rows.filter((row) => rowText(row)[0] === "█")).toHaveLength(4);
  });

  test("does not duplicate a peak across non-divisible buckets", () => {
    const rows = bars([0, 0, 100, 0, 0], 2, 4, "red");
    const columnHeights = [0, 1].map(
      (column) => rows.filter((row) => rowText(row)[column] === "█").length,
    );
    expect(columnHeights).toEqual([0, 4]);
  });

  test("labels active bars when the chart has room", () => {
    const labels = barLabels([0, 100, 0, 50], 16, (value) => `${value}K`, "red");
    expect(labels.map(({ offset, text }) => ({ offset, text }))).toEqual([
      { offset: 4, text: "100K" },
      { offset: 12, text: "50K" },
    ]);
  });

  test("clips labels that are wider than the chart", () => {
    const labels = barLabels([123_456], 3, String, "red");
    expect(labels).toEqual([{ offset: 0, text: "12…", color: "red" }]);
    expect(labels[0]!.offset + Bun.stringWidth(labels[0]!.text)).toBeLessThanOrEqual(3);
  });
});

describe("planChart", () => {
  const items = [
    { value: 88, color: "orange", label: "claude" },
    { value: null, color: "green", label: "codex" },
    { value: 41, color: "blue", label: "go" },
  ];

  test("uses the fixed design geometry", () => {
    const chart = planChart(items);
    expect(chart.rows).toHaveLength(10);
    expect(chart.width).toBe(39);
    for (const row of chart.rows) expect(rowText(row)).toHaveLength(39);
    expect(chart.baseline).toBe(`  0 └${"─".repeat(34)}`);
  });

  test("places ticks at 100 and 50 only", () => {
    const chart = planChart(items);
    const ticks = chart.rows.map((row) => row.segments[0]!.text);
    expect(ticks[0]).toBe("100 │");
    expect(ticks[4]).toBe(" 50 │");
    for (const tick of [...ticks.slice(1, 4), ...ticks.slice(5)]) expect(tick).toBe("    │");
  });

  test("rounds bar heights and keeps a minimum of one row", () => {
    const chart = planChart([{ value: 88, color: "orange", label: "claude" }]);
    const filled = chart.rows.filter((row) => rowText(row).includes("█")).length;
    expect(filled).toBe(9);
    const tiny = planChart([{ value: 1, color: "orange", label: "claude" }]);
    expect(tiny.rows.filter((row) => rowText(row).includes("█"))).toHaveLength(1);
  });

  test("renders a null provider as an empty bar with dimmed labels", () => {
    const chart = planChart(items);
    for (const row of chart.rows) {
      // Columns 18-25 hold the second bar; a null value never fills them.
      expect(rowText(row).slice(18, 26)).toBe(" ".repeat(8));
    }
    expect(chart.names[1]).toEqual({ text: `${" ".repeat(5)} codex  `, color: COLORS.textGhost });
    expect(chart.values[1]).toEqual({ text: `${" ".repeat(5)}   -    `, color: COLORS.textGhost });
    expect(chart.values[0]).toEqual({ text: `${" ".repeat(5)}  88%   `, color: "orange" });
  });
});

describe("formatTokens", () => {
  test("scales across billions, millions and thousands", () => {
    expect(formatTokens(1200)).toBe("1.20B");
    expect(formatTokens(42)).toBe("42M");
    // A light provider must not collapse to a flat "0M".
    expect(formatTokens(0.049)).toBe("49K");
    expect(formatTokens(0.0004)).toBe("<1K");
    expect(formatTokens(0)).toBe("0");
  });
});
