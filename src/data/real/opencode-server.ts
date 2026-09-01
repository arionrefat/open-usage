import { discoverServerFunctionRefs } from "./opencode-bundle";
import {
  type GoBilling,
  type GoCostReport,
  type GoUsageRow,
  parseBilling,
  parseCostReport,
  parseUsageRows,
} from "./opencode-usage";
import { finiteNumber, isRecord } from "./json";
import { numberField, objectAtKey } from "./seroval-text";

/**
 * Opencode's dashboard talks to an internal RPC whose responses are serialized
 * JavaScript, not JSON. Server function ids are content hashes that change when
 * opencode.ai redeploys, so a parse failure is drift rather than a bug - callers
 * fall back to the local spend estimate. Most ids can be recovered from the
 * client bundle by registration key; see `opencode-bundle.ts`.
 */
const OPENCODE_SERVER_URL = "https://opencode.ai/_server";

export const SERVER_FUNCTION_IDS = {
  workspaces: "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f",
  liteSubscription: "c7389bd0e731f80f49593e5ee53835475f4e28594dd6bd83eb229bab753498cd",
  /** Usage table, one row per request, 50 rows a page. */
  usageList: "bfd684bfc2e4eed05cd0b518f5e4eafd3f3376e3938abb9e536e7c03df831e5c",
  /** Per-day, per-model cost chart. */
  usageCosts: "15702f3a12ff8bff357f8c2aa154a17e65b746d5f6b96adc9002c86ee0c15205",
  /** Balance, metered usage, and reload settings - the only real-money surface. */
  billing: "c83b78a614689c38ebee981f9b39a8b377716db85c1fd7dbab604adc02d3313d",
} as const;

/**
 * Registration keys the bundle declares each id under. These outlive the hashes,
 * so a stale id can be re-derived from them.
 *
 * `usageCosts` is absent on purpose: the bundle calls `getCosts` directly instead
 * of registering it, leaving its hash the one id with no self-healing path.
 */
const SERVER_FUNCTION_KEYS: Partial<Record<keyof typeof SERVER_FUNCTION_IDS, string>> = {
  workspaces: "workspaces",
  liteSubscription: "lite.subscription.get",
  usageList: "usage.list",
  billing: "billing.get",
};

/** Only the session cookies carry auth; everything else is noise we must not send. */
const AUTH_COOKIE_NAMES = ["auth", "__Host-auth"];

const DEFAULT_TIMEOUT_MS = 8_000;
const PERCENT_KEYS = ["usagePercent", "usedPercent", "percentUsed", "percent"];
const RESET_KEYS = ["resetInSec", "resetInSeconds", "resetSeconds", "resetsInSec"];

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
    const candidate = finiteNumber(record[key]);
    if (candidate !== null) return candidate;
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

/** Pulls `usagePercent` and `resetInSec` out of one serialized-JS object literal. */
function windowFromText(text: string, key: string): UsageWindowReading | null {
  const block = objectAtKey(text, key);
  if (block === null) return null;
  const percent = numberField(block, "usagePercent");
  const resetInSec = numberField(block, "resetInSec");
  if (percent === null || resetInSec === null) return null;
  return { percent: normalizePercent(percent), resetInSec };
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
    readonly kind: "credentials" | "network" | "parse" | "rate-limited",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OpencodeServerError";
  }
}

/** Carries the server's own Retry-After so the caller can honor it exactly. */
export class OpencodeRateLimitError extends OpencodeServerError {
  constructor(readonly retryAfterMs: number | null) {
    super("opencode rate limited the request", "rate-limited");
    this.name = "OpencodeRateLimitError";
  }
}

const MAX_RETRY_AFTER_MS = 60 * 60_000;

/** Accepts both Retry-After forms: delta-seconds and an HTTP date. */
export function retryAfterMs(header: string | null, nowMs = Date.now()): number | null {
  const value = header?.trim();
  if (!value) return null;
  const clamp = (ms: number) => Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms));
  if (/^\d+$/.test(value)) return clamp(Number(value) * 1000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? clamp(dateMs - nowMs) : null;
}

export type ServerArg = string | number;

/** seroval's JSON AST: node type 0 is a number, 1 a string, 9 an array. */
function serializeArgs(args: ServerArg[]): string {
  const elements = args.map((value) => ({ t: typeof value === "string" ? 1 : 0, s: value }));
  return JSON.stringify({
    t: { t: 9, i: 0, l: elements.length, a: elements, o: 0 },
    f: 31,
    m: [],
  });
}

/**
 * GET carries args in the query string, POST in a JSON body. The dashboard uses
 * GET for the two limit queries and POST everywhere else, and the server rejects
 * the wrong pairing.
 */
async function callServer(
  functionId: string,
  args: ServerArg[],
  cookie: string,
  referer: string,
  signal?: AbortSignal,
  method: "GET" | "POST" = "GET",
): Promise<string> {
  const url = new URL(OPENCODE_SERVER_URL);
  url.searchParams.set("id", functionId);
  const isPost = method === "POST";
  if (!isPost && args.length > 0) {
    url.searchParams.set("args", serializeArgs(args));
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      body: isPost ? serializeArgs(args) : undefined,
      headers: {
        Cookie: cookie,
        "X-Server-Id": functionId,
        "X-Server-Instance": `server-fn:${crypto.randomUUID()}`,
        Origin: "https://opencode.ai",
        Referer: referer,
        Accept: "text/javascript, application/json;q=0.9, */*;q=0.8",
        ...(isPost ? { "Content-Type": "application/json" } : {}),
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
  // Being told to slow down is the one failure we must never retry on the normal
  // schedule, so it is reported apart from ordinary network trouble.
  if (response.status === 429) {
    throw new OpencodeRateLimitError(retryAfterMs(response.headers.get("Retry-After")));
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

/**
 * Ids recovered from the bundle, cached for the process. Discovery is a recovery
 * path: it runs only after a shipped id stops parsing, never on the happy path.
 */
let discoveredIds: Map<string, string[]> | null = null;

export function resetDiscoveredIds(): void {
  discoveredIds = null;
}

/**
 * Every id worth trying for a function, shipped one first. The bundle registers
 * some keys from more than one route, so a recovered key can yield several
 * candidates and only the caller's parser can tell which one answered.
 */
async function candidateIds(
  name: keyof typeof SERVER_FUNCTION_IDS,
  signal?: AbortSignal,
): Promise<string[]> {
  const shipped = SERVER_FUNCTION_IDS[name];
  const key = SERVER_FUNCTION_KEYS[name];
  if (key === undefined) return [shipped];

  if (discoveredIds === null) {
    discoveredIds = await discoverServerFunctionRefs({ signal }).catch(() => new Map());
  }
  const recovered = discoveredIds.get(key) ?? [];
  return [shipped, ...recovered.filter((hash) => hash !== shipped)];
}

/**
 * Calls a function, and if the response does not parse, re-derives the id from
 * the bundle and tries again. Returns null once every candidate has failed.
 */
async function callAndParse<T>(
  name: keyof typeof SERVER_FUNCTION_IDS,
  args: ServerArg[],
  parse: (text: string) => T | null,
  cookie: string,
  referer: string,
  signal?: AbortSignal,
  method: "GET" | "POST" = "POST",
): Promise<T | null> {
  const shipped = SERVER_FUNCTION_IDS[name];
  const firstAttempt = await callServer(shipped, args, cookie, referer, signal, method)
    .then(parse)
    .catch((error: unknown) => {
      // Credentials and rate limits are the caller's to handle; a fresh id
      // cannot fix either, so they must not be swallowed as a parse failure.
      if (error instanceof OpencodeServerError && error.kind !== "parse") throw error;
      return null;
    });
  if (firstAttempt !== null) return firstAttempt;

  for (const id of (await candidateIds(name, signal)).filter((hash) => hash !== shipped)) {
    const parsed = await callServer(id, args, cookie, referer, signal, method)
      .then(parse)
      .catch(() => null);
    if (parsed !== null) return parsed;
  }
  return null;
}

export interface GoUsageHistory {
  costs: GoCostReport;
  billing: GoBilling | null;
  workspaceId: string;
  /** Calendar month the cost rows cover, as YYYY-MM. */
  month: string;
}

/** `+HH:MM` for a date, which is what decides the calendar day a row lands in. */
export function timezoneOffsetLabel(now: Date): string {
  const minutes = -now.getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const hours = String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0");
  return `${sign}${hours}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
}

/**
 * Reads one calendar month of per-day, per-model cost plus the billing record.
 *
 * The two answer different questions and must stay apart: cost rows on a
 * subscription are allowance consumed, while billing is what was charged.
 */
export async function fetchGoUsageHistory(
  cookieHeader: string,
  now: Date,
  options: {
    workspaceId?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    monthsAgo?: number;
    /**
     * The billing record is one per workspace, not one per month, so a caller
     * reading several months asks for it once and leaves it off the rest.
     */
    withBilling?: boolean;
  } = {},
): Promise<GoUsageHistory> {
  const cookie = filterCookieHeader(cookieHeader);
  if (!cookie) throw new OpencodeServerError("no opencode auth cookie", "credentials");

  const deadline = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

  let workspaceId = options.workspaceId;
  if (!workspaceId) {
    const listed = await callAndParse(
      "workspaces",
      [],
      parseWorkspaceId,
      cookie,
      "https://opencode.ai",
      signal,
      "GET",
    );
    if (!listed) throw new OpencodeServerError("missing workspace id", "parse");
    workspaceId = listed;
  }
  const referer = `https://opencode.ai/workspace/${workspaceId}/usage`;

  const target = new Date(now.getFullYear(), now.getMonth() - (options.monthsAgo ?? 0), 1);
  const costs = await callAndParse(
    "usageCosts",
    [workspaceId, target.getFullYear(), target.getMonth(), timezoneOffsetLabel(now)],
    parseCostReport,
    cookie,
    referer,
    signal,
  );
  if (!costs) throw new OpencodeServerError("no usage in response", "parse");

  // Billing is supplementary: without it the allowance figures still stand, so a
  // failure here must not lose the month that was already read.
  const billing =
    options.withBilling === false
      ? null
      : await callAndParse(
          "billing",
          [workspaceId],
          parseBilling,
          cookie,
          `https://opencode.ai/workspace/${workspaceId}/billing`,
          signal,
        ).catch(() => null);

  return {
    costs,
    billing,
    workspaceId,
    month: `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}`,
  };
}

/** The dashboard's own page size for the usage table. */
const USAGE_PAGE_SIZE = 50;
/**
 * Backstop only. Paging normally ends the moment a page reaches past the
 * window, so a light month costs one or two requests rather than this. Sized
 * for a hundred sessions a day: a month that outgrows it is truncated rather
 * than walked indefinitely.
 */
const MAX_USAGE_PAGES = 60;
/**
 * Pages requested at once after the first. The first page goes alone because
 * it settles whether there is a second at all; after that, waiting on each
 * page before asking for the next turned a month of activity into thirty
 * round trips in series. A batch may overshoot the window by a few pages,
 * which is cheaper than the serial wait it replaces.
 */
const USAGE_PAGE_CONCURRENCY = 4;
const USAGE_ROWS_TIMEOUT_MS = 45_000;

/**
 * Pages the per-session usage table back to `sinceMs`.
 *
 * This is what lets a cookie alone carry an activity series: `opencode.db` is
 * the only other source of per-token history, and it does not exist until
 * opencode has been installed and used. Rows arrive newest first, so a page
 * that reaches past the window ends the walk.
 */
export async function fetchGoUsageRows(
  cookieHeader: string,
  workspaceId: string,
  options: { sinceMs: number; signal?: AbortSignal; timeoutMs?: number; maxPages?: number },
): Promise<GoUsageRow[]> {
  const cookie = filterCookieHeader(cookieHeader);
  if (!cookie) throw new OpencodeServerError("no opencode auth cookie", "credentials");

  const deadline = AbortSignal.timeout(options.timeoutMs ?? USAGE_ROWS_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const referer = `https://opencode.ai/workspace/${workspaceId}/usage`;
  const maxPages = options.maxPages ?? MAX_USAGE_PAGES;
  const fetchPage = (page: number) =>
    callAndParse("usageList", [workspaceId, page], parseUsageRows, cookie, referer, signal);

  const rows: GoUsageRow[] = [];
  let nextPage = 0;
  while (nextPage < maxPages) {
    const batchSize = nextPage === 0 ? 1 : USAGE_PAGE_CONCURRENCY;
    const pages = Array.from(
      { length: Math.min(batchSize, maxPages - nextPage) },
      (_, offset) => nextPage + offset,
    );
    nextPage += pages.length;
    const settled = await Promise.allSettled(pages.map(fetchPage));

    // Pages are folded in order, and the walk ends at the first that ends it:
    // a failure, an empty or short page, or one that reaches past the window.
    // Anything a later page in the batch returned past that point is dropped,
    // since the rows before it were never seen.
    let isDone = false;
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        // Pages arrive newest first, so a deadline or a blip part way through
        // still leaves the most recent window collected. Returning that beats
        // losing every row, but only once there is something to return - an
        // empty result would blank a chart the caller could have kept.
        if (rows.length === 0) throw outcome.reason;
        isDone = true;
        break;
      }
      const parsed = outcome.value;
      if (parsed === null || parsed.length === 0) {
        isDone = true;
        break;
      }
      rows.push(...parsed);
      if (parsed.some((row) => row.atMs !== null && row.atMs < options.sinceMs)) {
        isDone = true;
        break;
      }
      if (parsed.length < USAGE_PAGE_SIZE) {
        isDone = true;
        break;
      }
    }
    if (isDone) break;
  }
  // A row with no timestamp cannot be placed in the window, so it is kept only
  // for the totals rather than being guessed onto a day.
  return rows.filter((row) => row.atMs === null || row.atMs >= options.sinceMs);
}

export interface GoServerLimits {
  rollingPercent: number;
  /** null when the source reports usage without a reset; the row says so. */
  rollingResetAtMs: number | null;
  weeklyPercent: number | null;
  weeklyResetAtMs: number | null;
  monthlyPercent: number | null;
  monthlyResetAtMs: number | null;
  fetchedAtMs: number;
  useBalance?: boolean | null;
  /** Exact dollar figures when the API publishes them; the dashboard reports percentages only. */
  rollingUsd?: number | null;
  rollingCapUsd?: number | null;
  weeklyUsd?: number | null;
  weeklyCapUsd?: number | null;
  monthlyUsd?: number | null;
  monthlyCapUsd?: number | null;
  /** Authoritative quota source, persisted so cached values keep an honest label. */
  source?: "api" | "dashboard";
  /** Reused by the polling source so later reads can skip workspace discovery. */
  workspaceId?: string;
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
    source: "dashboard",
    workspaceId,
  };
}
