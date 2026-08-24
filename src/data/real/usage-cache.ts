import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { withFileLock } from "../../lib/file-lock";
import type { ClaudeCliUsage } from "./claude-usage";
import type {
  CodexAccountLimits,
  CodexAdditionalRateLimit,
  CodexCredits,
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
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
  const additionalRateLimits = raw.additionalRateLimits.map(codexAdditional);
  if (additionalRateLimits.some((limit) => limit === null)) return null;
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
  return {
    session,
    weekly,
    planType: raw.planType,
    resetCredits,
    resetCreditsExpireAtMs: expireAtMs,
    isSpendControlReached: raw.isSpendControlReached === true,
    additionalRateLimits: additionalRateLimits as CodexAdditionalRateLimit[],
    credits,
    usage,
    fetchedAtMs,
  };
}

function go(value: unknown): GoServerLimits | null {
  const raw = record(value);
  const rollingPercent = finite(raw?.rollingPercent);
  const rollingResetAtMs = finite(raw?.rollingResetAtMs);
  const weeklyPercent = nullableFinite(raw?.weeklyPercent);
  const weeklyResetAtMs = nullableFinite(raw?.weeklyResetAtMs);
  const monthlyPercent = nullableFinite(raw?.monthlyPercent);
  const monthlyResetAtMs = nullableFinite(raw?.monthlyResetAtMs);
  const fetchedAtMs = finite(raw?.fetchedAtMs);
  const useBalance = raw?.useBalance;
  if (
    rollingPercent === null ||
    rollingResetAtMs === null ||
    fetchedAtMs === null ||
    (raw?.weeklyPercent !== null && weeklyPercent === null) ||
    (raw?.weeklyResetAtMs !== null && weeklyResetAtMs === null) ||
    (raw?.monthlyPercent !== null && monthlyPercent === null) ||
    (raw?.monthlyResetAtMs !== null && monthlyResetAtMs === null) ||
    (useBalance !== undefined && useBalance !== null && typeof useBalance !== "boolean")
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
