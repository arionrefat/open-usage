import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSubscriptionEnd, readCodexSubscriptionEnd } from "../../../src/data/real/codex-subscription";

const ACTIVE_UNTIL = "2026-10-05T15:45:25+00:00";

function idToken(claims: unknown): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${payload}.signature`;
}

function authJson(auth: Record<string, unknown>) {
  return { tokens: { id_token: idToken({ "https://api.openai.com/auth": auth }) } };
}

describe("parseSubscriptionEnd", () => {
  test("reads the end of the paid period from the id token claim", () => {
    expect(parseSubscriptionEnd(authJson({ chatgpt_subscription_active_until: ACTIVE_UNTIL }))).toBe(
      Date.parse(ACTIVE_UNTIL),
    );
  });

  test("an api-key sign-in carries no tokens and so no date", () => {
    expect(parseSubscriptionEnd({ OPENAI_API_KEY: "key", tokens: null })).toBeNull();
  });

  test("a token without the claim reads as unknown", () => {
    expect(parseSubscriptionEnd(authJson({ chatgpt_plan_type: "plus" }))).toBeNull();
  });

  test("a payload that is not a readable JWT reads as unknown", () => {
    expect(parseSubscriptionEnd({ tokens: { id_token: "header.%%%.signature" } })).toBeNull();
    expect(parseSubscriptionEnd({ tokens: { id_token: "no-dots" } })).toBeNull();
  });
});

describe("readCodexSubscriptionEnd", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function codexHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "open-usage-codex-"));
    dirs.push(dir);
    return dir;
  }

  test("reads auth.json from the codex home", () => {
    const home = codexHome();
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify(authJson({ chatgpt_subscription_active_until: ACTIVE_UNTIL })),
    );
    expect(readCodexSubscriptionEnd(home)).toBe(Date.parse(ACTIVE_UNTIL));
  });

  test("a missing or half-written file reads as unknown rather than throwing", () => {
    const home = codexHome();
    expect(readCodexSubscriptionEnd(home)).toBeNull();
    writeFileSync(join(home, "auth.json"), '{"tokens":');
    expect(readCodexSubscriptionEnd(home)).toBeNull();
  });
});
