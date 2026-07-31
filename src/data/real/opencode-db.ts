import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { DAY_MS, type HourBuckets } from "./aggregate";
import { isRecord } from "./json";

export interface OpencodeSessionStats {
  sessions: number;
  tokens: number;
  latestMs: number;
}

/** Aggregates keyed by opencode's providerID ("openai", "opencode-go", ...). */
export interface OpencodeUsage {
  buckets: Map<string, HourBuckets>;
  stats: Map<string, OpencodeSessionStats>;
  latestMs: number;
}

const USAGE_WINDOW_DAYS = 31;

/** Fresh tokens only - cache reads would dwarf real work by two orders of magnitude. */
const TOKENS_SQL =
  "coalesce(json_extract(data,'$.tokens.input'),0)" +
  "+coalesce(json_extract(data,'$.tokens.output'),0)" +
  "+coalesce(json_extract(data,'$.tokens.reasoning'),0)" +
  "+coalesce(json_extract(data,'$.tokens.cache.write'),0)";

const HOUR_ROWS_SQL =
  "SELECT CAST(time_created/3600000 AS INTEGER) AS hour," +
  " json_extract(data,'$.providerID') AS provider," +
  ` SUM(${TOKENS_SQL}) AS tokens` +
  " FROM message" +
  " WHERE json_extract(data,'$.role')='assistant' AND time_created >= ?1" +
  " GROUP BY hour, provider";

const SESSION_ROWS_SQL =
  "SELECT json_extract(data,'$.providerID') AS provider," +
  " COUNT(DISTINCT session_id) AS sessions," +
  ` SUM(${TOKENS_SQL}) AS tokens,` +
  " MAX(time_created) AS latest" +
  " FROM message" +
  " WHERE json_extract(data,'$.role')='assistant' AND time_created >= ?1" +
  " GROUP BY provider";

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Pure assembly from raw SQL rows so tests can feed synthetic data. */
export function usageFromRows(hourRows: unknown[], sessionRows: unknown[]): OpencodeUsage {
  const buckets = new Map<string, HourBuckets>();
  for (const row of hourRows) {
    if (!isRecord(row) || typeof row.provider !== "string") continue;
    const hour = finiteNumber(row.hour);
    const tokens = finiteNumber(row.tokens);
    if (hour === null || tokens === null || tokens <= 0) continue;
    const providerBuckets = buckets.get(row.provider) ?? new Map<number, number>();
    providerBuckets.set(hour, (providerBuckets.get(hour) ?? 0) + tokens);
    buckets.set(row.provider, providerBuckets);
  }

  const stats = new Map<string, OpencodeSessionStats>();
  let latestMs = 0;
  for (const row of sessionRows) {
    if (!isRecord(row) || typeof row.provider !== "string") continue;
    const entry: OpencodeSessionStats = {
      sessions: finiteNumber(row.sessions) ?? 0,
      tokens: finiteNumber(row.tokens) ?? 0,
      latestMs: finiteNumber(row.latest) ?? 0,
    };
    stats.set(row.provider, entry);
    latestMs = Math.max(latestMs, entry.latestMs);
  }
  return { buckets, stats, latestMs };
}

/** Readonly aggregate read; null when the DB is missing or unreadable. */
export function readOpencodeUsage(dbPath: string, now: Date): OpencodeUsage | null {
  if (!existsSync(dbPath)) return null;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const sinceMs = now.getTime() - USAGE_WINDOW_DAYS * DAY_MS;
    const hourRows: unknown[] = db.query(HOUR_ROWS_SQL).all(sinceMs);
    const sessionRows: unknown[] = db.query(SESSION_ROWS_SQL).all(sinceMs);
    return usageFromRows(hourRows, sessionRows);
  } catch {
    // A locked or migrated DB is an expected local condition, not a crash.
    return null;
  } finally {
    db?.close();
  }
}
