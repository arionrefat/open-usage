import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { DAY_MS, localDateKey, type HourBuckets } from "./aggregate";
import { finiteNumber, isRecord } from "./json";
import { isMissingFile } from "./fs-errors";

export interface OpencodeSessionStats {
  sessions: number;
  tokens: number;
  latestMs: number;
  /** Most-used model id for the provider, e.g. "gpt-5.6-sol". */
  topModel: string | null;
  modelTokens30d?: Record<string, number>;
  tokenSplit30d?: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
  cost30d?: { totalUsd: number; peakDayUsd: number };
}

/** Aggregates keyed by opencode's providerID ("openai", "opencode-go", ...). */
export interface OpencodeUsage {
  buckets: Map<string, HourBuckets>;
  stats: Map<string, OpencodeSessionStats>;
  latestMs: number;
}

const USAGE_WINDOW_DAYS = 30;

/**
 * opencode renamed the Go provider from `opencode-go` to `opencode`, so a
 * machine that spans the rename holds rows under both. Folding them to one key
 * in SQL merges that history instead of showing whichever half the reader
 * happened to ask for, and keeps every consumer on the name it already uses.
 */
const PROVIDER_SQL =
  "CASE WHEN json_extract(data,'$.providerID') IN ('opencode','opencode-go')" +
  " THEN 'opencode-go' ELSE json_extract(data,'$.providerID') END";

/** Fresh tokens only - cache reads would dwarf real work by two orders of magnitude. */
const TOKENS_SQL =
  "coalesce(json_extract(data,'$.tokens.input'),0)" +
  "+coalesce(json_extract(data,'$.tokens.output'),0)" +
  "+coalesce(json_extract(data,'$.tokens.reasoning'),0)" +
  "+coalesce(json_extract(data,'$.tokens.cache.write'),0)";

const HOUR_ROWS_SQL =
  "SELECT CAST(time_created/3600000 AS INTEGER) AS hour," +
  ` ${PROVIDER_SQL} AS provider,` +
  ` SUM(${TOKENS_SQL}) AS tokens` +
  " FROM message" +
  " WHERE json_extract(data,'$.role')='assistant' AND time_created >= ?1" +
  " GROUP BY hour, provider";

const SESSION_ROWS_SQL =
  `SELECT ${PROVIDER_SQL} AS provider,` +
  " COUNT(DISTINCT session_id) AS sessions," +
  ` SUM(${TOKENS_SQL}) AS tokens,` +
  " MAX(time_created) AS latest" +
  " FROM message" +
  " WHERE json_extract(data,'$.role')='assistant' AND time_created >= ?1" +
  " GROUP BY provider";

const MODEL_ROWS_SQL =
  `SELECT ${PROVIDER_SQL} AS provider,` +
  " json_extract(data,'$.modelID') AS model," +
  // Same basis as the headline above, so the per-model bars sum to it rather
  // than contradicting it by the cache-read volume.
  ` COUNT(*) AS msgs, SUM(${TOKENS_SQL}) AS tokens` +
  " FROM message" +
  " WHERE json_extract(data,'$.role')='assistant' AND time_created >= ?1" +
  " GROUP BY provider, model";

const DETAIL_ROWS_SQL =
  `SELECT ${PROVIDER_SQL} AS provider,` +
  " SUM(coalesce(json_extract(data,'$.tokens.input'),0)) AS input," +
  " SUM(coalesce(json_extract(data,'$.tokens.output'),0)) AS output," +
  " SUM(coalesce(json_extract(data,'$.tokens.reasoning'),0)) AS reasoning," +
  " SUM(coalesce(json_extract(data,'$.tokens.cache.read'),0)) AS cacheRead," +
  " SUM(coalesce(json_extract(data,'$.tokens.cache.write'),0)) AS cacheWrite," +
  " SUM(coalesce(json_extract(data,'$.cost'),0)) AS totalUsd," +
  " SUM(CASE WHEN json_type(data,'$.tokens')='object' THEN 1 ELSE 0 END) AS tokenCount," +
  " COUNT(json_extract(data,'$.cost')) AS costCount" +
  " FROM message WHERE json_extract(data,'$.role')='assistant' AND time_created >= ?1" +
  " GROUP BY provider";

/**
 * Quarter-hour slots, folded into local days by `localDateKey` in JS.
 *
 * Not `time_created/86400000`, which buckets by UTC and moves the peak onto a
 * different date for anyone off the meridian. Not SQLite's own `'localtime'`
 * either: that reads the system timezone while every other day bucket in this
 * app reads the JS one, and a runtime that overrides only the latter would
 * silently split the two apart. A quarter hour divides every real UTC offset,
 * so the slot never straddles a local midnight.
 */
const COST_SLOT_MS = 900_000;

const DAILY_COST_ROWS_SQL =
  `SELECT ${PROVIDER_SQL} AS provider,` +
  ` CAST(time_created/${COST_SLOT_MS} AS INTEGER) AS slot,` +
  " SUM(coalesce(json_extract(data,'$.cost'),0)) AS usd" +
  " FROM message WHERE json_extract(data,'$.role')='assistant' AND time_created >= ?1" +
  " GROUP BY provider, slot";

/** Picks the model with the most assistant messages per provider. */
function topModels(modelRows: unknown[]): Map<string, string> {
  const best = new Map<string, { model: string; msgs: number }>();
  for (const row of modelRows) {
    if (!isRecord(row)) continue;
    const { provider, model } = row;
    if (typeof provider !== "string" || typeof model !== "string") continue;
    const msgs = finiteNumber(row.msgs) ?? 0;
    const current = best.get(provider);
    if (!current || msgs > current.msgs) best.set(provider, { model, msgs });
  }
  return new Map([...best].map(([provider, entry]) => [provider, entry.model]));
}

/** Pure assembly from raw SQL rows so tests can feed synthetic data. */
export function usageFromRows(
  hourRows: unknown[],
  sessionRows: unknown[],
  modelRows: unknown[] = [],
  detailRows: unknown[] = [],
  dailyCostRows: unknown[] = [],
): OpencodeUsage {
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

  const models = topModels(modelRows);
  const modelTokens = new Map<string, Record<string, number>>();
  for (const row of modelRows) {
    if (!isRecord(row) || typeof row.provider !== "string" || typeof row.model !== "string") continue;
    const tokens = finiteNumber(row.tokens);
    if (tokens === null || tokens <= 0) continue;
    const providerModels = modelTokens.get(row.provider) ?? {};
    providerModels[row.model] = tokens;
    modelTokens.set(row.provider, providerModels);
  }
  const details = new Map<
    string,
    OpencodeSessionStats["tokenSplit30d"] & {
      totalUsd: number;
      tokenCount: number;
      costCount: number;
    }
  >();
  for (const row of detailRows) {
    if (!isRecord(row) || typeof row.provider !== "string") continue;
    details.set(row.provider, {
      input: finiteNumber(row.input) ?? 0,
      output: finiteNumber(row.output) ?? 0,
      reasoning: finiteNumber(row.reasoning) ?? 0,
      cacheRead: finiteNumber(row.cacheRead) ?? 0,
      cacheWrite: finiteNumber(row.cacheWrite) ?? 0,
      totalUsd: finiteNumber(row.totalUsd) ?? 0,
      tokenCount: finiteNumber(row.tokenCount) ?? 0,
      costCount: finiteNumber(row.costCount) ?? 0,
    });
  }
  const dayCosts = new Map<string, Map<string, number>>();
  for (const row of dailyCostRows) {
    if (!isRecord(row) || typeof row.provider !== "string") continue;
    const slot = finiteNumber(row.slot);
    const usd = finiteNumber(row.usd);
    if (slot === null || usd === null) continue;
    const day = localDateKey(new Date(slot * COST_SLOT_MS));
    const byDay = dayCosts.get(row.provider) ?? new Map<string, number>();
    byDay.set(day, (byDay.get(day) ?? 0) + usd);
    dayCosts.set(row.provider, byDay);
  }
  const peakCosts = new Map<string, number>();
  for (const [provider, byDay] of dayCosts) {
    peakCosts.set(provider, Math.max(0, ...byDay.values()));
  }
  const stats = new Map<string, OpencodeSessionStats>();
  let latestMs = 0;
  for (const row of sessionRows) {
    if (!isRecord(row) || typeof row.provider !== "string") continue;
    const entry: OpencodeSessionStats = {
      sessions: finiteNumber(row.sessions) ?? 0,
      tokens: finiteNumber(row.tokens) ?? 0,
      latestMs: finiteNumber(row.latest) ?? 0,
      topModel: models.get(row.provider) ?? null,
    };
    const providerModels = modelTokens.get(row.provider);
    if (providerModels) entry.modelTokens30d = providerModels;
    const detail = details.get(row.provider);
    if (detail?.tokenCount) {
      entry.tokenSplit30d = {
        input: detail.input,
        output: detail.output,
        reasoning: detail.reasoning,
        cacheRead: detail.cacheRead,
        cacheWrite: detail.cacheWrite,
      };
    }
    if (detail?.costCount) {
      entry.cost30d = { totalUsd: detail.totalUsd, peakDayUsd: peakCosts.get(row.provider) ?? 0 };
    }
    stats.set(row.provider, entry);
    latestMs = Math.max(latestMs, entry.latestMs);
  }
  return { buckets, stats, latestMs };
}

/** Readonly aggregate read; null only when the DB is absent. */
export function aggregateRowsFromDatabase(db: Database, sinceMs: number): unknown[][] {
  return db.transaction(() => [
    db.query(HOUR_ROWS_SQL).all(sinceMs),
    db.query(SESSION_ROWS_SQL).all(sinceMs),
    db.query(MODEL_ROWS_SQL).all(sinceMs),
    db.query(DETAIL_ROWS_SQL).all(sinceMs),
    db.query(DAILY_COST_ROWS_SQL).all(sinceMs),
  ])();
}

/**
 * Read-only first, then read-write without create.
 *
 * SQLite cannot open a WAL database read-only unless the `-shm` file already
 * exists, and it needs write access to the directory to make one. A clean
 * shutdown removes it, so an installed-but-idle opencode is exactly the case
 * that fails - which is every machine that has the data but is not running.
 *
 * The fallback still only ever runs SELECTs. `create: false` matters: without
 * it a database that vanished after the stat above would be conjured empty and
 * read back as a real measurement of zero.
 */
function openForReading(dbPath: string): Database {
  // bun:sqlite connects lazily, so a handle that cannot reach the file is only
  // rejected on first use. Probing here is what makes the fallback reachable.
  let readonlyDb: Database | null = null;
  try {
    readonlyDb = new Database(dbPath, { readonly: true });
    readonlyDb.query("SELECT 1").get();
    return readonlyDb;
  } catch {
    readonlyDb?.close();
  }
  const db = new Database(dbPath, { readwrite: true, create: false });
  db.query("SELECT 1").get();
  return db;
}

export function readOpencodeUsage(dbPath: string, now: Date): OpencodeUsage | null {
  try {
    statSync(dbPath);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  let db: Database | null = null;
  try {
    db = openForReading(dbPath);
    const sinceMs = now.getTime() - USAGE_WINDOW_DAYS * DAY_MS;
    const [hourRows = [], sessionRows = [], modelRows = [], detailRows = [], dailyCostRows = []] =
      aggregateRowsFromDatabase(db, sinceMs);
    return usageFromRows(hourRows, sessionRows, modelRows, detailRows, dailyCostRows);
  } catch (error) {
    // The provider catches this boundary and marks the source unreadable.
    throw error;
  } finally {
    db?.close();
  }
}
