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
  /** One row per request across the activity window, or null when the table could not be read. */
  rows: GoUsageRow[] | null;
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
  poll(now: Date, options?: PollOptions): Promise<void>;
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
    summary: goSpendSummary(reading.months),
    billing: reading.months[0]?.billing ?? null,
    activity: reading.rows ? goActivityFromRows(reading.rows) : null,
  };
}

/**
 * Walks the usage table back only as far as the rows already held. A row is one
 * request and never changes once written, so everything older than the newest
 * row held was seen on an earlier walk: a poll that follows one by half an hour
 * costs a page or two, where walking the whole window is sixty for a busy
 * workspace. Rows that have aged out of the window are dropped as they go, so
 * the held set stays the size of one window.
 *
 * Rows without a timestamp cannot be placed in the window and are not held
 * across walks: whatever the latest walk returned of them stands in for totals.
 */
export async function readRowsSince(
  held: GoUsageRow[] | null,
  windowStartMs: number,
  fetchRowsSince: (sinceMs: number) => Promise<GoUsageRow[]>,
): Promise<GoUsageRow[]> {
  const kept = (held ?? []).filter((row) => row.atMs !== null && row.atMs >= windowStartMs);
  if (kept.length === 0) return fetchRowsSince(windowStartMs);

  const newestHeldMs = kept.reduce((newest, row) => Math.max(newest, row.atMs ?? 0), 0);
  const fresh = await fetchRowsSince(newestHeldMs);
  // The walk re-reads the second the newest held row landed in, so the join is
  // by the server's row id. A row the server did not name is new only if it is
  // strictly later - one it shares a second with is more likely a repeat.
  const heldIds = new Set(kept.map((row) => row.id).filter((id): id is string => id !== null));
  const unseen = fresh.filter((row) =>
    row.id !== null ? !heldIds.has(row.id) : row.atMs !== null && row.atMs > newestHeldMs,
  );
  return [...unseen, ...kept];
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

      // Discovery is one round trip, skipped whenever any source has already
      // made it. Without it the open month goes first, alone, to make it.
      let known = options.knownWorkspaceId?.() ?? workspaceId;
      let current: GoUsageHistory | null = null;
      if (!known) {
        current = await fetchHistory(cookie, now, { monthsAgo: 0, signal, withBilling: true });
        known = current.workspaceId;
      }
      const workspace = known;
      const remaining = Array.from({ length: MONTHS }, (_, index) => index).filter(
        (monthsAgo) => monthsAgo > 0 || current === null,
      );
      const windowStartMs = nowMs - ACTIVITY_WINDOW_DAYS * DAY_MS;
      // Everything left is independent, so it goes out together: three months
      // read in series were three round trips where one would do.
      const [months, rows] = await Promise.all([
        Promise.all(
          remaining.map((monthsAgo) =>
            fetchHistory(cookie, now, {
              monthsAgo,
              workspaceId: workspace,
              signal,
              // The billing record is per workspace, so the open month carries
              // it and the closed ones are spared the request.
              withBilling: monthsAgo === 0,
            }),
          ),
        ),
        // Supplementary to the money: a failure here leaves the last good rows
        // in place rather than blanking the chart.
        readRowsSince(previous?.rows ?? null, windowStartMs, (sinceMs) =>
          fetchRows(cookie, workspace, { sinceMs, signal }),
        ).catch(() => previous?.rows ?? null),
      ]);
      workspaceId = workspace;
      return { months: current ? [current, ...months] : months, rows, fetchedAtMs: nowMs };
    },
    fetchedAtMs: (value) => value.fetchedAtMs,
    describeFailure: () => "opencode history unavailable",
    onFailure: (error) => {
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
    poll: source.poll,
  };
}
