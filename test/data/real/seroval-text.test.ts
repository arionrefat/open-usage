import { describe, expect, test } from "bun:test";
import {
  booleanField,
  hasValue,
  isEmptyArrayAtKey,
  numberField,
  objectAtKey,
  objectLiterals,
  stringField,
  timestampField,
} from "../../../src/data/real/seroval-text";

describe("objectLiterals", () => {
  test("returns rows rather than the envelope that contains them", () => {
    // The whole payload also carries every required key, so a naive brace scan
    // would report it as one extra phantom row.
    const blocks = objectLiterals('{rows:[{a:1,b:2},{a:3,b:4}]}', ["a", "b"]);
    expect(blocks).toEqual(["{a:1,b:2}", "{a:3,b:4}"]);
  });

  test("returns the outer object when a nested one lacks the required keys", () => {
    const blocks = objectLiterals('{a:1,b:2,meta:{plan:"sub"}}', ["a", "b"]);
    expect(blocks).toEqual(['{a:1,b:2,meta:{plan:"sub"}}']);
  });

  test("ignores braces inside strings", () => {
    expect(objectLiterals('{a:"}{",b:1}', ["a", "b"])).toEqual(['{a:"}{",b:1}']);
  });

  test("skips objects missing any required key", () => {
    expect(objectLiterals("{a:1}", ["a", "b"])).toEqual([]);
  });
});

describe("field readers", () => {
  const block = '{name:"kimi",count:42,ratio:-1.5e3,live:!0,gone:!1,plain:true}';

  test("reads strings and numbers, including negatives and exponents", () => {
    expect(stringField(block, "name")).toBe("kimi");
    expect(numberField(block, "count")).toBe(42);
    expect(numberField(block, "ratio")).toBe(-1500);
  });

  test("reads minified booleans as well as spelled-out ones", () => {
    expect(booleanField(block, "live")).toBe(true);
    expect(booleanField(block, "gone")).toBe(false);
    expect(booleanField(block, "plain")).toBe(true);
  });

  test("an absent key reads as absent, not as zero or empty", () => {
    expect(stringField(block, "missing")).toBeNull();
    expect(numberField(block, "missing")).toBeNull();
    expect(booleanField(block, "missing")).toBe(false);
  });

  test("does not match a key that merely ends with the one asked for", () => {
    // numberField matches case-insensitively, so only the word boundary keeps
    // `xcount` and `sub_count` from being read as `count`.
    expect(numberField("{xcount:9,count:1}", "count")).toBe(1);
    expect(numberField("{sub_count:9,count:1}", "count")).toBe(1);
    expect(stringField('{xname:"wrong",name:"right"}', "name")).toBe("right");
  });
});

describe("hasValue", () => {
  test("distinguishes a present value from null, false and absence", () => {
    const block = "{set:1,nulled:null,off:false,minified:!1}";
    expect(hasValue(block, "set")).toBe(true);
    expect(hasValue(block, "nulled")).toBe(false);
    expect(hasValue(block, "off")).toBe(false);
    expect(hasValue(block, "minified")).toBe(false);
    expect(hasValue(block, "absent")).toBe(false);
  });
});

describe("timestampField", () => {
  test("reads a Date constructor behind a back-reference binding", () => {
    expect(timestampField('{at:$R[2]=new Date("2026-08-17T13:04:12.000Z")}', "at")).toBe(
      Date.parse("2026-08-17T13:04:12.000Z"),
    );
  });

  test("falls back to epoch milliseconds and to an iso string", () => {
    expect(timestampField("{at:1755000000000}", "at")).toBe(1755000000000);
    expect(timestampField('{at:"2026-08-17T13:04:12.000Z"}', "at")).toBe(
      Date.parse("2026-08-17T13:04:12.000Z"),
    );
  });
});

describe("objectAtKey", () => {
  test("takes the literal bound to the key, through a binding", () => {
    expect(objectAtKey('{w:$R[4]={pct:17}}', "w")).toBe("w:$R[4]={pct:17}");
  });

  test("a bare back-reference yields nothing rather than the next key's literal", () => {
    // The serializer emits a repeated object as a bare `$R[n]`. Scanning onward
    // would silently hand one window the following window's numbers.
    expect(objectAtKey("{first:$R[4],second:{pct:75}}", "first")).toBeNull();
  });
});

describe("isEmptyArrayAtKey", () => {
  test("recognises an explicitly empty array, bound or not", () => {
    expect(isEmptyArrayAtKey("{usage:$R[1]=[]}", "usage")).toBe(true);
    expect(isEmptyArrayAtKey("{usage:[]}", "usage")).toBe(true);
  });

  test("a populated or absent array is not empty", () => {
    expect(isEmptyArrayAtKey("{usage:[{a:1}]}", "usage")).toBe(false);
    expect(isEmptyArrayAtKey("{other:[]}", "usage")).toBe(false);
  });
});
