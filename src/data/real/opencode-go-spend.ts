import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { DAY_MS, HOUR_MS } from "./aggregate";
import { isRecord } from "./json";
import { isMissingFile } from "./fs-errors";
import { openForReading } from "./opencode-db";

/**
 * Derived from message.cost in opencode.db against the published caps.
 * Caps move with the plan, so they are overridable rather than constants.
 */
interface GoPlanCaps {
  sessionUsd: number;
  weeklyUsd: number;
  monthlyUsd: number;
}

const GO_PLAN_CAPS: GoPlanCaps = { sessionUsd: 12, weeklyUsd: 30, monthlyUsd: 60 };

/** $15 monthly-allowance models consume quota 4x faster per raw dollar. Source: opencode.ai/docs/go */
const GO_QUOTA_WEIGHTS: Record<string, number> = {
  "grok-4.5": 4,
  "gpt-5.6-luna": 4,
  "kimi-k3": 4,
  "mimo-v2.5-pro": 4,
  "qwen3.8-max": 4,
  "deepseek-v4-pro": 4,
};

export function goQuotaWeight(modelId: string | null): number {
  if (modelId === null) return 1;
  return GO_QUOTA_WEIGHTS[modelId] ?? 1;
}

export const GO_SESSION_MS = 5 * HOUR_MS;
const GO_WEEK_MS = 7 * DAY_MS;
const GO_MONTH_MS = 30 * DAY_MS;

const QUERY_WINDOW_MS = 31 * DAY_MS;

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

/** Rolling windows free up headroom gradually as the oldest spend ages out. */
function rollingWindow(
  events: SpendEvent[],
  nowMs: number,
  windowMs: number,
  capUsd: number,
): SpendWindow {
  const windowStartMs = nowMs - windowMs;
  let usd = 0;
  let oldestMs: number | null = null;
  for (const event of events) {
    const eventIsOutsideWindow = event.atMs <= windowStartMs || event.atMs > nowMs;
    if (eventIsOutsideWindow) continue;
    usd += event.usd;
    if (oldestMs === null || event.atMs < oldestMs) oldestMs = event.atMs;
  }
  const oldestSpendAgesOutAtMs = oldestMs === null ? null : oldestMs + windowMs;
  return {
    usd,
    capUsd,
    percent: percentOf(usd, capUsd),
    resetAtMs: oldestSpendAgesOutAtMs,
  };
}

/** The monthly figure is a trailing 30d window. The true billing-cycle boundary is only known to the server. */
export function goSpendFrom(
  events: SpendEvent[],
  now: Date,
  caps: GoPlanCaps = GO_PLAN_CAPS,
): GoSpend {
  const nowMs = now.getTime();
  let latestMs = 0;
  for (const event of events) latestMs = Math.max(latestMs, event.atMs);
  return {
    session: rollingWindow(events, nowMs, GO_SESSION_MS, caps.sessionUsd),
    weekly: rollingWindow(events, nowMs, GO_WEEK_MS, caps.weeklyUsd),
    monthly: rollingWindow(events, nowMs, GO_MONTH_MS, caps.monthlyUsd),
    latestMs,
  };
}

/** Rows carry the raw message cost; quota weighting is applied per model. */
export function spendFromRows(rows: unknown[]): SpendEvent[] {
  const events: SpendEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const { at, usd, model } = row;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) continue;
    events.push({ atMs: at, usd: usd * goQuotaWeight(typeof model === "string" ? model : null) });
  }
  return events;
}

const SPEND_SQL =
  "SELECT CAST(COALESCE(json_extract(data,'$.time.created'), time_created) AS INTEGER) AS at," +
  " CAST(json_extract(data,'$.cost') AS REAL) AS usd," +
  " json_extract(data,'$.modelID') AS model" +
  " FROM message" +
  // Both names, because opencode renamed the Go provider and a machine that
  // spans the rename holds spend under each.
  " WHERE json_extract(data,'$.providerID') IN ('opencode','opencode-go')" +
  " AND json_extract(data,'$.role')='assistant'" +
  " AND json_type(data,'$.cost') IN ('integer','real')" +
  " AND CAST(COALESCE(json_extract(data,'$.time.created'), time_created) AS INTEGER) >= ?1";

/**
 * Newer OpenCode databases write one cost per `step-finish` part. Fall back to
 * message.cost only for messages without those parts, so a transitional row
 * carrying both shapes is counted once rather than twice.
 */
const PART_SPEND_SQL = `
  WITH provider_messages AS (
    SELECT
      id AS messageID,
      CAST(COALESCE(json_extract(data,'$.time.created'), time_created) AS INTEGER) AS createdMs,
      CAST(json_extract(data,'$.cost') AS REAL) AS messageCost,
      json_type(data,'$.cost') IN ('integer','real') AS hasMessageCost,
      json_extract(data,'$.modelID') AS model
    FROM message
    WHERE json_extract(data,'$.providerID') IN ('opencode','opencode-go')
      AND json_extract(data,'$.role')='assistant'
      -- Bounded so the CTE does not scan every message ever written. The day of
      -- slack covers a part timestamped after the message that opened it.
      AND time_created >= ?1 - ${DAY_MS}
  )
  SELECT
    CAST(COALESCE(json_extract(p.data,'$.time.created'), p.time_created, m.createdMs) AS INTEGER) AS at,
    CAST(json_extract(p.data,'$.cost') AS REAL) AS usd,
    m.model AS model
  FROM part p
  JOIN provider_messages m ON m.messageID = p.message_id
  WHERE json_valid(p.data)
    AND json_extract(p.data,'$.type')='step-finish'
    AND json_type(p.data,'$.cost') IN ('integer','real')
    AND CAST(COALESCE(json_extract(p.data,'$.time.created'), p.time_created, m.createdMs) AS INTEGER) >= ?1
  UNION ALL
  SELECT createdMs AS at, messageCost AS usd, model
  FROM provider_messages m
  WHERE hasMessageCost
    AND createdMs >= ?1
    AND NOT EXISTS (
      SELECT 1 FROM part p
      WHERE p.message_id=m.messageID
        AND json_valid(p.data)
        AND json_extract(p.data,'$.type')='step-finish'
        AND json_type(p.data,'$.cost') IN ('integer','real')
    )`;

function hasPartTable(db: Database): boolean {
  return db.query(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='part' LIMIT 1",
  ).get() !== null;
}

/** null only when the DB is absent. */
export function readGoSpend(dbPath: string, now: Date, caps: GoPlanCaps = GO_PLAN_CAPS): GoSpend | null {
  try {
    statSync(dbPath);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  let db: Database | null = null;
  try {
    db = openForReading(dbPath);
    const sql = hasPartTable(db) ? PART_SPEND_SQL : SPEND_SQL;
    const rows: unknown[] = db.query(sql).all(now.getTime() - QUERY_WINDOW_MS);
    return goSpendFrom(spendFromRows(rows), now, caps);
  } catch (error) {
    // The provider catches this boundary and marks the source unreadable.
    throw error;
  } finally {
    db?.close();
  }
}
