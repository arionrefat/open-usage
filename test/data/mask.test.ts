import { describe, expect, test } from "bun:test";
import { maskCredential } from "../../src/data/mask";

describe("maskCredential", () => {
  test("returns an empty string for an empty credential", () => {
    expect(maskCredential("")).toBe("");
  });

  test("replaces short credentials entirely with bullets", () => {
    expect(maskCredential("secret")).toBe("••••••");
  });

  test("masks every character at the 24-character boundary", () => {
    expect(maskCredential("a".repeat(24))).toBe("•".repeat(24));
  });

  test("keeps the first and last four characters of long credentials", () => {
    expect(maskCredential("abcd" + "x".repeat(17) + "wxyz")).toBe(
      `abcd${"•".repeat(9)}wxyz`,
    );
  });
});
