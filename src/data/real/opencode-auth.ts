import { readFileSync } from "node:fs";
import { maskCredential } from "../mask";
import { isRecord } from "./json";

/** Connection-status facts only - secrets never leave this module unmasked. */
export interface OpencodeAuth {
  openai: { expiresMs: number | null } | null;
  opencodeGo: { maskedKey: string } | null;
}

const EMPTY_AUTH: OpencodeAuth = { openai: null, opencodeGo: null };

export function parseOpencodeAuth(value: unknown): OpencodeAuth {
  if (!isRecord(value)) return EMPTY_AUTH;

  let openai: OpencodeAuth["openai"] = null;
  const openaiEntry = value.openai;
  if (isRecord(openaiEntry) && openaiEntry.type === "oauth") {
    const expires = openaiEntry.expires;
    openai = {
      expiresMs: typeof expires === "number" && Number.isFinite(expires) ? expires : null,
    };
  }

  let opencodeGo: OpencodeAuth["opencodeGo"] = null;
  const goEntry = value["opencode-go"];
  if (isRecord(goEntry) && goEntry.type === "api" && typeof goEntry.key === "string") {
    opencodeGo = { maskedKey: maskCredential(goEntry.key) };
  }

  return { openai, opencodeGo };
}

export function readOpencodeAuth(path: string): OpencodeAuth {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parseOpencodeAuth(parsed);
  } catch {
    return EMPTY_AUTH;
  }
}
