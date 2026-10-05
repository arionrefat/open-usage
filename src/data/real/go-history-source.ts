import type { PollOptions, SpendSummary } from "../types";
import { DAY_MS } from "./aggregate";
import { goActivityFromRows, type GoActivity } from "./go-activity";
import { goSpendSummary } from "./go-spend-summary";
import {
  OpencodeServerError,
  fetchGoUsageHistory,
  fetchGoUsageRows,
  type GoUsageHistory,
} from "./opencode-server";
import type { GoBilling, GoUsageRow } from "./opencode-usage";
import { createPolledSource, type PolledSource } from "./polled-source";

/**
 * What one poll of the dashboard's history brings back, kept as the rows the
 * server sent rather than the figures derived from them. Rows persist as plain
 * JSON in the shared usage cache, which is what lets a daemon's walk of the
 * usage table serve a dashboard opened an hour later; the derivations are
 * cheap enough to repeat on read.
 */
export interface GoHistoryReading {
  /** The open month first, then the two before it. */
  months: GoUsageHistory[];
  /** One row per request across the activity window, or null when the log could not be read. */
  rows: GoUsageRow[] | null;
  /**
   * True when the latest walk found the request log changed and `rows` are the
   * last good ones. Persisted, so a dashboard adopting a daemon's reading says
   * so too instead of showing a chart that silently stopped moving.
   */
  hasRequestLogDrift: boolean;
  fetchedAtMs: number;
}

/**
 * Server-side month history, polled out-of-band because the UI reads snapshots
 * synchronously. Dormant without a cookie: opencode.db carries no per-model cost
 * history, so there is nothing to fall back to here.
 */
export interface GoHistorySource {
  read(): SpendSummary | null;
  billing(): GoBilling | null;
  /** Workspace-wide activity from the dashboard, or null without a cookie. */
  activity(): GoActivity | null;
  /**
   * Set when a route the history reads has changed shape, which is the one
   * failure nothing else reports: the limits share this cookie and host, so
   * they already say when the session or the network is the problem.
   */
  note(): string | null;
  poll(now: Date, options?: PollOptions): Promise<void>;
}

const COST_DRIFT_NOTE = "opencode cost history changed - showing saved months";
const REQUEST_LOG_DRIFT_NOTE = "opencode request log changed - showing saved activity";

function isDrift(error: unknown): boolean {
  return error instanceof OpencodeServerError && error.kind === "parse";
}

export interface GoHistorySourceOptions {
  fetchHistory?: typeof fetchGoUsageHistory;
  fetchRows?: typeof fetchGoUsageRows;
  initial?: GoHistoryReading | null;
  onUpdate?: (value: GoHistoryReading) => void;
  readPersisted?: () => GoHistoryReading | null;
  /** A workspace id another source has already discovered, which saves the round trip. */
  knownWorkspaceId?: () => string | undefined;
}

/** Completed months never change, and the open one moves slowly. */
const MIN_POLL_MS = 30 * 60_000;
/**
 * Far above the limits sources' floor: a history poll is thirty-odd requests,
 * and what it refreshes - last month's spend, a 30-day chart - cannot have
 * moved in the five minutes since the last press.
 */
const MIN_FORCED_POLL_MS = 5 * 60_000;
const BACKOFF_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
/** The open month plus two closed ones, which is what the history line shows. */
const MONTHS = 3;
/** Matches the window every other activity series covers. */
const ACTIVITY_WINDOW_DAYS = 30;

export const dormantGoHistorySource: GoHistorySource = {
  read: () => null,
  billing: () => null,
  activity: () => null,
  note: () => null,
  poll: async () => {},
};

interface DerivedHistory {
  summary: SpendSummary | null;
  billing: GoBilling | null;
  activity: GoActivity | null;
}

const NOTHING_DERIVED: DerivedHistory = { summary: null, billing: null, activity: null };

function deriveHistory(reading: GoHistoryReading | null): DerivedHistory {
  if (!reading) return NOTHING_DERIVED;
  return {
    summary: goSpendSummary(reading.months, reading.rows),
    billing: reading.months[0]?.billing ?? null,
    activity: reading.rows ? goActivityFromRows(reading.rows) : null,
  };
}

/**
 * Walks the request log back only as far as the rows already held. A row is
 * one request and never changes once written, so everything older than the
 * newest row held was seen on an earlier walk: a poll that follows one by half
 * an hour costs a page or two, where walking the whole window is a dozen or
 * more. Rows that have aged out of the window are dropped as they go, so the
 * held set stays the size of one window.
 */
export async function readRowsSince(
  held: GoUsageRow[] | null,
  windowStartMs: number,
  fetchRowsSince: (sinceMs: number) => Promise<GoUsageRow[]>,
): Promise<GoUsageRow[]> {
  const kept = (held ?? []).filter((row) => row.atMs >= windowStartMs);
  if (kept.length === 0) return fetchRowsSince(windowStartMs);

  const newestHeldMs = kept.reduce((newest, row) => Math.max(newest, row.atMs), 0);
  const fresh = await fetchRowsSince(newestHeldMs);
  // The walk re-reads the millisecond the newest held row started in, so the
  // join is by the server's request id rather than by time.
  const heldIds = new Set(kept.map((row) => row.id));
  return [...fresh.filter((row) => !heldIds.has(row.id)), ...kept];
}

export function createGoHistorySource(
  readCookieHeader: () => string | null,
  options: GoHistorySourceOptions = {},
): GoHistorySource {
  const fetchHistory = options.fetchHistory ?? fetchGoUsageHistory;
  const fetchRows = options.fetchRows ?? fetchGoUsageRows;
  let workspaceId: string | undefined = options.initial?.months[0]?.workspaceId;
  // Read once per attempt and reused through the request, so a cookie rewritten
  // mid-poll cannot make the precheck and fetch disagree.
  let cookieForAttempt: string | null = null;
  // The derivations are repeated on every snapshot build, and a reading changes
  // at most once per poll, so they are memoized on the reading's identity.
  let derivedFrom: GoHistoryReading | null = null;
  let derived: DerivedHistory = NOTHING_DERIVED;
  let isLastFailureDrift = false;

  // Annotated because `fetch` reads the previous value back through `source`.
  const source: PolledSource<GoHistoryReading> = createPolledSource<GoHistoryReading>({
    precheck: (now) => {
      cookieForAttempt = readCookieHeader();
      // No cookie is the normal local-only state. The schedule stays untouched
      // so pasting one takes effect on the next tick.
      if (!cookieForAttempt) return { note: null, isThrottled: false };
      // Unlike the limits, a reading minutes old is not worth thirty requests
      // to repeat, whoever made it - the daemon, or this process before `r`.
      const reading = source.read();
      if (reading && now.getTime() - reading.fetchedAtMs < MIN_FORCED_POLL_MS) {
        return { note: null, isThrottled: false };
      }
      return null;
    },
    fetch: async (now, signal) => {
      const cookie = cookieForAttempt;
      if (!cookie) throw new OpencodeServerError("no opencode auth cookie", "credentials");
      const nowMs = now.getTime();
      const previous = source.read();
      const windowStartMs = nowMs - ACTIVITY_WINDOW_DAYS * DAY_MS;

      // Supplementary to the money: a failure here leaves the last good rows in
      // place rather than blanking the chart. Only drift is worth flagging; a
      // blip says nothing about whether the log still reads.
      const readRows = (workspace: string) =>
        readRowsSince(previous?.rows ?? null, windowStartMs, (sinceMs) =>
          fetchRows(cookie, workspace, { sinceMs, signal }),
        ).then(
          (rows) => ({ rows, hasRequestLogDrift: false }),
          (error: unknown) => ({
            rows: previous?.rows ?? null,
            hasRequestLogDrift: isDrift(error) || (previous?.hasRequestLogDrift ?? false),
          }),
        );

      // Discovery is one round trip, skipped whenever any source has already
      // made it. Without it the months go first, alone, to make it: the rows
      // walk cannot start until the workspace is named.
      const known = options.knownWorkspaceId?.() ?? workspaceId;
      if (!known) {
        const months = await fetchHistory(cookie, now, { months: MONTHS, signal });
        const discovered = months[0]?.workspaceId;
        if (!discovered) throw new OpencodeServerError("missing workspace id", "parse");
        workspaceId = discovered;
        return { months, ...(await readRows(discovered)), fetchedAtMs: nowMs };
      }

      const [months, rows] = await Promise.all([
        fetchHistory(cookie, now, { months: MONTHS, workspaceId: known, signal }),
        readRows(known),
      ]);
      workspaceId = known;
      return { months, ...rows, fetchedAtMs: nowMs };
    },
    fetchedAtMs: (value) => value.fetchedAtMs,
    describeFailure: () => "opencode history unavailable",
    onFailure: (error) => {
      isLastFailureDrift = isDrift(error);
      // An expired session or a dashboard redeploy invalidates the discovered
      // workspace id; a network blip or a rate limit does not.
      if (!(error instanceof OpencodeServerError)) return;
      if (error.kind === "credentials" || error.kind === "parse") workspaceId = undefined;
    },
    minPollMs: MIN_POLL_MS,
    minForcedPollMs: MIN_FORCED_POLL_MS,
    backoffMs: BACKOFF_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
    initial: options.initial ?? null,
    onUpdate: options.onUpdate,
    readPersisted: options.readPersisted,
  });

  function current(): DerivedHistory {
    const reading = source.read();
    if (reading !== derivedFrom) {
      derivedFrom = reading;
      derived = deriveHistory(reading);
    }
    return derived;
  }

  return {
    read: () => current().summary,
    billing: () => current().billing,
    activity: () => current().activity,
    note: () => {
      // The schedule's own note clears on the next good reading, ours or one
      // another process persisted, so it says whether the failure still stands.
      const notes = [
        isLastFailureDrift && source.note() !== null ? COST_DRIFT_NOTE : null,
        source.read()?.hasRequestLogDrift ? REQUEST_LOG_DRIFT_NOTE : null,
      ].filter((note): note is string => note !== null);
      return notes.length > 0 ? notes.join(" · ") : null;
    },
    poll: source.poll,
  };
}
