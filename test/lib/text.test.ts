import { describe, expect, test } from "bun:test";
import { columnWidth, padEnd, padStart, truncate } from "../../src/lib/text";

describe("columnWidth", () => {
  test("counts plain ASCII columns", () => {
    expect(columnWidth("dashboard")).toBe(9);
  });

  test("counts wide CJK graphemes as two columns", () => {
    expect(columnWidth("你好")).toBe(4);
  });

  test("counts an emoji by its displayed width", () => {
    expect(columnWidth("👍🏽")).toBe(2);
  });
});

describe("truncate", () => {
  test("leaves text that already fits unchanged", () => {
    expect(truncate("usage", 5)).toBe("usage");
  });

  test("truncates ASCII text to the requested width", () => {
    const result = truncate("dashboard", 6);

    expect(result).toBe("dashb…");
    expect(columnWidth(result)).toBe(6);
  });

  test("keeps wide graphemes whole when truncating", () => {
    const result = truncate("你好世界", 6);

    expect(result).toBe("你好…");
    expect(columnWidth(result)).toBe(5);
  });

  test("keeps emoji grapheme clusters whole when truncating", () => {
    const result = truncate("A👍🏽BC", 4);

    expect(result).toBe("A👍🏽…");
    expect(columnWidth(result)).toBe(4);
  });
});

describe("padding", () => {
  test("pads ASCII on either side to the exact width", () => {
    expect(padEnd("go", 5)).toBe("go   ");
    expect(padStart("go", 5)).toBe("   go");
    expect(columnWidth(padEnd("go", 5))).toBe(5);
    expect(columnWidth(padStart("go", 5))).toBe(5);
  });

  test("pads wide text by display columns", () => {
    expect(padEnd("你好", 6)).toBe("你好  ");
    expect(padStart("你好", 6)).toBe("  你好");
  });
});
