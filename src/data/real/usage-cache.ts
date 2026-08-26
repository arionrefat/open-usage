import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { withFileLock } from "../../lib/file-lock";
import { isRecord } from "./json";
import type { ClaudeCliUsage } from "./claude-usage";
import type {
  CodexAccountLimits,
  CodexAdditionalRateLimit,
  CodexCredits,
  CodexSpendControl,
  CodexUsageHistory,
  CodexUsageSummary,
  CodexWindow,
} from "./codex-app-server";
import type { GoServerLimits } from "./opencode-server";

export interface UsageCache {
  claude: ClaudeCliUsage | null;
  codex: CodexAccountLimits | null;
  go: GoServerLimits | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && !Array.isArray(value) ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableFinite(value: unknown): number | null {
  return value === null ? null : finite(value);
}

function claude(value: unknown): ClaudeCliUsage | null {
  const raw = record(value);
  const session = record(raw?.session);
  const weekly = record(raw?.weekly);
  const fable = raw?.fable === undefined ? null : record(raw.fable);
  const sessionPercent = finite(session?.percent);
  const weeklyPercent = finite(weekly?.percent);
  const fablePercent = fable ? finite(fable.percent) : null;
  const parsedFable = raw?.fable === undefined
    ? undefined
    : fable && fablePercent !== null && typeof fable.reset === "string"
      ? { percent: fablePercent, reset: fable.reset }
      : null;
  const fetchedAtMs = finite(raw?.fetchedAtMs);
  if (sessionPercent === null || weeklyPercent === null || fetchedAtMs === null) return null;
  if (typeof session?.reset !== "string" || typeof weekly?.reset !== "string") return null;
  if (parsedFable === null) return null;
  return {
    session: { percent: sessionPercent, reset: session.reset },
    weekly: { percent: weeklyPercent, reset: weekly.reset },
    ...(parsedFable ? { fable: parsedFable } : {}),
    fetchedAtMs,
  };
}

function codexWindow(value: unknown): CodexWindow | null {
  const raw = record(value);
  const usedPercent = finite(raw?.usedPercent);
  if (usedPercent === null) return null;
  const resetsAtMs = nullableFinite(raw?.resetsAtMs);
  const windowMinutes = nullableFinite(raw?.windowMinutes);
  if (raw?.resetsAtMs !== null && resetsAtMs === null) return null;
  if (raw?.windowMinutes !== null && windowMinutes === null) return null;
  return { usedPercent, resetsAtMs, windowMinutes };
}

function codexAdditional(value: unknown): CodexAdditionalRateLimit | null {
  const raw = record(value);
  if (typeof raw?.name !== "string") return null;
  const window = codexWindow(raw);
  return window ? { name: raw.name, ...window } : null;
}

function codexCredits(value: unknown): CodexCredits | null {
  const raw = record(value);
  if (!raw) return null;
  const balance = nullableFinite(raw.balance);
  if (raw.balance !== null && balance === null) return null;
  if (typeof raw.unlimited !== "boolean") return null;
  return { balance, unlimited: raw.unlimited };
}

function codexSpendControl(value: unknown): CodexSpendControl | null {
  const raw = record(value);
  if (!raw) return null;
  const limit = finite(raw.limit);
  const used = finite(raw.used);
  const usedPercent = finite(raw.usedPercent);
  const resetsAtMs = nullableFinite(raw.resetsAtMs);
  if (limit === null || used === null || usedPercent === null) return null;
  if (raw.resetsAtMs !== null && resetsAtMs === null) return null;
  return { limit, used, usedPercent, resetsAtMs };
}

function codexSummary(value: unknown): CodexUsageSummary | null {
  const raw = record(value);
  if (!raw) return null;
  const values = [
    finite(raw.lifetimeTokens),
    finite(raw.peakDailyTokens),
    finite(raw.longestRunningTurnSec),
    finite(raw.currentStreakDays),
    finite(raw.longestStreakDays),
  ];
  if (values.some((candidate) => candidate === null)) return null;
  return {
    lifetimeTokens: values[0]!,
    peakDailyTokens: values[1]!,
    longestRunningTurnSec: values[2]!,
    currentStreakDays: values[3]!,
    longestStreakDays: values[4]!,
  };
}

function codexUsage(value: unknown): CodexUsageHistory | null {
  const raw = record(value);
  if (!raw || !Array.isArray(raw.dailyTokens)) return null;
  const dailyTokens = new Map<string, number>();
  for (const item of raw.dailyTokens) {
    if (!Array.isArray(item) || typeof item[0] !== "string") return null;
    const tokens = finite(item[1]);
    if (tokens === null) return null;
    dailyTokens.set(item[0], tokens);
  }
  const summary = raw.summary === null ? null : codexSummary(raw.summary);
  if (raw.summary !== null && summary === null) return null;
  return { dailyTokens, summary };
}

function codex(value: unknown): CodexAccountLimits | null {
  const raw = record(value);
  const fetchedAtMs = finite(raw?.fetchedAtMs);
  const resetCredits = finite(raw?.resetCredits);
  if (
    fetchedAtMs === null ||
    resetCredits === null ||
    (typeof raw?.planType !== "string" && raw?.planType !== null)
  ) {
    return null;
  }
  if (!Array.isArray(raw?.additionalRateLimits)) return null;
  const additionalRateLimits: CodexAdditionalRateLimit[] = [];
  for (const item of raw.additionalRateLimits) {
    const limit = codexAdditional(item);
    if (!limit) return null;
    additionalRateLimits.push(limit);
  }
  const usage = raw.usage === null ? null : codexUsage(raw.usage);
  if (raw.usage !== null && usage === null) return null;
  const session = raw.session === null ? null : codexWindow(raw.session);
  const weekly = raw.weekly === null ? null : codexWindow(raw.weekly);
  const credits = raw.credits === null ? null : codexCredits(raw.credits);
  if (raw.session !== null && session === null) return null;
  if (raw.weekly !== null && weekly === null) return null;
  if (raw.credits !== null && credits === null) return null;
  // Absent on entries written before these fields existed; that is not corruption.
  const rawExpireAtMs = raw.resetCreditsExpireAtMs ?? null;
  const expireAtMs = rawExpireAtMs === null ? null : finite(rawExpireAtMs);
  if (rawExpireAtMs !== null && expireAtMs === null) return null;
  const rawReachedType = raw.rateLimitReachedType ?? null;
  if (rawReachedType !== null && typeof rawReachedType !== "string") return null;
  const rawSpendControl = raw.spendControl ?? null;
  const spendControl = rawSpendControl === null ? null : codexSpendControl(rawSpendControl);
  if (rawSpendControl !== null && spendControl === null) return null;
  return {
    session,
    weekly,
    planType: raw.planType,
    resetCredits,
    resetCreditsExpireAtMs: expireAtMs,
    isSpendControlReached: raw.isSpendControlReached === true,
    rateLimitReachedType: rawReachedType,
    spendControl,
    additionalRateLimits,
    credits,
    usage,
    fetchedAtMs,
  };
}

function go(value: unknown): GoServerLimits | null {
  const raw = record(value);
  const rollingPercent = finite(raw?.rollingPercent);
  const rollingResetAtMs = nullableFinite(raw?.rollingResetAtMs);
  const weeklyPercent = nullableFinite(raw?.weeklyPercent);
  const weeklyResetAtMs = nullableFinite(raw?.weeklyResetAtMs);
  const monthlyPercent = nullableFinite(raw?.monthlyPercent);
  const monthlyResetAtMs = nullableFinite(raw?.monthlyResetAtMs);
  const fetchedAtMs = finite(raw?.fetchedAtMs);
  const useBalance = raw?.useBalance;
  const source = raw?.source;
  const rollingUsd = nullableFinite(raw?.rollingUsd);
  const rollingCapUsd = nullableFinite(raw?.rollingCapUsd);
  const weeklyUsd = nullableFinite(raw?.weeklyUsd);
  const weeklyCapUsd = nullableFinite(raw?.weeklyCapUsd);
  const monthlyUsd = nullableFinite(raw?.monthlyUsd);
  const monthlyCapUsd = nullableFinite(raw?.monthlyCapUsd);
  if (
    rollingPercent === null ||
    fetchedAtMs === null ||
    (raw?.rollingResetAtMs !== null && rollingResetAtMs === null) ||
    (raw?.weeklyPercent !== null && weeklyPercent === null) ||
    (raw?.weeklyResetAtMs !== null && weeklyResetAtMs === null) ||
    (raw?.monthlyPercent !== null && monthlyPercent === null) ||
    (raw?.monthlyResetAtMs !== null && monthlyResetAtMs === null) ||
    (useBalance !== undefined && useBalance !== null && typeof useBalance !== "boolean") ||
    (source !== undefined && source !== "api" && source !== "dashboard") ||
    (raw?.rollingUsd !== undefined && raw.rollingUsd !== null && rollingUsd === null) ||
    (raw?.rollingCapUsd !== undefined && raw.rollingCapUsd !== null && rollingCapUsd === null) ||
    (raw?.weeklyUsd !== undefined && raw.weeklyUsd !== null && weeklyUsd === null) ||
    (raw?.weeklyCapUsd !== undefined && raw.weeklyCapUsd !== null && weeklyCapUsd === null) ||
    (raw?.monthlyUsd !== undefined && raw.monthlyUsd !== null && monthlyUsd === null) ||
    (raw?.monthlyCapUsd !== undefined && raw.monthlyCapUsd !== null && monthlyCapUsd === null)
  ) {
    return null;
  }
  return {
    rollingPercent,
    rollingResetAtMs,
    weeklyPercent,
    weeklyResetAtMs,
    monthlyPercent,
    monthlyResetAtMs,
    fetchedAtMs,
    useBalance: useBalance ?? null,
    // Absent dollar figures stay absent, so a decoded entry re-encodes to what
    // was written rather than growing null keys on every round trip.
    ...(raw?.rollingUsd !== undefined ? { rollingUsd } : {}),
    ...(raw?.rollingCapUsd !== undefined ? { rollingCapUsd } : {}),
    ...(raw?.weeklyUsd !== undefined ? { weeklyUsd } : {}),
    ...(raw?.weeklyCapUsd !== undefined ? { weeklyCapUsd } : {}),
    ...(raw?.monthlyUsd !== undefined ? { monthlyUsd } : {}),
    ...(raw?.monthlyCapUsd !== undefined ? { monthlyCapUsd } : {}),
    ...(source ? { source } : {}),
  };
}

function emptyUsageCache(): UsageCache {
  return { claude: null, codex: null, go: null };
}

export function readUsageCache(path: string): UsageCache {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const raw = record(parsed);
    if (raw?.version !== 1) return emptyUsageCache();
    return { claude: claude(raw.claude), codex: codex(raw.codex), go: go(raw.go) };
  } catch {
    return emptyUsageCache();
  }
}

function serializable(cache: UsageCache): Record<string, unknown> {
  return {
    version: 1,
    claude: cache.claude,
    codex: cache.codex
      ? {
          ...cache.codex,
          usage: cache.codex.usage
            ? {
                ...cache.codex.usage,
                dailyTokens: [...cache.codex.usage.dailyTokens.entries()],
              }
            : null,
        }
      : null,
    go: cache.go,
  };
}

function writeUsageCacheFile(path: string, cache: UsageCache): void {
  let temporary: string | null = null;
  try {
    temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(serializable(cache))}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (temporary) rmSync(temporary, { force: true });
  }
}

/** Writes through a sibling file so an interrupted refresh cannot corrupt the cache. */
export function writeUsageCache(path: string, cache: UsageCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    withFileLock(path, () => writeUsageCacheFile(path, cache));
  } catch {
    // Cached values are an enhancement; a read-only home must not break usage polling.
  }
}

export function updateUsageCache<K extends keyof UsageCache>(
  path: string,
  key: K,
  value: UsageCache[K],
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    withFileLock(path, () => {
      const cache = { ...readUsageCache(path), [key]: value };
      writeUsageCacheFile(path, cache);
    });
  } catch {
    // Another instance or a read-only home must not break usage polling.
  }
}
