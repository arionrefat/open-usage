import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { withFileLock } from "../../lib/file-lock";
import type { GoHistoryReading } from "./go-history-source";
import { isRecord } from "./json";
import type { GoUsageHistory } from "./opencode-server";
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
  if (!raw || typeof raw.date !== "string" || typeof raw.model !== "string") return null;
  const usd = finite(raw.usd);
  const keyId = nullableString(raw.keyId);
  const plan = goPlan(raw.plan);
  if (usd === null || keyId === undefined || plan === null) return null;
  return { date: raw.date, model: raw.model, usd, keyId, plan };
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
  return {
    balanceUsd,
    monthlyUsageUsd,
    monthlyLimitUsd,
    isAutoReloadOn: raw.isAutoReloadOn,
    reloadAmountUsd,
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
  if (!raw || typeof raw.model !== "string" || typeof raw.isByok !== "boolean") return null;
  const id = nullableString(raw.id);
  const sessionId = nullableString(raw.sessionId);
  const keyId = nullableString(raw.keyId);
  const atMs = nullableFinite(raw.atMs);
  const plan = goPlan(raw.plan);
  if (id === undefined || sessionId === undefined || keyId === undefined) return null;
  if (atMs === undefined || plan === null) return null;
  const counts = [
    finite(raw.inputTokens),
    finite(raw.outputTokens),
    finite(raw.reasoningTokens),
    finite(raw.cacheReadTokens),
    finite(raw.cacheWrite5mTokens),
    finite(raw.cacheWrite1hTokens),
    finite(raw.usd),
  ];
  if (counts.some((count) => count === null)) return null;
  return {
    id,
    sessionId,
    keyId,
    atMs,
    model: raw.model,
    inputTokens: counts[0]!,
    outputTokens: counts[1]!,
    reasoningTokens: counts[2]!,
    cacheReadTokens: counts[3]!,
    cacheWrite5mTokens: counts[4]!,
    cacheWrite1hTokens: counts[5]!,
    usd: counts[6]!,
    plan,
    isByok: raw.isByok,
  };
}

function goHistory(value: unknown): GoHistoryReading | null {
  const raw = record(value);
  const fetchedAtMs = finite(raw?.fetchedAtMs);
  if (!raw || fetchedAtMs === null) return null;
  const months = everyItem(raw.months, goUsageHistory);
  if (months === null || months.length === 0) return null;
  const rows = raw.rows === null ? null : everyItem(raw.rows, goUsageRow);
  if (raw.rows !== null && rows === null) return null;
  return { months, rows, fetchedAtMs };
}

/** null for a missing, malformed, or foreign-version file: all mean "walk it". */
export function readGoHistoryCache(path: string): GoHistoryReading | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const raw = record(parsed);
    if (raw?.version !== 1) return null;
    return goHistory(raw.reading);
  } catch {
    return null;
  }
}

function writeGoHistoryCacheFile(path: string, reading: GoHistoryReading): void {
  let temporary: string | null = null;
  try {
    temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify({ version: 1, reading })}\n`, {
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
