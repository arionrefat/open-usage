import { isRecord, timestampMs } from "./json";
import {
  parseBillingStatus,
  parseCostDays,
  parseUsagePage,
  planFromBillingSource,
  usdFromMicroCents,
  type GoBilling,
  type GoCostDay,
  type GoCostReport,
  type GoCostRow,
  type GoUsageRow,
} from "./opencode-usage";

/**
 * opencode's console API.
 *
 * The dashboard moved to `opencode.ai/console` in September 2026 and replaced
 * the serialized-JavaScript `_server` RPC with plain JSON REST: the workspace is
 * named by an `x-org-id` header instead of a positional argument, money arrives
 * in micro-cents, and content-hashed function ids are gone. A response the
 * parsers cannot read is drift rather than a bug - callers fall back to the
 * local spend estimate.
 */
const CONSOLE_API_URL = "https://opencode.ai/console/api";
const ORG_HEADER = "x-org-id";

/**
 * Only the session cookies carry auth; everything else is noise we must not
 * send. `console_session` is what the console issues; `auth` is the older
 * dashboard's Iron-sealed cookie, kept because it still carries the expiry the
 * card warns on and costs nothing to pass along.
 */
const AUTH_COOKIE_NAMES = ["__Host-console_session", "console_session", "auth", "__Host-auth"];

const DEFAULT_TIMEOUT_MS = 8_000;

// A control character in a pasted cookie makes fetch throw a header-validation
// error that can quote the offending value, so such cookies are refused here.

const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F]");

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

/** The workspace ids the console issues; `wrk_` predates the rename to orgs. */
const ORG_ID_PATTERN = /^(?:org_|wrk_)[A-Za-z0-9]+$/;

export function parseOrgId(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { id } = entry;
    if (typeof id === "string" && ORG_ID_PATTERN.test(id)) return id;
  }
  return null;
}

/**
 * opencode refuses a request from a workspace with no plan and no credit with a
 * `CreditsError`, which arrives as a 401 and must not be read as a bad key.
 */
export function isInsufficientBalance(text: string): boolean {
  const lowered = text.toLowerCase();
  return lowered.includes("creditserror") || lowered.includes("insufficient balance");
}

/** Phrases the console returns instead of data once a session lapses. */
export function isSignedOut(text: string): boolean {
  const lowered = text.toLowerCase();
  return (
    lowered.includes("console/login") ||
    lowered.includes("auth/authorize") ||
    lowered.includes("not associated with an account") ||
    lowered.includes('actor of type "public"')
  );
}

export class OpencodeServerError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "credentials"
      | "network"
      | "parse"
      | "rate-limited"
      | "no-subscription"
      | "insufficient-balance",
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

interface ConsoleRequest {
  cookie: string;
  orgId?: string;
  query?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * One console call. A 4xx that is not about credentials means the query no
 * longer matches the API, which is drift and reported as a parse failure so the
 * caller keeps its cached reading instead of retrying a request that cannot work.
 */
async function consoleJson(path: string, request: ConsoleRequest): Promise<unknown> {
  const url = new URL(`${CONSOLE_API_URL}${path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Cookie: request.cookie,
        Accept: "application/json",
        ...(request.orgId === undefined ? {} : { [ORG_HEADER]: request.orgId }),
      },
      // This API never legitimately redirects; refusing keeps the session
      // cookie from following a redirect to another host.
      redirect: "error",
      signal: request.signal,
    });
  } catch (error) {
    // The cause carries the detail; the message stays free of anything that
    // could echo the request headers back into the UI.
    throw new OpencodeServerError("request failed", "network", { cause: error });
  }

  // Being told to slow down is the one failure we must never retry on the normal
  // schedule, so it is reported apart from ordinary network trouble.
  if (response.status === 429) {
    throw new OpencodeRateLimitError(retryAfterMs(response.headers.get("Retry-After")));
  }
  if (response.status === 401 || response.status === 403) {
    const body = await response.text().catch(() => "");
    if (isInsufficientBalance(body)) {
      throw new OpencodeServerError("insufficient opencode balance", "insufficient-balance");
    }
    throw new OpencodeServerError("opencode session expired", "credentials");
  }
  if (response.status === 400 || response.status === 404 || response.status === 422) {
    throw new OpencodeServerError(`HTTP ${response.status}`, "parse");
  }
  if (!response.ok) throw new OpencodeServerError(`HTTP ${response.status}`, "network");

  const text = await response.text();
  if (isSignedOut(text)) {
    throw new OpencodeServerError("opencode session expired", "credentials");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new OpencodeServerError("invalid JSON response", "parse", { cause: error });
  }
}

function deadlineSignal(timeoutMs: number | undefined, signal: AbortSignal | undefined): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

function requireCookie(cookieHeader: string): string {
  const cookie = filterCookieHeader(cookieHeader);
  if (!cookie) throw new OpencodeServerError("no opencode auth cookie", "credentials");
  return cookie;
}

/** The workspace the session belongs to, which every other call is scoped by. */
async function discoverOrgId(cookie: string, signal: AbortSignal): Promise<string> {
  const orgId = parseOrgId(await consoleJson("/orgs", { cookie, signal }));
  if (!orgId) throw new OpencodeServerError("missing workspace id", "parse");
  return orgId;
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
  /** Exact dollar figures, which the console publishes for every window. */
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

interface MeterReading {
  percent: number;
  resetAtMs: number | null;
  usedUsd: number;
  limitUsd: number;
}

/**
 * One usage meter. The console sends dollars rather than a percentage, so the
 * percentage is computed here and clamped: a meter may overshoot its cap by the
 * request that crossed it.
 */
function meterFrom(value: unknown, fallbackResetAtMs: number | null): MeterReading | null {
  if (!isRecord(value)) return null;
  const usedUsd = usdFromMicroCents(value.usedMicroCents);
  const limitUsd = usdFromMicroCents(value.limitMicroCents);
  if (usedUsd === null || limitUsd === null || limitUsd <= 0) return null;
  return {
    percent: Math.min(100, Math.max(0, (usedUsd / limitUsd) * 100)),
    resetAtMs: timestampMs(value.resetsAt) ?? fallbackResetAtMs,
    usedUsd,
    limitUsd,
  };
}

/**
 * Reads `GET /go/status`. The rolling window is required; a console that stops
 * publishing the weekly or monthly meter still gives a usable card.
 */
export function parseGoStatus(value: unknown, now: Date): GoServerLimits | null {
  if (!isRecord(value) || !isRecord(value.access)) return null;
  const { access } = value;
  if (!isRecord(access.meters)) return null;
  const { meters } = access;

  // The month meter is the one window with no reset of its own: the plan's own
  // renewal is what clears it, which is what the console's card shows too.
  const renewalAtMs = timestampMs(access.endsAt);
  const rolling = meterFrom(meters.fiveHour, null);
  if (!rolling) return null;
  const weekly = meterFrom(meters.week, null);
  const monthly = meterFrom(meters.month, renewalAtMs);

  return {
    rollingPercent: rolling.percent,
    rollingResetAtMs: rolling.resetAtMs,
    weeklyPercent: weekly?.percent ?? null,
    weeklyResetAtMs: weekly?.resetAtMs ?? null,
    monthlyPercent: monthly?.percent ?? null,
    monthlyResetAtMs: monthly?.resetAtMs ?? null,
    rollingUsd: rolling.usedUsd,
    rollingCapUsd: rolling.limitUsd,
    weeklyUsd: weekly?.usedUsd ?? null,
    weeklyCapUsd: weekly?.limitUsd ?? null,
    monthlyUsd: monthly?.usedUsd ?? null,
    monthlyCapUsd: monthly?.limitUsd ?? null,
    fetchedAtMs: now.getTime(),
    useBalance: typeof value.useBalance === "boolean" ? value.useBalance : null,
    source: "dashboard",
  };
}

/** True when the console answered with a workspace that has no Go plan attached. */
function isPlanAbsent(payload: unknown): boolean {
  return isRecord(payload) && "access" in payload && !isRecord(payload.access);
}

/**
 * Two round trips: discover the workspace, then read its Go subscription usage.
 * `workspaceId` skips the first when the caller already knows it.
 */
export async function fetchGoServerLimits(
  cookieHeader: string,
  now: Date,
  options: { workspaceId?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<GoServerLimits> {
  const cookie = requireCookie(cookieHeader);
  // One budget spans both round trips, so a stalled connection can never hold
  // the refresh loop open indefinitely.
  const signal = deadlineSignal(options.timeoutMs, options.signal);
  const workspaceId = options.workspaceId ?? (await discoverOrgId(cookie, signal));

  const payload = await consoleJson("/go/status", { cookie, orgId: workspaceId, signal });
  const limits = parseGoStatus(payload, now);
  if (!limits) {
    // A workspace whose plan has lapsed answers with a null `access`. That is
    // the account's own state, not drift, and reporting it as drift sends the
    // user hunting a bug in us instead of showing what actually changed.
    if (isPlanAbsent(payload)) {
      throw new OpencodeServerError("no opencode go subscription", "no-subscription");
    }
    throw new OpencodeServerError("no usage in response", "parse");
  }
  return { ...limits, workspaceId };
}

export interface GoUsageHistory {
  costs: GoCostReport;
  billing: GoBilling | null;
  workspaceId: string;
  /** Calendar month the cost rows cover, as YYYY-MM. */
  month: string;
}

/** `YYYY-MM-DDTHH:MM:SSZ`, which is the only `since` form the console accepts. */
export function consoleTimestamp(atMs: number): string {
  return `${new Date(atMs).toISOString().slice(0, 19)}Z`;
}

/** Midnight on the first of the month `monthsAgo` before `now`, in local time. */
function monthStart(now: Date, monthsAgo: number): Date {
  return new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Day totals become one cost row each. The console breaks its chart down by day
 * but not by model, so the model is left unnamed and filled in from the
 * per-request table where that reaches, rather than guessed at here.
 */
function costRowsFrom(days: GoCostDay[], hasGoAccess: boolean): GoCostRow[] {
  return days.map((day) => ({
    date: day.date,
    model: null,
    usd: day.usd,
    keyId: null,
    plan: hasGoAccess ? planFromBillingSource("go") : "payg",
  }));
}

/**
 * Reads the recent months of per-day cost plus the billing record.
 *
 * The two answer different questions and must stay apart: cost rows on a
 * subscription are allowance consumed, while billing is what was charged.
 * Months come back newest first.
 */
export async function fetchGoUsageHistory(
  cookieHeader: string,
  now: Date,
  options: {
    workspaceId?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** How many calendar months to cover, counting the open one. */
    months?: number;
  } = {},
): Promise<GoUsageHistory[]> {
  const cookie = requireCookie(cookieHeader);
  const signal = deadlineSignal(options.timeoutMs, options.signal);
  const workspaceId = options.workspaceId ?? (await discoverOrgId(cookie, signal));
  const months = Math.max(1, options.months ?? 1);
  const since = consoleTimestamp(monthStart(now, months - 1).getTime());

  // The chart, the plan state and the balance are independent reads, so they go
  // out together rather than in series.
  const [chart, goStatus, billingStatus, autoRecharge] = await Promise.all([
    consoleJson("/usage/cost-by-day", { cookie, orgId: workspaceId, signal, query: { since, bucket: "day" } }),
    // Billing is supplementary: without it the cost rows still stand, so a
    // failure here must not lose the months that were already read.
    consoleJson("/go/status", { cookie, orgId: workspaceId, signal }).catch(() => null),
    consoleJson("/billing/status", { cookie, orgId: workspaceId, signal }).catch(() => null),
    consoleJson("/billing/auto-recharge", { cookie, orgId: workspaceId, signal }).catch(() => null),
  ]);

  const days = parseCostDays(chart);
  if (!days) throw new OpencodeServerError("no usage in response", "parse");

  const hasGoAccess = isRecord(goStatus) && isRecord(goStatus.access);
  const billing = parseBillingStatus(billingStatus, autoRecharge, { hasGoAccess });
  const byMonth = new Map<string, GoCostDay[]>();
  for (const day of days) {
    const key = day.date.slice(0, 7);
    byMonth.set(key, [...(byMonth.get(key) ?? []), day]);
  }

  return Array.from({ length: months }, (_, monthsAgo) => {
    const month = monthKey(monthStart(now, monthsAgo));
    return {
      costs: { rows: costRowsFrom(byMonth.get(month) ?? [], hasGoAccess), keys: [] },
      // The billing record is one per workspace, not one per month, so only the
      // open month carries it and the closed ones stay unannotated.
      billing: monthsAgo === 0 ? billing : null,
      workspaceId,
      month,
    };
  });
}

/** The console's own page size for the usage table, and its maximum. */
const USAGE_PAGE_SIZE = 100;
/**
 * Backstop only. Paging normally ends at the first page that reaches past the
 * window, so a light month costs one or two requests rather than this. Sized
 * for a hundred sessions a day: a month that outgrows it is truncated rather
 * than walked indefinitely.
 */
const MAX_USAGE_PAGES = 60;
const USAGE_ROWS_TIMEOUT_MS = 45_000;

/**
 * Pages the per-request usage table back to `sinceMs`.
 *
 * This is what lets a cookie alone carry an activity series: `opencode.db` is
 * the only other source of per-token history, and it does not exist until
 * opencode has been installed and used. The console filters by `since` itself,
 * so the walk ends when it runs out of cursors.
 */
export async function fetchGoUsageRows(
  cookieHeader: string,
  workspaceId: string,
  options: { sinceMs: number; signal?: AbortSignal; timeoutMs?: number; maxPages?: number },
): Promise<GoUsageRow[]> {
  const cookie = requireCookie(cookieHeader);
  const signal = deadlineSignal(options.timeoutMs ?? USAGE_ROWS_TIMEOUT_MS, options.signal);
  const maxPages = options.maxPages ?? MAX_USAGE_PAGES;
  const query = {
    since: consoleTimestamp(options.sinceMs),
    pageSize: String(USAGE_PAGE_SIZE),
  };

  const rows: GoUsageRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const payload: unknown = await consoleJson("/usage/rows", {
      cookie,
      orgId: workspaceId,
      signal,
      query: cursor === null ? query : { ...query, cursor },
    });
    const parsed = parseUsagePage(payload);
    if (!parsed) throw new OpencodeServerError("no usage in response", "parse");
    rows.push(...parsed.rows);
    if (parsed.nextCursor === null || parsed.rows.length === 0) break;
    cursor = parsed.nextCursor;
  }
  // A row with no timestamp cannot be placed in the window, so it is kept only
  // for the totals rather than being guessed onto a day.
  return rows.filter((row) => row.atMs === null || row.atMs >= options.sinceMs);
}
