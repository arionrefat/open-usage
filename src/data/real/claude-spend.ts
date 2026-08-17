import type { Exactness, ModelSpend, Money, SpendPeriod, SpendSummary, TokenSplit } from "../types";
import { hasSpendFigure, type ClaudeAccountUsage } from "./claude-account-usage";
import type { TranscriptAggregate } from "./claude-transcripts";
import {
  isPricedModel,
  priceTokens,
  splitModelUsageKey,
  PRICES_AS_OF,
  type PriceTable,
  type TokenUsage,
} from "./pricing";
import {
  openCycleTotal,
  recordDayTokens,
  recordSpendReading,
  recordsBeganMs,
  sumWindow,
  updateSpendStore,
  type SpendStore,
} from "./spend-store";

/**
 * Assembles what the UI renders from the two honest sources: Claude's own
 * account figures for money, and our recorded transcripts for tokens.
 *
 * The pricing table only ever apportions. Where Claude reports an exact total,
 * the per-model split is priced, normalised, and scaled to that total, so the
 * parts sum to the truth and a stale price can shift the split but never the
 * headline. Where Claude reports nothing, the priced figure is shown directly
 * and labelled an estimate.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function toSplit(usage: TokenUsage): TokenSplit {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite5m + usage.cacheWrite1h,
  };
}

function usdToMoney(usd: number): Money {
  return { amountMinor: Math.round(usd * 100), currency: "USD", exponent: 2 };
}

function tokenVolume(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
}

interface PricedModel {
  key: string;
  model: string;
  isFast: boolean;
  tokens: TokenUsage;
  /** USD from the price table, or null when the model has no published price. */
  usd: number | null;
}

function priceModels(models: Record<string, TokenUsage>, table: PriceTable): PricedModel[] {
  const priced: PricedModel[] = [];
  for (const [key, tokens] of Object.entries(models)) {
    if (tokenVolume(tokens) <= 0) continue;
    const { model, speed } = splitModelUsageKey(key);
    const { usd } = priceTokens(model, { ...tokens, speed }, table);
    priced.push({ key, model, isFast: speed === "fast", tokens, usd });
  }
  return priced;
}

/**
 * Scales priced costs so they sum exactly to `total`. Rounding is settled by
 * giving the remainder to the largest row, so the displayed parts always add up
 * to the displayed headline rather than being a cent out.
 */
function apportion(priced: PricedModel[], total: Money): ModelSpend[] {
  const pricedSum = priced.reduce((sum, entry) => sum + (entry.usd ?? 0), 0);
  const scalable = priced.filter((entry) => entry.usd !== null);

  if (pricedSum <= 0 || scalable.length === 0) {
    return priced.map((entry) => ({
      model: entry.model,
      ...(entry.isFast ? { isFast: true } : {}),
      tokens: toSplit(entry.tokens),
      cost: null,
      exactness: "unavailable" as const,
    }));
  }

  const shares = scalable.map((entry) => ({
    entry,
    minor: Math.round((total.amountMinor * (entry.usd ?? 0)) / pricedSum),
  }));
  const assigned = shares.reduce((sum, share) => sum + share.minor, 0);
  const remainder = total.amountMinor - assigned;
  if (remainder !== 0) {
    let largest = shares[0];
    for (const share of shares) if (largest && share.minor > largest.minor) largest = share;
    if (largest) largest.minor += remainder;
  }

  const byKey = new Map(shares.map((share) => [share.entry.key, share.minor]));
  return priced.map((entry) => {
    const minor = byKey.get(entry.key);
    return {
      model: entry.model,
      ...(entry.isFast ? { isFast: true } : {}),
      tokens: toSplit(entry.tokens),
      cost:
        minor === undefined
          ? null
          : { amountMinor: minor, currency: total.currency, exponent: total.exponent },
      exactness: minor === undefined ? ("unavailable" as const) : ("exact" as const),
    };
  });
}

function estimateModels(priced: PricedModel[]): ModelSpend[] {
  return priced.map((entry) => ({
    model: entry.model,
    ...(entry.isFast ? { isFast: true } : {}),
    tokens: toSplit(entry.tokens),
    cost: entry.usd === null ? null : usdToMoney(entry.usd),
    exactness: entry.usd === null ? ("unavailable" as const) : ("estimated" as const),
  }));
}

function byCostThenTokens(a: ModelSpend, b: ModelSpend): number {
  const costDelta = (b.cost?.amountMinor ?? -1) - (a.cost?.amountMinor ?? -1);
  if (costDelta !== 0) return costDelta;
  const volume = (split: TokenSplit) => split.input + split.output + split.cacheWrite;
  return volume(b.tokens) - volume(a.tokens);
}

interface PeriodInput {
  label: string;
  fromMs: number;
  toMs: number;
  /** Claude's own figure, when it has one. */
  exactTotal: Money | null;
  /**
   * Whether `exactTotal` covers exactly this window. Only then can it be
   * apportioned across the window's tokens; otherwise the money and the tokens
   * describe different spans and the split would be meaningless.
   */
  isTotalAligned: boolean;
  /** Names the money's own window when it differs from the period's. */
  totalWindowLabel?: string;
  limit: Money | null;
}

function buildPeriod(
  input: PeriodInput,
  store: SpendStore,
  table: PriceTable,
  recordsFromMs: number | null,
): SpendPeriod {
  const priced = priceModels(sumWindow(store, input.fromMs, input.toMs), table);
  const estimatedUsd = priced.reduce((sum, entry) => sum + (entry.usd ?? 0), 0);

  const canApportion = input.exactTotal !== null && input.isTotalAligned;
  const models = canApportion && input.exactTotal
    ? apportion(priced, input.exactTotal)
    : estimateModels(priced);

  const total = input.exactTotal ?? (priced.length > 0 ? usdToMoney(estimatedUsd) : null);
  const exactness: Exactness = input.exactTotal
    ? "exact"
    : priced.length > 0
      ? "estimated"
      : "unavailable";

  return {
    label: input.label,
    total,
    ...(input.totalWindowLabel ? { totalWindowLabel: input.totalWindowLabel } : {}),
    limit: input.limit,
    exactness,
    models: models.sort(byCostThenTokens),
    isBeforeRecordsBegan: recordsFromMs === null || input.fromMs < recordsFromMs,
  };
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function monthLabel(date: Date): string {
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function shortDate(ms: number): string {
  const date = new Date(ms);
  return `${MONTHS[date.getMonth()]?.slice(0, 3)} ${date.getDate()}`;
}

/** Start of the local calendar month containing `date`. */
function monthStart(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

function monthEnd(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
}

export interface ClaudeSpendInput {
  account: ClaudeAccountUsage | null;
  store: SpendStore;
  table: PriceTable;
  now: Date;
  /** How many completed periods to report. */
  historyLimit?: number;
}

export function buildClaudeSpend(input: ClaudeSpendInput): SpendSummary | undefined {
  const { account, store, table, now } = input;
  const historyLimit = input.historyLimit ?? 6;
  const hasTokens = Object.keys(store.days).length > 0;
  const hasMoney = hasSpendFigure(account);
  if (!hasTokens && !hasMoney) return undefined;

  const nowMs = now.getTime();
  const recordsFromMs = recordsBeganMs(store);
  const exactTotal = hasMoney ? openCycleTotal(store) : null;
  const limit = account?.spend.limit ?? null;

  // Tokens are always reported for the calendar month - that is the window the
  // question is asked in. The credit cycle rarely starts on the 1st, and we only
  // learn its start when we first observe it, so the exact total is apportioned
  // across the month only when the observed cycle demonstrably covers it.
  const currentMonthStartMs = monthStart(now);
  const cycleStartMs = hasMoney ? (store.openCycle?.startedMs ?? null) : null;
  const isCycleCoveringMonth = cycleStartMs !== null && cycleStartMs <= currentMonthStartMs;
  const current = buildPeriod(
    {
      label: monthLabel(now),
      fromMs: currentMonthStartMs,
      toMs: nowMs + DAY_MS,
      exactTotal,
      isTotalAligned: isCycleCoveringMonth,
      ...(cycleStartMs !== null && !isCycleCoveringMonth
        ? { totalWindowLabel: `cycle since ${shortDate(cycleStartMs)}` }
        : {}),
      limit,
    },
    store,
    table,
    recordsFromMs,
  );

  const history: SpendPeriod[] = [];
  if (store.completedCycles.length > 0) {
    for (const cycle of [...store.completedCycles].reverse().slice(0, historyLimit)) {
      history.push(
        buildPeriod(
          {
            label: `${shortDate(cycle.startedMs)} - ${shortDate(cycle.endedMs)}`,
            fromMs: cycle.startedMs,
            toMs: cycle.endedMs + DAY_MS,
            exactTotal: {
              amountMinor: cycle.totalMinor,
              currency: cycle.currency,
              exponent: cycle.exponent,
            },
            // A completed cycle's span is fully known, so its total does cover
            // exactly the tokens summed over it.
            isTotalAligned: true,
            limit: null,
          },
          store,
          table,
          recordsFromMs,
        ),
      );
    }
  } else {
    // No credit cycles to anchor to, so fall back to calendar months, which is
    // the window a subscription user thinks in anyway.
    for (let back = 1; back <= historyLimit; back++) {
      const anchor = new Date(now.getFullYear(), now.getMonth() - back, 1);
      const fromMs = monthStart(anchor);
      if (recordsFromMs !== null && monthEnd(anchor) <= recordsFromMs) break;
      history.push(
        buildPeriod(
          {
            label: monthLabel(anchor),
            fromMs,
            toMs: monthEnd(anchor),
            exactTotal: null,
            isTotalAligned: false,
            limit: null,
          },
          store,
          table,
          recordsFromMs,
        ),
      );
    }
  }

  const unpriced = new Set<string>();
  for (const period of [current, ...history]) {
    for (const model of period.models) {
      if (!isPricedModel(model.model, table)) unpriced.add(model.model);
    }
  }

  return {
    current,
    history,
    pricesAsOf: PRICES_AS_OF,
    unpricedModels: [...unpriced].sort(),
  };
}

export interface RecordClaudeSpendInput {
  path: string;
  account: ClaudeAccountUsage | null;
  transcripts: Pick<TranscriptAggregate, "dayModelTokens" | "earliestMs">;
  nowMs: number;
}

/**
 * Folds this poll's measurements into the persisted store and returns the
 * result. Token days are replaced or max-merged; the spend reading only ever
 * raises the cycle's running maximum, never accumulates.
 */
export function recordClaudeSpend(input: RecordClaudeSpendInput): SpendStore {
  const measured: Record<string, Record<string, TokenUsage>> = {};
  for (const [day, models] of input.transcripts.dayModelTokens) {
    measured[day] = Object.fromEntries(models);
  }
  const reading = hasSpendFigure(input.account) ? input.account?.spend.used : null;

  return updateSpendStore(input.path, (store) => {
    const withTokens = recordDayTokens(store, measured, input.transcripts.earliestMs);
    return reading ? recordSpendReading(withTokens, reading, input.nowMs) : withTokens;
  });
}
