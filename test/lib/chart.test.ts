import { describe, expect, test } from "bun:test";
import {
  bars,
  formatTokens,
  planChart,
  sparkline,
  stackedBar,
  type ChartRow,
} from "../../src/lib/chart";
import { buildMeter } from "../../src/lib/meter";
import { COLORS } from "../../src/theme";

function rowText(row: ChartRow): string {
  return row.segments.map((segment) => segment.text).join("");
}

describe("chart edge cases", () => {
  test("renders zero sparkline values as empty cells", () => {
    expect(sparkline([0, 0], 4)).toBe("    ");
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
    expect([...glyphs].every((glyph) => glyph === "█" || glyph === " ")).toBe(true);
  });

  test("gives tiny non-zero values one row and zero values none", () => {
    const rows = bars([100, 1, 0], 3, 8, "red");
    const bottom = rowText(rows[7]!);
    expect(bottom).toBe("██ ");
  });

  test("resamples when there are more points than columns", () => {
    const rows = bars(Array.from({ length: 30 }, (_, i) => i + 1), 10, 4, "red");
    for (const row of rows) expect(rowText(row)).toHaveLength(10);
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
