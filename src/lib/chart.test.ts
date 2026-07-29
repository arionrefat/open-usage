import { describe, expect, test } from "bun:test";
import { sparkline, stackedBar } from "./chart";
import { buildMeter } from "./meter";
import { COLORS } from "../theme";

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
