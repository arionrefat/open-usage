import { formatClock } from "./aggregate";
import { isRecord } from "./json";
import { createPolledSource } from "./polled-source";
import { createSubprocessGuard, subprocessEnvironment } from "./subprocess";
import type { ConnectionStatus, Money, PollOptions } from "../types";

export interface ClaudeUsageWindow {
  percent: number;
  /** First-party display text, including the leading "resets". */
  reset: string;
  /** From the structured report; absent on readings parsed from the text alone. */
  resetsAtMs?: number;
}

export type ClaudeLimitScope = "model" | "surface";

/** A weekly lane the server scopes to one model or one surface, such as Fable. */
export interface ClaudeScopedWindow extends ClaudeUsageWindow {
  /** Derived from the scope alone, so it stays stable across polls; notifications key on it. */
  id: string;
  scope: ClaudeLimitScope;
  /** The server's display label, e.g. "Fable". */
  name: string;
}

/** Extra-usage spend for the billing period, carried only while it is switched on. */
export interface ClaudeExtraUsageSpend {
  used: Money;
  /** null when the plan sets no monthly cap. */
  monthlyLimit: Money | null;
  /** 0-100, as reported. */
  utilization: number | null;
}

export interface ClaudeCliUsage {
  session: ClaudeUsageWindow;
  weekly: ClaudeUsageWindow;
  /** In the server's order. */
  scoped: ClaudeScopedWindow[];
  extraUsage?: ClaudeExtraUsageSpend;
  fetchedAtMs: number;
}

export type ClaudeUsageFailure = "not-installed" | "not-logged-in" | "timeout" | "protocol";

export class ClaudeUsageError extends Error {
  constructor(
    readonly kind: ClaudeUsageFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClaudeUsageError";
  }
}

const RESERVED_LIMIT_IDS = new Set(["session", "weekly"]);

/**
 * "Fable" becomes `fable`, which is the id the Fable lane has always had, so
 * a recorded notification state survives the move to the structured report.
 */
export function scopedWindowId(scope: ClaudeLimitScope, name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) return null;
  if (scope === "surface") return `surface-${slug}`;
  return RESERVED_LIMIT_IDS.has(slug) ? `model-${slug}` : slug;
}

const WINDOW_PATTERN = /^(.+?):\s*([0-9]+(?:\.[0-9]+)?)% used(?:\s*[·|-]\s*(resets .+))?$/i;
const SCOPED_LABEL = /^current week \((.+)\)$/i;
const STALE_MARKER = /last-known usage/i;
const AGE_HOURS = /(\d+)\s*h(?:ours?)?\b/i;
const AGE_MINUTES = /(\d+)\s*m(?:in(?:utes?)?)?\b/i;

/** Claude can show cached bars for up to an hour when rate-limited. Age is subtracted from fetch time so our staleness window sees it too. Unparseable age fails closed. */
function staleAdjustedFetchTime(result: string, fetchedAtMs: number): number | null {
  const markerLine = result.split("\n").find((line) => STALE_MARKER.test(line));
  if (markerLine === undefined) return fetchedAtMs;
  const hours = Number(AGE_HOURS.exec(markerLine)?.[1] ?? 0);
  const minutes = Number(AGE_MINUTES.exec(markerLine)?.[1] ?? 0);
  const ageMs = (hours * 60 + minutes) * 60_000;
  return ageMs > 0 ? fetchedAtMs - ageMs : null;
}

function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, percent));
}

/** What a window that has not started accruing says instead of a reset time. */
function unstartedReset(isSession: boolean): string {
  return isSession ? "starts when a message is sent" : "no usage yet";
}

interface TextWindows {
  session: ClaudeUsageWindow | null;
  weekly: ClaudeUsageWindow | null;
  scoped: ClaudeScopedWindow[];
}

function parseUsageText(text: string): TextWindows {
  const windows: TextWindows = { session: null, weekly: null, scoped: [] };
  for (const line of text.split("\n")) {
    const match = WINDOW_PATTERN.exec(line.trim());
    if (!match) continue;
    const rawLabel = match[1]?.trim();
    const label = rawLabel?.toLowerCase();
    const rawPercent = Number(match[2]);
    if (!rawLabel || !label || !Number.isFinite(rawPercent)) continue;
    const reset = match[3];
    // Claude omits the reset clause on windows that have not started accruing yet.
    if (!reset && rawPercent !== 0) continue;
    const isSession = label === "current session";
    const window = { percent: clampPercent(rawPercent), reset: reset ?? unstartedReset(isSession) };
    if (isSession) {
      windows.session = window;
      continue;
    }
    if (label === "current week (all models)") {
      windows.weekly = window;
      continue;
    }
    const name = SCOPED_LABEL.exec(rawLabel)?.[1]?.trim();
    const id = name ? scopedWindowId("model", name) : null;
    if (!name || !id || windows.scoped.some((scoped) => scoped.id === id)) continue;
    windows.scoped.push({ id, scope: "model", name, ...window });
  }
  return windows;
}

/** Parses the text returned by the first-party `claude -p "/usage"` command. */
export function parseClaudeUsage(value: unknown, fetchedAtMs: number): ClaudeCliUsage | null {
  if (!isRecord(value) || typeof value.result !== "string") return null;
  const { session, weekly, scoped } = parseUsageText(value.result);
  if (!session || !weekly) return null;
  const effectiveFetchedAtMs = staleAdjustedFetchTime(value.result, fetchedAtMs);
  return effectiveFetchedAtMs === null
    ? null
    : { session, weekly, scoped, fetchedAtMs: effectiveFetchedAtMs };
}

interface ReportRow {
  kind: string;
  percent: number;
  resetsAtMs: number | null;
  scope: { scope: ClaudeLimitScope; name: string } | null;
}

const MALFORMED = Symbol("malformed");
const RENDERED_KINDS = new Set(["session", "weekly_all", "weekly_scoped"]);

function parseReportScope(value: unknown): ReportRow["scope"] | typeof MALFORMED {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return MALFORMED;
  for (const scope of ["model", "surface"] as const) {
    const target = value[scope];
    if (target === null || target === undefined) continue;
    if (!isRecord(target) || typeof target.display_name !== "string") return MALFORMED;
    const name = target.display_name.trim();
    return name.length > 0 ? { scope, name } : MALFORMED;
  }
  return null;
}

function parseReportRow(value: unknown): ReportRow | typeof MALFORMED {
  if (!isRecord(value) || typeof value.kind !== "string") return MALFORMED;
  const percent = value.percent;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return MALFORMED;
  let resetsAtMs: number | null = null;
  if (value.resets_at !== null && value.resets_at !== undefined) {
    if (typeof value.resets_at !== "string") return MALFORMED;
    resetsAtMs = Date.parse(value.resets_at);
    if (!Number.isFinite(resetsAtMs)) return MALFORMED;
  }
  const scope = parseReportScope(value.scope);
  if (scope === MALFORMED) return MALFORMED;
  return { kind: value.kind, percent: clampPercent(percent), resetsAtMs, scope };
}

function reportWindow(row: ReportRow, prose: ClaudeUsageWindow | null, isSession: boolean): ClaudeUsageWindow {
  // The text twin's prose is kept where it exists, so the reset reads as it
  // always has; the timestamp is what the countdown and projection use.
  const reset =
    prose?.reset ??
    (row.resetsAtMs !== null
      ? `resets ${formatClock(row.resetsAtMs)}`
      : row.percent === 0
        ? unstartedReset(isSession)
        : "reset unavailable");
  return {
    percent: row.percent,
    reset,
    ...(row.resetsAtMs !== null ? { resetsAtMs: row.resetsAtMs } : {}),
  };
}

function currencyExponent(currency: string): number | null {
  try {
    const digits = new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits;
    return typeof digits === "number" ? digits : null;
  } catch (error) {
    // An unknown currency code cannot be scaled, so its amounts are not shown.
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function parseExtraUsage(value: unknown): ClaudeExtraUsageSpend | undefined {
  if (!isRecord(value) || value.is_enabled !== true) return undefined;
  const { currency, used_credits: used, monthly_limit: limit, utilization } = value;
  if (typeof currency !== "string" || currency.length === 0) return undefined;
  const exponent = currencyExponent(currency);
  if (exponent === null) return undefined;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return undefined;
  if (limit !== null && (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0)) {
    return undefined;
  }
  return {
    used: { amountMinor: used, currency, exponent },
    monthlyLimit: limit === null ? null : { amountMinor: limit, currency, exponent },
    utilization: typeof utilization === "number" && Number.isFinite(utilization) ? utilization : null,
  };
}

/**
 * Reads the structured twin Claude Code attaches to `/usage` in stream-json
 * mode. Rows are classified on `kind`, never on their label, as its schema
 * asks. The twin is marked experimental, so anything short of a well-formed
 * session and all-models row reads as absent and the caller falls back to the
 * text, which stays the canonical form.
 */
export function parseUsageReport(
  report: unknown,
  text: string | null,
  fetchedAtMs: number,
): ClaudeCliUsage | null {
  if (!isRecord(report) || !isRecord(report.rate_limits)) return null;
  const { limits, extra_usage: extraUsage } = report.rate_limits;
  if (!Array.isArray(limits)) return null;

  const prose = text === null ? null : parseUsageText(text);
  let session: ClaudeUsageWindow | null = null;
  let weekly: ClaudeUsageWindow | null = null;
  const scoped: ClaudeScopedWindow[] = [];
  for (const value of limits) {
    // A meter of a kind we do not render yet is skipped unread; a malformed
    // row of a kind we do render means the shape moved under us.
    if (isRecord(value) && typeof value.kind === "string" && !RENDERED_KINDS.has(value.kind)) continue;
    const row = parseReportRow(value);
    if (row === MALFORMED) return null;
    if (row.kind === "session") {
      session ??= reportWindow(row, prose?.session ?? null, true);
    } else if (row.kind === "weekly_all") {
      weekly ??= reportWindow(row, prose?.weekly ?? null, false);
    } else if (row.kind === "weekly_scoped") {
      if (!row.scope) return null;
      const id = scopedWindowId(row.scope.scope, row.scope.name);
      if (!id) return null;
      if (scoped.some((window) => window.id === id)) continue;
      const scopedProse = prose?.scoped.find((window) => window.id === id) ?? null;
      scoped.push({ id, ...row.scope, ...reportWindow(row, scopedProse, false) });
    }
  }
  if (!session || !weekly) return null;

  const effectiveFetchedAtMs = text === null ? fetchedAtMs : staleAdjustedFetchTime(text, fetchedAtMs);
  if (effectiveFetchedAtMs === null) return null;
  const extra = parseExtraUsage(extraUsage);
  return {
    session,
    weekly,
    scoped,
    ...(extra ? { extraUsage: extra } : {}),
    fetchedAtMs: effectiveFetchedAtMs,
  };
}

/**
 * Parses `--output-format stream-json` output: the structured report rides on
 * the assistant line and the text on the result line. A single JSON object,
 * the older `--output-format json` shape, reads as one line carrying text only.
 */
export function parseClaudeUsageMessages(messages: unknown[], fetchedAtMs: number): ClaudeCliUsage | null {
  const textMessage = messages.find(
    (message) => isRecord(message) && typeof message.result === "string",
  );
  const text = isRecord(textMessage) && typeof textMessage.result === "string" ? textMessage.result : null;
  const reportMessage = messages.find(
    (message) => isRecord(message) && message.type === "assistant" && message.usage_report !== undefined,
  );
  const report = isRecord(reportMessage) ? reportMessage.usage_report : undefined;
  const structured = report === undefined ? null : parseUsageReport(report, text, fetchedAtMs);
  return structured ?? (text === null ? null : parseClaudeUsage({ result: text }, fetchedAtMs));
}

function decodeJsonLines(output: string): unknown[] {
  const messages: unknown[] = [];
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      // One unreadable line must not hide the others; none at all is reported by the caller.
    }
  }
  return messages;
}

const REQUEST_TIMEOUT_MS = 15_000;

interface ClaudeUsageReadOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Test seam; production discovers `claude` through PATH. */
  executable?: string;
  /** Test seam; production inherits the scrubbed process environment. */
  env?: Record<string, string | undefined>;
  killGraceMs?: number;
}

function spawnClaudeUsage(options: ClaudeUsageReadOptions) {
  return Bun.spawn(
    [
      options.executable ?? "claude",
      "--safe-mode",
      "-p",
      "/usage",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
    ],
    {
      // Without an explicit EOF on stdin, stream-json mode waits three seconds
      // for piped input before it runs the command.
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: subprocessEnvironment(options.env),
    },
  );
}

/** Reads live subscription limits through Claude Code without touching its credentials. */
export async function readClaudeUsage(
  now: Date,
  options: ClaudeUsageReadOptions = {},
): Promise<ClaudeCliUsage> {
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException("Refresh aborted", "AbortError");
  }
  let proc: ReturnType<typeof spawnClaudeUsage>;
  try {
    proc = spawnClaudeUsage(options);
  } catch (error) {
    throw new ClaudeUsageError("not-installed", "claude cli not found", { cause: error });
  }

  const guard = createSubprocessGuard(proc, {
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    signal: options.signal,
    timeoutError: () => new ClaudeUsageError("timeout", "claude usage did not respond"),
    killGraceMs: options.killGraceMs,
  });
  try {
    const { output, exitCode } = await guard.waitFor(
      (async () => ({
        output: await new Response(proc.stdout).text(),
        exitCode: await proc.exited,
      }))(),
    );
    if (exitCode !== 0) {
      throw new ClaudeUsageError("not-logged-in", "claude usage requires a signed-in cli");
    }

    const messages = decodeJsonLines(output);
    if (messages.length === 0) {
      throw new ClaudeUsageError("protocol", "claude usage returned invalid json");
    }
    const usage = parseClaudeUsageMessages(messages, now.getTime());
    if (!usage) throw new ClaudeUsageError("protocol", "claude usage returned no plan limits");
    return usage;
  } finally {
    guard.dispose();
  }
}

export interface ClaudeLimitsSource {
  read(): ClaudeCliUsage | null;
  note(): string | null;
  status?(): ConnectionStatus;
  poll(now: Date, options?: PollOptions): Promise<void>;
}

export interface ClaudeLimitsSourceOptions {
  initial?: ClaudeCliUsage | null;
  onUpdate?: (value: ClaudeCliUsage) => void;
  readPersisted?: () => ClaudeCliUsage | null;
  /**
   * True while a fresh statusline snapshot already carries the session and
   * weekly windows, which leaves the CLI responsible only for the scoped lanes
   * and extra usage. Checked on every tick, so the cadence tightens again the
   * moment that cover lapses.
   */
  isCoveredBySnapshot?: () => boolean;
}

/** Cadence when the CLI is the only source of the session and weekly windows. */
const MIN_POLL_MS = 3 * 60_000;
/**
 * Cadence when a fresh statusline snapshot already carries the session and
 * weekly windows for free. All the CLI still adds is the scoped lanes, and a
 * weekly bar cannot move far in twenty minutes, so this trades a little
 * latency on them for roughly six times fewer requests against the account.
 */
const SNAPSHOT_COVERED_POLL_MS = 20 * 60_000;
export const CLAUDE_LIMITS_STALE_MS = 10 * 60_000;
/** Sits above the snapshot-covered cadence so a routine tick never reads stale. */
export const CLAUDE_SCOPED_STALE_MS = SNAPSHOT_COVERED_POLL_MS + 5 * 60_000;
const BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
/**
 * Every poll is a real request against the account, so `r` is floored harder
 * than the local-CLI providers: a held key must not turn into an API flood.
 */
const MIN_FORCED_POLL_MS = 15_000;

const NOTES: Record<ClaudeUsageFailure, string> = {
  "not-installed": "claude cli not installed",
  "not-logged-in": "claude cli not signed in - run claude login",
  timeout: "claude usage did not respond",
  protocol: "claude usage format changed",
};

export const dormantClaudeLimitsSource: ClaudeLimitsSource = {
  read: () => null,
  note: () => null,
  status: () => "none",
  poll: () => Promise.resolve(),
};

type ClaudeUsageReader = typeof readClaudeUsage;

export function createClaudeLimitsSource(
  reader: ClaudeUsageReader = readClaudeUsage,
  sourceOptions: ClaudeLimitsSourceOptions = {},
): ClaudeLimitsSource {
  // Staleness is reported by the provider, which weighs the CLI reading against
  // the statusline snapshot, so no stale note is configured here.
  return createPolledSource<ClaudeCliUsage>({
    fetch: (now, signal) => reader(now, { signal }),
    fetchedAtMs: (value) => value.fetchedAtMs,
    minPollMs: () =>
      sourceOptions.isCoveredBySnapshot?.() ? SNAPSHOT_COVERED_POLL_MS : MIN_POLL_MS,
    describeFailure: (error) =>
      error instanceof ClaudeUsageError ? NOTES[error.kind] : "claude live limits unavailable",
    minForcedPollMs: MIN_FORCED_POLL_MS,
    backoffMs: BACKOFF_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
    initial: sourceOptions.initial ?? null,
    onUpdate: sourceOptions.onUpdate,
    readPersisted: sourceOptions.readPersisted,
  });
}
