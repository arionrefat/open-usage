import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { withFileLock } from "../../lib/file-lock";
import { isRecord } from "./json";
import type {
  ClaudeCliUsage,
  ClaudeExtraUsageSpend,
  ClaudeScopedWindow,
  ClaudeUsageWindow,
} from "./claude-usage";
import type { Money } from "../types";
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

function claudeWindow(value: unknown): ClaudeUsageWindow | null {
  const raw = record(value);
  const percent = finite(raw?.percent);
  if (percent === null || typeof raw?.reset !== "string") return null;
  // Absent on text-only readings and on entries cached before the structured report.
  if (raw.resetsAtMs === undefined) return { percent, reset: raw.reset };
  const resetsAtMs = finite(raw.resetsAtMs);
  return resetsAtMs === null ? null : { percent, reset: raw.reset, resetsAtMs };
}

function claudeScopedWindow(value: unknown): ClaudeScopedWindow | null {
  const raw = record(value);
  const window = claudeWindow(raw);
  if (!window || typeof raw?.id !== "string" || typeof raw.name !== "string") return null;
  if (raw.scope !== "model" && raw.scope !== "surface") return null;
  return { id: raw.id, scope: raw.scope, name: raw.name, ...window };
}

/** Entries written before scoped lanes existed carried Fable under its own key. */
function claudeScopedWindows(raw: Record<string, unknown>): ClaudeScopedWindow[] | null {
  if (raw.scoped === undefined) {
    if (raw.fable === undefined) return [];
    const fable = claudeWindow(raw.fable);
    return fable ? [{ id: "fable", scope: "model", name: "Fable", ...fable }] : null;
  }
  if (!Array.isArray(raw.scoped)) return null;
  const windows: ClaudeScopedWindow[] = [];
  for (const item of raw.scoped) {
    const window = claudeScopedWindow(item);
    if (!window) return null;
    windows.push(window);
  }
  return windows;
}

function claudeMoney(value: unknown): Money | null {
  const raw = record(value);
  const amountMinor = finite(raw?.amountMinor);
  const exponent = finite(raw?.exponent);
  if (amountMinor === null || exponent === null || typeof raw?.currency !== "string") return null;
  return { amountMinor, currency: raw.currency, exponent };
}

function claudeExtraUsage(value: unknown): ClaudeExtraUsageSpend | null {
  const raw = record(value);
  const used = claudeMoney(raw?.used);
  if (!raw || !used) return null;
  const monthlyLimit = raw.monthlyLimit === null ? null : claudeMoney(raw.monthlyLimit);
  const utilization = nullableFinite(raw.utilization);
  if (raw.monthlyLimit !== null && monthlyLimit === null) return null;
  if (raw.utilization !== null && utilization === null) return null;
  return { used, monthlyLimit, utilization };
}

function claude(value: unknown): ClaudeCliUsage | null {
  const raw = record(value);
  const session = claudeWindow(raw?.session);
  const weekly = claudeWindow(raw?.weekly);
  const fetchedAtMs = finite(raw?.fetchedAtMs);
  if (!raw || !session || !weekly || fetchedAtMs === null) return null;
  const scoped = claudeScopedWindows(raw);
  if (!scoped) return null;
  const extraUsage = raw.extraUsage === undefined ? undefined : claudeExtraUsage(raw.extraUsage);
  if (extraUsage === null) return null;
  return { session, weekly, scoped, ...(extraUsage ? { extraUsage } : {}), fetchedAtMs };
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
  const usedPercent = finite(raw.usedPercent);
  const resetsAtMs = nullableFinite(raw.resetsAtMs);
  if (usedPercent === null) return null;
  if (raw.resetsAtMs !== null && resetsAtMs === null) return null;
  // Entries cached while the dollar figures were still carried decode fine:
  // the money keys are simply dropped.
  return { usedPercent, resetsAtMs };
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
  const rawOrdinaryUsage = raw.isOrdinaryUsageAllowed ?? null;
  if (rawOrdinaryUsage !== null && typeof rawOrdinaryUsage !== "boolean") return null;
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
    isOrdinaryUsageAllowed: rawOrdinaryUsage,
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
  const workspaceId = raw?.workspaceId;
  const isCancelling = raw?.isCancelling;
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
    (workspaceId !== undefined && typeof workspaceId !== "string") ||
    (isCancelling !== undefined && typeof isCancelling !== "boolean") ||
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
    ...(typeof workspaceId === "string" ? { workspaceId } : {}),
    ...(typeof isCancelling === "boolean" ? { isCancelling } : {}),
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
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
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
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    withFileLock(path, () => {
      const cache = { ...readUsageCache(path), [key]: value };
      writeUsageCacheFile(path, cache);
    });
  } catch {
    // Another instance or a read-only home must not break usage polling.
  }
}
