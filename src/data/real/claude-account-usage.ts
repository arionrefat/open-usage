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

export interface ClaudeAccountUsage {
  spend: ClaudeSpend;
  extraUsage: ClaudeExtraUsage;
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

export function parseClaudeAccountUsage(value: unknown): ClaudeAccountUsage | null {
  if (!isRecord(value)) return null;
  const cached = value.cachedUsageUtilization;
  if (!isRecord(cached)) return null;
  const utilization = cached.utilization;
  if (!isRecord(utilization)) return null;
  return {
    spend: parseSpend(utilization.spend),
    extraUsage: parseExtraUsage(utilization.extra_usage),
    fetchedAtMs: finite(cached.fetchedAtMs),
  };
}

/**
 * `~/.claude.json` is large and rewritten often, so a read failure or a partial
 * write is expected rather than exceptional and reads as "no account usage".
 */
export function readClaudeAccountUsage(path: string): ClaudeAccountUsage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  return parseClaudeAccountUsage(parsed);
}

/** Whether there is a real money figure to show, as opposed to a subscription with credits off. */
export function hasSpendFigure(usage: ClaudeAccountUsage | null): boolean {
  if (!usage) return false;
  return usage.spend.used !== null && (usage.spend.isEnabled || usage.extraUsage.isEnabled);
}
