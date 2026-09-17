import { describe, expect, test } from "bun:test";
import { COLORS } from "../../../src/theme";
import {
  capLessLimit,
  formatTokenCount,
  localBurn,
  planEndFrom,
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
      // A distinct outcome, not a label: the overview reads this to suppress a
      // projection it cannot make, rather than splicing words into a sentence.
      outcome: { kind: "no-cap" },
    });
  });
});

describe("planEndFrom", () => {
  const NOW_MS = new Date(2026, 8, 18, 12).getTime();
  const DAY_MS = 24 * 60 * 60 * 1000;

  test("states the local calendar day the paid period stops", () => {
    expect(planEndFrom(new Date(2026, 9, 5, 21).getTime(), NOW_MS)).toEqual({
      text: "until Oct 5",
      isSoon: false,
    });
  });

  test("flags an end within three days", () => {
    expect(planEndFrom(NOW_MS + 2 * DAY_MS, NOW_MS)?.isSoon).toBe(true);
    expect(planEndFrom(NOW_MS + 4 * DAY_MS, NOW_MS)?.isSoon).toBe(false);
  });

  test("a date already past is a stale reading, so nothing is claimed", () => {
    expect(planEndFrom(NOW_MS - DAY_MS, NOW_MS)).toBeUndefined();
    expect(planEndFrom(null, NOW_MS)).toBeUndefined();
  });
});
