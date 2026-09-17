import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, timestampMs } from "./json";

const AUTH_CLAIM = "https://api.openai.com/auth";

/**
 * The app-server reports the plan but not when it runs out. The only local
 * statement of that is a claim inside the id token Codex keeps in `auth.json`.
 * Only the claim is decoded; the token itself is never kept, logged or sent.
 */
export function parseSubscriptionEnd(authJson: unknown): number | null {
  if (!isRecord(authJson) || !isRecord(authJson.tokens)) return null;
  const idToken = authJson.tokens.id_token;
  if (typeof idToken !== "string") return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    // Not a JWT we can read, which is the same as the claim being absent.
    return null;
  }
  if (!isRecord(claims) || !isRecord(claims[AUTH_CLAIM])) return null;
  return timestampMs(claims[AUTH_CLAIM].chatgpt_subscription_active_until);
}

/** null when Codex is signed out, uses an API key, or the token carries no end date. */
export function readCodexSubscriptionEnd(codexHome: string): number | null {
  try {
    return parseSubscriptionEnd(JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8")));
  } catch {
    // The date is supplemental, so a missing, locked or half-written file must
    // not mark the whole provider unreadable. The header simply omits the date,
    // and Codex rewriting the file on token refresh is retried on the next poll.
    return null;
  }
}
