import { describe, expect, test } from "bun:test";
import { parseOpencodeAuth, readOpencodeAuth } from "../../../src/data/real/opencode-auth";

describe("parseOpencodeAuth", () => {
  test("reads oauth expiry and masks the api key", () => {
    const auth = parseOpencodeAuth({
      openai: { type: "oauth", access: "secret", refresh: "secret", expires: 1_785_350_000_000 },
      "opencode-go": { type: "api", key: "oc_live_0123456789abcdefghijklmnop" },
    });
    expect(auth.openai?.expiresMs).toBe(1_785_350_000_000);
    expect(auth.opencodeGo?.maskedKey).toBe("oc_l•••••••••mnop");
    expect(auth.opencodeGo?.maskedKey).not.toContain("0123456789");
  });

  test("returns empty entries for missing or malformed data", () => {
    expect(parseOpencodeAuth(null)).toEqual({ openai: null, opencodeGo: null });
    expect(parseOpencodeAuth({ openai: { type: "api" } }).openai).toBeNull();
    expect(parseOpencodeAuth({ "opencode-go": { type: "api" } }).opencodeGo).toBeNull();
  });
});

describe("readOpencodeAuth", () => {
  test("missing file yields empty auth", () => {
    expect(readOpencodeAuth("/nonexistent/auth.json")).toEqual({ openai: null, opencodeGo: null });
  });
});
