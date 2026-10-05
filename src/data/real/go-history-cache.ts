import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { withFileLock } from "../../lib/file-lock";
import type { GoHistoryReading } from "./go-history-source";
import { isRecord } from "./json";
import type { GoCostSpan, GoUsageHistory } from "./opencode-server";
import type { GoApiKey, GoBilling, GoCostRow, GoPlan, GoUsageRow } from "./opencode-usage";

/**
 * `~/.config/open-usage/go-history.json`: the dashboard's month history and
 * usage table, shared between the daemon and the dashboard like the limits.
 *
 * Its own file rather than a key in the usage cache because it is the size of
 * a month's usage - a megabyte for a busy workspace - and changes every half
 * hour, while the limits beside it change every minute. Kept together, every
 * limits update rewrote the megabyte.
 */

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && !Array.isArray(value) ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableFinite(value: unknown): number | null | undefined {
  if (value === null) return null;
  const parsed = finite(value);
  return parsed === null ? undefined : parsed;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/** Every element decoded, or null: one corrupt row spoils the list rather than vanishing from it. */
function everyItem<T>(value: unknown, decode: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const item of value) {
    const decoded = decode(item);
    if (decoded === null) return null;
    items.push(decoded);
  }
  return items;
}

function goPlan(value: unknown): GoPlan | null {
  return value === "sub" || value === "lite" || value === "payg" ? value : null;
}

function goCostRow(value: unknown): GoCostRow | null {
  const raw = record(value);
  if (!raw || typeof raw.date !== "string") return null;
  const usd = finite(raw.usd);
  const keyId = nullableString(raw.keyId);
  // A day total names no model, which is the shape the console's chart returns.
  const model = nullableString(raw.model);
  const plan = goPlan(raw.plan);
  if (usd === null || keyId === undefined || model === undefined || plan === null) return null;
  return { date: raw.date, model, usd, keyId, plan };
}

function goApiKey(value: unknown): GoApiKey | null {
  const raw = record(value);
  if (!raw || typeof raw.id !== "string" || typeof raw.displayName !== "string") return null;
  if (typeof raw.isDeleted !== "boolean") return null;
  return { id: raw.id, displayName: raw.displayName, isDeleted: raw.isDeleted };
}

function goBilling(value: unknown): GoBilling | null {
  const raw = record(value);
  if (!raw) return null;
  const balanceUsd = finite(raw.balanceUsd);
  const monthlyUsageUsd = nullableFinite(raw.monthlyUsageUsd);
  const monthlyLimitUsd = nullableFinite(raw.monthlyLimitUsd);
  const reloadAmountUsd = nullableFinite(raw.reloadAmountUsd);
  if (balanceUsd === null) return null;
  if (monthlyUsageUsd === undefined || monthlyLimitUsd === undefined) return null;
  if (reloadAmountUsd === undefined) return null;
  if (typeof raw.isAutoReloadOn !== "boolean") return null;
  if (typeof raw.hasLiteSubscription !== "boolean" || typeof raw.hasSubscription !== "boolean") {
    return null;
  }
  // Absent from records written before the auto-recharge state was kept.
  const autoReloadFailure = raw.autoReloadFailure === undefined ? null : nullableString(raw.autoReloadFailure);
  if (autoReloadFailure === undefined) return null;
  if (raw.isAutoReloadPending !== undefined && typeof raw.isAutoReloadPending !== "boolean") return null;
  return {
    balanceUsd,
    monthlyUsageUsd,
    monthlyLimitUsd,
    isAutoReloadOn: raw.isAutoReloadOn,
    reloadAmountUsd,
    isAutoReloadPending: raw.isAutoReloadPending === true,
    autoReloadFailure,
    hasLiteSubscription: raw.hasLiteSubscription,
    hasSubscription: raw.hasSubscription,
  };
}

function goUsageHistory(value: unknown): GoUsageHistory | null {
  const raw = record(value);
  const costs = record(raw?.costs);
  if (!raw || !costs) return null;
  if (typeof raw.workspaceId !== "string" || typeof raw.month !== "string") return null;
  const rows = everyItem(costs.rows, goCostRow);
  const keys = everyItem(costs.keys, goApiKey);
  if (rows === null || keys === null) return null;
  const billing = raw.billing === null ? null : goBilling(raw.billing);
  if (raw.billing !== null && billing === null) return null;
  return { costs: { rows, keys }, billing, workspaceId: raw.workspaceId, month: raw.month };
}

function goUsageRow(value: unknown): GoUsageRow | null {
  const raw = record(value);
  if (!raw || typeof raw.id !== "string" || typeof raw.model !== "string") return null;
  if (typeof raw.isRejected !== "boolean") return null;
  const sessionId = nullableString(raw.sessionId);
  const atMs = finite(raw.atMs);
  const plan = goPlan(raw.plan);
  if (sessionId === undefined || atMs === null || plan === null) return null;
  const counts = [
    finite(raw.inputTokens),
    finite(raw.outputTokens),
    finite(raw.reasoningTokens),
    finite(raw.cacheReadTokens),
    finite(raw.cacheWriteTokens),
    finite(raw.usd),
  ];
  if (counts.some((count) => count === null)) return null;
  return {
    id: raw.id,
    sessionId,
    atMs,
    model: raw.model,
    isRejected: raw.isRejected,
    inputTokens: counts[0]!,
    outputTokens: counts[1]!,
    reasoningTokens: counts[2]!,
    cacheReadTokens: counts[3]!,
    cacheWriteTokens: counts[4]!,
    usd: counts[5]!,
    plan,
  };
}

function goMonths(value: unknown): GoUsageHistory[] | null {
  const months = everyItem(value, goUsageHistory);
  return months === null || months.length === 0 ? null : months;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function goCostSpan(value: unknown): GoCostSpan | null {
  const raw = record(value);
  if (!raw || typeof raw.from !== "string" || typeof raw.until !== "string") return null;
  if (!DATE_PATTERN.test(raw.from) || !DATE_PATTERN.test(raw.until)) return null;
  return { from: raw.from, until: raw.until };
}

function goHistory(value: unknown): GoHistoryReading | null {
  const raw = record(value);
  const fetchedAtMs = finite(raw?.fetchedAtMs);
  if (!raw || fetchedAtMs === null) return null;
  if (typeof raw.hasRequestLogDrift !== "boolean" || typeof raw.hasCostGap !== "boolean") return null;
  const months = goMonths(raw.months);
  const costCoverage = everyItem(raw.costCoverage, goCostSpan);
  if (months === null || costCoverage === null) return null;
  const rows = raw.rows === null ? null : everyItem(raw.rows, goUsageRow);
  if (raw.rows !== null && rows === null) return null;
  return {
    months,
    costCoverage,
    hasCostGap: raw.hasCostGap,
    rows,
    hasRequestLogDrift: raw.hasRequestLogDrift,
    fetchedAtMs,
  };
}

/**
 * Version 1 rows came from the retired usage table, whose ids would never join
 * the request log's, so only the cost months survive; fetchedAtMs 0 forces a walk.
 */
function migratedFromVersion1(value: unknown): GoHistoryReading | null {
  const months = goMonths(record(value)?.months);
  if (months === null) return null;
  return {
    months,
    costCoverage: [],
    hasCostGap: false,
    rows: null,
    hasRequestLogDrift: false,
    fetchedAtMs: 0,
  };
}

const CACHE_VERSION = 2;

/** null for a missing, malformed, or foreign-version file: all mean "walk it". */
export function readGoHistoryCache(path: string): GoHistoryReading | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const raw = record(parsed);
    if (raw?.version === 1) return migratedFromVersion1(raw.reading);
    if (raw?.version !== CACHE_VERSION) return null;
    return goHistory(raw.reading);
  } catch {
    return null;
  }
}

function writeGoHistoryCacheFile(path: string, reading: GoHistoryReading): void {
  let temporary: string | null = null;
  try {
    temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify({ version: CACHE_VERSION, reading })}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    if (temporary) rmSync(temporary, { force: true });
  }
}

/** Writes through a sibling file so an interrupted poll cannot corrupt the cache. */
export function writeGoHistoryCache(path: string, reading: GoHistoryReading): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    withFileLock(path, () => writeGoHistoryCacheFile(path, reading));
  } catch {
    // Cached history is an enhancement; a read-only home must not break polling.
  }
}
