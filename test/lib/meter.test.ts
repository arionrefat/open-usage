import { describe, expect, test } from "bun:test";
import { buildMeter, emptyMeter } from "../../src/lib/meter";
import { COLORS } from "../../src/theme";

const WIDTH = 10;
const ACCENT = "#123456";

describe("buildMeter", () => {
  test.each([
    [0, "", "█".repeat(WIDTH)],
    [50, "█".repeat(5), "█".repeat(5)],
    [100, "█".repeat(WIDTH), ""],
  ])("fills the expected width at %i percent", (percent, fill, track) => {
    const meter = buildMeter(percent, WIDTH, ACCENT);

    expect(meter.fill).toBe(fill);
    expect(meter.track).toBe(track);
  });

  test.each([
    [69, ACCENT],
    [70, COLORS.warn],
    [84, COLORS.warn],
    [85, COLORS.danger],
  ])("uses the expected severity color at %i percent", (percent, color) => {
    const meter = buildMeter(percent, WIDTH, ACCENT);

    expect(meter.color).toBe(color);
    expect(meter.percentColor).toBe(color);
  });

  test("caps fill at the meter width while preserving an overflow percentage", () => {
    const meter = buildMeter(118, WIDTH, ACCENT);

    expect(meter.fill).toBe("█".repeat(WIDTH));
    expect(meter.track).toBe("");
    expect(meter.percentLabel).toBe("118%");
    expect(meter.percentColor).toBe(COLORS.danger);
  });

  test("uses a configurable danger threshold", () => {
    expect(buildMeter(85, WIDTH, ACCENT, false, 90).color).toBe(COLORS.warn);
    expect(buildMeter(90, WIDTH, ACCENT, false, 90).color).toBe(COLORS.danger);
  });
});

test("emptyMeter returns a disabled, width-exact meter", () => {
  expect(emptyMeter(WIDTH)).toEqual({
    fill: "",
    track: "█".repeat(WIDTH),
    color: COLORS.track,
    percentLabel: "-",
    percentColor: COLORS.textDisabled,
  });
});
