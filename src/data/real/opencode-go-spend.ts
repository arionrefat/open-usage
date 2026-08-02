import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { DAY_MS, HOUR_MS } from "./aggregate";
import { isRecord } from "./json";

/**
 * Opencode publishes no usage API, so plan usage is derived from the dollar
 * cost opencode.db records per assistant message against the published caps.
 * Caps move with the plan, so they are overridable rather than constants.
 */
interface GoPlanCaps {
  sessionUsd: number;
  weeklyUsd: number;
  monthlyUsd: number;
}

const GO_PLAN_CAPS: GoPlanCaps = { sessionUsd: 12, weeklyUsd: 30, monthlyUsd: 60 };

export const GO_SESSION_MS = 5 * HOUR_MS;
const GO_WEEK_MS = 7 * DAY_MS;

const QUERY_WINDOW_MS = 62 * DAY_MS;

export interface SpendEvent {
  atMs: number;
  usd: number;
}

export interface SpendWindow {
  usd: number;
  capUsd: number;
  percent: number;
  /** When headroom returns: the oldest spend ages out, or the month rolls over. */
  resetAtMs: number | null;
}

export interface GoSpend {
  session: SpendWindow;
  weekly: SpendWindow;
  monthly: SpendWindow;
  latestMs: number;
}

function percentOf(usd: number, capUsd: number): number {
  if (!(capUsd > 0)) return 0;
  return Math.max(0, (usd / capUsd) * 100);
}

/**
 * Rolling windows never "reset" wholesale - headroom returns gradually as the
 * oldest spend ages out, which is the timestamp reported here.
 */
function rollingWindow(
  events: SpendEvent[],
  nowMs: number,
  windowMs: number,
  capUsd: number,
): SpendWindow {
  const since = nowMs - windowMs;
  let usd = 0;
  let oldestMs: number | null = null;
  for (const event of events) {
    if (event.atMs <= since || event.atMs > nowMs) continue;
    usd += event.usd;
    if (oldestMs === null || event.atMs < oldestMs) oldestMs = event.atMs;
  }
  return {
    usd,
    capUsd,
    percent: percentOf(usd, capUsd),
    resetAtMs: oldestMs === null ? null : oldestMs + windowMs,
  };
}

/** Day-of-month clamped into `month`, so a 31st anchor still lands in February. */
function anchorDate(year: number, month: number, day: number): Date {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, lastDay));
}

/**
 * The billing cycle renews on the subscription day, not the 1st, so the month
 * window is anchored to the first-ever spend. Without that anchor a cycle that
 * just rolled over would read near-zero while the weekly window reads high.
 */
function monthlyWindow(
  events: SpendEvent[],
  now: Date,
  capUsd: number,
  anchorMs: number | null,
): SpendWindow {
  const anchorDay = anchorMs === null ? 1 : new Date(anchorMs).getDate();
  let start = anchorDate(now.getFullYear(), now.getMonth(), anchorDay);
  if (start.getTime() > now.getTime()) {
    start = anchorDate(now.getFullYear(), now.getMonth() - 1, anchorDay);
  }
  const next = anchorDate(start.getFullYear(), start.getMonth() + 1, anchorDay);

  const startMs = start.getTime();
  const nowMs = now.getTime();
  let usd = 0;
  for (const event of events) {
    if (event.atMs < startMs || event.atMs > nowMs) continue;
    usd += event.usd;
  }
  return { usd, capUsd, percent: percentOf(usd, capUsd), resetAtMs: next.getTime() };
}

/**
 * Pure assembly so tests can feed synthetic spend without a database.
 * `anchorMs` is the first spend ever recorded, which dates the billing cycle.
 */
export function goSpendFrom(
  events: SpendEvent[],
  now: Date,
  caps: GoPlanCaps = GO_PLAN_CAPS,
  anchorMs: number | null = null,
): GoSpend {
  const nowMs = now.getTime();
  let latestMs = 0;
  for (const event of events) latestMs = Math.max(latestMs, event.atMs);
  return {
    session: rollingWindow(events, nowMs, GO_SESSION_MS, caps.sessionUsd),
    weekly: rollingWindow(events, nowMs, GO_WEEK_MS, caps.weeklyUsd),
    monthly: monthlyWindow(events, now, caps.monthlyUsd, anchorMs),
    latestMs,
  };
}

export function spendFromRows(rows: unknown[]): SpendEvent[] {
  const events: SpendEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const { at, usd } = row;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) continue;
    events.push({ atMs: at, usd });
  }
  return events;
}

const SPEND_SQL =
  "SELECT CAST(COALESCE(json_extract(data,'$.time.created'), time_created) AS INTEGER) AS at," +
  " CAST(json_extract(data,'$.cost') AS REAL) AS usd" +
  " FROM message" +
  " WHERE json_extract(data,'$.providerID')='opencode-go'" +
  " AND json_extract(data,'$.role')='assistant'" +
  " AND json_type(data,'$.cost') IN ('integer','real')" +
  " AND CAST(COALESCE(json_extract(data,'$.time.created'), time_created) AS INTEGER) >= ?1";

const ANCHOR_SQL =
  "SELECT MIN(CAST(COALESCE(json_extract(data,'$.time.created'), time_created) AS INTEGER)) AS at" +
  " FROM message" +
  " WHERE json_extract(data,'$.providerID')='opencode-go'" +
  " AND json_extract(data,'$.role')='assistant'" +
  " AND json_type(data,'$.cost') IN ('integer','real')";

/** Readonly spend read; null when the DB is missing or unreadable. */
export function readGoSpend(dbPath: string, now: Date, caps: GoPlanCaps = GO_PLAN_CAPS): GoSpend | null {
  if (!existsSync(dbPath)) return null;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows: unknown[] = db.query(SPEND_SQL).all(now.getTime() - QUERY_WINDOW_MS);
    const [anchorRow]: unknown[] = db.query(ANCHOR_SQL).all();
    const anchorAt = isRecord(anchorRow) ? anchorRow.at : null;
    const anchorMs = typeof anchorAt === "number" && Number.isFinite(anchorAt) ? anchorAt : null;
    return goSpendFrom(spendFromRows(rows), now, caps, anchorMs);
  } catch {
    // A locked or migrated DB is an expected local condition, not a crash.
    return null;
  } finally {
    db?.close();
  }
}
