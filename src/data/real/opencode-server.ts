import { isRecord } from "./json";

/**
 * Opencode's dashboard talks to an internal RPC whose responses are serialized
 * JavaScript, not JSON. Server function ids are content hashes that change when
 * opencode.ai redeploys, so a parse failure here is expected drift, not a bug -
 * callers fall back to the local spend estimate.
 */
const OPENCODE_SERVER_URL = "https://opencode.ai/_server";

export const SERVER_FUNCTION_IDS = {
  workspaces: "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f",
  liteSubscription: "c7389bd0e731f80f49593e5ee53835475f4e28594dd6bd83eb229bab753498cd",
} as const;

/** Only the session cookies carry auth; everything else is noise we must not send. */
const AUTH_COOKIE_NAMES = ["auth", "__Host-auth"];

const DEFAULT_TIMEOUT_MS = 8_000;
const PERCENT_KEYS = ["usagePercent", "usedPercent", "percentUsed", "percent"];
const RESET_KEYS = ["resetInSec", "resetInSeconds", "resetSeconds", "resetsInSec"];
const WINDOW_PERCENT_PATTERN = /usagePercent\s*:\s*([0-9]+(?:\.[0-9]+)?)/;
const WINDOW_RESET_PATTERN = /resetInSec\s*:\s*([0-9]+)/;

// A control character in a pasted cookie makes fetch throw a header-validation
// error that can quote the offending value, so such cookies are refused here.

const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F]");

export interface UsageWindowReading {
  percent: number;
  resetInSec: number;
}

export interface OpencodeSubscription {
  rolling: UsageWindowReading;
  weekly: UsageWindowReading | null;
  monthly: UsageWindowReading | null;
  useBalance: boolean | null;
}

/** Keeps only the auth cookies from a pasted Cookie header. */
export function filterCookieHeader(raw: string): string | null {
  const kept: string[] = [];
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const name = trimmed.slice(0, equals).trim();
    if (!AUTH_COOKIE_NAMES.includes(name)) continue;
    if (CONTROL_CHARS.test(trimmed)) continue;
    kept.push(trimmed);
  }
  return kept.length > 0 ? kept.join("; ") : null;
}

export function parseWorkspaceId(text: string): string | null {
  return /\bwrk_[A-Za-z0-9]+/.exec(text)?.[0] ?? null;
}

/**
 * `usagePercent` is on a 0-100 scale, so small values are taken literally.
 * Rescaling anything at or under 1 as a fraction - as some ports do - turns a
 * genuine 1% reading, common right after a reset, into a 100% false alarm.
 */
function normalizePercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function firstFiniteNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

function percentFromRecord(value: Record<string, unknown>): number | null {
  const explicitPercent = firstFiniteNumber(value, PERCENT_KEYS);
  if (explicitPercent !== null) return normalizePercent(explicitPercent);

  const used = value.used;
  const limit = value.limit;
  if (typeof used !== "number" || typeof limit !== "number" || limit <= 0) return null;
  return normalizePercent((used / limit) * 100);
}

function windowFromRecord(value: unknown): UsageWindowReading | null {
  if (!isRecord(value)) return null;
  const percent = percentFromRecord(value);
  if (percent === null) return null;

  const resetInSec = firstFiniteNumber(value, RESET_KEYS);
  if (resetInSec === null) return null;
  return { percent, resetInSec: Math.max(0, resetInSec) };
}

/**
 * Pulls `usagePercent` and `resetInSec` out of one serialized-JS object literal.
 * The literal must start right after the key, optionally through a `$R[n]=`
 * binding: the serializer emits an already-seen object as a bare `$R[n]`
 * back-reference, and scanning past that would read the NEXT window's values.
 */
function windowFromText(text: string, key: string): UsageWindowReading | null {
  const objectAfterKey = `${key}\\s*:\\s*(?:\\$R\\[\\d+\\]\\s*=\\s*)?\\{[^{}]*\\}`;
  const block = new RegExp(objectAfterKey).exec(text)?.[0];
  if (!block) return null;
  const percentText = WINDOW_PERCENT_PATTERN.exec(block)?.[1];
  const resetText = WINDOW_RESET_PATTERN.exec(block)?.[1];
  if (percentText === undefined || resetText === undefined) return null;
  return { percent: normalizePercent(Number(percentText)), resetInSec: Number(resetText) };
}

function subscriptionFromJson(text: string): OpencodeSubscription | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const rolling = windowFromRecord(parsed.rollingUsage);
  if (!rolling) return null;
  return {
    rolling,
    weekly: windowFromRecord(parsed.weeklyUsage),
    monthly: windowFromRecord(parsed.monthlyUsage),
    useBalance: typeof parsed.useBalance === "boolean" ? parsed.useBalance : null,
  };
}

function subscriptionFromSerializedText(text: string): OpencodeSubscription | null {
  const rolling = windowFromText(text, "rollingUsage");
  if (!rolling) return null;
  return {
    rolling,
    weekly: windowFromText(text, "weeklyUsage"),
    monthly: windowFromText(text, "monthlyUsage"),
    useBalance: /\buseBalance\s*:\s*true\b/.test(text)
      ? true
      : /\buseBalance\s*:\s*false\b/.test(text)
        ? false
        : null,
  };
}

/**
 * Accepts either JSON or the serialized-JS form. The rolling window is
 * required; absent weekly and monthly windows are tolerated.
 */
export function parseSubscription(text: string): OpencodeSubscription | null {
  return subscriptionFromJson(text) ?? subscriptionFromSerializedText(text);
}

/** Phrases the dashboard returns instead of data once a session lapses. */
export function isSignedOut(text: string): boolean {
  const lowered = text.toLowerCase();
  return (
    lowered.includes("auth/authorize") ||
    lowered.includes("not associated with an account") ||
    lowered.includes('actor of type "public"')
  );
}

export class OpencodeServerError extends Error {
  constructor(
    message: string,
    readonly kind: "credentials" | "network" | "parse",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OpencodeServerError";
  }
}

async function callServer(
  functionId: string,
  args: string[],
  cookie: string,
  referer: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = new URL(OPENCODE_SERVER_URL);
  url.searchParams.set("id", functionId);
  if (args.length > 0) {
    const elements = args.map((value) => ({ t: 1, s: value }));
    url.searchParams.set(
      "args",
      JSON.stringify({ t: { t: 9, i: 0, l: elements.length, a: elements, o: 0 }, f: 31, m: [] }),
    );
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Cookie: cookie,
        "X-Server-Id": functionId,
        "X-Server-Instance": `server-fn:${crypto.randomUUID()}`,
        Origin: "https://opencode.ai",
        Referer: referer,
        Accept: "text/javascript, application/json;q=0.9, */*;q=0.8",
      },
      // This RPC never legitimately redirects; refusing keeps the session
      // cookie from following a redirect to another host.
      redirect: "error",
      signal,
    });
  } catch (error) {
    // The cause carries the detail; the message stays free of anything that
    // could echo the request headers back into the UI.
    throw new OpencodeServerError("request failed", "network", { cause: error });
  }

  if (response.status === 401 || response.status === 403) {
    throw new OpencodeServerError("opencode session expired", "credentials");
  }
  if (!response.ok) {
    throw new OpencodeServerError(`HTTP ${response.status}`, "network");
  }

  const text = await response.text();
  if (isSignedOut(text)) {
    throw new OpencodeServerError("opencode session expired", "credentials");
  }
  if (response.headers.has("X-Error")) {
    throw new OpencodeServerError("error payload in response", "parse");
  }
  return text;
}

export interface GoServerLimits {
  rollingPercent: number;
  rollingResetAtMs: number;
  weeklyPercent: number | null;
  weeklyResetAtMs: number | null;
  monthlyPercent: number | null;
  monthlyResetAtMs: number | null;
  fetchedAtMs: number;
  useBalance?: boolean | null;
}

/**
 * Two round trips: discover the workspace, then read its subscription usage.
 * `workspaceId` skips the first when the caller already knows it.
 */
export async function fetchGoServerLimits(
  cookieHeader: string,
  now: Date,
  options: { workspaceId?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<GoServerLimits> {
  const cookie = filterCookieHeader(cookieHeader);
  if (!cookie) {
    throw new OpencodeServerError("no opencode auth cookie", "credentials");
  }

  // One budget spans both round trips, so a stalled connection can never hold
  // the refresh loop open indefinitely.
  const deadline = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline])
    : deadline;

  let workspaceId = options.workspaceId;
  if (!workspaceId) {
    const listed = await callServer(
      SERVER_FUNCTION_IDS.workspaces,
      [],
      cookie,
      "https://opencode.ai",
      signal,
    );
    workspaceId = parseWorkspaceId(listed) ?? undefined;
    if (!workspaceId) throw new OpencodeServerError("missing workspace id", "parse");
  }

  const body = await callServer(
    SERVER_FUNCTION_IDS.liteSubscription,
    [workspaceId],
    cookie,
    `https://opencode.ai/workspace/${workspaceId}/billing`,
    signal,
  );
  const subscription = parseSubscription(body);
  if (!subscription) throw new OpencodeServerError("no usage in response", "parse");

  const nowMs = now.getTime();
  const weeklyResetAtMs = subscription.weekly
    ? nowMs + subscription.weekly.resetInSec * 1000
    : null;
  const monthlyResetAtMs = subscription.monthly
    ? nowMs + subscription.monthly.resetInSec * 1000
    : null;
  return {
    rollingPercent: subscription.rolling.percent,
    rollingResetAtMs: nowMs + subscription.rolling.resetInSec * 1000,
    weeklyPercent: subscription.weekly?.percent ?? null,
    weeklyResetAtMs,
    monthlyPercent: subscription.monthly?.percent ?? null,
    monthlyResetAtMs,
    fetchedAtMs: nowMs,
    useBalance: subscription.useBalance ?? null,
  };
}
