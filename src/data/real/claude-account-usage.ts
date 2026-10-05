import { readFileSync } from "node:fs";
import { isRecord } from "./json";
import type { Money } from "../types";

/**
 * Claude Code caches the account's server-side utilization in `~/.claude.json`
 * under `cachedUsageUtilization`. It is the only local source of real money:
 * credits used, the monthly cap, and the remaining balance. Every field is
 * optional - credit fields read null on subscription accounts with credits off,
 * and older Claude Code versions omit the block entirely.
 */

export type { Money };

export interface ClaudeSpend {
  used: Money | null;
  limit: Money | null;
  balance: Money | null;
  /** 0-100, as reported. */
  percent: number | null;
  isEnabled: boolean;
}

export interface ClaudeExtraUsage {
  isEnabled: boolean;
  isSpendLimitReached: boolean;
  /** True once credits have ever been turned on, even if off now. */
  wasEverEnabled: boolean;
  /** 0-100, as reported. */
  utilization: number | null;
}

export interface ClaudeSurfaceShare {
  key: string;
  label: string;
  percent: number;
}

export interface ClaudeWeeklyBreakdown {
  asOfMs: number;
  windowStartedAtMs: number;
  rows: ClaudeSurfaceShare[];
}

export interface ClaudeAccountUsage {
  spend: ClaudeSpend;
  extraUsage: ClaudeExtraUsage;
  weeklyBreakdown: ClaudeWeeklyBreakdown | null;
  /** When Claude Code last refreshed this from the server. */
  fetchedAtMs: number | null;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Only the `{amount_minor, currency, exponent}` form is trusted; anything else reads as absent. */
function parseMoney(value: unknown): Money | null {
  if (!isRecord(value)) return null;
  const amountMinor = finite(value.amount_minor);
  const exponent = finite(value.exponent);
  if (amountMinor === null || exponent === null) return null;
  if (typeof value.currency !== "string" || value.currency.length === 0) return null;
  return { amountMinor, currency: value.currency, exponent };
}

function parseSpend(value: unknown): ClaudeSpend {
  const raw = isRecord(value) ? value : {};
  return {
    used: parseMoney(raw.used),
    limit: parseMoney(raw.limit),
    balance: parseMoney(raw.balance),
    percent: finite(raw.percent),
    isEnabled: boolOr(raw.enabled, false),
  };
}

function parseExtraUsage(value: unknown): ClaudeExtraUsage {
  const raw = isRecord(value) ? value : {};
  return {
    isEnabled: boolOr(raw.is_enabled, false),
    isSpendLimitReached: boolOr(raw.spend_limit_reached, false),
    wasEverEnabled: boolOr(raw.credits_ever_enabled, false),
    utilization: finite(raw.utilization),
  };
}

function isoMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSurfaceShare(value: unknown): ClaudeSurfaceShare | null {
  if (!isRecord(value)) return null;
  const { key, display_name: label } = value;
  const percent = finite(value.percent);
  if (typeof key !== "string" || key.length === 0) return null;
  if (typeof label !== "string" || label.trim().length === 0) return null;
  if (percent === null || percent < 0 || percent > 100) return null;
  return { key, label: label.trim(), percent };
}

/**
 * A raw server passthrough Claude Code itself never reads, so any mismatch -
 * including shares that stop summing to 100 - drops the whole breakdown.
 */
export function parseWeeklyBreakdown(value: unknown): ClaudeWeeklyBreakdown | null {
  if (!isRecord(value) || !Array.isArray(value.rows) || value.rows.length === 0) return null;
  const asOfMs = isoMs(value.as_of);
  const windowStartedAtMs = isoMs(value.window_started_at);
  if (asOfMs === null || windowStartedAtMs === null || windowStartedAtMs > asOfMs) return null;
  const rows: ClaudeSurfaceShare[] = [];
  for (const item of value.rows) {
    const row = parseSurfaceShare(item);
    if (!row || rows.some((existing) => existing.key === row.key)) return null;
    rows.push(row);
  }
  // Whole-number shares round independently, half a point each at most.
  const total = rows.reduce((sum, row) => sum + row.percent, 0);
  if (Math.abs(total - 100) > rows.length / 2) return null;
  return { asOfMs, windowStartedAtMs, rows };
}

export function parseClaudeAccountUsage(value: unknown): ClaudeAccountUsage | null {
  if (!isRecord(value)) return null;
  const cached = value.cachedUsageUtilization;
  if (!isRecord(cached)) return null;
  const utilization = cached.utilization;
  if (!isRecord(utilization)) return null;
  return {
    spend: parseSpend(utilization.spend),
    extraUsage: parseExtraUsage(utilization.extra_usage),
    weeklyBreakdown: parseWeeklyBreakdown(utilization.seven_day_breakdown),
    fetchedAtMs: finite(cached.fetchedAtMs),
  };
}

const RATE_LIMIT_TIER = /^[a-z][a-z0-9_]{0,63}$/;

/** A user-level tier that disagrees with the organisation's leaves the tier unknown. */
export function parseRateLimitTier(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.oauthAccount)) return null;
  const { organizationRateLimitTier: tier, userRateLimitTier: userTier } = value.oauthAccount;
  if (typeof tier !== "string" || !RATE_LIMIT_TIER.test(tier)) return null;
  if (userTier !== null && userTier !== undefined && userTier !== tier) return null;
  return tier;
}

export interface ClaudeConfig {
  usage: ClaudeAccountUsage | null;
  rateLimitTier: string | null;
}

/**
 * `~/.claude.json` is large and rewritten often, so a read failure or a partial
 * write is expected rather than exceptional and reads as "nothing known".
 */
export function readClaudeConfig(path: string): ClaudeConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { usage: null, rateLimitTier: null };
  }
  return { usage: parseClaudeAccountUsage(parsed), rateLimitTier: parseRateLimitTier(parsed) };
}

/** Whether there is a real money figure to show, as opposed to a subscription with credits off. */
export function hasSpendFigure(usage: ClaudeAccountUsage | null): boolean {
  if (!usage) return false;
  return usage.spend.used !== null && (usage.spend.isEnabled || usage.extraUsage.isEnabled);
}
