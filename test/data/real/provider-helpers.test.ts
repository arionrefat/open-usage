import { describe, expect, test } from "bun:test";
import { COLORS } from "../../../src/theme";
import {
  capLessLimit,
  formatTokenCount,
  localBurn,
  resetText,
} from "../../../src/data/real/provider-helpers";

describe("capLessLimit", () => {
  test("builds the complete unavailable-limit presentation", () => {
    expect(capLessLimit("weekly", "week", "weekly limit", "offline", "source note")).toEqual({
      id: "weekly",
      label: "week",
      detailLabel: "weekly limit",
      percent: null,
      valueLabel: "n/a",
      valueColor: COLORS.textGhost,
      reset: "offline",
      footnote: "source note",
    });
  });
});

describe("resetText", () => {
  test("formats a known future reset", () => {
    expect(resetText(3_600_000, 0)).toBe("resets in 1h 0m");
  });

  test("reports an unknown reset timestamp", () => {
    expect(resetText(null, 0)).toBe("reset unknown");
  });
});

describe("formatTokenCount", () => {
  test.each([
    [999, "999"],
    [1_000, "1K"],
    [999_499, "999K"],
    [999_999, "1.0M"],
    [1_000_000, "1.0M"],
    [9_999_999, "10.0M"],
    [10_000_000, "10M"],
  ])("formats %d tokens as %s", (tokens, expected) => {
    expect(formatTokenCount(tokens)).toBe(expected);
  });
});

describe("localBurn", () => {
  test("labels a token rate without inventing cap data", () => {
    expect(localBurn(1_500)).toEqual({
      limit: "local burn only",
      timeToReset: "no cap data",
      rate: "2K tok/h",
      projectedPercent: 0,
      capsOutAt: "no cap data",
    });
  });
});
