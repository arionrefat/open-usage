import { describe, expect, test } from "bun:test";
import { formatMoney, modelShares, shortModelName } from "../../src/lib/spend";
import type { ModelSpend } from "../../src/data/types";

function model(costMinor: number | null, tokens = 0): ModelSpend {
  return {
    model: "claude-opus-5",
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: costMinor === null ? null : { amountMinor: costMinor, currency: "USD", exponent: 2 },
    exactness: costMinor === null ? "unavailable" : "exact",
  };
}

describe("formatMoney", () => {
  test("renders USD to the cent", () => {
    expect(formatMoney({ amountMinor: 1842, currency: "USD", exponent: 2 })).toBe("$18.42");
  });

  test("keeps a whole-dollar figure explicit", () => {
    expect(formatMoney({ amountMinor: 5000, currency: "USD", exponent: 2 })).toBe("$50.00");
  });

  test("names a non-dollar currency rather than mislabelling it", () => {
    expect(formatMoney({ amountMinor: 1050, currency: "EUR", exponent: 2 })).toBe("10.50 EUR");
  });
});

describe("shortModelName", () => {
  test("drops the vendor prefix and reads the version as a number", () => {
    expect(shortModelName("claude-opus-4-8")).toBe("opus 4.8");
    expect(shortModelName("claude-haiku-4-5")).toBe("haiku 4.5");
    expect(shortModelName("claude-opus-5")).toBe("opus 5");
  });

  test("leaves an unrecognised shape readable rather than mangling it", () => {
    expect(shortModelName("claude-brand-new-thing")).toBe("brand-new-thing");
    expect(shortModelName("gpt-5")).toBe("gpt 5");
  });
});

describe("modelShares", () => {
  test("shares by cost when costs are known", () => {
    const shares = modelShares([model(7500), model(2500)]);

    expect(shares[0]).toBeCloseTo(75, 10);
    expect(shares[1]).toBeCloseTo(25, 10);
  });

  test("falls back to token volume so unpriced models still rank", () => {
    const shares = modelShares([model(null, 300), model(null, 100)]);

    expect(shares[0]).toBeCloseTo(75, 10);
    expect(shares[1]).toBeCloseTo(25, 10);
  });

  test("an empty period yields zero shares rather than dividing by zero", () => {
    expect(modelShares([model(null, 0)])).toEqual([0]);
    expect(modelShares([])).toEqual([]);
  });
});
