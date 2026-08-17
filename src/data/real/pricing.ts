import { readFileSync } from "node:fs";
import { isRecord } from "./json";

/**
 * Prices are USD per million tokens, as published by Anthropic.
 * Rendered in the UI so a stale table is visible rather than silently wrong.
 */
export const PRICES_AS_OF = "2026-08-17";

const PER_MILLION = 1_000_000;

/** Cache reads bill at 10% of input; writes at 1.25x (5m TTL) or 2x (1h TTL). */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;

export interface ModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** Fast mode bills at its own rate; absent when the model has no fast mode. */
  fast?: { input: number; output: number };
}

/**
 * Only models whose pricing is published. A model missing here is reported as
 * unpriced rather than priced at zero - see `priceTokens`.
 */
const BASE_PRICES: Record<string, ModelPrice> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25, fast: { input: 10, output: 50 } },
  "claude-opus-4-8": { input: 5, output: 25, fast: { input: 10, output: 50 } },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/**
 * Strips deployment suffixes that do not change price: `[1m]` (the 1M context
 * window bills at standard rates on current models) and a trailing date stamp.
 * `-fast` is kept out of this - fast mode is priced through `TokenUsage.speed`.
 */
export function canonicalModelId(model: string): string {
  const withoutContext = model.replace(/\[[^\]]*\]$/, "");
  const withoutDate = withoutContext.replace(/-\d{8}$/, "");
  return withoutDate.trim();
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  /** Cache writes with the 5-minute TTL. */
  cacheWrite5m: number;
  /** Cache writes with the 1-hour TTL. */
  cacheWrite1h: number;
  speed?: "standard" | "fast";
}

export interface PricedTokens {
  /** USD, or null when the model has no published price. */
  usd: number | null;
  /** The canonical id the price was looked up under, for display. */
  model: string;
}

export type PriceTable = Record<string, ModelPrice>;

function ratesFor(price: ModelPrice, speed: TokenUsage["speed"]): { input: number; output: number } {
  return speed === "fast" && price.fast ? price.fast : { input: price.input, output: price.output };
}

/**
 * Prices one model's tokens. Returns null for unknown models so callers can
 * surface them as unpriced; a zero here would understate a real bill.
 */
export function priceTokens(
  model: string,
  usage: TokenUsage,
  table: PriceTable = BASE_PRICES,
): PricedTokens {
  const canonical = canonicalModelId(model);
  const price = table[canonical];
  if (!price) return { usd: null, model: canonical };

  const { input, output } = ratesFor(price, usage.speed);
  const usd =
    (usage.input * input +
      usage.output * output +
      usage.cacheRead * input * CACHE_READ_MULTIPLIER +
      usage.cacheWrite5m * input * CACHE_WRITE_5M_MULTIPLIER +
      usage.cacheWrite1h * input * CACHE_WRITE_1H_MULTIPLIER) /
    PER_MILLION;
  return { usd, model: canonical };
}

function parsePrice(value: unknown): ModelPrice | null {
  if (!isRecord(value)) return null;
  const input = value.input;
  const output = value.output;
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) return null;
  if (typeof output !== "number" || !Number.isFinite(output) || output < 0) return null;
  const fastRaw = value.fast;
  if (fastRaw === undefined) return { input, output };
  const fast = parsePrice(fastRaw);
  return fast ? { input, output, fast: { input: fast.input, output: fast.output } } : { input, output };
}

/**
 * Merges `~/.config/open-usage/pricing.json` over the shipped table so a price
 * change does not require a release. Malformed entries are skipped, not fatal.
 */
export function loadPriceTable(path: string): PriceTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ...BASE_PRICES };
  }
  if (!isRecord(parsed)) return { ...BASE_PRICES };

  const merged: PriceTable = { ...BASE_PRICES };
  for (const [model, value] of Object.entries(parsed)) {
    const price = parsePrice(value);
    if (price) merged[canonicalModelId(model)] = price;
  }
  return merged;
}

export function isPricedModel(model: string, table: PriceTable = BASE_PRICES): boolean {
  return table[canonicalModelId(model)] !== undefined;
}

/**
 * Fast mode bills at a different rate than standard, so the two cannot share a
 * bucket. Model ids never contain `::`, which makes this suffix unambiguous.
 */
const FAST_SUFFIX = "::fast";

export function modelUsageKey(model: string, speed: TokenUsage["speed"]): string {
  const canonical = canonicalModelId(model);
  return speed === "fast" ? `${canonical}${FAST_SUFFIX}` : canonical;
}

export function splitModelUsageKey(key: string): { model: string; speed: "standard" | "fast" } {
  return key.endsWith(FAST_SUFFIX)
    ? { model: key.slice(0, -FAST_SUFFIX.length), speed: "fast" }
    : { model: key, speed: "standard" };
}

export function emptyTokenUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

export function addTokenUsage(target: TokenUsage, source: TokenUsage): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite5m += source.cacheWrite5m;
  target.cacheWrite1h += source.cacheWrite1h;
}

export function maxTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite5m: Math.max(a.cacheWrite5m, b.cacheWrite5m),
    cacheWrite1h: Math.max(a.cacheWrite1h, b.cacheWrite1h),
  };
}
