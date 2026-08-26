import { describe, expect, test } from "bun:test";
import {
  addToBucket,
  dailyDateKeys,
  formatCountdown,
  formatRate,
  localDateKey,
  seriesFromBuckets,
  tokensPerHour,
  type HourBuckets,
} from "../../../src/data/real/aggregate";

const NOW = new Date(2026, 6, 30, 14, 30); // local Jul 30 2026, 14:30

function bucketsAt(entries: Array<[Date, number]>): HourBuckets {
  const buckets: HourBuckets = new Map();
  for (const [date, tokens] of entries) addToBucket(buckets, date.getTime(), tokens);
  return buckets;
}

describe("daily date keys", () => {
  test("produces 30 local dates ending today", () => {
    const dates = dailyDateKeys(NOW);
    expect(dates).toHaveLength(30);
    expect(dates.at(-1)).toBe("2026-07-30");
    expect(dates[0]).toBe("2026-07-01");
  });

  test("crosses month boundaries", () => {
    const dates = dailyDateKeys(new Date(2026, 7, 2), 5);
    expect(dates).toEqual(["2026-07-29", "2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"]);
  });
});

describe("series from hour buckets", () => {
  test("fills daily and hourly slots in millions", () => {
    const buckets = bucketsAt([
      [new Date(2026, 6, 30, 13, 5), 2_000_000],
      [new Date(2026, 6, 30, 13, 40), 1_000_000],
      [new Date(2026, 6, 29, 9, 0), 4_000_000],
    ]);
    const series = seriesFromBuckets(buckets, dailyDateKeys(NOW), NOW);

    expect(series.daily).toHaveLength(30);
    expect(series.hourly).toHaveLength(24);
    expect(series.daily.at(-1)).toBeCloseTo(3);
    expect(series.daily.at(-2)).toBeCloseTo(4);
    expect(series.hourly[13]).toBeCloseTo(3);
    expect(series.hourly[9]).toBe(0); // yesterday's 9am stays out of today's hourly
  });

  test("zero-fills when there is no data", () => {
    const series = seriesFromBuckets(new Map(), dailyDateKeys(NOW), NOW);
    expect(series.daily).toHaveLength(30);
    expect(series.hourly).toHaveLength(24);
    expect(series.daily.every((value) => value === 0)).toBe(true);
    expect(series.hourly.every((value) => value === 0)).toBe(true);
  });

  test("ignores events outside the date window", () => {
    const buckets = bucketsAt([[new Date(2026, 4, 1, 12, 0), 9_000_000]]);
    const series = seriesFromBuckets(buckets, dailyDateKeys(NOW), NOW);
    expect(series.daily.every((value) => value === 0)).toBe(true);
  });
});

describe("burn rate", () => {
  test("divides by the time that has run, not by the whole window", () => {
    // NOW is 14:30, so the 3h window has only 2.5h behind it. Charging 9M
    // against three whole hours reads 3.0M/h for work that ran at 3.6M/h.
    const buckets = bucketsAt([
      [new Date(2026, 6, 30, 14, 10), 3_000_000],
      [new Date(2026, 6, 30, 13, 10), 3_000_000],
      [new Date(2026, 6, 30, 12, 10), 3_000_000],
      [new Date(2026, 6, 30, 8, 0), 50_000_000], // outside the 3h window
    ]);
    expect(tokensPerHour(buckets, NOW)).toBeCloseTo(3_600_000);
  });

  test("counts a whole window once the current hour has fully run", () => {
    const endOfHour = new Date(2026, 6, 30, 14, 59, 59, 999);
    const buckets = bucketsAt([
      [new Date(2026, 6, 30, 14, 10), 3_000_000],
      [new Date(2026, 6, 30, 13, 10), 3_000_000],
      [new Date(2026, 6, 30, 12, 10), 3_000_000],
    ]);
    expect(tokensPerHour(buckets, endOfHour)).toBeCloseTo(3_000_000, 0);
  });

  test("reports a finite rate at the very top of a one-hour window", () => {
    const topOfHour = new Date(2026, 6, 30, 14, 0, 0, 0);
    const buckets = bucketsAt([[new Date(2026, 6, 30, 14, 0), 1_000_000]]);
    expect(Number.isFinite(tokensPerHour(buckets, topOfHour, 1))).toBe(true);
  });

  test("is zero without recent activity", () => {
    expect(tokensPerHour(new Map(), NOW)).toBe(0);
  });
});

describe("formatting", () => {
  test("rates", () => {
    expect(formatRate(12_400_000)).toBe("12.4M tok/h");
    expect(formatRate(845_000)).toBe("845K tok/h");
    expect(formatRate(12)).toBe("12 tok/h");
  });

  test("countdowns clamp at zero", () => {
    expect(formatCountdown(2 * 86_400_000 + 11 * 3_600_000)).toBe("2d 11h");
    expect(formatCountdown(97 * 60_000)).toBe("1h 37m");
    expect(formatCountdown(42 * 60_000)).toBe("42m");
    expect(formatCountdown(-5_000)).toBe("0m");
  });
});

describe("bucket plumbing", () => {
  test("addToBucket drops non-finite and non-positive input", () => {
    const buckets: HourBuckets = new Map();
    addToBucket(buckets, Number.NaN, 10);
    addToBucket(buckets, Date.now(), 0);
    addToBucket(buckets, Date.now(), -5);
    expect(buckets.size).toBe(0);
  });

});

describe("local date key", () => {
  test("pads month and day", () => {
    expect(localDateKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
